import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { createHost } from '../../server/app';
import type { JobSnapshot } from '../../shared/protocol';
import { buildSemanticWindowPlan, createSemanticBase } from '../../shared/editing/semanticFillers';

const fixture = JSON.parse(readFileSync(resolve('experiments/f-0008-semantic-cut/fixtures/mini-transcript.json'), 'utf8'));

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'flycut-semantic-f0009-'));
  const ctx = await createHost({ home, token: 'f0009-token', port: 0, resourceRoot: resolve('.') }, {
    profile: 'desktop',
    patches: [{ source: 'f0009-test', patch: { config: { 'ai-settings': { secretBackend: 'memory' } } } }],
  });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const call = async <T = any>(method: string, payload: unknown = {}): Promise<T> => {
    const response = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { Authorization: 'Bearer f0009-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
    });
    const envelope = await response.json();
    if (!envelope.result.ok) throw new Error(envelope.result.error.message);
    return envelope.result.value;
  };
  const wait = async (id: string) => {
    for (let index = 0; index < 100; index++) {
      const job = await call<JobSnapshot>('jobs.get', { id });
      if (['complete', 'error', 'cancelled'].includes(job.status)) return job;
      await setTimeout(20);
    }
    throw new Error('job did not settle');
  };
  return { home, ctx, call, wait, async close() {
    await ctx.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  } };
}

async function fixtureModel() {
  const seen: Array<{ auth?: string; user: any; body: string }> = [];
  let mode: 'valid' | 'unknown' | 'bad-json' = 'valid';
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    const user = JSON.parse(parsed.messages[1].content);
    seen.push({ auth: request.headers.authorization, user, body });
    response.setHeader('Content-Type', 'application/json');
    const content = mode === 'bad-json' ? 'not json'
      : JSON.stringify({ version: 1, base: user.base, candidates: mode === 'unknown' ? [{
          startWordId: 'w99', endWordId: 'w99', scope: 'word', category: 'contextual-filler',
          reason: 'unknown id must reject the batch', confidence: 'low',
        }] : [{
          startWordId: 'w5', endWordId: 'w6', scope: 'word', category: 'repetition',
          reason: '重复的开头词，保留后一次', confidence: 'high', startMs: 999999,
        }] });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    seen,
    setMode(next: typeof mode) { mode = next; },
    close: () => new Promise<void>(done => server.close(() => done())),
  };
}

test('F-0009/AC-2 AC-4 AC-9 Host resolves saved config, sends no key, and derives validated candidate times', async () => {
  const model = await fixtureModel();
  const host = await setup();
  try {
    const identity = await host.call('projects.identity');
    const saved = await host.call('aiSettings.save', {
      hostId: identity.hostId, expectedRevision: 0,
      config: { name: 'Semantic fixture', baseUrl: model.url, model: 'fixture-semantic', apiKey: 'f0009-secret' },
    });
    assert.equal(saved.status, 'saved');
    const base = await createSemanticBase({
      edl: { deleted: [] }, chunks: fixture.chunks, wordChunks: fixture.wordChunks,
      sourceDuration: fixture.duration, transcriptId: 'mini',
    });
    const plan = buildSemanticWindowPlan({
      base, transcriptId: 'mini', language: fixture.language,
      chunks: fixture.chunks, wordChunks: fixture.wordChunks,
    });
    const request = plan.windows[0];
    const rpcPayload = { configId: saved.configId, request };
    assert.equal(JSON.stringify(rpcPayload).includes('f0009-secret'), false);

    const result = await host.wait((await host.call('text.suggestCuts', rpcPayload)).id);
    assert.equal(result.status, 'complete', result.error);
    const output = result.result as any;
    assert.equal(output.base, base);
    assert.equal(output.candidates[0].startMs, 2000);
    assert.equal(output.candidates[0].endMs, 2600);
    assert.equal(output.candidates[0].text, '这个这个');
    assert.equal(model.seen[0].auth, 'Bearer f0009-secret');
    assert.equal(model.seen[0].user.sentences[0].words[0].startMs, undefined, 'model payload omits timestamps');
    assert.equal(model.seen[0].body.includes('f0009-secret'), false);
    assert.equal((await readFile(join(host.home, 'jobs', `${result.id}.json`), 'utf8')).includes('f0009-secret'), false);

    model.setMode('unknown');
    const invalid = await host.wait((await host.call('text.suggestCuts', rpcPayload)).id);
    assert.equal(invalid.status, 'error');
    assert.match(invalid.error ?? '', /word|未知|UNKNOWN/i);
    model.setMode('bad-json');
    const bad = await host.wait((await host.call('text.suggestCuts', rpcPayload)).id);
    assert.equal(bad.status, 'error');
    assert.match(bad.error ?? '', /Response must be an object|Invalid|无效/i);
  } finally {
    await host.close();
    await model.close();
  }
});

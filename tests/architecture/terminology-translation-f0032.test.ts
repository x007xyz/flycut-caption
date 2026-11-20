import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHost } from '../../server/app';
import type { JobSnapshot } from '../../shared/protocol';
import { findTerminologyIssues } from '../../shared/terminology';

test('F-0032/AC-3 translation requests carry the project glossary to the model', async () => {
  const seen: string[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push(body);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'fixture' }] }));
    const items = JSON.parse(body).messages[1].content as string;
    const parsed = JSON.parse(items) as Array<{ id: string }>;
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(parsed.map(item => ({ id: item.id, text: 'Subtitle tool' }))) } }] }));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0032-'));
  const ctx = await createHost({ home, token: 'f0032-token', port: 0, resourceRoot: resolve('.') }, {
    profile: 'desktop', patches: [{ source: 'f0032', patch: { config: { 'ai-settings': { secretBackend: 'memory' } } } }] });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const call = async <T>(method: string, payload: unknown = {}): Promise<T> => {
    const response = await fetch(`${base}/rpc`, { method: 'POST', headers: { Authorization: 'Bearer f0032-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }) });
    const envelope = await response.json() as { result: { ok: boolean; value: T; error?: { message: string } } };
    if (!envelope.result.ok) throw new Error(envelope.result.error.message);
    return envelope.result.value;
  };
  try {
    const host = await call<{ hostId: string }>('projects.identity');
    const saved = await call<{ configId: string }>('aiSettings.save', { hostId: host.hostId, expectedRevision: 0,
      config: { name: 'Fixture', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        model: 'fixture', apiKey: 'key' } });
    const job = await call<JobSnapshot>('text.start', { mode: 'translation', configId: saved.configId, targetLang: 'English',
      items: [{ id: 'a', text: '字幕工具' }], terms: [{ term: '字幕', translation: 'Subtitle' }] });
    for (let i = 0; i < 100; i += 1) {
      const current = await call<JobSnapshot>('jobs.get', { id: job.id });
      if (current.status === 'complete') break;
      if (current.status === 'error') throw new Error(current.error);
      await new Promise(done => setTimeout(done, 20));
    }
    const body = seen.find(item => item.includes('字幕'));
    assert.ok(body, 'request body missing');
    assert.match(body, /「字幕」→「Subtitle」/);
  } finally {
    await ctx.fiber.dispose();
    await new Promise<void>(done => server.close(() => done()));
    await rm(home, { recursive: true, force: true });
  }
});


test('F-0032/AC-1 AC-3 flags translations that miss the required glossary term', () => {
  const issues = findTerminologyIssues([
    { id: 'a', sourceText: 'FlyCut 字幕工具', translatedText: 'FlyCut subtitle tool' },
    { id: 'b', sourceText: 'FlyCut 字幕工具', translatedText: 'Subtitle tool' },
    { id: 'c', sourceText: '没有术语', translatedText: 'No terms' },
  ], [{ term: 'FlyCut', translation: 'FlyCut' }, { term: '字幕', translation: 'subtitle' }]);
  assert.deepEqual(issues, [{ id: 'b', terms: ['FlyCut'] }]);
});

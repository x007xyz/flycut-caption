import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHost } from '../../server/app';
import type { JobSnapshot } from '../../shared/protocol';

test('F-0036/AC-2 shortening requests carry the target character limit and return reviewable text', async () => {
  const seen: string[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push(body);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'fixture' }] }));
    const parsed = JSON.parse(body);
    const items = JSON.parse(parsed.messages[1].content) as Array<{ id: string }>;
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(items.map(item => ({ id: item.id, text: 'Shorter' }))) } }] }));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0036-shorten-'));
  const ctx = await createHost({ home, token: 'f0036s', port: 0, resourceRoot: resolve('.') }, {
    profile: 'desktop', patches: [{ source: 'f0036s', patch: { config: { 'ai-settings': { secretBackend: 'memory' } } } }] });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const call = async <T>(method: string, payload: unknown = {}): Promise<T> => {
    const response = await fetch(`${base}/rpc`, { method: 'POST', headers: { Authorization: 'Bearer f0036s', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }) });
    const envelope = await response.json() as { result: { ok: boolean; value: T; error?: { message: string } } };
    if (!envelope.result.ok) throw new Error(envelope.result.error.message);
    return envelope.result.value;
  };
  try {
    const host = await call<{ hostId: string }>('projects.identity');
    const saved = await call<{ configId: string }>('aiSettings.save', { hostId: host.hostId, expectedRevision: 0,
      config: { name: 'Fixture', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: 'fixture', apiKey: 'key' } });
    const job = await call<JobSnapshot>('text.shorten', { configId: saved.configId,
      items: [{ id: 'a', text: 'This is a long translated cue', maxChars: 12 }] });
    for (let i = 0; i < 100; i += 1) {
      const current = await call<JobSnapshot>('jobs.get', { id: job.id });
      if (current.status === 'complete') { assert.deepEqual(current.result, [{ id: 'a', text: 'Shorter' }]); break; }
      if (current.status === 'error') throw new Error(current.error);
      await new Promise(done => setTimeout(done, 20));
    }
    assert.ok(seen.some(body => body.includes('不超过 12 个字符')));
  } finally {
    await ctx.fiber.dispose();
    await new Promise<void>(done => server.close(() => done()));
    await rm(home, { recursive: true, force: true });
  }
});

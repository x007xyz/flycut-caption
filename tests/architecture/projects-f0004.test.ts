// F-0004 Host side: stable Host identity and idempotent Save as new project for crash recovery (ADR-0004).
// Client-side recovery copies and the open/recover/discard flows are covered by tests/e2e/features/F-0004.spec.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHost } from '../../server/app';

const SHELL = 'shell-secret';
const transcript = { text: '你好 世界', language: 'zh', duration: 4,
  chunks: [{ id: 's1', text: '你好', timestamp: [0, 1] }, { id: 's2', text: '世界', timestamp: [1, 2] }] };
const edits = (text: string) => ({ chunks: [{ id: 's1', text, timestamp: [0, 1] }], deletedWordIds: [] });

async function start(home: string, token = 'test-credential') {
  const ctx = await createHost({ home, token, port: 0, resourceRoot: resolve('.'), shellToken: SHELL }, { profile: 'desktop', providers: [], patches: [] });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const call = async <T = any>(method: string, payload: unknown = {}): Promise<T> => {
    const response = await fetch(`${base}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r', method, payload }) });
    const envelope = await response.json();
    if (!envelope.result.ok) throw new Error(envelope.result.error.message);
    return envelope.result.value;
  };
  const upload = async (body: string) => (await (await fetch(`${base}/assets`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body })).json()).assetId as string;
  return { ctx, call, upload, stop: () => ctx.fiber.dispose() };
}

test('F-0004/AC-1: the Host identity survives restarts and token changes, and differs for another Host home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0004-'));
  const other = await mkdtemp(join(tmpdir(), 'flycut-f0004-'));
  try {
    let host = await start(home);
    const first = await host.call('projects.identity');
    assert.match(first.hostId, /^[0-9a-f-]{36}$/); assert.equal(first.recovery, 1);
    await host.stop();
    host = await start(home, 'another-token');
    assert.equal((await host.call('projects.identity')).hostId, first.hostId, 'restart with a new token keeps the identity');
    await host.stop();
    const second = await start(other);
    assert.notEqual((await second.call('projects.identity')).hostId, first.hostId, 'another Host home is another Host');
    await second.stop();
  } finally { await rm(home, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); }
});

test('F-0004/AC-1: a damaged identity file stops the Host instead of quietly making a new identity', async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0004-'));
  try {
    await writeFile(join(home, 'host-id.json'), '{"hostId": 42}');
    await assert.rejects(start(home), /Host 身份文件已损坏/);
    assert.equal(await readFile(join(home, 'host-id.json'), 'utf8'), '{"hostId": 42}', 'the damaged file is left for the user to inspect');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('F-0004/AC-7: Save as new project with a client-chosen ID makes one copy however often it is retried', async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0004-'));
  const host = await start(home);
  try {
    const created = await host.call('projects.create', { name: '口播', videoName: '口播.mp4', durationSeconds: 4,
      media: { assetId: await host.upload('video-bytes'), mimeType: 'video/mp4' } });
    await host.call('projects.saveTranscript', { projectId: created.projectId, videoId: created.videoId, transcript });
    const copyId = randomUUID();
    const input = { projectId: created.projectId, videoId: created.videoId, name: '口播 副本', edits: edits('恢复的修改'), copyId };
    const first = await host.call('projects.duplicate', input);
    // the response got lost: the client retries with the same ID
    const again = await host.call('projects.duplicate', input);
    assert.equal(first.projectId, copyId); assert.equal(again.projectId, copyId);
    const names = (await host.call('projects.list')).map((item: any) => item.name).sort();
    assert.deepEqual(names, ['口播', '口播 副本'], 'exactly one copy');
    const opened = await host.call('projects.open', { projectId: copyId, videoId: created.videoId });
    assert.equal(opened.edits.chunks[0].text, '恢复的修改');
    const original = await host.call('projects.open', { projectId: created.projectId, videoId: created.videoId });
    assert.equal(original.edits, undefined, 'the original project is not written');
  } finally { await host.stop(); await rm(home, { recursive: true, force: true }); }
});

test('F-0004/AC-7: a copy a crash left half done is made again, not returned', async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0004-'));
  const host = await start(home);
  try {
    const created = await host.call('projects.create', { name: '口播', videoName: '口播.mp4', durationSeconds: 4,
      media: { assetId: await host.upload('video-bytes'), mimeType: 'video/mp4' } });
    const copyId = randomUUID();
    // the folder was copied, but project.json still names the original: the crash came before the copy was renamed
    await cp(join(home, 'projects', created.projectId), join(home, 'projects', copyId), { recursive: true });
    const copy = await host.call('projects.duplicate', { projectId: created.projectId, videoId: created.videoId, name: '副本', copyId });
    assert.equal(copy.projectId, copyId);
    const project = JSON.parse(await readFile(join(home, 'projects', copyId, 'project.json'), 'utf8'));
    assert.equal(project.id, copyId); assert.equal(project.name, '副本');
    assert.equal((await readdir(join(home, 'projects'))).filter(name => !name.startsWith('.')).length, 2);
  } finally { await host.stop(); await rm(home, { recursive: true, force: true }); }
});

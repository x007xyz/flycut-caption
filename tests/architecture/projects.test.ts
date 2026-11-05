// F-0002 Host side: project storage, media and the shell-only registration channel (ADR-0001, ADR-0002).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHost } from '../../server/app';
import { migrateProject } from '../../server/projects/migrations';

const TOKEN = 'test-credential';
const SHELL = 'shell-secret';
const transcript = { text: '你好 世界', language: 'zh', duration: 4,
  chunks: [{ id: 's1', text: '你好', timestamp: [0, 1] }, { id: 's2', text: '世界', timestamp: [1, 2], speaker: 'A' }],
  wordChunks: [{ id: 'w1', text: '你', timestamp: [0, 0.5], sentenceId: 's1' }], hasWordTimestamps: true };

async function setup(options: { profile?: string; shellToken?: string } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'flycut-projects-test-'));
  const ctx = await createHost({ home, token: TOKEN, port: 0, resourceRoot: resolve('.'), shellToken: options.shellToken ?? SHELL },
    { profile: options.profile ?? 'desktop', providers: [] });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const call = async <T = any>(method: string, payload: unknown = {}): Promise<T> => {
    const response = await fetch(`${base}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r', method, payload }) });
    const envelope = await response.json();
    if (!envelope.result.ok) throw new Error(envelope.result.error.message);
    return envelope.result.value;
  };
  const upload = async (body: string) => (await (await fetch(`${base}/assets`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body })).json()).assetId as string;
  const shellLink = (path: string, authorization = `Bearer ${SHELL}`, headers: Record<string, string> = {}) =>
    fetch(`${base}/shell/projects/media`, { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ path }) });
  return { home, ctx, base, call, upload, shellLink, async close() { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }); } };
}

test('F-0002/AC-1 AC-2 AC-5 AC-6: an uploaded video becomes a project that survives restarts and asset expiry', async () => {
  const host = await setup();
  try {
    const assetId = await host.upload('fake-mp4-bytes');
    const created = await host.call('projects.create', { name: '口播', videoName: '口播.mp4', durationSeconds: 4, media: { assetId, mimeType: 'video/mp4' } });
    assert.equal(created.revision, 1);
    // The asset left the TTL-managed store: cleanup can no longer delete the project's media.
    assert.deepEqual(await readdir(join(host.home, 'assets')), []);
    const saved = await host.call('projects.saveTranscript', { projectId: created.projectId, videoId: created.videoId, transcript,
      model: { providerId: 'sherpa-onnx', modelId: 'sense-voice' } });
    assert.equal(saved.status, 'saved'); assert.equal(saved.revision, 2);

    const list = await host.call('projects.list');
    assert.equal(list.length, 1);
    assert.deepEqual({ name: list[0].name, videoCount: list[0].videoCount, durationSeconds: list[0].durationSeconds, mediaMissing: list[0].mediaMissing },
      { name: '口播', videoCount: 1, durationSeconds: 4, mediaMissing: false });
  } finally { await host.close(); }
});

test('F-0002/AC-5 AC-6: reopening after a Host restart returns the saved transcript and streams the media with Range', async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-projects-restart-'));
  const boot = () => createHost({ home, token: TOKEN, port: 0, resourceRoot: resolve('.'), assetTtlHours: 0 }, { providers: [] });
  let ctx = await boot();
  const url = () => `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const call = async (method: string, payload: unknown = {}) => {
    const response = await fetch(`${url()}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r', method, payload }) });
    const envelope = await response.json(); if (!envelope.result.ok) throw new Error(envelope.result.error.message); return envelope.result.value;
  };
  try {
    const assetId = (await (await fetch(`${url()}/assets`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: '0123456789' })).json()).assetId;
    const created = await call('projects.create', { name: 'a', videoName: 'a.mp4', media: { assetId, mimeType: 'video/mp4' } });
    await call('projects.saveTranscript', { projectId: created.projectId, videoId: created.videoId, transcript });
    await ctx.fiber.dispose();
    // TTL 0 hours: the restart's cleanup deletes every asset, but not project media.
    ctx = await boot();
    const opened = await call('projects.open', { projectId: created.projectId });
    assert.equal(opened.status, 'ok');
    assert.equal(opened.media.status, 'ok');
    assert.deepEqual(opened.transcript.chunks.map((chunk: any) => chunk.text), ['你好', '世界']);
    assert.equal(opened.transcript.chunks[1].speaker, 'A', 'unknown chunk fields are kept');
    assert.equal(opened.video.hasTranscript, true);
    assert.deepEqual(opened.media.playback, { kind: 'url', path: `/projects/${created.projectId}/media/${created.videoId}` });

    const media = `${url()}${opened.media.playback.path}`;
    assert.equal((await fetch(media)).status, 401, 'media needs the client token');
    const full = await fetch(`${media}?token=${TOKEN}`);
    assert.equal(full.headers.get('accept-ranges'), 'bytes'); assert.equal(await full.text(), '0123456789');
    const part = await fetch(media, { headers: { Authorization: `Bearer ${TOKEN}`, Range: 'bytes=2-5' } });
    assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), 'bytes 2-5/10'); assert.equal(await part.text(), '2345');
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }); }
});

test('F-0002/AC-1: the shell channel registers picked files; tokens, origins and the server profile cannot use it', async () => {
  const host = await setup();
  const media = join(host.home, 'local.mp4');
  await writeFile(media, Buffer.alloc(3 * 1024 * 1024, 7));
  try {
    assert.equal((await host.shellLink(media, `Bearer ${TOKEN}`)).status, 401, 'frontend token is rejected');
    assert.equal((await host.shellLink(media, `Bearer ${SHELL}`, { Origin: 'http://localhost:5173' })).status, 401, 'browser pages are rejected');
    const response = await host.shellLink(media);
    assert.equal(response.status, 201);
    const { mediaRef } = await response.json();
    // RPC takes the opaque reference, never a path.
    await assert.rejects(host.call('projects.create', { name: 'x', videoName: 'x.mp4', media: { path: media } }));
    const created = await host.call('projects.create', { name: '本地', videoName: 'local.mp4', media: { mediaRef } });
    const opened = await host.call('projects.open', { projectId: created.projectId });
    assert.deepEqual(opened.media, { status: 'ok', name: 'local.mp4', playback: { kind: 'path', path: media } });
    await assert.rejects(host.call('projects.create', { name: 'y', videoName: 'y.mp4', media: { mediaRef } }), /失效/, 'a reference is used once');
  } finally { await host.close(); }

  const unset = await setup({ shellToken: '' });
  try { assert.equal((await unset.shellLink('/etc/hosts', 'Bearer ')).status, 401, 'no shell secret: channel closed'); }
  finally { await unset.close(); }

  const server = await setup({ profile: 'server' });
  try {
    assert.notEqual((await server.shellLink('/etc/hosts')).status, 201, 'server profile has no shell channel');
    const info = await server.call('host.info');
    assert.equal(info.capabilities['projects.linkedMedia'], false);
    assert.equal(info.capabilities.projects, true);
  } finally { await server.close(); }
});

test('F-0002/AC-7: a moved or replaced linked file reads as missing', async () => {
  const host = await setup();
  const media = join(host.home, 'clip.mp4');
  await writeFile(media, Buffer.alloc(2048, 1));
  try {
    const { mediaRef } = await (await host.shellLink(media)).json();
    const { projectId } = await host.call('projects.create', { name: 'c', videoName: 'clip.mp4', media: { mediaRef } });
    // Same size, new content and a touched mtime: the fingerprint catches it.
    await writeFile(media, Buffer.alloc(2048, 2)); const later = new Date(Date.now() + 5000); await utimes(media, later, later);
    assert.equal((await host.call('projects.open', { projectId })).media.status, 'missing');
    await rm(media);
    assert.equal((await host.call('projects.list'))[0].mediaMissing, true);
    assert.equal((await host.call('projects.open', { projectId })).media.status, 'missing');
  } finally { await host.close(); }
});

test('F-0002/AC-8: a newer format is listed but never opened or rewritten; a stray .tmp does not break reading', async () => {
  const host = await setup();
  try {
    const assetId = await host.upload('x');
    const { projectId } = await host.call('projects.create', { name: '新版', videoName: 'n.mp4', media: { assetId } });
    const file = join(host.home, 'projects', projectId, 'project.json');
    await writeFile(`${file}.dead.tmp`, '{"half');
    assert.equal((await host.call('projects.open', { projectId })).status, 'ok');
    const newer = { ...JSON.parse(await readFile(file, 'utf8')), formatVersion: 99 };
    await writeFile(file, JSON.stringify(newer)); const before = (await stat(file)).mtimeMs;
    assert.deepEqual(await host.call('projects.open', { projectId }), { status: 'newer-version', name: '新版' });
    const [item] = await host.call('projects.list');
    assert.equal(item.newerVersion, true);
    await assert.rejects(host.call('projects.saveTranscript', { projectId, videoId: newer.videos[0].id, transcript }));
    assert.equal((await stat(file)).mtimeMs, before); assert.equal(JSON.parse(await readFile(file, 'utf8')).formatVersion, 99);
  } finally { await host.close(); }
});

test('F-0002/AC-8: migrations run step by step and refuse gaps', () => {
  const table = { 1: (raw: any) => ({ ...raw, renamed: raw.old }), 2: (raw: any) => ({ ...raw, third: true }) };
  assert.deepEqual(migrateProject({ formatVersion: 1, old: 'x' }, table, 3), { formatVersion: 3, old: 'x', renamed: 'x', third: true });
  assert.throws(() => migrateProject({ formatVersion: 1 }, {}, 2), /迁移/);
  assert.throws(() => migrateProject({ formatVersion: 3, name: 'n' }, table, 2), /更新/);
});

const edits = (text: string) => ({ chunks: [{ id: 's1', text, timestamp: [0, 1] }, { id: 's2', text: '世界', timestamp: [1, 2], deleted: true }],
  deletedWordIds: ['w1'], stylePair: { primary: { aspectPreset: '9:16' }, secondary: {} } });

test('F-0002/AC-3 AC-5: autosaved edits come back on open without touching the transcript', async () => {
  const host = await setup();
  try {
    const assetId = await host.upload('x');
    const { projectId, videoId } = await host.call('projects.create', { name: 'e', videoName: 'e.mp4', media: { assetId } });
    const saved = await host.call('projects.saveTranscript', { projectId, videoId, transcript });
    const transcriptFile = join(host.home, 'projects', projectId, 'videos', videoId, 'transcript.json');
    const before = (await stat(transcriptFile)).mtimeMs;
    const result = await host.call('projects.saveEdits', { projectId, videoId, edits: edits('你好！'), baseRevision: saved.revision });
    assert.equal(result.status, 'saved'); assert.equal(result.revision, saved.revision + 1);
    const opened = await host.call('projects.open', { projectId });
    assert.equal(opened.edits.chunks[0].text, '你好！'); assert.equal(opened.edits.chunks[1].deleted, true);
    assert.deepEqual(opened.edits.deletedWordIds, ['w1']); assert.equal(opened.edits.stylePair.primary.aspectPreset, '9:16');
    assert.equal(opened.transcript.chunks[0].text, '你好', 'the transcript itself is untouched');
    assert.equal((await stat(transcriptFile)).mtimeMs, before);
  } finally { await host.close(); }
});

test('F-0002/AC-9 AC-25: a stale baseRevision is a conflict; force overwrites; save as new keeps both versions', async () => {
  const host = await setup();
  try {
    const assetId = await host.upload('x');
    const { projectId, videoId } = await host.call('projects.create', { name: '冲突', videoName: 'c.mp4', media: { assetId } });
    const base = (await host.call('projects.saveTranscript', { projectId, videoId, transcript })).revision;
    // Window A saves first.
    const a = await host.call('projects.saveEdits', { projectId, videoId, edits: edits('A 的版本'), baseRevision: base });
    // Window B still holds `base`: nothing is written.
    const b = await host.call('projects.saveEdits', { projectId, videoId, edits: edits('B 的版本'), baseRevision: base });
    assert.deepEqual(b, { status: 'conflict', revision: a.revision, updatedAt: a.updatedAt });
    assert.equal((await host.call('projects.open', { projectId })).edits.chunks[0].text, 'A 的版本');

    const copy = await host.call('projects.duplicate', { projectId, videoId, name: '冲突（副本）', edits: edits('B 的版本') });
    assert.notEqual(copy.projectId, projectId); assert.equal(copy.videoId, videoId);
    const copied = await host.call('projects.open', { projectId: copy.projectId });
    assert.equal(copied.project.name, '冲突（副本）'); assert.equal(copied.edits.chunks[0].text, 'B 的版本');
    assert.equal(copied.transcript.chunks.length, 2); assert.equal(copied.media.status, 'ok', 'stored media is copied');
    assert.equal((await host.call('projects.open', { projectId })).edits.chunks[0].text, 'A 的版本', 'original unchanged');

    const forced = await host.call('projects.saveEdits', { projectId, videoId, edits: edits('B 覆盖'), baseRevision: base, force: true });
    assert.equal(forced.status, 'saved');
    assert.equal((await host.call('projects.open', { projectId })).edits.chunks[0].text, 'B 覆盖');
    assert.equal((await host.call('projects.list')).length, 2);
  } finally { await host.close(); }
});

test('F-0002/AC-7: choosing the file again restores playback and keeps the edits', async () => {
  const host = await setup();
  const media = join(host.home, 'moved.mp4');
  await writeFile(media, Buffer.alloc(2048, 1));
  try {
    const { mediaRef } = await (await host.shellLink(media)).json();
    const { projectId, videoId } = await host.call('projects.create', { name: 'm', videoName: 'moved.mp4', media: { mediaRef } });
    const base = (await host.call('projects.saveTranscript', { projectId, videoId, transcript })).revision;
    await host.call('projects.saveEdits', { projectId, videoId, edits: edits('改过'), baseRevision: base });
    const moved = join(host.home, 'new-place.mp4');
    await writeFile(moved, Buffer.alloc(2048, 1)); await rm(media);
    assert.equal((await host.call('projects.open', { projectId })).media.status, 'missing');
    const { mediaRef: again } = await (await host.shellLink(moved)).json();
    const relinked = await host.call('projects.relinkMedia', { projectId, videoId, media: { mediaRef: again } });
    assert.equal(relinked.status, 'saved');
    const opened = await host.call('projects.open', { projectId });
    assert.deepEqual(opened.media, { status: 'ok', name: 'new-place.mp4', playback: { kind: 'path', path: moved } });
    assert.equal(opened.edits.chunks[0].text, '改过');
  } finally { await host.close(); }
});

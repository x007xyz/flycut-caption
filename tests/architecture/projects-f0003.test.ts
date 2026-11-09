// F-0003 Host side: project management, several videos per project, Trash and format 2 (ADR-0003).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHost } from '../../server/app';
import type { ProjectsConfig } from '../../server/plugins/projects';

const TOKEN = 'test-credential';
const SHELL = 'shell-secret';
const transcript = { text: '你好 世界', language: 'zh', duration: 4,
  chunks: [{ id: 's1', text: '你好', timestamp: [0, 1] }, { id: 's2', text: '世界', timestamp: [1, 2] }] };
const style = (color: string) => ({ primary: { color, aspectPreset: 'landscape' }, secondary: { color: '#fff' } });
const edits = (text: string, extra: Record<string, unknown> = {}) => ({ chunks: [{ id: 's1', text, timestamp: [0, 1] }], deletedWordIds: [], ...extra });

async function setup(options: { home?: string; projects?: ProjectsConfig; profile?: string } = {}) {
  const home = options.home ?? await mkdtemp(join(tmpdir(), 'flycut-f0003-'));
  const ctx = await createHost({ home, token: TOKEN, port: 0, resourceRoot: resolve('.'), shellToken: SHELL }, { profile: options.profile ?? 'desktop',
    providers: [], patches: options.projects ? [{ source: 'test', patch: { config: { projects: options.projects } } }] : [] });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const call = async <T = any>(method: string, payload: unknown = {}): Promise<T> => {
    const response = await fetch(`${base}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r', method, payload }) });
    const envelope = await response.json();
    if (!envelope.result.ok) throw new Error(envelope.result.error.message);
    return envelope.result.value;
  };
  const upload = async (body: string) => (await (await fetch(`${base}/assets`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body })).json()).assetId as string;
  const link = async (path: string) => (await (await fetch(`${base}/shell/projects/media`, { method: 'POST',
    headers: { Authorization: `Bearer ${SHELL}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) })).json()).mediaRef as string;
  const media = (path: string) => fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  /** A project with one uploaded video and a transcript. */
  const project = async (name = '口播') => {
    const created = await call('projects.create', { name, videoName: `${name}.mp4`, durationSeconds: 4, media: { assetId: await upload('video-bytes'), mimeType: 'video/mp4' } });
    await call('projects.saveTranscript', { projectId: created.projectId, videoId: created.videoId, transcript });
    return created as { projectId: string; videoId: string };
  };
  return { home, ctx, call, upload, link, media, project,
    async stop() { await ctx.fiber.dispose(); },
    async close() { await ctx.fiber.dispose(); if (!options.home) await rm(home, { recursive: true, force: true }); } };
}

const projectDir = (home: string, id: string) => join(home, 'projects', id);
const exists = (path: string) => stat(path).then(() => true, () => false);

test('F-0003/AC-1: an empty project exists on the Host, is listed with no videos and opens as a detail page', async () => {
  const host = await setup();
  try {
    const { projectId } = await host.call('projects.createEmpty', { name: '未命名项目' });
    const second = await host.call('projects.createEmpty', { name: '未命名项目' });
    assert.notEqual(second.projectId, projectId, 'duplicate names are allowed');
    const item = (await host.call('projects.list')).find((entry: any) => entry.id === projectId);
    assert.deepEqual({ name: item.name, videoCount: item.videoCount, durationSeconds: item.durationSeconds, videoId: item.videoId },
      { name: '未命名项目', videoCount: 0, durationSeconds: 0, videoId: undefined });
    const detail = await host.call('projects.detail', { projectId });
    assert.equal(detail.status, 'ok'); assert.deepEqual(detail.videos, []);
    await assert.rejects(host.call('projects.open', { projectId }), /没有这个视频/);
  } finally { await host.close(); }
});

test('F-0003/AC-2: rename trims, validates and only changes the name and modification time', async () => {
  const host = await setup();
  try {
    const { projectId, videoId } = await host.project();
    const before = await host.call('projects.open', { projectId });
    await new Promise(done => setTimeout(done, 5));
    const renamed = await host.call('projects.rename', { projectId, name: '  第 12 期 · 剪辑工作流  ' });
    assert.equal(renamed.status, 'saved');
    const after = await host.call('projects.open', { projectId, videoId });
    assert.equal(after.project.name, '第 12 期 · 剪辑工作流');
    assert.notEqual(after.project.updatedAt, before.project.updatedAt);
    assert.deepEqual(after.transcript, before.transcript);
    assert.deepEqual(after.project.videos, before.project.videos);
    await assert.rejects(host.call('projects.rename', { projectId, name: '   ' }));
    await assert.rejects(host.call('projects.rename', { projectId, name: 'x'.repeat(201) }));
    await host.call('projects.rename', { projectId, name: 'x'.repeat(200) });
  } finally { await host.close(); }
});

test('F-0003/AC-3 AC-4 AC-15: Trash hides a project from every reader and writer; restore brings back the same data', async () => {
  const host = await setup();
  try {
    const { projectId, videoId } = await host.project();
    const saved = await host.call('projects.saveVideoEdits', { projectId, videoId, edits: edits('改过', { aspectPreset: 'portrait' }), styleSource: 'project', baseRevision: 0 });
    assert.equal(saved.status, 'saved');
    const before = await host.call('projects.open', { projectId });
    const trashed = await host.call('projects.trash', { projectId });
    assert.ok(Date.parse(trashed.purgeAfter) - Date.parse(trashed.deletedAt) >= 30 * 86400_000 - 1000, 'kept 30 days');
    assert.deepEqual(await host.call('projects.trash', { projectId }), trashed, 'trashing twice changes nothing');

    assert.deepEqual(await host.call('projects.list'), []);
    const [row] = await host.call('projects.trashList');
    assert.deepEqual({ id: row.id, name: row.name, videoCount: row.videoCount, deletedAt: row.deletedAt }, { id: projectId, name: '口播', videoCount: 1, deletedAt: trashed.deletedAt });
    assert.deepEqual(await host.call('projects.open', { projectId }), { status: 'trashed', name: '口播' });
    assert.deepEqual(await host.call('projects.detail', { projectId }), { status: 'trashed', name: '口播' });
    assert.equal((await host.media(before.media.playback.path)).status, 404, 'no playback from Trash');
    // AC-15: nothing is written into a project in Trash
    const edited = await readFile(join(projectDir(host.home, projectId), 'videos', videoId, 'edits.json'), 'utf8');
    assert.deepEqual(await host.call('projects.saveVideoEdits', { projectId, videoId, edits: edits('另一个窗口'), styleSource: 'project', baseRevision: 1 }), { status: 'trashed' });
    assert.deepEqual(await host.call('projects.saveProjectStyle', { projectId, style: style('#f00'), baseRevision: 0 }), { status: 'trashed' });
    await assert.rejects(host.call('projects.rename', { projectId, name: 'x' }), /回收站/);
    await assert.rejects(host.call('projects.addVideo', { projectId, videoName: 'b.mp4', media: { assetId: await host.upload('b'), mimeType: 'video/mp4' } }), /回收站/);
    assert.equal(await readFile(join(projectDir(host.home, projectId), 'videos', videoId, 'edits.json'), 'utf8'), edited);

    await host.call('projects.restore', { projectId });
    await host.call('projects.restore', { projectId });
    assert.deepEqual(await host.call('projects.trashList'), []);
    const after = await host.call('projects.open', { projectId });
    assert.deepEqual({ transcript: after.transcript, edits: after.edits, videos: after.project.videos },
      { transcript: before.transcript, edits: before.edits, videos: before.project.videos });
    assert.equal((await host.media(after.media.playback.path)).status, 200);
    assert.equal((await host.call('projects.list'))[0].updatedAt, before.project.updatedAt, 'Trash and restore are not edits');
  } finally { await host.close(); }
});

test('F-0003/AC-5 AC-24: permanent delete removes Host data and stored media, never the user\'s original or symlink targets', async () => {
  const host = await setup();
  const outside = await mkdtemp(join(tmpdir(), 'flycut-f0003-originals-'));
  try {
    const original = join(outside, '原片.mp4'); await writeFile(original, 'original-bytes');
    const precious = join(outside, 'precious.txt'); await writeFile(precious, 'keep me');
    const { projectId } = await host.call('projects.createEmpty', { name: '混合' });
    await host.call('projects.addVideo', { projectId, videoName: '原片.mp4', media: { mediaRef: await host.link(original) } });
    await host.call('projects.addVideo', { projectId, videoName: 'upload.mp4', media: { assetId: await host.upload('uploaded'), mimeType: 'video/mp4' } });
    // Even a symbolic link that found its way into the project folder must not lead the delete outside.
    await symlink(precious, join(projectDir(host.home, projectId), 'link-to-outside'));
    await symlink(outside, join(projectDir(host.home, projectId), 'dir-link'));
    await assert.rejects(host.call('projects.purge', { projectId }), /回收站/, 'only projects in Trash');
    assert.ok(await exists(projectDir(host.home, projectId)));

    await host.call('projects.trash', { projectId });
    await host.call('projects.purge', { projectId });
    assert.equal(await exists(projectDir(host.home, projectId)), false);
    assert.deepEqual((await readdir(join(host.home, 'projects'))).filter(name => !name.startsWith('.')), []);
    assert.equal(await readFile(original, 'utf8'), 'original-bytes');
    assert.equal(await readFile(precious, 'utf8'), 'keep me');
    assert.deepEqual((await readdir(outside)).sort(), ['precious.txt', '原片.mp4']);
    assert.deepEqual(await host.call('projects.saveProjectStyle', { projectId, style: style('#f00'), baseRevision: 0 }), { status: 'deleted' });
    await assert.rejects(host.call('projects.restore', { projectId }), /彻底删除/);
  } finally { await host.close(); await rm(outside, { recursive: true, force: true }); }
});

test('F-0003/AC-24: Empty Trash deletes the rows the user saw and reports failures; projects trashed later stay', async () => {
  const host = await setup();
  try {
    const a = await host.project('a'); const b = await host.project('b'); const c = await host.project('c');
    await host.call('projects.trash', { projectId: a.projectId }); await host.call('projects.trash', { projectId: b.projectId });
    const seen = (await host.call('projects.trashList')).map((row: any) => row.id);
    await host.call('projects.trash', { projectId: c.projectId });
    await host.call('projects.restore', { projectId: b.projectId });
    const result = await host.call('projects.emptyTrash', { projectIds: [...seen, randomUUID()] });
    assert.deepEqual(result.failed, []);
    assert.ok(result.purged.includes(a.projectId));
    assert.ok(!result.purged.includes(b.projectId), 'restored meanwhile: kept');
    assert.ok(!result.purged.includes(c.projectId), 'trashed after the user looked: kept');
    assert.deepEqual((await host.call('projects.trashList')).map((row: any) => row.id), [c.projectId]);
    assert.deepEqual((await host.call('projects.list')).map((row: any) => row.id), [b.projectId]);
  } finally { await host.close(); }
});

test('F-0003/AC-5: expired projects are deleted while the Host runs and on start; an interrupted delete finishes on start', async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0003-expiry-'));
  // About 0.4 s in Trash, checked every 100 ms: the maintainer's "shorten the retention to simulate" (AC-5).
  let host = await setup({ home, projects: { trashRetentionHours: 0.4 / 3600, purgeIntervalMs: 100 } });
  try {
    const kept = await host.project('kept'); const expired = await host.project('expired'); const restored = await host.project('restored');
    await host.call('projects.trash', { projectId: expired.projectId });
    await host.call('projects.trash', { projectId: restored.projectId });
    await host.call('projects.restore', { projectId: restored.projectId });
    for (let i = 0; i < 50 && await exists(projectDir(home, expired.projectId)); i++) await new Promise(done => setTimeout(done, 50));
    assert.equal(await exists(projectDir(home, expired.projectId)), false, 'deleted after the retention');
    assert.ok(await exists(projectDir(home, kept.projectId)));
    assert.ok(await exists(projectDir(home, restored.projectId)), 'restored before expiry: kept');
    await host.stop();

    // Trashed while the Host was off, and a delete that was cut off half way.
    host = await setup({ home, projects: { trashRetentionHours: 0, purgeIntervalMs: 3600_000 } });
    await host.call('projects.trash', { projectId: kept.projectId });
    await host.stop();
    const halfDeleted = join(home, 'projects', `.purge-${randomUUID()}-x`);
    await mkdir(join(halfDeleted, 'videos'), { recursive: true });
    host = await setup({ home, projects: { trashRetentionHours: 0, purgeIntervalMs: 3600_000 } });
    assert.equal(await exists(projectDir(home, kept.projectId)), false, 'expired while the Host was off: deleted on start');
    assert.equal(await exists(halfDeleted), false);
    assert.deepEqual((await host.call('projects.list')).map((row: any) => row.id), [restored.projectId]);
  } finally { await host.close(); await rm(home, { recursive: true, force: true }); }
});

test('F-0003/AC-8 AC-11: videos are added one by one, a failed add leaves nothing, removing deletes only Host copies', async () => {
  const host = await setup();
  const outside = await mkdtemp(join(tmpdir(), 'flycut-f0003-linked-'));
  try {
    const { projectId } = await host.call('projects.createEmpty', { name: '系列' });
    const first = await host.call('projects.addVideo', { projectId, videoName: '开场.mp4', durationSeconds: 30, media: { assetId: await host.upload('one'), mimeType: 'video/mp4' } });
    const original = join(outside, '正文.mov'); await writeFile(original, 'linked');
    const second = await host.call('projects.addVideo', { projectId, videoName: '正文.mov', durationSeconds: 90, media: { mediaRef: await host.link(original) } });
    await assert.rejects(host.call('projects.addVideo', { projectId, videoName: '坏.mp4', media: { assetId: randomUUID(), mimeType: 'video/mp4' } }));
    await assert.rejects(host.call('projects.addVideo', { projectId, videoName: '坏.mp4', media: { mediaRef: randomUUID() } }), /重新选择/);

    let detail = await host.call('projects.detail', { projectId });
    assert.deepEqual(detail.videos.map((video: any) => [video.name, video.hasTranscript, video.styleSource, video.mediaMissing]),
      [['开场.mp4', false, 'project', false], ['正文.mov', false, 'project', false]]);
    assert.equal((await host.call('projects.list'))[0].durationSeconds, 120, 'card duration is the sum');
    assert.equal((await host.call('projects.list'))[0].videoCount, 2);
    const videoDirs = await readdir(join(projectDir(host.home, projectId), 'videos'));
    assert.deepEqual(videoDirs.sort(), [first.videoId, second.videoId].sort(), 'no half-added video');

    const opened = await host.call('projects.open', { projectId, videoId: second.videoId });
    assert.deepEqual(opened.videos.map((video: any) => video.id), [first.videoId, second.videoId]);

    await host.call('projects.removeVideo', { projectId, videoId: first.videoId });
    assert.deepEqual(await readdir(join(projectDir(host.home, projectId), 'media')), [], 'stored copy deleted');
    await host.call('projects.removeVideo', { projectId, videoId: second.videoId });
    assert.equal(await readFile(original, 'utf8'), 'linked', 'the original file stays');
    detail = await host.call('projects.detail', { projectId });
    assert.deepEqual(detail.videos, [], 'the last video goes, the project stays');
    assert.deepEqual(await readdir(join(projectDir(host.home, projectId), 'videos')), []);
    await assert.rejects(host.call('projects.removeVideo', { projectId, videoId: second.videoId }), /没有这个视频/);
    assert.deepEqual(await host.call('projects.saveVideoEdits', { projectId, videoId: second.videoId, edits: edits('x'), styleSource: 'project', baseRevision: 0 }),
      { status: 'video-missing' });
  } finally { await host.close(); await rm(outside, { recursive: true, force: true }); }
});

test('F-0003/AC-14: two windows editing different videos both save; the same video or the project style is a conflict', async () => {
  const host = await setup();
  try {
    const { projectId, videoId: one } = await host.project();
    const { videoId: two } = await host.call('projects.addVideo', { projectId, videoName: 'b.mp4', media: { assetId: await host.upload('b'), mimeType: 'video/mp4' } });
    // Window A edits video one, window B video two, at the same moment, each from what it opened.
    const [a, b] = await Promise.all([
      host.call('projects.saveVideoEdits', { projectId, videoId: one, edits: edits('A 改的'), styleSource: 'project', baseRevision: 0 }),
      host.call('projects.saveVideoEdits', { projectId, videoId: two, edits: edits('B 改的'), styleSource: 'project', baseRevision: 0 }),
    ]);
    assert.deepEqual([a.status, b.status], ['saved', 'saved']);
    assert.equal((await host.call('projects.open', { projectId, videoId: one })).edits.chunks[0].text, 'A 改的');
    assert.equal((await host.call('projects.open', { projectId, videoId: two })).edits.chunks[0].text, 'B 改的');

    // Same video from a stale revision: conflict, nothing written; force writes.
    const stale = await host.call('projects.saveVideoEdits', { projectId, videoId: one, edits: edits('B 也改了一'), styleSource: 'project', baseRevision: 0 });
    assert.equal(stale.status, 'conflict'); assert.equal(stale.revision, 1);
    assert.equal((await host.call('projects.open', { projectId, videoId: one })).edits.chunks[0].text, 'A 改的');
    assert.equal((await host.call('projects.saveVideoEdits', { projectId, videoId: one, edits: edits('覆盖'), styleSource: 'project', baseRevision: 0, force: true })).status, 'saved');

    // Project style: A saves, B saves from the old style revision.
    assert.equal((await host.call('projects.saveProjectStyle', { projectId, style: style('#f00'), baseRevision: 0 })).status, 'saved');
    const styleConflict = await host.call('projects.saveProjectStyle', { projectId, style: style('#0f0'), baseRevision: 0 });
    assert.equal(styleConflict.status, 'conflict');
    assert.deepEqual((await host.call('projects.open', { projectId, videoId: two })).projectStyle, style('#f00'));
    // A video save does not move the style revision, nor the other way round.
    const styleAgain = await host.call('projects.saveProjectStyle', { projectId, style: style('#00f'), baseRevision: 1 });
    assert.equal(styleAgain.status, 'saved');
    assert.equal((await host.call('projects.saveVideoEdits', { projectId, videoId: two, edits: edits('B 再改'), styleSource: 'project', baseRevision: 1 })).status, 'saved');
  } finally { await host.close(); }
});

test('F-0003/AC-12 AC-13: videos follow the project style; a custom video keeps its own; the aspect stays per video', async () => {
  const host = await setup();
  try {
    const { projectId, videoId: one } = await host.project();
    const { videoId: two } = await host.call('projects.addVideo', { projectId, videoName: 'b.mp4', media: { assetId: await host.upload('b'), mimeType: 'video/mp4' } });
    await host.call('projects.saveProjectStyle', { projectId, style: style('#f00'), baseRevision: 0 });
    await host.call('projects.saveVideoEdits', { projectId, videoId: one, styleSource: 'custom', baseRevision: 0,
      edits: edits('a', { stylePair: style('#0f0'), aspectPreset: 'portrait' }) });
    // A following video's own style is not kept: only the aspect.
    await host.call('projects.saveVideoEdits', { projectId, videoId: two, styleSource: 'project', baseRevision: 0,
      edits: edits('b', { stylePair: style('#00f'), aspectPreset: 'square' }) });
    const a = await host.call('projects.open', { projectId, videoId: one });
    const b = await host.call('projects.open', { projectId, videoId: two });
    assert.deepEqual([a.video.styleSource, a.edits.stylePair, a.edits.aspectPreset], ['custom', style('#0f0'), 'portrait']);
    assert.deepEqual([b.video.styleSource, b.edits.stylePair, b.edits.aspectPreset], ['project', undefined, 'square']);
    assert.deepEqual(a.projectStyle, style('#f00'));
    // Follow the project again: the video's own style is dropped.
    await host.call('projects.saveVideoEdits', { projectId, videoId: one, styleSource: 'project', baseRevision: 1, edits: edits('a', { stylePair: style('#0f0'), aspectPreset: 'portrait' }) });
    const back = await host.call('projects.open', { projectId, videoId: one });
    assert.deepEqual([back.video.styleSource, back.edits.stylePair, back.edits.aspectPreset], ['project', undefined, 'portrait']);
  } finally { await host.close(); }
});

/** A project exactly as F-0002 (format 1) wrote it. */
async function writeFormat1(home: string) {
  const projectId = randomUUID(); const videoId = randomUUID(); const dir = projectDir(home, projectId);
  await mkdir(join(dir, 'videos', videoId), { recursive: true }); await mkdir(join(dir, 'media'));
  await writeFile(join(dir, 'media', `${videoId}.mp4`), 'v1-media');
  const project = { formatVersion: 1, id: projectId, name: '旧项目', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z', revision: 7,
    videos: [{ id: videoId, name: '旧.mp4', durationSeconds: 4, createdAt: '2026-11-01T00:00:00.000Z', hasTranscript: true,
      media: { kind: 'stored', file: `media/${videoId}.mp4`, size: 8, mimeType: 'video/mp4' } }] };
  await writeFile(join(dir, 'project.json'), JSON.stringify(project));
  await writeFile(join(dir, 'videos', videoId, 'transcript.json'), JSON.stringify(transcript));
  const v1Edits = { chunks: [{ id: 's1', text: '旧的修改', timestamp: [0, 1], deleted: true, secondText: 'old edit' }], deletedWordIds: ['w1'],
    stylePair: { primary: { color: '#123456', aspectPreset: 'portrait' }, secondary: { color: '#abcdef', aspectPreset: 'landscape' } } };
  await writeFile(join(dir, 'videos', videoId, 'edits.json'), JSON.stringify(v1Edits));
  return { projectId, videoId, dir, project, v1Edits };
}

test('F-0003/AC-16 AC-12: a format-1 project opens with nothing lost; its style becomes the project style; the first write keeps a backup', async () => {
  const host = await setup();
  try {
    const { projectId, videoId, dir, project, v1Edits } = await writeFormat1(host.home);
    const raw = await readFile(join(dir, 'project.json'), 'utf8');
    const opened = await host.call('projects.open', { projectId });
    assert.equal(opened.status, 'ok');
    assert.equal(opened.media.status, 'ok');
    const { editing, ...unchangedEdits } = opened.edits;
    assert.deepEqual(unchangedEdits, v1Edits, 'subtitles, deletions, translations, style and aspect');
    assert.equal(editing.edl.origin, 'legacy-export');
    assert.deepEqual(editing.history, [], 'migration does not invent user history');
    assert.deepEqual(opened.transcript.chunks, transcript.chunks);
    assert.deepEqual(opened.projectStyle, { primary: v1Edits.stylePair.primary, secondary: v1Edits.stylePair.secondary });
    assert.deepEqual([opened.video.styleSource, opened.video.revision], ['project', 0]);
    assert.equal(await readFile(join(dir, 'project.json'), 'utf8'), raw, 'reading never writes');
    assert.equal((await host.call('projects.list'))[0].durationSeconds, 4);

    // A second video added to the old project follows the style that came from format 1.
    const { videoId: two } = await host.call('projects.addVideo', { projectId, videoName: 'new.mp4', media: { assetId: await host.upload('n'), mimeType: 'video/mp4' } });
    const upgraded = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'));
    assert.equal(upgraded.formatVersion, 3);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'project.v1.json'), 'utf8')), project, 'the format-1 file is kept');
    assert.deepEqual((await host.call('projects.open', { projectId, videoId: two })).projectStyle, opened.projectStyle);
    // Removing the video the style came from keeps the style.
    await host.call('projects.removeVideo', { projectId, videoId });
    assert.deepEqual((await host.call('projects.open', { projectId, videoId: two })).projectStyle, opened.projectStyle);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'project.json'), 'utf8')).style, opened.projectStyle);
  } finally { await host.close(); }
});

test('F-0003/AC-32: save as new after a permanent delete keeps subtitles, edits and style; media reads as missing', async () => {
  const host = await setup();
  try {
    const { projectId, videoId } = await host.call('projects.createFromSnapshot', { name: '口播（副本）', videoName: '开场.mp4', durationSeconds: 4,
      transcript, edits: edits('保住的修改', { aspectPreset: 'portrait', stylePair: style('#0f0') }), styleSource: 'project', style: style('#f00') });
    const opened = await host.call('projects.open', { projectId, videoId });
    assert.equal(opened.media.status, 'missing', 'the original media went with the deleted project');
    assert.equal(opened.video.hasTranscript, true);
    assert.deepEqual(opened.transcript.chunks, transcript.chunks);
    assert.deepEqual([opened.edits.chunks[0].text, opened.edits.aspectPreset, opened.edits.stylePair], ['保住的修改', 'portrait', undefined]);
    assert.deepEqual(opened.projectStyle, style('#f00'));
    assert.equal(JSON.stringify(opened).includes('path'), false, 'no local path anywhere');
  } finally { await host.close(); }
});

test('F-0005/AC-7 AC-10 format migration is repeatable, keeps raw files and rejects unknown or mismatched EDL', async () => {
  const host = await setup();
  try {
    const { projectId, videoId, dir, v1Edits } = await writeFormat1(host.home);
    const rawTranscript = await readFile(join(dir, 'videos', videoId, 'transcript.json'), 'utf8');
    const beforeEdits = await readFile(join(dir, 'videos', videoId, 'edits.json'), 'utf8');
    const first = await host.call('projects.open', { projectId, videoId });
    for (let i = 0; i < 3; i++) assert.deepEqual((await host.call('projects.open', { projectId, videoId })).edits.editing, first.edits.editing);
    assert.equal(await readFile(join(dir, 'videos', videoId, 'edits.json'), 'utf8'), beforeEdits, 'opening is read-only');
    const saved = await host.call('projects.saveVideoEdits', { projectId, videoId, baseRevision: 0, styleSource: 'project', edits: { ...v1Edits, editing: first.edits.editing } });
    assert.equal(saved.status, 'saved');
    assert.equal(await exists(join(dir, 'project.v1.json')), true);
    for (let i = 0; i < 3; i++) assert.deepEqual((await host.call('projects.open', { projectId, videoId })).edits.editing, first.edits.editing);
    const stable = await readFile(join(dir, 'videos', videoId, 'edits.json'), 'utf8');
    for (const patch of [{ version: 99 }, { sourceDurationUs: 5e6 }, { deleted: [{ startUs: 0, endUs: 5e6 }] }]) {
      await assert.rejects(host.call('projects.saveVideoEdits', { projectId, videoId, baseRevision: saved.revision, styleSource: 'project',
        edits: { ...v1Edits, editing: { ...first.edits.editing, edl: { ...first.edits.editing.edl, ...patch } } } }));
      assert.equal(await readFile(join(dir, 'videos', videoId, 'edits.json'), 'utf8'), stable);
    }
    assert.equal(await readFile(join(dir, 'videos', videoId, 'transcript.json'), 'utf8'), rawTranscript);
  } finally { await host.close(); }
});

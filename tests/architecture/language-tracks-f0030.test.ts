// F-0030 Host contract: format-4 language tracks and lossless secondText migration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHost } from '../../server/app';
import { createEdl } from '../../shared/editing/edl';
import { LEGACY_LANGUAGE_TRACK_ID, languageTrackCounts, projectLanguageTrack } from '../../shared/languageTracks';
import { PROJECT_FORMAT_VERSION } from '../../shared/projects';
import { chunksToSrt } from '../../src/subtitle/exportFormats.ts';
import { defaultSubtitleStylePair } from '../../src/subtitle/subtitleStyle.ts';
import { diffWithHost } from '../../src/recovery/copy.ts';

const TOKEN = 'test-credential';
const transcript = {
  text: '你好 世界',
  language: 'zh',
  duration: 4,
  chunks: [
    { id: 's1', text: '你好', timestamp: [0, 1] as [number, number] },
    { id: 's2', text: '世界', timestamp: [1, 2] as [number, number] },
  ],
};

async function setup(inputHome?: string) {
  const home = inputHome ?? await mkdtemp(join(tmpdir(), 'flycut-f0030-'));
  const ctx = await createHost({ home, token: TOKEN, port: 0, resourceRoot: resolve('.'), shellToken: 'shell' }, { profile: 'desktop', providers: [] });
  const address = ctx.httpServer.address() as { port: number };
  const call = async <T = any>(method: string, payload: unknown = {}): Promise<T> => {
    const response = await fetch(`http://127.0.0.1:${address.port}/rpc`, { method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'f0030', method, payload }) });
    const envelope = await response.json();
    if (!envelope.result.ok) throw new Error(envelope.result.error.message);
    return envelope.result.value;
  };
  const upload = async (body: string) => (await (await fetch(`http://127.0.0.1:${address.port}/assets`,
    { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body })).json()).assetId as string;
  const project = async () => {
    const created = await call('projects.create', { name: '多语言', videoName: 'voice.mp4', durationSeconds: 4,
      media: { assetId: await upload('video'), mimeType: 'video/mp4' } });
    await call('projects.saveTranscript', { projectId: created.projectId, videoId: created.videoId, transcript });
    return created as { projectId: string; videoId: string; revision: number };
  };
  return { home, ctx, call, project };
}

const projectDir = (home: string, id: string) => join(home, 'projects', id);
const track = (id: string, name: string, code: string | null, text: string, sourceText = '你好') => ({
  id, name, languageCode: code, origin: 'manual' as const,
  entries: { s1: { text, sourceText, updatedAt: '2026-11-12T12:00:00.000Z' } },
});

test('F-0030/AC-2 legacy secondText migrates in memory with an unspecified language and keeps existing bilingual export', async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0030-legacy-'));
  const host = await setup(home);
  const projectId = randomUUID(); const videoId = randomUUID();
  const dir = projectDir(home, projectId);
  await mkdir(join(dir, 'videos', videoId), { recursive: true });
  await mkdir(join(dir, 'media'), { recursive: true });
  await writeFile(join(dir, 'media', `${videoId}.mp4`), 'video');
  const project = { formatVersion: 3, id: projectId, name: '旧双语', createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z', revision: 7, styleRevision: 0,
    videos: [{ id: videoId, name: '旧.mp4', durationSeconds: 4, createdAt: '2026-11-01T00:00:00.000Z', hasTranscript: true,
      media: { kind: 'stored', file: `media/${videoId}.mp4`, size: 5, mimeType: 'video/mp4' }, revision: 0, styleSource: 'project' }] };
  const oldEdits = { chunks: [
    { id: 's1', text: '你好', secondText: 'Bonjour', timestamp: [0, 1] },
    { id: 's2', text: '世界', timestamp: [1, 2] },
  ], deletedWordIds: [] };
  await writeFile(join(dir, 'project.json'), JSON.stringify(project));
  await writeFile(join(dir, 'videos', videoId, 'transcript.json'), JSON.stringify(transcript));
  await writeFile(join(dir, 'videos', videoId, 'edits.json'), JSON.stringify(oldEdits));
  const projectRaw = await readFile(join(dir, 'project.json'), 'utf8');
  const editsRaw = await readFile(join(dir, 'videos', videoId, 'edits.json'), 'utf8');
  try {
    const opened = await host.call('projects.open', { projectId, videoId });
    assert.equal(opened.status, 'ok');
    assert.equal(opened.edits.chunks[0].secondText, 'Bonjour');
    assert.equal(opened.edits.chunks[1].secondText, undefined);
    assert.equal(opened.edits.activeLanguageTrackId, LEGACY_LANGUAGE_TRACK_ID);
    assert.deepEqual(opened.edits.languageTracks, [{
      id: LEGACY_LANGUAGE_TRACK_ID, name: 'Legacy translation', languageCode: null, origin: 'legacy-second-text',
      entries: { s1: { text: 'Bonjour', sourceText: '你好', updatedAt: '1970-01-01T00:00:00.000Z' } },
    }]);
    assert.match(chunksToSrt(opened.edits.chunks, 'Bilingual'), /你好\nBonjour/);
    assert.equal(await readFile(join(dir, 'project.json'), 'utf8'), projectRaw, 'opening never writes project.json');
    assert.equal(await readFile(join(dir, 'videos', videoId, 'edits.json'), 'utf8'), editsRaw, 'opening never writes edits.json');

    const saved = await host.call('projects.saveVideoEdits', { projectId, videoId, baseRevision: 0, styleSource: 'project',
      edits: { ...opened.edits, activeLanguageTrackId: LEGACY_LANGUAGE_TRACK_ID } });
    assert.equal(saved.status, 'saved');
    const upgraded = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'));
    assert.equal(upgraded.formatVersion, PROJECT_FORMAT_VERSION);
    assert.equal(PROJECT_FORMAT_VERSION, 4);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'project.v3.json'), 'utf8')), project);
    const reopened = await host.call('projects.open', { projectId, videoId });
    assert.deepEqual(reopened.edits.languageTracks, opened.edits.languageTracks);
    assert.equal(reopened.edits.chunks[0].secondText, 'Bonjour');
  } finally { await host.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }); }
});

test('F-0030/AC-1 AC-4 format-4 tracks persist, share source timing, and a stale client cannot replace another language', async () => {
  const host = await setup();
  try {
    const { projectId, videoId } = await host.project();
    const languageTracks = [track('track-en', 'English', 'en', 'Hello'), track('track-fr', 'Français', 'fr', 'Bonjour')];
    let chunks = projectLanguageTrack(transcript.chunks, languageTracks, 'track-en');
    const edl = createEdl(4);
    const first = await host.call('projects.saveVideoEdits', { projectId, videoId, baseRevision: 0, styleSource: 'project',
      edits: { chunks, deletedWordIds: [], editing: { edl, history: [] }, languageTracks, activeLanguageTrackId: 'track-en' } });
    assert.equal(first.status, 'saved');
    const opened = await host.call('projects.open', { projectId, videoId });
    assert.deepEqual(opened.edits.languageTracks.map((item: any) => item.languageCode), ['en', 'fr']);
    assert.equal(opened.edits.chunks[0].secondText, 'Hello');
    assert.deepEqual(opened.edits.chunks.map((item: any) => item.timestamp), transcript.chunks.map(item => item.timestamp));
    assert.deepEqual(languageTrackCounts(opened.edits.languageTracks[0], opened.edits.chunks), { translated: 1, outdated: 0 });

    const staleTracks = [track('track-en', 'English', 'en', 'Changed'), track('track-fr', 'Français', 'fr', 'Bonjour')];
    chunks = projectLanguageTrack(chunks, staleTracks, 'track-en');
    const stale = await host.call('projects.saveVideoEdits', { projectId, videoId, baseRevision: 0, styleSource: 'project',
      edits: { ...opened.edits, chunks, languageTracks: staleTracks } });
    assert.equal(stale.status, 'conflict');
    const again = await host.call('projects.open', { projectId, videoId });
    assert.equal(again.edits.languageTracks[0].entries.s1.text, 'Hello');
    assert.equal(again.edits.languageTracks[1].entries.s1.text, 'Bonjour');
    assert.equal(again.edits.chunks[0].secondText, 'Hello');

    await assert.rejects(host.call('projects.saveVideoEdits', { projectId, videoId, baseRevision: again.video.revision, styleSource: 'project',
      edits: { ...again.edits, languageTracks: [{ ...again.edits.languageTracks[0],
        entries: { ...again.edits.languageTracks[0].entries, missing: { text: 'x', sourceText: 'x', updatedAt: 'now' } } }],
      activeLanguageTrackId: 'track-en' } }), /unknown subtitle/);
  } finally { await host.ctx.fiber.dispose(); await rm(host.home, { recursive: true, force: true }); }
});

test('F-0030/AC-1 AC-3 editor tracks switch, mark source changes outdated, keep and undo without duplicating time', async () => {
  const { createHistoryStore, editingOf } = await import('../../src/stores/historyStore.ts');
  const { buildEdits } = await import('../../src/services/projectService.ts');
  const store = createHistoryStore();
  const languageTracks = [track('track-en', 'English', 'en', 'Hello'), track('track-fr', 'Français', 'fr', 'Bonjour')];
  store.getState().setTranscript(transcript, languageTracks, 'track-en');
  assert.equal(store.getState().chunks[0].secondText, 'Hello');
  store.getState().selectLanguageTrack('track-fr');
  assert.equal(store.getState().chunks[0].secondText, 'Bonjour');
  store.getState().update('s1', { text: '你好呀' });
  assert.equal(languageTrackCounts(store.getState().languageTracks[1], store.getState().chunks).outdated, 1);
  assert.deepEqual(store.getState().chunks.map(chunk => chunk.timestamp), transcript.chunks.map(chunk => chunk.timestamp));
  store.getState().keepLanguageTranslation('s1');
  assert.equal(store.getState().languageTracks[1].entries.s1.sourceText, '你好呀');
  store.getState().update('s1', { secondText: 'Salut' });
  assert.equal(store.getState().chunks[0].secondText, 'Salut');
  assert.equal(store.getState().languageTracks[1].entries.s1.text, 'Salut');
  store.getState().undo();
  assert.equal(store.getState().chunks[0].secondText, 'Bonjour');
  store.getState().redo();
  store.getState().applyLanguageTranslations({ languageCode: 'de', name: 'Deutsch', updates: [{ id: 's1', text: 'Hallo' }] });
  assert.equal(store.getState().activeLanguageTrackId, store.getState().languageTracks.at(-1)?.id);
  assert.deepEqual(store.getState().languageTracks.at(-1)?.languageCode, 'de');
  assert.equal(store.getState().chunks[0].secondText, 'Hallo');
  const state = store.getState();
  const edits = buildEdits(state.chunks, state.wordChunks, defaultSubtitleStylePair as any, false, editingOf(state), [],
    state.languageTracks, state.activeLanguageTrackId);
  assert.equal(edits.activeLanguageTrackId, state.activeLanguageTrackId);
  assert.equal(edits.languageTracks?.[2].entries.s1.text, 'Hallo');
  assert.deepEqual(edits.chunks.map(chunk => chunk.timestamp), transcript.chunks.map(chunk => chunk.timestamp));
  const content = { editing: edits.editing, chunks: edits.chunks, deletedWordIds: edits.deletedWordIds, languageTracks: edits.languageTracks,
    activeLanguageTrackId: edits.activeLanguageTrackId, styleSource: 'project' as const,
    stylePair: defaultSubtitleStylePair as unknown as Record<string, Record<string, unknown>> };
  const host = { editing: edits.editing, chunks: structuredClone(edits.chunks), deletedWordIds: edits.deletedWordIds,
    languageTracks: structuredClone(edits.languageTracks), activeLanguageTrackId: edits.activeLanguageTrackId, styleSource: 'project' as const,
    effectiveStyle: content.stylePair as any, projectStyle: content.stylePair as any };
  assert.equal(diffWithHost(content, host).same, true);
  content.languageTracks[2].entries.s1.text = 'Different';
  assert.equal(diffWithHost(content, host).video, true);
});

test('F-0030/AC-2 loading an old secondText transcript creates the same explicitly unspecified track in the editor', async () => {
  const { createHistoryStore } = await import('../../src/stores/historyStore.ts');
  const store = createHistoryStore();
  store.getState().setTranscript({ ...transcript, chunks: [{ ...transcript.chunks[0], secondText: 'Bonjour' }, transcript.chunks[1]] });
  assert.equal(store.getState().activeLanguageTrackId, LEGACY_LANGUAGE_TRACK_ID);
  assert.equal(store.getState().languageTracks[0].languageCode, null);
  assert.equal(store.getState().chunks[0].secondText, 'Bonjour');
});


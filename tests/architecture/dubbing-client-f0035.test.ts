import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { createHistoryStore } from '../../src/stores/historyStore';
import { createAppStore } from '../../src/stores/appStore';
import { createProjectStore } from '../../src/stores/projectStore';
import { createConnectionStore } from '../../src/stores/connectionStore';
import type { RuntimeStores } from '../../src/stores/runtimeStore';
import { ProjectService, buildEdits } from '../../src/services/projectService';
import { DubbingService } from '../../src/services/dubbingService';
import { diffWithHost, type HostContent, type RecoveryContent } from '../../src/recovery/copy';
import { defaultSubtitleStylePair } from '../../src/subtitle';
import type { RemoteConnection } from '../../src/runtime/connection';
import type { CueDubbingArtifact } from '../../shared/tts/dubbing';

const PROJ_ID = '00000000-0000-4000-8000-000000000101';
const VID_ID = '00000000-0000-4000-8000-000000000102';
const HOST_ID = '00000000-0000-4000-8000-000000000103';
const DUB_1 = '00000000-0000-4000-8000-000000000201';
const DUB_2 = '00000000-0000-4000-8000-000000000202';
const OP_1 = '00000000-0000-4000-8000-000000000301';

const sampleArtifact = (id = DUB_1, trackId = 'track-en', chunkId = 'c1'): CueDubbingArtifact => ({
  id,
  trackId,
  chunkId,
  file: `dubbing/${id}.wav`,
  mimeType: 'audio/wav',
  format: 'wav',
  byteLength: 12044,
  durationSeconds: 1.25,
  sampleRate: 24000,
  cueDurationSeconds: 2.0,
  text: 'Hello there',
  model: { providerId: 'flycut:tts', modelId: 'kokoro' },
  voiceId: 'af_heart',
  language: 'en',
  speed: 1.0,
  operationId: OP_1,
  createdAt: '2026-11-13T10:00:00.000Z',
});

test('F-0035/AC-3 AC-7 historyStore keeps persisted dubbings across undo/redo and cleans up on track removal', () => {
  const store = createHistoryStore();
  const trackEn = {
    id: 'track-en',
    name: 'English',
    languageCode: 'en',
    origin: 'manual' as const,
    entries: { c1: { text: 'Hello there', sourceText: '你好', updatedAt: '2026-11-13T10:00:00.000Z' } },
  };
  const trackJa = {
    id: 'track-ja',
    name: '日本語',
    languageCode: 'ja',
    origin: 'manual' as const,
    entries: { c1: { text: 'こんにちは', sourceText: '你好', updatedAt: '2026-11-13T10:00:00.000Z' } },
  };
  const artEn = sampleArtifact(DUB_1, 'track-en', 'c1');
  const artJa = sampleArtifact(DUB_2, 'track-ja', 'c1');

  store.getState().setTranscript(
    { text: '你好', language: 'zh', duration: 4, chunks: [{ id: 'c1', text: '你好', timestamp: [0, 2] }] },
    [trackEn, trackJa],
    'track-en',
    [artEn],
  );
  assert.equal(store.getState().dubbings.length, 1);

  store.getState().upsertCueDubbing(artJa);
  assert.equal(store.getState().dubbings.length, 2);

  // Editing subtitle translation & undoing must NOT erase persisted dubbings
  store.getState().update('c1', { secondText: 'Updated hello' });
  assert.equal(store.getState().dubbings.length, 2);
  store.getState().undo();
  assert.equal(store.getState().dubbings.length, 2);

  // Removing a track clears dubbings belonging to that track
  store.getState().removeLanguageTrack('track-en');
  assert.equal(store.getState().dubbings.length, 1);
  assert.equal(store.getState().dubbings[0].trackId, 'track-ja');
});

test('F-0035/AC-7 AC-8 ProjectService recordDubbingSaved, reloadCurrentVideo, DubbingService operation lookup, and recovery diff', async () => {
  const prevStorage = globalThis.localStorage;
  const mem = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
  try {
  const art1 = sampleArtifact(DUB_1, 'track-en', 'c1');
  const trackEn = {
    id: 'track-en',
    name: 'English',
    languageCode: 'en',
    origin: 'manual' as const,
    entries: { c1: { text: 'Hello there', sourceText: '你好', updatedAt: '2026-11-13T10:00:00.000Z' } },
  };
  const updatedTrackEn = {
    ...trackEn,
    entries: { c1: { text: 'Updated on Host', sourceText: '你好', updatedAt: '2026-11-13T10:05:00.000Z' } },
  };
  let openVersion = 1;
  const calls: Array<{ method: string; payload: any }> = [];

  const connection: RemoteConnection = {
    call: (async (method: string, payload?: any) => {
      calls.push({ method, payload });
      if (method === 'projects.identity') return { hostId: HOST_ID, recovery: 1 };
      if (method === 'projects.open') {
        return {
          status: 'ok',
          project: { id: PROJ_ID, name: 'Test', formatVersion: 4, revision: openVersion === 1 ? 5 : 8, styleRevision: 0, videos: [], createdAt: '2026-11-13T10:00:00.000Z', updatedAt: '2026-11-13T10:05:00.000Z' },
          video: { id: VID_ID, name: 'v.mp4', durationSeconds: 4, createdAt: '2026-11-13T10:00:00.000Z', media: { kind: 'stored', file: `media/${VID_ID}.mp4`, size: 1, mimeType: 'video/mp4' }, hasTranscript: true, revision: openVersion === 1 ? 2 : 4, styleSource: 'project' },
          transcript: { text: '你好', language: 'zh', duration: 4, chunks: [{ id: 'c1', text: '你好', timestamp: [0, 2] }] },
          edits: {
            chunks: [{ id: 'c1', text: '你好', timestamp: [0, 2] }],
            deletedWordIds: [],
            languageTracks: [openVersion === 1 ? trackEn : updatedTrackEn],
            activeLanguageTrackId: 'track-en',
            dubbings: openVersion === 1 ? [] : [art1],
          },
          media: { status: 'missing', name: 'v.mp4' },
          videos: [],
        };
      }
      if (method === 'projects.saveVideoEdits') {
        return { status: 'saved', revision: 4, projectRevision: 7, updatedAt: '2026-11-13T10:02:00.000Z' };
      }
      if (method === 'jobs.list') {
        return [
          { id: 'job-op-1', operationId: OP_1, status: 'complete', result: { status: 'saved', artifact: art1, videoRevision: 3, projectRevision: 6, updatedAt: '2026-11-13T10:01:00.000Z' }, createdAt: '', updatedAt: '' },
        ];
      }
      throw new Error(`Unexpected RPC ${method}`);
    }) as RemoteConnection['call'],
    on: () => () => undefined,
    upload: async () => '',
    uploadCapabilities: async () => ({ protocolVersion: 1, chunkSize: 1024, maxBytes: 1024, maxChunks: 1, sessionTtlHours: 1, allowedMimeTypes: [] }),
    createUploadSession: async () => { throw new Error('unused'); },
    getUploadSession: async () => { throw new Error('unused'); },
    putUploadChunk: async () => { throw new Error('unused'); },
    completeUploadSession: async () => { throw new Error('unused'); },
    cancelUploadSession: async () => { throw new Error('unused'); },
    download: async () => new Blob(),
    resourceUrl: path => path,
    waitJob: async () => { throw new Error('unused'); },
    subscribe: () => () => undefined,
    snapshot: () => 'connected',
    isReady: () => true,
    open: async () => { throw new Error('unused'); },
    waitForJobsSnapshot: async () => undefined,
    setRefreshHandler: () => undefined,
    setErrorHandler: () => undefined,
    setSessionExpiry: () => undefined,
    close: () => undefined,
  };

  const stores: RuntimeStores = {
    app: createAppStore(),
    history: createHistoryStore(),
    project: createProjectStore(),
    connection: createConnectionStore(),
  };
  const ctx = new Context() as Context & { connection: RemoteConnection; stores: RuntimeStores };
  ctx.provide('connection', connection);
  ctx.provide('stores', stores);
  const memoryStorage = {
    list: async () => [],
    save: async () => true,
    delete: async () => true,
    clearScope: async () => undefined,
  };
  const service = new ProjectService(ctx, memoryStorage as any);
  await service.open(PROJ_ID, VID_ID);

  assert.equal(stores.project.getState().current?.videoRevision, 2);
  assert.equal(stores.history.getState().dubbings.length, 0);

  // Record dubbing saved from Host -> updates revision + baseline without marking dirty
  service.recordDubbingSaved({
    projectId: PROJ_ID,
    videoId: VID_ID,
    artifact: art1,
    videoRevision: 3,
    projectRevision: 6,
    updatedAt: '2026-11-13T10:01:00.000Z',
  });
  assert.equal(stores.project.getState().current?.videoRevision, 3);
  assert.equal(stores.history.getState().dubbings.length, 1);
  assert.equal(service.hasUnsavedChanges(), false);

  // Subsequent edit + flush preserves dubbings in saveVideoEdits payload
  stores.history.getState().update('c1', { text: '你好呀' });
  assert.equal(await service.flush(), true);
  const saveCall = calls.find(c => c.method === 'projects.saveVideoEdits');
  assert.equal(saveCall?.payload.baseRevision, 3);
  assert.equal(saveCall?.payload.edits.dubbings?.length, 1);

  // DubbingService.findOperationResult looks up operationId on jobs.list
  const dubService = new DubbingService(connection);
  const lookup = await dubService.findOperationResult(OP_1);
  assert.equal(lookup.state, 'complete');
  assert.equal((lookup as any).result.artifact.id, DUB_1);

  // reloadCurrentVideo fetches updated Host translation and dubbings
  openVersion = 2;
  assert.equal(await service.reloadCurrentVideo(), true);
  assert.equal(stores.project.getState().current?.videoRevision, 4);
  assert.equal(stores.history.getState().chunks[0].secondText, 'Updated on Host');

  // Recovery diff detects dubbings mismatch
  const edits = buildEdits(
    stores.history.getState().chunks,
    [],
    defaultSubtitleStylePair,
    false,
    undefined,
    [],
    [updatedTrackEn],
    'track-en',
    [art1],
  );
  assert.equal(edits.dubbings?.length, 1);
  const baseContent: RecoveryContent = {
    chunks: [{ id: 'c1', text: '你好', timestamp: [0, 2] }],
    deletedWordIds: [],
    languageTracks: [updatedTrackEn],
    activeLanguageTrackId: 'track-en',
    dubbings: [art1],
    styleSource: 'project',
    stylePair: defaultSubtitleStylePair as any,
  };
  const hostState: HostContent = {
    chunks: [{ id: 'c1', text: '你好', timestamp: [0, 2] }],
    deletedWordIds: [],
    languageTracks: [updatedTrackEn],
    activeLanguageTrackId: 'track-en',
    dubbings: [],
    styleSource: 'project',
    effectiveStyle: defaultSubtitleStylePair as any,
    projectStyle: defaultSubtitleStylePair as any,
  };
  assert.equal(diffWithHost(baseContent, hostState).video, true);
  assert.equal(diffWithHost(baseContent, { ...hostState, dubbings: [art1] }).same, true);
  } finally {
    (globalThis as any).localStorage = prevStorage;
  }
});

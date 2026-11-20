import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cueDubbingArtifactSchema,
  dubCueInputSchema,
  evaluateCueDubbingStatus,
  pickDefaultOfflineTtsModel,
  removeTrackDubbings,
  upsertCueDubbing,
  validateCueDubbings,
} from '../shared/tts/dubbing.ts';

const ID_1 = '00000000-0000-4000-8000-000000000001';
const ID_2 = '00000000-0000-4000-8000-000000000002';
const PROJ_ID = '00000000-0000-4000-8000-000000000010';
const VID_ID = '00000000-0000-4000-8000-000000000020';
const OP_ID = '00000000-0000-4000-8000-000000000030';

const baseArtifact = {
  id: ID_1,
  trackId: 'track-en',
  chunkId: 'c1',
  file: `dubbing/${ID_1}.wav`,
  mimeType: 'audio/wav',
  format: 'wav',
  byteLength: 16044,
  durationSeconds: 1.5,
  sampleRate: 24000,
  cueDurationSeconds: 2.0,
  text: 'Hello world',
  model: { providerId: 'flycut:tts-local', modelId: 'kokoro-v1' },
  voiceId: 'af_heart',
  language: 'en',
  speed: 1.0,
  operationId: OP_ID,
  createdAt: '2026-11-13T10:00:00.000Z',
};

test('F-0035/AC-1 pickDefaultOfflineTtsModel never auto-selects paid cloud or remote non-offline endpoints', () => {
  const paidCloud = {
    provider: { id: 'flycut-cloud', name: 'FlyCut Cloud', kind: 'builtin' },
    models: [{ id: 'cloud-tts', name: 'Cloud TTS', role: 'tts', status: 'ready', offline: true, recommended: true }],
  };
  const remoteEndpoint = {
    provider: { id: 'flycut:remote', name: 'Remote TTS', kind: 'endpoint' },
    models: [{ id: 'remote-tts', name: 'Remote TTS', role: 'tts', status: 'ready', offline: false }],
  };
  const downloadLocal = {
    provider: { id: 'local-tts', name: 'Local TTS', kind: 'builtin' },
    models: [{ id: 'kokoro', name: 'Kokoro', role: 'tts', status: 'download', offline: true }],
  };
  assert.equal(pickDefaultOfflineTtsModel([paidCloud, remoteEndpoint, downloadLocal]), null);

  const readyLocal = {
    provider: { id: 'local-tts', name: 'Local TTS', kind: 'builtin' },
    models: [
      { id: 'm1', name: 'M1', role: 'tts', status: 'ready', offline: true, recommended: false },
      { id: 'm2', name: 'M2', role: 'tts', status: 'ready', offline: true, recommended: true },
    ],
  };
  assert.deepEqual(pickDefaultOfflineTtsModel([paidCloud, remoteEndpoint, readyLocal]), {
    providerId: 'local-tts',
    modelId: 'm2',
  });
});

test('F-0035/AC-2 AC-3 evaluateCueDubbingStatus flags tooLong and outdated reasons without false positives', () => {
  const fresh = evaluateCueDubbingStatus(baseArtifact, {
    currentText: 'Hello world',
    cueDurationSeconds: 2.0,
    selectedModel: { providerId: 'flycut:tts-local', modelId: 'kokoro-v1' },
    voiceId: 'af_heart',
  });
  assert.equal(fresh.tooLong, false);
  assert.equal(fresh.outdated, false);
  assert.deepEqual(fresh.reasons, []);

  // Tolerance 0.01s prevents floating-point false positives
  const boundary = evaluateCueDubbingStatus({ ...baseArtifact, durationSeconds: 2.005 }, {
    currentText: 'Hello world',
    cueDurationSeconds: 2.0,
    selectedModel: null,
  });
  assert.equal(boundary.tooLong, false);
  assert.equal(boundary.outdated, false);

  const tooLong = evaluateCueDubbingStatus({ ...baseArtifact, durationSeconds: 2.6 }, {
    currentText: 'Hello world',
    cueDurationSeconds: 2.0,
    selectedModel: null,
  });
  assert.equal(tooLong.tooLong, true);
  assert.ok(Math.abs(tooLong.exceedsSeconds - 0.6) < 1e-6);

  const textChanged = evaluateCueDubbingStatus(baseArtifact, {
    currentText: 'Updated translation',
    cueDurationSeconds: 2.0,
    selectedModel: { providerId: 'flycut:tts-local', modelId: 'kokoro-v1' },
    voiceId: 'af_heart',
  });
  assert.equal(textChanged.outdated, true);
  assert.deepEqual(textChanged.reasons, ['textChanged']);

  const modelChanged = evaluateCueDubbingStatus(baseArtifact, {
    currentText: 'Hello world',
    cueDurationSeconds: 2.0,
    selectedModel: { providerId: 'flycut:other', modelId: 'vits' },
    voiceId: 'af_heart',
  });
  assert.equal(modelChanged.outdated, true);
  assert.deepEqual(modelChanged.reasons, ['modelChanged']);

  const voiceChanged = evaluateCueDubbingStatus(baseArtifact, {
    currentText: 'Hello world',
    cueDurationSeconds: 2.0,
    selectedModel: { providerId: 'flycut:tts-local', modelId: 'kokoro-v1' },
    voiceId: 'zf_xiaobei',
  });
  assert.equal(voiceChanged.outdated, true);
  assert.deepEqual(voiceChanged.reasons, ['voiceChanged']);
});

test('F-0035/AC-1 AC-2 F-0038 schema enforces safe dubbing path and requires a project voice profile for cloning', () => {
  assert.throws(() => cueDubbingArtifactSchema.parse({ ...baseArtifact, file: '../evil.wav' }), /Invalid dubbing file path/);
  assert.throws(() => cueDubbingArtifactSchema.parse({ ...baseArtifact, file: 'media/foo.wav' }), /Invalid dubbing file path/);
  assert.ok(cueDubbingArtifactSchema.parse(baseArtifact));

  assert.throws(() => dubCueInputSchema.parse({
    projectId: PROJ_ID,
    videoId: VID_ID,
    trackId: 'track-en',
    chunkId: 'c1',
    baseVideoRevision: 1,
    expectedText: 'Hello world',
    request: {
      providerId: 'flycut:tts',
      modelId: 'cosyvoice',
      text: 'Hello world',
      language: 'en',
      cloneReferenceAssetId: ID_2,
    },
  }), /声音克隆必须使用项目音色/);

});

test('F-0035/AC-3 AC-7 upsertCueDubbing, removeTrackDubbings, and validateCueDubbings maintain cue uniqueness', () => {
  const replacement = { ...baseArtifact, id: ID_2, file: `dubbing/${ID_2}.wav`, durationSeconds: 1.8 };
  const otherTrack = { ...baseArtifact, id: OP_ID, trackId: 'track-ja', file: `dubbing/${OP_ID}.wav` };
  const updated = upsertCueDubbing([baseArtifact, otherTrack], replacement);
  assert.equal(updated.length, 2);
  assert.equal(updated.find(item => item.trackId === 'track-en')?.id, ID_2);

  const afterRemove = removeTrackDubbings(updated, 'track-en');
  assert.equal(afterRemove.length, 1);
  assert.equal(afterRemove[0].trackId, 'track-ja');

  validateCueDubbings(updated, [{ id: 'track-en' }, { id: 'track-ja' }], [{ id: 'c1' }]);
  assert.throws(() => validateCueDubbings([baseArtifact, { ...baseArtifact, id: ID_2 }], [{ id: 'track-en' }], [{ id: 'c1' }]), /Duplicate cue dubbing artifact for subtitle cue/);
  assert.throws(() => validateCueDubbings([baseArtifact], [{ id: 'track-other' }], [{ id: 'c1' }]), /unknown language track/);
  assert.throws(() => validateCueDubbings([baseArtifact], [{ id: 'track-en' }], [{ id: 'c2' }]), /unknown subtitle/);
});

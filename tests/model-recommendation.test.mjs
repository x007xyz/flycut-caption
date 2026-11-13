import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  findRecommendedAsrModel,
  formatByteSize,
  listReadyAsrModels,
  pickDefaultOfflineAsrModel,
  shouldPreserveUserSelection,
} from '../src/utils/modelRecommendation.ts';

const sherpaDownload = {
  provider: { id: 'sherpa-onnx', name: 'sherpa-onnx（本地）', kind: 'builtin' },
  models: [
    { id: 'sensevoice-small-int8-zh-en-ja-ko-yue-2024-07-17', name: 'SenseVoice Small INT8', role: 'asr', status: 'download', recommended: true, offline: true, size: '230 MB', timestampLevel: 'segment' },
    { id: 'paraformer-zh-int8-2023-09-14', name: 'Paraformer 2023', role: 'asr', status: 'download', recommended: false, offline: true, size: '234.1 MB', timestampLevel: 'segment' },
  ],
};

const cloudReady = {
  provider: { id: 'flycut-cloud', name: 'FlyCut Cloud', kind: 'builtin' },
  models: [
    { id: 'cloud-asr', name: 'Cloud ASR', role: 'asr', status: 'ready', offline: false, timestampLevel: 'word' },
  ],
};

const endpointReady = {
  provider: { id: 'flycut:gpu', name: 'GPU Server', kind: 'endpoint' },
  models: [
    { id: 'remote-1', name: 'Remote ASR', role: 'asr', status: 'ready', offline: false, timestampLevel: 'word' },
  ],
};

describe('F-0018/AC-1 AC-3 modelRecommendation', () => {
  it('finds the recommended ASR model and never auto-picks paid cloud or remote endpoints', () => {
    const groups = [sherpaDownload, cloudReady, endpointReady];
    assert.equal(findRecommendedAsrModel(groups)?.model.id, 'sensevoice-small-int8-zh-en-ja-ko-yue-2024-07-17');
    assert.equal(pickDefaultOfflineAsrModel(groups), undefined);
    assert.equal(listReadyAsrModels(groups).length, 2);
  });

  it('picks ready offline builtin model, preferring recommended first', () => {
    const readyParaformer = {
      ...sherpaDownload,
      models: [
        sherpaDownload.models[0],
        { ...sherpaDownload.models[1], status: 'ready' },
      ],
    };
    assert.equal(pickDefaultOfflineAsrModel([readyParaformer, cloudReady])?.model.id, 'paraformer-zh-int8-2023-09-14');

    const readyBoth = {
      ...sherpaDownload,
      models: [
        { ...sherpaDownload.models[0], status: 'ready' },
        { ...sherpaDownload.models[1], status: 'ready' },
      ],
    };
    assert.equal(pickDefaultOfflineAsrModel([readyBoth, cloudReady])?.model.id, 'sensevoice-small-int8-zh-en-ja-ko-yue-2024-07-17');
  });

  it('preserves existing valid user selections and transient provider errors', () => {
    assert.equal(shouldPreserveUserSelection([sherpaDownload, endpointReady], null), false);
    assert.equal(shouldPreserveUserSelection([sherpaDownload, endpointReady], { providerId: 'flycut:gpu', modelId: 'remote-1' }), true);
    assert.equal(shouldPreserveUserSelection([sherpaDownload, { ...endpointReady, models: [], error: 'timeout' }], { providerId: 'flycut:gpu', modelId: 'remote-1' }), true);
    assert.equal(shouldPreserveUserSelection([sherpaDownload, endpointReady], { providerId: 'flycut:gpu', modelId: 'deleted-model' }), false);
  });

  it('formats byte sizes cleanly', () => {
    assert.equal(formatByteSize(512), '512 B');
    assert.equal(formatByteSize(2048), '2.0 KB');
    assert.equal(formatByteSize(115_000_000), '115.0 MB');
  });
});

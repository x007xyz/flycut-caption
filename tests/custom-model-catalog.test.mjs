import test from 'node:test';
import assert from 'node:assert/strict';
import { createQwenModelPreset } from '../src/services/customModelCatalog.ts';

test('Qwen presets use the correct single or sharded checkpoint files', () => {
  const small = createQwenModelPreset();
  const large = createQwenModelPreset('1.7B');
  assert.equal(small.provider, 'qwen-asr');
  assert(small.files.some(f => f.path === 'model.safetensors'));
  assert(!large.files.some(f => f.path === 'model.safetensors'));
  for (const path of ['model.safetensors.index.json', 'model-00001-of-00002.safetensors', 'model-00002-of-00002.safetensors']) {
    assert(large.files.some(f => f.path === path));
  }
  for (const preset of [small, large]) {
    assert(preset.id.startsWith('custom-'));
    assert.equal(preset.download_sources[0].download_mode, 'files');
    assert.equal(preset.timestamp.level, 'segment');
    assert.equal(preset.timestamp.token_timestamp_verified, false);
  }
});

test('editing a template never mutates future templates', () => {
  const model = createQwenModelPreset();
  model.recognizer_config.device = 'cpu';
  model.files.pop();
  assert.equal(createQwenModelPreset().recognizer_config.device, 'auto');
  assert.equal(createQwenModelPreset().files.length, 8);
});

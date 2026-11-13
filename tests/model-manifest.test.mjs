import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { projectRoot } from './lib/asrPaths.mjs';

describe('F-0018/AC-1 default ASR model manifest', () => {
  it('declares exactly one recommended ASR model with F-0001 benchmark metadata and file checksums', () => {
    const manifest = JSON.parse(readFileSync(join(projectRoot(), 'models.json'), 'utf8'));
    const recommended = manifest.models.filter((m) => m.enabled && m.recommended);
    assert.equal(recommended.length, 1, 'Expected exactly one recommended ASR model in models.json');
    const [model] = recommended;
    assert.equal(model.id, 'sensevoice-small-int8-zh-en-ja-ko-yue-2024-07-17');
    assert.equal(model.supports_subtitle, true);
    assert.equal(model.timestamp?.level, 'segment');
    assert.equal(model.timestamp?.token_timestamp_verified, false);
    assert.equal(model.recommendation?.benchmarkId, 'F-0001');
    assert.ok(model.recommendation?.cer, 'Expected F-0001 measured CER metadata');
    for (const file of model.files) {
      assert.match(file.sha256 ?? '', /^[0-9a-f]{64}$/, `Expected SHA-256 for ${file.path}`);
    }
  });
});

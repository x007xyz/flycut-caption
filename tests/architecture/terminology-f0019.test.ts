import assert from 'node:assert/strict';
import test from 'node:test';
import { checkAsrRequest, inferHotwordCapabilities, type ModelInfo } from '../../shared/providers';
import { dedupeProjectTerms, formatHotwordsForOption, selectActiveHotwords, validateTermDraft, type ProjectTermEntry } from '../../shared/terminology';

test('F-0019/AC-1 validateTermDraft rejects blank, oversized, invalid weights, and case-insensitive duplicates', () => {
  const existing: ProjectTermEntry[] = [
    { id: 't1', term: 'FlyCut', asHotword: true, weight: 2, translations: { en: 'FlyCut' }, updatedAt: '2026-11-13T00:00:00Z' },
  ];
  assert.equal(validateTermDraft({ term: '   ' }, existing).ok, false);
  assert.equal(validateTermDraft({ term: 'A'.repeat(201) }, existing).ok, false);
  assert.equal(validateTermDraft({ term: 'FunASR', weightRaw: '0' }, existing).ok, false);
  assert.equal(validateTermDraft({ term: 'FunASR', weightRaw: '-1.5' }, existing).ok, false);
  assert.equal(validateTermDraft({ term: 'FunASR', weightRaw: 'abc' }, existing).ok, false);
  assert.equal(validateTermDraft({ term: 'flycut' }, existing).ok, false);
  assert.equal(validateTermDraft({ term: 'flycut', weightRaw: '3' }, existing, 't1').ok, true);

  const deduped = dedupeProjectTerms([
    ...existing,
    { id: 't2', term: '  flycut ', asHotword: true, updatedAt: '2026-11-13T00:00:00Z' },
    { id: 't3', term: 'Whisper', asHotword: false, updatedAt: '2026-11-13T00:00:00Z' },
  ]);
  assert.equal(deduped.length, 2);
  assert.deepEqual(deduped[0].translations, { en: 'FlyCut' });
});

test('F-0019/AC-2 AC-3 selectActiveHotwords and checkAsrRequest enforce model hotword capability without hardcoding providerId', () => {
  const terms: ProjectTermEntry[] = [
    { id: 't1', term: 'FlyCut', asHotword: true, weight: 3, updatedAt: '2026-11-13T00:00:00Z' },
    { id: 't2', term: 'Whisper', asHotword: false, weight: 2, updatedAt: '2026-11-13T00:00:00Z' },
    { id: 't3', term: 'FunASR', asHotword: true, weight: 1.5, updatedAt: '2026-11-13T00:00:00Z' },
  ];

  const unsupportedModel: ModelInfo = {
    id: 'sensevoice-small',
    name: 'SenseVoice',
    role: 'asr',
    status: 'ready',
    hotwords: { supported: false },
  };
  assert.deepEqual(selectActiveHotwords(terms, inferHotwordCapabilities(unsupportedModel)), []);
  assert.throws(() => checkAsrRequest(unsupportedModel, {
    providerId: 'any-provider',
    modelId: 'sensevoice-small',
    language: 'zh',
    hotwords: [{ term: 'FlyCut' }],
  }), /不支持热词/);

  const noWeightModel: ModelInfo = {
    id: 'paraformer-http',
    name: 'Paraformer HTTP',
    role: 'asr',
    status: 'ready',
    options: { hotword: { type: 'string', label: '热词' } },
  };
  const capsNoWeight = inferHotwordCapabilities(noWeightModel);
  assert.equal(capsNoWeight.supported, true);
  assert.equal(capsNoWeight.weights, false);
  const selectedNoWeight = selectActiveHotwords(terms, capsNoWeight);
  assert.deepEqual(selectedNoWeight, [{ term: 'FlyCut' }, { term: 'FunASR' }]);
  assert.equal(formatHotwordsForOption(selectedNoWeight, capsNoWeight), 'FlyCut FunASR');

  const weightedModel: ModelInfo = {
    id: 'paraformer-weighted',
    name: 'Paraformer Weighted',
    role: 'asr',
    status: 'ready',
    hotwords: { supported: true, weights: true, maxTerms: 1, format: 'weighted-lines' },
  };
  const selectedWeighted = selectActiveHotwords(terms, weightedModel.hotwords);
  assert.deepEqual(selectedWeighted, [{ term: 'FlyCut', weight: 3 }]);
  assert.equal(formatHotwordsForOption(selectedWeighted, weightedModel.hotwords), 'FlyCut 3');
  assert.throws(() => checkAsrRequest(weightedModel, {
    providerId: 'flycut:gpu',
    modelId: 'paraformer-weighted',
    language: 'zh',
    hotwords: [{ term: 'FlyCut', weight: 3 }, { term: 'Extra' }],
  }), /最多支持/);
});

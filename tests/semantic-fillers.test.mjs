import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SemanticContractError, buildSemanticWindowPlan, createSemanticBase,
  mergeSemanticSuggestions, validateSemanticModelResponse,
} from '../shared/editing/semanticFillers.ts';

const transcript = JSON.parse(readFileSync(new URL('../experiments/f-0008-semantic-cut/fixtures/mini-transcript.json', import.meta.url), 'utf8'));
const options = {
  base: 'base-fixture',
  transcriptId: 'mini',
  language: transcript.language,
  chunks: transcript.chunks,
  wordChunks: transcript.wordChunks,
};
const plan = buildSemanticWindowPlan(options);
const window = plan.windows[0];
const response = (candidates, patch = {}) => ({ version: 1, base: window.base, candidates, ...patch });
const candidate = (patch = {}) => ({
  startWordId: 'w5', endWordId: 'w6', scope: 'word', category: 'repetition',
  reason: '重复的开头词，保留后一次', confidence: 'high', ...patch,
});
const errorCode = code => error => error instanceof SemanticContractError && error.code === code;

test('F-0009/AC-2 AC-5 windows include only ambiguous targets and non-deletable context', () => {
  assert.equal(plan.totalBatches, 1);
  assert.deepEqual(plan.eligibleSentenceIds, ['s2']);
  assert.equal(plan.targetSentenceCount, 1);
  assert.equal(plan.targetWordCount, 4);
  const built = plan.windows[0];
  assert.deepEqual(built.target, { startWordId: 'w5', endWordId: 'w8' });
  assert.deepEqual(built.sentences.map(sentence => sentence.id), ['s1', 's2', 's3']);
  assert.equal(built.sentences[0].words.every(word => word.deletable === false), true);
  assert.equal(built.sentences[1].words.every(word => word.deletable === true), true);
  assert.equal(built.sentences[2].words.every(word => word.deletable === false), true);
});

test('F-0009/AC-4 valid candidates derive time from IDs and an empty candidate list is a valid no-result', () => {
  const normalized = validateSemanticModelResponse(response([candidate({
    endWordId: 'w7', startMs: 999999, reason: '重复开头，保留后一次方案', confidence: 'medium',
  })]), window);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].startMs, 2000);
  assert.equal(normalized[0].endMs, 3000);
  assert.equal(normalized[0].text, '这个这个方案');
  assert.notEqual(normalized[0].startMs, 999999, 'model-provided timestamps are ignored');
  assert.deepEqual(validateSemanticModelResponse(response([]), window), []);
});

test('F-0009/AC-4 unknown, duplicate, out-of-range, non-contiguous and stale results fail the entire batch', () => {
  assert.throws(() => validateSemanticModelResponse(response([candidate({ startWordId: 'w99', endWordId: 'w99' })]), window), errorCode('UNKNOWN_WORD_ID'));
  assert.throws(() => validateSemanticModelResponse(response([candidate({ startWordId: 'w6', endWordId: 'w5' })]), window), errorCode('REVERSED_RANGE'));
  assert.throws(() => validateSemanticModelResponse(response([candidate({ startWordId: 'w2', endWordId: 'w3' })]), window), errorCode('OUT_OF_RANGE'));
  assert.throws(() => validateSemanticModelResponse(response([candidate({ wordIds: ['w5', 'w7'] })]), window), errorCode('NON_CONTIGUOUS'));
  assert.throws(() => validateSemanticModelResponse(response([], { base: 'old' }), window), errorCode('STALE_BASE'));
  assert.throws(() => validateSemanticModelResponse(response([candidate(), candidate()]), window), errorCode('DUPLICATE_RANGE'));
});

test('F-0009/AC-4 half-sentence, whole-sentence word scope and category/scope mismatches are rejected', () => {
  assert.throws(() => validateSemanticModelResponse(response([
    candidate({ startWordId: 'w5', endWordId: 'w6' }),
    candidate({ startWordId: 'w7', endWordId: 'w8', category: 'contextual-filler' }),
  ]), window), errorCode('HALF_SENTENCE'));
  assert.throws(() => validateSemanticModelResponse(response([
    candidate({ startWordId: 'w5', endWordId: 'w8', category: 'fragment' }),
  ]), window), errorCode('SCOPE_REQUIRED'));
  assert.throws(() => validateSemanticModelResponse(response([
    candidate({ startWordId: 'w5', endWordId: 'w8', scope: 'sentence', category: 'contextual-filler' }),
  ]), window), errorCode('INVALID_CATEGORY_SCOPE'));
  assert.throws(() => validateSemanticModelResponse(response([
    candidate({ category: 'fragment', scope: 'word' }),
  ]), window), errorCode('INVALID_CATEGORY_SCOPE'));
});

test('F-0009/AC-4 a candidate may not cover non-deletable context inside the target span', () => {
  const long = {
    ...transcript,
    chunks: [
      { id: 'a', text: '这个就是这个', timestamp: [0, 1], wordIds: ['a1', 'a2', 'a3'] },
      { id: 'b', text: '普通内容', timestamp: [1.5, 2.5], wordIds: ['b1', 'b2'] },
      { id: 'c', text: '那个我觉得', timestamp: [3, 4], wordIds: ['c1', 'c2', 'c3'] },
    ],
    wordChunks: [
      { id: 'a1', text: '这个', timestamp: [0, 0.3], sentenceId: 'a' },
      { id: 'a2', text: '就是', timestamp: [0.3, 0.6], sentenceId: 'a' },
      { id: 'a3', text: '这个', timestamp: [0.6, 1], sentenceId: 'a' },
      { id: 'b1', text: '普通', timestamp: [1.5, 2], sentenceId: 'b' },
      { id: 'b2', text: '内容', timestamp: [2, 2.5], sentenceId: 'b' },
      { id: 'c1', text: '那个', timestamp: [3, 3.3], sentenceId: 'c' },
      { id: 'c2', text: '我', timestamp: [3.3, 3.6], sentenceId: 'c' },
      { id: 'c3', text: '觉得', timestamp: [3.6, 4], sentenceId: 'c' },
    ],
  };
  const built = buildSemanticWindowPlan({ ...options, ...long }).windows[0];
  assert.equal(built.sentences.find(sentence => sentence.id === 'b').words.every(word => !word.deletable), true);
  assert.throws(() => validateSemanticModelResponse({
    version: 1, base: built.base, candidates: [{
      startWordId: 'a1', endWordId: 'c3', scope: 'sentence', category: 'repetition',
      reason: '跨过不可删除的上下文', confidence: 'high',
    }],
  }, built), errorCode('NON_DELETABLE_WORD'));
});

test('F-0009/AC-5 AC-8 semantic candidates stay unselected and exact rule overlap shows both sources', () => {
  const semantic = validateSemanticModelResponse(response([candidate()]), window);
  const rule = [{
    id: 'rule-1', start: 2, end: 2.6, reason: 'filler.repeated', category: 'repeated-word',
    label: '这个这个', selected: true,
  }];
  const merged = mergeSemanticSuggestions(rule, semantic);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].selected, true, 'existing rule selection is preserved');
  assert.deepEqual(merged[0].sources, ['rule', 'semantic']);
  assert.equal(merged[0].semanticConfidence, 'high');

  const semanticOnly = mergeSemanticSuggestions([], semantic);
  assert.equal(semanticOnly[0].selected, false);
  assert.deepEqual(semanticOnly[0].sources, ['semantic']);
});

test('F-0009/AC-7 the base changes with edited text, timestamps and formal EDL', async () => {
  const baseInput = { edl: { deleted: [] }, chunks: transcript.chunks, wordChunks: transcript.wordChunks,
    sourceDuration: transcript.duration, transcriptId: 'mini' };
  const first = await createSemanticBase(baseInput);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(await createSemanticBase(baseInput), first);
  const edited = structuredClone(baseInput);
  edited.wordChunks[4].timestamp = [2.01, 2.3];
  assert.notEqual(await createSemanticBase(edited), first);
  const cut = { ...baseInput, edl: { deleted: [{ startUs: 0, endUs: 100000 }] } };
  assert.notEqual(await createSemanticBase(cut), first);
});


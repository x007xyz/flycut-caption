import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildIndex, buildWindow, validateCandidates } from './protocol.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const transcript = JSON.parse(readFileSync(join(here, 'fixtures/mini-transcript.json'), 'utf8'));
const index = buildIndex(transcript, { transcriptId: 'mini' });
const request = buildWindow(index, 'w1', 'w12');
const response = (candidates, base = request.base) => ({ version: 1, base, candidates });

test('valid filler and repetition candidates derive timestamps from words', () => {
  const result = validateCandidates(response([
    { startWordId: 'w1', endWordId: 'w1', scope: 'word', category: 'contextual-filler', reason: '独立语气词', confidence: 'high' },
    { startWordId: 'w5', endWordId: 'w6', scope: 'word', category: 'repetition', reason: '重复的“这个”', confidence: 'high' },
  ]), request, index);
  assert.equal(result.length, 2);
  assert.equal(result[0].startMs, 0);
  assert.equal(result[0].endMs, 350);
  assert.equal(result[1].endMs, 2600);
  assert.deepEqual(result[1].wordIds, ['w5', 'w6']);
});

test('valid complete sentence candidate', () => {
  const result = validateCandidates(response([
    { startWordId: 'w9', endWordId: 'w12', scope: 'sentence', category: 'fragment', reason: '需要整句删除时使用句级范围', confidence: 'medium' },
  ]), request, index);
  assert.equal(result[0].scope, 'sentence');
  assert.equal(result[0].startMs, 4000);
  assert.equal(result[0].endMs, 5600);
});

test('empty candidate list is valid', () => {
  assert.deepEqual(validateCandidates(response([]), request, index), []);
});

test('unknown id is rejected', () => {
  assert.throws(() => validateCandidates(response([
    { startWordId: 'w99', endWordId: 'w99', scope: 'word', category: 'contextual-filler', reason: 'x', confidence: 'low' },
  ]), request, index), { code: 'UNKNOWN_ID' });
});

test('reversed range is rejected', () => {
  assert.throws(() => validateCandidates(response([
    { startWordId: 'w4', endWordId: 'w1', scope: 'word', category: 'contextual-filler', reason: 'x', confidence: 'low' },
  ]), request, index), { code: 'REVERSED_RANGE' });
});

test('explicit non-contiguous wordIds are rejected', () => {
  assert.throws(() => validateCandidates(response([
    { startWordId: 'w1', endWordId: 'w2', wordIds: ['w1', 'w3'], scope: 'word', category: 'contextual-filler', reason: 'x', confidence: 'low' },
  ]), request, index), { code: 'NON_CONTIGUOUS' });
});

test('candidate outside the requested target range is rejected', () => {
  const narrow = buildWindow(index, 'w2', 'w11');
  assert.throws(() => validateCandidates(response([
    { startWordId: 'w1', endWordId: 'w1', scope: 'word', category: 'contextual-filler', reason: 'x', confidence: 'low' },
  ], narrow.base), narrow, index), { code: 'OUT_OF_RANGE' });
});

test('stale base is rejected', () => {
  assert.throws(() => validateCandidates(response([], '0'.repeat(64)), request, index), { code: 'STALE_BASE' });
});

test('partial sentence scope is rejected', () => {
  assert.throws(() => validateCandidates(response([
    { startWordId: 'w9', endWordId: 'w11', scope: 'sentence', category: 'fragment', reason: 'x', confidence: 'low' },
  ]), request, index), { code: 'PARTIAL_SENTENCE' });
});

test('word scope across a sentence boundary is rejected', () => {
  assert.throws(() => validateCandidates(response([
    { startWordId: 'w7', endWordId: 'w9', scope: 'word', category: 'repetition', reason: 'x', confidence: 'low' },
  ]), request, index), { code: 'CROSS_SENTENCE_WORD_SCOPE' });
});

test('a whole sentence must use sentence scope', () => {
  assert.throws(() => validateCandidates(response([
    { startWordId: 'w5', endWordId: 'w8', scope: 'word', category: 'fragment', reason: 'x', confidence: 'low' },
  ]), request, index), { code: 'SCOPE_REQUIRED' });
});

test('two word candidates may not empty a sentence together', () => {
  assert.throws(() => validateCandidates(response([
    { startWordId: 'w5', endWordId: 'w6', scope: 'word', category: 'repetition', reason: 'x', confidence: 'low' },
    { startWordId: 'w7', endWordId: 'w8', scope: 'word', category: 'fragment', reason: 'y', confidence: 'low' },
  ]), request, index), { code: 'HALF_SENTENCE' });
});

test('overlapping candidates are rejected', () => {
  assert.throws(() => validateCandidates(response([
    { startWordId: 'w5', endWordId: 'w7', scope: 'word', category: 'repetition', reason: 'x', confidence: 'low' },
    { startWordId: 'w6', endWordId: 'w8', scope: 'word', category: 'fragment', reason: 'y', confidence: 'low' },
  ]), request, index), { code: 'OVERLAP' });
});

test('duplicate ranges are rejected', () => {
  assert.throws(() => validateCandidates(response([
    { startWordId: 'w5', endWordId: 'w6', scope: 'word', category: 'repetition', reason: 'x', confidence: 'low' },
    { startWordId: 'w5', endWordId: 'w6', scope: 'word', category: 'repetition', reason: 'x', confidence: 'low' },
  ]), request, index), { code: 'DUPLICATE_RANGE' });
});

test('invalid confidence, category, and reason are rejected', () => {
  const base = { startWordId: 'w1', endWordId: 'w1', scope: 'word', category: 'contextual-filler', reason: 'x', confidence: 'low' };
  assert.throws(() => validateCandidates(response([{ ...base, confidence: '0.9' }]), request, index), { code: 'INVALID_CONFIDENCE' });
  assert.throws(() => validateCandidates(response([{ ...base, category: 'content' }]), request, index), { code: 'INVALID_CATEGORY' });
  assert.throws(() => validateCandidates(response([{ ...base, reason: '   ' }]), request, index), { code: 'INVALID_REASON' });
});

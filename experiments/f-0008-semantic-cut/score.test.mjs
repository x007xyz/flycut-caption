import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreCandidates } from './score.mjs';

const words = Array.from({ length: 8 }, (_, index) => ({
  id: `w${index + 1}`, startMs: index * 100, endMs: (index + 1) * 100,
}));

test('false-delete rate is computed over proposed words', () => {
  const result = scoreCandidates({
    words,
    candidates: [{ startWordId: 'w5', endWordId: 'w6' }],
    goldSpans: [{ startWordId: 'w5', endWordId: 'w7' }],
    protectedSpans: [{ startWordId: 'w2', endWordId: 'w2' }],
  });
  assert.equal(result.proposedWords, 2);
  assert.equal(result.truePositiveWords, 2);
  assert.equal(result.missedWords, 1);
  assert.equal(result.falseDeleteRate, 0);
  assert.equal(result.recall, 2 / 3);
});

test('protected content is counted separately from ordinary false deletes', () => {
  const result = scoreCandidates({
    words,
    candidates: [{ startWordId: 'w1', endWordId: 'w2' }],
    goldSpans: [{ startWordId: 'w5', endWordId: 'w6' }],
    protectedSpans: [{ startWordId: 'w2', endWordId: 'w2' }],
  });
  assert.equal(result.falseDeleteWords, 2);
  assert.equal(result.criticalFalseDeleteWords, 1);
  assert.equal(result.falseDeleteRate, 1);
  assert.equal(result.recall, 0);
});

test('empty predictions report null rates instead of zero recall claims', () => {
  const result = scoreCandidates({
    words, candidates: [], goldSpans: [{ startWordId: 'w5', endWordId: 'w6' }],
  });
  assert.equal(result.falseDeleteRate, null);
  assert.equal(result.recall, 0);
  assert.equal(result.proposedWords, 0);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapToSentenceBoundary, suggestClips } from '../../shared/clips';

const chunks = [
  { id: 's1', text: '第一句完整引入', timestamp: [0, 10] as [number, number] },
  { id: 's2', text: '第二句展开说明', timestamp: [10, 25] as [number, number] },
  { id: 's3', text: '第三句给出结论', timestamp: [25, 40] as [number, number] },
];

test('F-0045/AC-1 AC-2 suggests sentence-aligned clips with score and reasons', () => {
  const result = suggestClips(chunks, 40, { minSeconds: 15, maxSeconds: 40 });
  assert.ok(result.candidates.length > 0);
  const first = result.candidates[0];
  assert.equal(first.start, 0);
  assert.ok(first.end <= 40);
  assert.ok(first.score > 0);
  assert.ok(first.reasons.length >= 1);
  assert.ok(result.candidates.some(candidate => candidate.start === 0 && candidate.end === 25));
  assert.equal(snapToSentenceBoundary(chunks, 11), 10);
  assert.equal(snapToSentenceBoundary(chunks, 38), 40);
});

test('F-0045/AC-1 returns no candidate when no sentence window fits', () => {
  const result = suggestClips(chunks, 40, { minSeconds: 60, maxSeconds: 90 });
  assert.equal(result.candidates.length, 0);
});

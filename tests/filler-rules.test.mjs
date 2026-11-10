import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeFillers, inspectFillerGate } from '../shared/editing/fillerRules.ts';

const sentence = (words, text, duration = 4) => ({
  chunks: [{ id: 's', text, timestamp: [0, duration], wordIds: words.map(word => word.id) }],
  wordChunks: words.map(word => ({ ...word, sentenceId: 's' })),
  hasWordTimestamps: true,
  sourceDuration: duration,
});

test('F-0007 standalone sentence-initial filler is selected; semantic 那个 is not', () => {
  const result = analyzeFillers(sentence([
    { id: 'w1', text: '嗯', timestamp: [0, 0.2] },
    { id: 'w2', text: '我', timestamp: [0.3, 0.5] },
    { id: 'w3', text: '觉得', timestamp: [0.6, 1] },
    { id: 'w4', text: '很好', timestamp: [1.1, 2] },
  ], '嗯我觉得很好'));
  assert.equal(result.gate.ok, true);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].category, 'standalone-filler');
  assert.equal(result.candidates[0].defaultSelected, true);
  assert.equal(result.candidates[0].label, '嗯');
});

test('F-0007 single 那个 is never a filler candidate', () => {
  const result = analyzeFillers(sentence([
    { id: 'w1', text: '那个', timestamp: [0, 0.3] },
    { id: 'w2', text: '东西', timestamp: [0.4, 0.8] },
  ], '那个东西'));
  assert.equal(result.candidates.length, 0);
});

test('F-0007 repeated 那个那个 is a conservative candidate that keeps the last word', () => {
  const result = analyzeFillers(sentence([
    { id: 'w1', text: '那个', timestamp: [0, 0.2] },
    { id: 'w2', text: '那个', timestamp: [0.25, 0.45] },
    { id: 'w3', text: '东西', timestamp: [0.5, 2] },
  ], '那个那个东西'));
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].category, 'repeated-word');
  assert.equal(result.candidates[0].defaultSelected, false);
  assert.deepEqual(result.candidates[0].wordIds, ['w1']);
  assert.equal(result.candidates[0].end, 0.25);
});

test('F-0007 repeated 嗯嗯 merges the run and keeps the last filler', () => {
  const result = analyzeFillers(sentence([
    { id: 'w1', text: '嗯', timestamp: [0, 0.1] },
    { id: 'w2', text: '嗯', timestamp: [0.15, 0.25] },
    { id: 'w3', text: '好', timestamp: [0.3, 1] },
  ], '嗯嗯好'));
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].category, 'repeated-word');
  assert.deepEqual(result.candidates[0].wordIds, ['w1']);
});

test('F-0007 missing word timestamps blocks precise analysis', () => {
  const gate = inspectFillerGate({ chunks: [{ id: 's', text: '嗯好', timestamp: [0, 1] }], hasWordTimestamps: false, sourceDuration: 1 });
  assert.equal(gate.ok, false);
  assert.ok(gate.reasons.includes('missing-word-timestamps'));
});

test('F-0007 text mismatch and synthetic equal-division timing skip the sentence', () => {
  const mismatch = inspectFillerGate(sentence([
    { id: 'w1', text: '嗯', timestamp: [0, 0.2] },
    { id: 'w2', text: '我', timestamp: [0.3, 0.5] },
  ], '嗯他'));
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.skippedSentences[0].reason, 'text-mismatch');

  const words = ['一', '二', '三', '四'].map((text, index) => ({ id: `w${index}`, text, timestamp: [index * 0.5, (index + 1) * 0.5] }));
  const synthetic = inspectFillerGate(sentence(words, '一二三四', 2));
  assert.equal(synthetic.ok, false);
  assert.equal(synthetic.skippedSentences[0].reason, 'synthetic-timing');
});

test('F-0007 60-minute rule analysis stays bounded', () => {
  const chunks = [];
  const wordChunks = [];
  for (let index = 0; index < 1000; index++) {
    const start = index * 3.6;
    const words = ['嗯', '好', '啊'].map((text, offset) => ({
      id: `s${index}w${offset}`, text, sentenceId: `s${index}`,
      timestamp: [start + offset * 1.2, start + offset * 1.2 + 1],
    }));
    wordChunks.push(...words);
    chunks.push({ id: `s${index}`, text: '嗯好啊', timestamp: [start, start + 3.4], wordIds: words.map(word => word.id) });
  }
  const started = performance.now();
  const result = analyzeFillers({ chunks, wordChunks, hasWordTimestamps: true, sourceDuration: 3600 });
  const elapsed = performance.now() - started;
  assert.equal(result.gate.ok, true);
  assert.equal(result.stats.sentences, 1000);
  assert.ok(elapsed < 1000, `expected <1000ms, got ${elapsed.toFixed(1)}ms`);
});

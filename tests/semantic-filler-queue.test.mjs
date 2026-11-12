import test from 'node:test';
import assert from 'node:assert/strict';
import { runSemanticBatchQueue } from '../src/services/semanticFillerAnalysis.ts';

const window = base => ({
  version: 1,
  base,
  transcriptId: 'queue-test',
  language: 'zh',
  target: { startWordId: 'w1', endWordId: 'w2' },
  sentences: [{ id: 's1', text: '这个就是这个', words: [
    { id: 'w1', text: '这个', startMs: 0, endMs: 300, deletable: true },
    { id: 'w2', text: '就是', startMs: 300, endMs: 600, deletable: true },
    { id: 'w3', text: '这个', startMs: 600, endMs: 900, deletable: false },
  ] }],
  policy: { allowedCategories: ['contextual-filler', 'repetition', 'self-correction', 'fragment'],
    allowSentenceScope: true, maxCandidates: 40, maxWordsPerCandidate: 30, maxReasonChars: 200 },
});

const batch = (index, status = 'pending', candidates = []) => ({
  id: 'batch-' + index, index, window: window('base-' + index), status, candidates,
});

test('F-0009/AC-3 invalid batches keep prior success and remain independently retryable', async () => {
  const calls = [];
  const connection = {
    async call(method, payload) {
      calls.push({ method, configId: payload.configId });
      return { id: 'job-' + calls.length };
    },
    async waitJob(id) {
      if (id === 'job-1') return { version: 1, base: 'base-1', promptVersion: 'f0009-v1', candidates: [] };
      throw new Error('Invalid analysis result (UNKNOWN_WORD_ID)');
    },
  };
  const progress = [];
  const states = await runSemanticBatchQueue({
    connection,
    configId: '00000000-0000-4000-8000-000000000001',
    batches: [batch(1), batch(2)],
    signal: new AbortController().signal,
    onProgress: value => progress.push(value.completed),
  });
  assert.equal(calls.length, 2);
  assert.equal(calls.every(call => call.method === 'text.suggestCuts' && call.configId.endsWith('0001')), true);
  assert.deepEqual(states.map(state => state.status), ['success', 'invalid']);
  assert.deepEqual(progress.slice(-3), [1, 2, 2]);
});

test('F-0009/AC-3 cancellation retains successful batches and marks late work cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  const states = await runSemanticBatchQueue({
    connection: {
      async call() { throw new Error('must not call after cancellation'); },
      async waitJob() { throw new Error('must not wait after cancellation'); },
    },
    configId: '00000000-0000-4000-8000-000000000001',
    batches: [batch(1, 'success'), batch(2), batch(3)],
    signal: controller.signal,
  });
  assert.deepEqual(states.map(state => state.status), ['success', 'cancelled', 'cancelled']);
});

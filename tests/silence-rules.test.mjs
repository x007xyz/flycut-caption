import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SILENCE_PARAMS, generateSilenceCandidates, validateSilenceParams } from '../shared/editing/silence.ts';

test('F-0006 shorten mode keeps guard plus retain and skips short pauses', () => {
  const result = generateSilenceCandidates({
    duration: 4, speech: [{ start: 1, end: 1.2 }, { start: 2, end: 2.5 }], params: DEFAULT_SILENCE_PARAMS,
  });
  assert.equal(result.paramsErrors.length, 0);
  assert.equal(result.candidates.length, 3);
  assert.ok(result.candidates.some(candidate => candidate.start === 1.35 && candidate.end === 1.75));
});

test('F-0006 remove mode keeps only guards and never cuts into word intervals', () => {
  const result = generateSilenceCandidates({
    duration: 6,
    speech: [{ start: 1, end: 1.5 }],
    wordSegments: [{ start: 3.0, end: 3.2 }],
    params: { ...DEFAULT_SILENCE_PARAMS, mode: 'remove' },
  });
  assert.ok(result.candidates.every(candidate => candidate.end <= 3 || candidate.start >= 3.2));
  assert.ok(result.candidates.some(candidate => Math.abs(candidate.start - 1.65) < 1e-6));
});

test('F-0006 existing EDL deletions are subtracted and not applied twice', () => {
  const result = generateSilenceCandidates({
    duration: 6, speech: [{ start: 2, end: 2.5 }], existingDeleted: [{ start: 0, end: 1 }],
    params: { ...DEFAULT_SILENCE_PARAMS, mode: 'remove' },
  });
  assert.ok(result.candidates.every(candidate => !(candidate.start < 1 && candidate.end > 1)));
});

test('F-0006 edge silence is shortened from the edge; no speech returns a warning', () => {
  const edge = generateSilenceCandidates({ duration: 5, speech: [{ start: 2, end: 3 }], params: DEFAULT_SILENCE_PARAMS });
  assert.equal(edge.candidates.length, 2);
  assert.ok(edge.candidates.every(candidate => candidate.reason === 'silence.vad-edge'));
  const none = generateSilenceCandidates({ duration: 5, speech: [], params: DEFAULT_SILENCE_PARAMS });
  assert.deepEqual(none.candidates, []);
  assert.ok(none.warnings.includes('no-speech'));
});

test('F-0006 edge silence keeps padding only on the speech side (design §2: max(guard, retain) / guard)', () => {
  const ranges = mode => generateSilenceCandidates({ duration: 5, speech: [{ start: 2, end: 3 }], params: { ...DEFAULT_SILENCE_PARAMS, mode } })
    .candidates.map(candidate => [candidate.start, candidate.end]);
  assert.deepEqual(ranges('shorten'), [[0, 1.75], [3.25, 5]]);
  assert.deepEqual(ranges('remove'), [[0, 1.85], [3.15, 5]]);
});

test('F-0006 invalid params are rejected before candidate generation', () => {
  assert.deepEqual(validateSilenceParams({ minPauseSeconds: 0, guardSeconds: -1, mode: 'shorten', retainSeconds: Number.NaN }), ['min-pause', 'guard', 'retain']);
  const result = generateSilenceCandidates({ duration: 5, speech: [], params: { minPauseSeconds: 0, guardSeconds: 0, mode: 'shorten', retainSeconds: 0 } });
  assert.deepEqual(result.candidates, []);
  assert.ok(result.paramsErrors.includes('min-pause'));
});

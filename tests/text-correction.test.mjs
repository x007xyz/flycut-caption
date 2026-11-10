import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyTextSnapshots, createTextRecord, MAX_TEXT_HISTORY, planTextRestore, splitCorrectionBatches,
  trimTextHistory, validateCorrectionResults, validateTextUpdates,
} from '../shared/text/corrections.ts';

const record = (id, at, before, after, kind = 'ai-correction') => ({
  id, at, kind, before: before.map(([chunkId, text]) => ({ id: chunkId, text })),
  after: after.map(([chunkId, text]) => ({ id: chunkId, text })),
});

test('F-0013 batch validation requires one non-empty result per requested id', () => {
  const requested = [{ id: 'a', text: '第一句' }, { id: 'b', text: '第二句' }];
  assert.deepEqual(validateCorrectionResults(requested, [{ id: 'b', text: '第二句。' }, { id: 'a', text: '第一句。' }]),
    [{ id: 'a', text: '第一句。' }, { id: 'b', text: '第二句。' }]);
  assert.throws(() => validateCorrectionResults(requested, [{ id: 'a', text: '第一句。' }]), /缺少 1 条.*id: b/);
  assert.throws(() => validateCorrectionResults(requested, [{ id: 'a', text: 'A' }, { id: 'a', text: 'A2' }]), /重复 1 条.*id: a/);
  assert.throws(() => validateCorrectionResults(requested, [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'x', text: 'X' }]),
    /多出 1 条未知 id.*x/);
  assert.throws(() => validateCorrectionResults(requested, [{ id: 'a', text: 'A' }, { id: 'b', text: '   ' }]), /空文本 1 条.*id: b/);
  assert.throws(() => validateCorrectionResults(requested, 'not-an-array'), /不是数组/);
});

test('F-0013 batches keep order and stay bounded', () => {
  const items = Array.from({ length: 7 }, (_, index) => ({ id: String(index), text: '字'.repeat(3) }));
  const batches = splitCorrectionBatches(items, 3, 100);
  assert.deepEqual(batches.map(batch => batch.map(item => item.id)), [['0', '1', '2'], ['3', '4', '5'], ['6']]);
  const byChars = splitCorrectionBatches(items, 100, 7);
  assert.deepEqual(byChars.map(batch => batch.map(item => item.id)), [['0', '1'], ['2', '3'], ['4', '5'], ['6']]);
});

test('F-0013 text history keeps the newest 100 records', () => {
  const records = Array.from({ length: 105 }, (_, index) => record(`r-${index}`, `2026-11-09T00:00:${String(index).padStart(2, '0')}Z`,
    [['a', 'old']], [['a', `new-${index}`]]));
  const trimmed = trimTextHistory(records);
  assert.equal(trimmed.length, MAX_TEXT_HISTORY);
  assert.equal(trimmed[0].id, 'r-5');
  assert.equal(trimmed.at(-1).id, 'r-104');
});

test('F-0013 a text record contains only changed text and never other subtitle fields', () => {
  const chunks = [
    { id: 'a', text: '旧', timestamp: [0, 1], secondText: '译文', wordIds: ['w1'] },
    { id: 'b', text: '不变', timestamp: [1, 2] },
  ];
  const after = applyTextSnapshots(chunks, [{ id: 'a', text: '新' }]);
  assert.equal(after[0].text, '新');
  assert.deepEqual(after[0].timestamp, [0, 1]);
  assert.equal(after[0].secondText, '译文');
  assert.deepEqual(after[0].wordIds, ['w1']);
  assert.equal(after[1], chunks[1]);
  const entry = createTextRecord('ai-correction', chunks, after, { id: 'record', at: '2026-11-09T00:00:00Z' });
  assert.deepEqual(entry, { id: 'record', at: '2026-11-09T00:00:00Z', kind: 'ai-correction',
    before: [{ id: 'a', text: '旧' }], after: [{ id: 'a', text: '新' }] });
  assert.equal(createTextRecord('ai-correction', chunks, chunks, { id: 'none' }), null);
});

test('F-0013 restore is blocked by later edits and creates a new restore record', () => {
  const chunks = [{ id: 'a', text: '新' }, { id: 'b', text: '不动' }];
  const history = [record('ai', '2026-11-09T00:00:00Z', [['a', '旧']], [['a', '新']])];
  const conflict = planTextRestore(history, [{ id: 'a', text: '后来手动改的' }, chunks[1]], 'ai');
  assert.deepEqual(conflict, { ok: false, reason: 'conflict', ids: ['a'] });
  const plan = planTextRestore(history, chunks, 'ai', { newId: 'restore', at: '2026-11-09T00:01:00Z' });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.changes, [{ id: 'a', text: '旧' }]);
  assert.deepEqual(plan.record, { id: 'restore', at: '2026-11-09T00:01:00Z', kind: 'history-restore',
    before: [{ id: 'a', text: '新' }], after: [{ id: 'a', text: '旧' }] });
  assert.deepEqual(planTextRestore(history, chunks, 'missing'), { ok: false, reason: 'missing', ids: [] });
});

test('F-0013 text updates reject duplicate, unknown, empty and stale ids atomically', () => {
  const chunks = [{ id: 'a', text: '旧' }, { id: 'b', text: '原文' }];
  assert.deepEqual(validateTextUpdates(chunks, []), { ok: false, reason: 'empty', ids: [] });
  assert.deepEqual(validateTextUpdates(chunks, [{ id: 'a', text: '新' }, { id: 'a', text: '再新' }]),
    { ok: false, reason: 'duplicate', ids: ['a'] });
  assert.deepEqual(validateTextUpdates(chunks, [{ id: 'x', text: '新' }]), { ok: false, reason: 'unknown', ids: ['x'] });
  assert.deepEqual(validateTextUpdates(chunks, [{ id: 'a', text: ' ' }]), { ok: false, reason: 'blank', ids: ['a'] });
  assert.deepEqual(validateTextUpdates(chunks, [{ id: 'a', before: '过期', text: '新' }]), { ok: false, reason: 'stale', ids: ['a'] });
  assert.deepEqual(validateTextUpdates(chunks, [{ id: 'a', before: '旧', text: '新' }]), { ok: true, changes: [{ id: 'a', text: '新' }] });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  anchoredScrollTop,
  createVirtualLayout,
  findFirstVisible,
  findVirtualRange,
  isVirtualIndexVisible,
  scrollOffsetForIndex,
} from '../../src/components/SubtitleEditor/virtualRows';

test('F-0017/AC-4 variable rows build exact prefix offsets and binary ranges', () => {
  const layout = createVirtualLayout([100, 120, 80], 3, 104);
  assert.deepEqual(layout.starts, [0, 100, 220]);
  assert.equal(layout.totalSize, 300);
  assert.equal(findFirstVisible(layout, 0), 0);
  assert.equal(findFirstVisible(layout, 100), 1);
  assert.equal(findFirstVisible(layout, 220), 2);
  assert.deepEqual(findVirtualRange(layout, 110, 100, 0), { start: 1, end: 2 });
  assert.equal(isVirtualIndexVisible(layout, 1, 100, 150), true);
  assert.equal(isVirtualIndexVisible(layout, 2, 100, 150), false);
});

test('F-0017/AC-8 auto scroll moves only when the target is outside the current viewport', () => {
  const layout = createVirtualLayout([100, 120, 80, 60], 4, 104);
  assert.equal(scrollOffsetForIndex(layout, 1, 100, 150, 'auto'), 100, 'already visible stays put');
  assert.equal(scrollOffsetForIndex(layout, 0, 160, 100, 'auto'), 0, 'above target aligns its top');
  assert.equal(scrollOffsetForIndex(layout, 3, 0, 200, 'auto'), 160, 'below target aligns its bottom');
  assert.equal(scrollOffsetForIndex(layout, 1, 0, 200, 'center'), 60);
  assert.equal(scrollOffsetForIndex(layout, 3, 0, 100, 'start'), 260);
});

test('F-0017/AC-4 height measurements above the viewport keep the visible anchor stable', () => {
  const before = createVirtualLayout([100, 100, 100, 100], 4, 104);
  const after = createVirtualLayout([160, 100, 100, 100], 4, 104);
  assert.equal(anchoredScrollTop(before, after, 120), 180);
  assert.equal(findFirstVisible(after, 180), 1);
});

test('F-0017/AC-10 setTranscript never logs subtitle text', async () => {
  const { createHistoryStore } = await import('../../src/stores/historyStore');
  const store = createHistoryStore();
  const chunks = Array.from({ length: 1173 }, (_, index) => ({
    id: `row-${index}`,
    text: `这是一条不能被打印到控制台的长字幕-${index}`,
    timestamp: [index * 3, index * 3 + 2] as [number, number],
  }));
  const calls: unknown[][] = [];
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  for (const method of Object.keys(original) as Array<keyof typeof original>) {
    console[method] = (...args: unknown[]) => { calls.push(args); };
  }
  try {
    store.getState().setTranscript({ text: chunks.map(chunk => chunk.text).join(' '), language: 'zh', duration: 3600, chunks });
  } finally {
    Object.assign(console, original);
  }
  assert.equal(store.getState().chunks.length, 1173);
  assert.doesNotMatch(JSON.stringify(calls), /不能被打印到控制台的长字幕/);
});


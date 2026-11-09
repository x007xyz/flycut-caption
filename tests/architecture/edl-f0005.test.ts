import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEdl, changeCuts, deriveKept, outputDuration, outputToSource, sourceToOutput, projectCues, migrateLegacy } from '../../shared/editing/edl';

test('F-0005/AC-1 explicit deletion preserves leading/trailing silence and merges overlaps exactly', () => {
  const edl = createEdl(10, [{ start: 2, end: 4 }, { start: 3, end: 5 }]);
  assert.equal(outputDuration(edl), 7);
  assert.deepEqual(deriveKept(edl).map(r => [r.startUs, r.endUs]), [[0, 2e6], [5e6, 10e6]]);
  assert.equal(outputDuration(changeCuts(edl, [{ start: 2, end: 4 }])), 7);
  assert.equal(outputDuration(changeCuts(edl, [{ start: 3, end: 4 }], false)), 8);
  assert.equal(deriveKept(createEdl(1, [{ start: 0, end: 0.4 }, { start: 0.400001, end: 1 }]))[0].endUs, 400001);
});
test('F-0005/AC-3 half-open joins, deleted source positions and terminal endpoints', () => {
  const edl = createEdl(10, [{ start: 2, end: 4 }, { start: 8, end: 10 }]);
  assert.equal(outputToSource(edl, 2), 4);
  assert.equal(outputToSource(edl, 6), 8);
  assert.equal(sourceToOutput(edl, 3), 2);
  assert.equal(sourceToOutput(edl, 9), 6);
  for (const t of [0, 0.5, 1.999, 2, 3.333, 5.999]) assert.equal(sourceToOutput(edl, outputToSource(edl, t)!), t);
});
test('F-0005/AC-4 crossing cue splits rather than spanning deleted content', () => {
  const cue = { id: 's', text: '校对后的原文', secondText: 'Translation', timestamp: [1, 7] as [number, number] };
  const result = projectCues(createEdl(10, [{ start: 2, end: 4 }]), [cue]);
  assert.deepEqual(result.map(c => c.timestamp), [[1, 2], [2, 5]]);
  assert.equal(result[1].secondText, 'Translation'); assert.deepEqual(cue.timestamp, [1, 7]);
});
test('F-0005/AC-7 migration preserves the historical Host tail-only fast path', () => {
  const chunks = [{ id: 'a', text: 'a', timestamp: [0, 2] as [number, number] },
    { id: 'b', text: 'b', timestamp: [4, 6] as [number, number], deleted: true }];
  assert.equal(outputDuration(migrateLegacy(10, chunks, [], false)), 10);
  assert.equal(outputDuration(createEdl(10, [{ start: 4, end: 6 }])), 8);
});
test('F-0005/AC-9 AC-10 all deleted has no fake playable position; invalid input is rejected', () => {
  const edl = createEdl(10, [{ start: 0, end: 10 }]);
  assert.equal(outputDuration(edl), 0); assert.equal(outputToSource(edl, 0), null);
  for (const span of [{ start: -1, end: 1 }, { start: 1, end: 11 }, { start: 1, end: 1 }, { start: NaN, end: 1 }])
    assert.throws(() => createEdl(10, [span]));
  assert.throws(() => createEdl(0));
});

test('F-0005/AC-1 AC-6 AC-11 store cuts are atomic; pending previews never enter persisted history', async () => {
  const { createHistoryStore, editingOf } = await import('../../src/stores/historyStore');
  const store = createHistoryStore();
  store.getState().setTranscript({ text: '甲乙', language: 'zh', duration: 10,
    chunks: [{ id: 'a', text: '甲', timestamp: [1, 3] }, { id: 'b', text: '乙', timestamp: [5, 7] }] });
  store.getState().delete('a');
  assert.equal(store.getState().duration, 8);
  const saved = editingOf(store.getState());
  store.getState().proposeCuts([{ start: 3, end: 5 }]); store.getState().previewPending(true);
  assert.deepEqual(editingOf(store.getState()), saved);
  store.getState().cancelPending(); assert.equal(store.getState().duration, 8);
  store.getState().undo(); assert.equal(store.getState().duration, 10);
  store.getState().redo(); assert.equal(store.getState().duration, 8);
  store.getState().proposeCuts([{ start: 3, end: 5 }]); store.getState().confirmPending();
  assert.equal(store.getState().duration, 6); assert.equal(store.getState().pendingCuts, null);
  store.getState().undo(); assert.equal(store.getState().duration, 8);
});

test('F-0005/AC-12 persisted cut restore survives reopening and preserves later corrections', async () => {
  const { createHistoryStore, editingOf } = await import('../../src/stores/historyStore');
  const store = createHistoryStore();
  const transcript = { text: '甲', language: 'zh', duration: 10, chunks: [{ id: 'a', text: '甲', timestamp: [1, 3] as [number, number] }] };
  store.getState().setTranscript(transcript); store.getState().delete('a');
  const initial = store.getState().cutHistory[0].id;
  const editing = editingOf(store.getState());
  const reopen = createHistoryStore(); reopen.getState().setTranscript({ ...transcript, chunks: store.getState().chunks, editing });
  reopen.getState().updateChunkText('a', '后来校对'); reopen.getState().restoreHistory(initial);
  assert.equal(reopen.getState().duration, 10);
  assert.equal(reopen.getState().chunks[0].text, '后来校对');
  assert.equal(reopen.getState().chunks[0].deleted, false);
  assert.equal(reopen.getState().cutHistory.at(-1)?.kind, 'history-restore');
});

test('F-0005/AC-10 AC-11 stale suggestions and invalid cuts leave the formal result unchanged', async () => {
  const { createHistoryStore } = await import('../../src/stores/historyStore');
  const store = createHistoryStore();
  store.getState().setTranscript({ text: '甲', language: 'zh', duration: 10, chunks: [{ id: 'a', text: '甲', timestamp: [1, 3] }] });
  store.getState().proposeCuts([{ start: 3, end: 4 }]); store.getState().updateChunkText('a', '校对'); store.getState().confirmPending();
  assert.equal(store.getState().duration, 10); assert.match(store.getState().cutError!, /outdated/);
  store.getState().cancelPending(); store.getState().insertBlankChunks([{ start: 9, end: 11 }]);
  assert.equal(store.getState().duration, 10); assert.equal(store.getState().cutHistory.length, 0);
});

test('F-0005/AC-1 AC-5 export adapter retains all unselected gaps rather than exporting only kept subtitles', async () => {
  const { buildVideoExportSegments } = await import('../../src/utils/videoExportSegments');
  assert.deepEqual(buildVideoExportSegments({ duration: 10, hasWordTimestamps: false,
    chunks: [{ id: 'a', text: '删除', timestamp: [1, 3], deleted: true }, { id: 'b', text: '保留', timestamp: [6, 8] }] }),
  [{ start: 0, end: 1, keep: true }, { start: 3, end: 10, keep: true }]);
});

test('F-0005/AC-4 subtitle formats share projected cuts and omit unrepresentable zero-length cues', async () => {
  const { chunksToSrt, chunksToVtt, chunksToJson, chunksToAss } = await import('../../src/subtitle/exportFormats');
  const { defaultSubtitleStylePair } = await import('../../src/subtitle/subtitleStyle');
  const cue = { id: 's', text: '主字幕', secondText: 'Translation', timestamp: [1, 7] as [number, number] };
  const projected = projectCues(createEdl(10, [{ start: 2, end: 4 }]), [cue]);
  assert.match(chunksToSrt(projected), /00:00:01,000 --> 00:00:02,000/);
  assert.match(chunksToVtt(projected), /00:00:02.000 --> 00:00:05.000/);
  assert.deepEqual(JSON.parse(chunksToJson(projected)).map((c: {timestamp: number[]}) => c.timestamp), [[1, 2], [2, 5]]);
  assert.equal(chunksToSrt([{ ...cue, timestamp: [0, 0.0001] }]), '');
  assert.equal(chunksToAss([{ ...cue, timestamp: [0, 0.001] }], { playResX: 1920, playResY: 1080, stylePair: defaultSubtitleStylePair }).includes('Dialogue:'), false);
});

test('F-0005/AC-6 AC-8 sixty-minute project remains atomic across twenty delete/undo operations', async () => {
  const { createHistoryStore } = await import('../../src/stores/historyStore');
  const store = createHistoryStore();
  const chunks = Array.from({ length: 10000 }, (_, i) => ({ id: `s${i}`, text: `字幕${i}`, timestamp: [i * 0.36, i * 0.36 + 0.2] as [number, number] }));
  store.getState().setTranscript({ text: '', language: 'zh', duration: 3600, chunks });
  let maximum = 0;
  for (let i = 0; i < 20; i++) {
    const start = performance.now(); store.getState().delete(`s${i * 400}`); maximum = Math.max(maximum, performance.now() - start);
    assert.equal(store.getState().duration, 3599.8);
    store.getState().undo(); assert.equal(store.getState().duration, 3600);
  }
  console.log(`F-0005 60min/10000 cues/20 delete+undo: max delete ${maximum.toFixed(2)}ms`);
  assert.ok(maximum < 200, `delete took ${maximum}ms`);
});

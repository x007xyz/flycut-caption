// F-0013 client text history and project persistence: one atomic text batch, bounded append-only records.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHistoryStore } from '../../src/stores/historyStore.ts';
import { ProjectStore } from '../../server/projects/store.ts';

const transcript = { text: '旧 原文', language: 'zh', duration: 4,
  chunks: [
    { id: 'a', text: '旧', timestamp: [0, 1] as [number, number], secondText: '译文', wordIds: ['w1'] },
    { id: 'b', text: '原文', timestamp: [1, 2] as [number, number] },
  ] };

const makeStore = () => {
  const store = createHistoryStore();
  store.getState().setTranscript(transcript);
  return store;
};

test('F-0013/AC-7 AC-9 one text batch is atomic, leaves timestamps/translations/EDL alone, and undo/redo restores text', () => {
  const store = makeStore();
  const before = store.getState();
  const result = before.applyTextBatch([{ id: 'a', before: '旧', text: '新' }]);
  assert.deepEqual(result, { ok: true, count: 1 });
  const applied = store.getState();
  assert.equal(applied.chunks[0].text, '新');
  assert.equal(applied.chunks[0].secondText, '译文');
  assert.deepEqual(applied.chunks[0].timestamp, [0, 1]);
  assert.deepEqual(applied.chunks[0].wordIds, ['w1']);
  assert.deepEqual(applied.edl, before.edl);
  assert.deepEqual(applied.cutHistory, before.cutHistory);
  assert.equal(applied.textHistory.length, 1);
  assert.deepEqual(applied.textHistory[0].before, [{ id: 'a', text: '旧' }]);
  assert.deepEqual(applied.textHistory[0].after, [{ id: 'a', text: '新' }]);

  applied.undo();
  assert.equal(store.getState().chunks[0].text, '旧');
  assert.equal(store.getState().textHistory[0].kind, 'ai-correction', 'undo does not erase the operation record');
  store.getState().redo();
  assert.equal(store.getState().chunks[0].text, '新');
});

test('F-0013/AC-9 text history keeps at most 100 records and restore conflicts with later edits', () => {
  const store = makeStore();
  for (let index = 0; index < 105; index++) {
    const text = `v${index}`;
    const result = store.getState().applyTextBatch([{ id: 'a', text }]);
    assert.equal(result.ok, true);
  }
  const history = store.getState().textHistory;
  assert.equal(history.length, 100);
  assert.match(history[0].after[0].text, /^v5$/);
  assert.match(history.at(-1)!.after[0].text, /^v104$/);

  const recordId = history.at(-1)!.id;
  store.getState().update('a', { text: 'later' });
  const conflict = store.getState().restoreTextHistory(recordId);
  assert.deepEqual(conflict, { ok: false, error: 'conflict' });
  assert.equal(store.getState().chunks[0].text, 'later', 'a conflict never overwrites a later edit');

  const cleanId = store.getState().textHistory.at(-1)!.id;
  store.getState().update('a', { text: 'later' });
  const clean = store.getState().textHistory.find(item => item.id === cleanId)!;
  // Make the affected text match the record again: this simulates the user undoing the later edit.
  store.getState().update('a', { text: clean.after[0].text });
  const restored = store.getState().restoreTextHistory(cleanId);
  assert.equal(restored.ok, true);
  assert.equal(store.getState().chunks[0].text, clean.before[0].text);
  assert.equal(store.getState().textHistory.at(-1)!.kind, 'history-restore');
  assert.equal(store.getState().textHistory.filter(item => item.id === cleanId).length, 1, 'the original record stays');
});

test('F-0013/AC-9 textHistory is a format-3 additive project field, bounded by ProjectStore and readable on open', async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0013-'));
  try {
    const store = new ProjectStore(home);
    await store.init();
    const project = await store.create({ name: '文字历史', video: { name: 'v.mp4', durationSeconds: 4 },
      media: async () => ({ kind: 'stored', file: `media/${randomUUID()}.mp4`, size: 1, mimeType: 'video/mp4' }) });
    const videoId = project.videos[0].id;
    await store.writeTranscript(project.id, videoId, transcript);
    const textHistory = Array.from({ length: 105 }, (_, index) => ({
      id: `record-${index}`, at: new Date(2026, 10, 9, 0, 0, index).toISOString(), kind: 'ai-correction' as const,
      before: [{ id: 'a', text: '旧' }], after: [{ id: 'a', text: `新-${index}` }],
    }));
    await store.writeEdits(project.id, videoId, { chunks: [{ id: 'a', text: '新-104', timestamp: [0, 1] }], deletedWordIds: [], textHistory });
    const raw = JSON.parse(await readFile(join(home, 'projects', project.id, 'videos', videoId, 'edits.json'), 'utf8'));
    assert.equal(raw.textHistory.length, 100);
    assert.equal(raw.textHistory[0].id, 'record-5');
    const edits = await store.readEdits(project.id, videoId);
    assert.equal(edits?.textHistory?.length, 100);
    assert.equal(edits?.textHistory?.at(-1)?.id, 'record-104');
    const projectRaw = JSON.parse(await readFile(join(home, 'projects', project.id, 'project.json'), 'utf8'));
    assert.equal(projectRaw.formatVersion, 3, 'the optional field does not bump the project format');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('F-0013/AC-9 undo/redo of an AI correction append records, so the saved history matches the text', () => {
  const store = makeStore();
  store.getState().applyTextBatch([{ id: 'a', before: '旧', text: '新' }]);
  store.getState().undo();
  assert.equal(store.getState().chunks[0].text, '旧');
  assert.deepEqual(store.getState().textHistory.map(record => [record.kind, record.after[0].text]), [['ai-correction', '新'], ['undo', '旧']]);
  store.getState().redo();
  assert.equal(store.getState().chunks[0].text, '新');
  assert.deepEqual(store.getState().textHistory.map(record => record.kind), ['ai-correction', 'undo', 'redo']);
  // The latest record now matches the current text, so restoring it is not a false conflict.
  const latest = store.getState().textHistory.at(-1)!;
  assert.equal(store.getState().restoreTextHistory(latest.id).ok, true);
  assert.equal(store.getState().chunks[0].text, '旧');
});

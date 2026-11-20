import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSentenceSplits, countChars, isSplitBaseCurrent, splitBase, validateSplitPlans,
  type SplitPlan, type SplitSourceChunk, type SplitSourceWord } from '../../shared/asr/sentenceSplitting.ts';
import { createHistoryStore } from '../../src/stores/historyStore.ts';
import { createEdl } from '../../shared/editing/edl/index.ts';

const word = (id: string, text: string, start: number, end: number, sentenceId = 'c1'): SplitSourceWord =>
  ({ id, text, timestamp: [start, end], sentenceId });

const zhWords = (): SplitSourceWord[] => [
  word('w1', '我', 0, 0.1), word('w2', '们', 0.1, 0.2), word('w3', '今', 0.2, 0.3), word('w4', '天', 0.3, 0.4),
  word('w5', '来', 0.4, 0.5), word('w6', '聊', 0.5, 0.6), word('w7', '聊', 0.6, 0.7), word('w8', '，', 0.7, 0.8),
  word('w9', '字', 0.8, 0.9), word('w10', '幕', 0.9, 1.0), word('w11', '断', 1.0, 1.1), word('w12', '句', 1.1, 1.2),
  word('w13', '的', 1.2, 1.3), word('w14', '问', 1.3, 1.4), word('w15', '题', 1.4, 1.5), word('w16', '。', 1.5, 1.6),
];

const zhChunk = (words: SplitSourceWord[], patch: Partial<SplitSourceChunk> = {}): SplitSourceChunk => ({
  id: 'c1', text: '我们今天来聊聊，字幕断句的问题。', timestamp: [0, 1.6],
  wordIds: words.map(item => item.id), ...patch,
});

test('F-0020/AC-1 splits long Chinese sentences only on word boundaries without inventing timing', () => {
  const words = zhWords();
  const chunk = zhChunk(words);
  const analysis = analyzeSentenceSplits([chunk], words, { maxChars: 8 });
  assert.equal(analysis.suggestions.length, 1);
  const [suggestion] = analysis.suggestions;
  assert.ok(suggestion.pieces.length >= 2);
  assert.equal(suggestion.pieces.map(piece => piece.text).join(''), chunk.text);
  assert.equal(suggestion.pieces.flatMap(piece => piece.wordIds).length, words.length);
  for (const piece of suggestion.pieces) {
    const first = words.find(item => item.id === piece.wordIds[0])!;
    const last = words.find(item => item.id === piece.wordIds.at(-1))!;
    assert.deepEqual(piece.timestamp, [first.timestamp[0], last.timestamp[1]]);
    assert.ok(countChars(piece.text) <= 8 + 2);
  }
});

test('F-0020/AC-1 keeps short sentences untouched and splits English on word boundaries', () => {
  const shortWords = [word('a1', '你', 0, 0.2), word('a2', '好', 0.2, 0.4)];
  const short = zhChunk(shortWords, { id: 'short', text: '你好', timestamp: [0, 0.4], wordIds: ['a1', 'a2'] });
  const englishWords = [
    word('e1', 'hello ', 2, 2.2), word('e2', 'world ', 2.2, 2.4), word('e3', 'this ', 2.4, 2.6),
    word('e4', 'is ', 2.6, 2.8), word('e5', 'a ', 2.8, 3), word('e6', 'long ', 3, 3.2), word('e7', 'sentence', 3.2, 3.4),
  ];
  const english = zhChunk(englishWords, { id: 'en', text: 'hello world this is a long sentence', timestamp: [2, 3.4],
    wordIds: englishWords.map(item => item.id) });
  const analysis = analyzeSentenceSplits([short, english], [...shortWords, ...englishWords], { maxChars: 12 });
  assert.equal(analysis.suggestions.length, 1);
  assert.equal(analysis.suggestions[0].chunkId, 'en');
  assert.equal(analysis.skipped.short, 1);
  assert.equal(analysis.overLimit, 0);
  assert.equal(analysis.suggestions[0].pieces.map(piece => piece.text).join(' '), 'hello world this is a long sentence');
});

test('F-0020/AC-1 marks a piece that cannot be split because one word token is longer than the limit', () => {
  const words = [word('l1', 'short ', 0, 0.2), word('l2', 'averylongsinglewordtokenthatcannotbesplit', 0.2, 1.4)];
  const chunk = zhChunk(words, { id: 'long-token', text: 'short averylongsinglewordtokenthatcannotbesplit', timestamp: [0, 1.4],
    wordIds: words.map(item => item.id) });
  const analysis = analyzeSentenceSplits([chunk], words, { maxChars: 10 });
  const pieces = analysis.suggestions[0].pieces;
  assert.equal(pieces.length, 2);
  assert.equal(analysis.overLimit, 1);
  assert.equal(pieces[1].limited, true);
  assert.equal(pieces.map(piece => piece.text).join(' '), chunk.text);
});

test('F-0020/AC-4 skips a long cue when its words no longer spell the displayed text', () => {
  const words = [
    word('m1', '我们', 0, 0.2), word('m2', '邀请', 0.2, 0.4), word('m3', '到', 0.4, 0.5),
    word('m4', 'Tomy', 0.5, 0.7), word('m5', '。', 0.7, 0.8),
  ];
  const chunk = zhChunk(words, { id: 'mismatch', text: '我们邀请到 Tommy。这是已校对的长字幕内容。', timestamp: [0, 0.8],
    wordIds: words.map(item => item.id) });
  const analysis = analyzeSentenceSplits([chunk], words, { maxChars: 10 });
  assert.equal(analysis.suggestions.length, 0);
  assert.equal(analysis.skipped.mismatch, 1);
});

test('F-0020/AC-3 AC-4 skips cues without reliable words, translations, keywords or dubbing', () => {
  const words = zhWords();
  const noWords: SplitSourceChunk = { id: 'no-words', text: '这是一段没有字词时间戳而且很长的字幕内容', timestamp: [2, 3] };
  const translated = zhChunk(words, { id: 'translated', secondText: 'translated' });
  const keyworded = zhChunk(words, { id: 'keyworded', keywords: [{ start: 0, end: 2 }] });
  const dubbed = zhChunk(words, { id: 'dubbed' });
  const bad: SplitSourceWord[] = words.map((item, index) => index === 3 ? { ...item, timestamp: [0.4, 0.3] } : item);
  const invalid = zhChunk(bad, { id: 'invalid' });
  const analysis = analyzeSentenceSplits([noWords, translated, keyworded, dubbed, invalid], bad, {
    maxChars: 8, dubbingChunkIds: new Set(['dubbed']),
  });
  assert.equal(analysis.suggestions.length, 0);
  assert.deepEqual(analysis.skipped, { noWords: 2, mismatch: 0, translated: 1, keyworded: 1, dubbed: 1, short: 0 });
});

test('F-0020/AC-3 validateSplitPlans rejects lost or duplicated words, bad timing and protected cues', () => {
  const words = zhWords();
  const chunk = zhChunk(words);
  const analysis = analyzeSentenceSplits([chunk], words, { maxChars: 8 });
  const plan = (): SplitPlan => ({
    chunkId: 'c1',
    pieces: analysis.suggestions[0].pieces.map(piece => ({ text: piece.text, timestamp: piece.timestamp, wordIds: [...piece.wordIds] })),
  });
  assert.deepEqual(validateSplitPlans([chunk], [plan()]), { ok: true });
  assert.deepEqual(validateSplitPlans([chunk], []), { ok: false, reason: 'empty' });

  const duplicated = plan();
  duplicated.pieces[1].wordIds = [...duplicated.pieces[1].wordIds, duplicated.pieces[0].wordIds[0]];
  assert.deepEqual(validateSplitPlans([chunk], [duplicated]), { ok: false, reason: 'word-mismatch' });

  const missing = plan();
  missing.pieces[1].wordIds = missing.pieces[1].wordIds.slice(1);
  assert.deepEqual(validateSplitPlans([chunk], [missing]), { ok: false, reason: 'word-mismatch' });

  const badTime = plan();
  badTime.pieces[0].timestamp = [5, 6];
  assert.deepEqual(validateSplitPlans([chunk], [badTime]), { ok: false, reason: 'invalid-time' });

  const translated = zhChunk(words, { secondText: '译文' });
  assert.deepEqual(validateSplitPlans([translated], [plan()]), { ok: false, reason: 'protected' });
});

test('F-0020/AC-2 AC-3 AC-7 applies all splits as one undoable edit and leaves EDL and translations alone', () => {
  const words = zhWords();
  const transcript = {
    text: '我们今天来聊聊，字幕断句的问题。',
    language: 'zh',
    duration: 4,
    chunks: [zhChunk(words, { speaker: 'S1' })],
    wordChunks: words,
    hasWordTimestamps: true,
    editing: { edl: createEdl(4, [{ start: 3, end: 3.5 }]), history: [] },
  };
  const store = createHistoryStore();
  store.getState().setTranscript(transcript as never);
  const before = store.getState();
  const analysis = analyzeSentenceSplits(before.chunks as never, before.wordChunks as never, { maxChars: 8 });
  const plans: SplitPlan[] = analysis.suggestions.map(suggestion => ({
    chunkId: suggestion.chunkId,
    pieces: suggestion.pieces.map((piece, index) => ({
      text: index === 0 ? `${piece.text}嗯` : piece.text,
      timestamp: piece.timestamp,
      wordIds: piece.wordIds,
    })),
  }));
  const result = before.applySentenceSplits(plans);
  assert.deepEqual(result, { ok: true, count: 1 });

  const applied = store.getState();
  assert.equal(applied.chunks.length, analysis.suggestions[0].pieces.length);
  assert.ok(applied.chunks.every(chunk => chunk.speaker === 'S1' && chunk.deleted === false));
  assert.deepEqual(applied.edl, before.edl);
  assert.deepEqual(applied.deletedWordIds ?? [], []);
  const sentenceOf = new Map(applied.chunks.flatMap(chunk => (chunk.wordIds ?? []).map(id => [id, chunk.id] as const)));
  for (const item of applied.wordChunks) assert.equal(item.sentenceId, sentenceOf.get(item.id));

  applied.undo();
  assert.equal(store.getState().chunks.length, 1);
  assert.equal(store.getState().chunks[0].text, before.chunks[0].text);
  assert.equal(store.getState().wordChunks[0].sentenceId, 'c1');
  store.getState().redo();
  assert.equal(store.getState().chunks.length, applied.chunks.length);
});

test('F-0020/AC-3 AC-8 the analysis base becomes stale when subtitles or word timing change', () => {
  const words = zhWords();
  const chunk = zhChunk(words);
  const base = splitBase([chunk], words);
  assert.equal(isSplitBaseCurrent(base, [chunk], words), true);
  assert.equal(isSplitBaseCurrent(base, [{ ...chunk, text: '改过的字幕' }], words), false);
  assert.equal(isSplitBaseCurrent(base, [chunk], [{ ...words[0], timestamp: [0, 0.2] }, ...words.slice(1)]), false);
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDraft, formatClock, mergeSentence } from './lib/referenceDraft.mjs';

describe('mergeSentence', () => {
  it('keeps model A punctuation when the texts agree', () => {
    assert.deepEqual(mergeSentence('那大家好，我是易伟。', '那大家好我是易伟'), { text: '那大家好，我是易伟。', conflicts: 0 });
  });

  it('marks a substitution with both readings', () => {
    assert.deepEqual(mergeSentence('他是在提测的时候，', '他是在骑车的时候'), { text: '他是在{提测|骑车}的时候，', conflicts: 1 });
  });

  it('marks a filler only one model heard', () => {
    assert.deepEqual(mergeSentence('就像是一些问题', '就像是呃一些问题'), { text: '就像是{∅|呃}一些问题', conflicts: 1 });
    assert.deepEqual(mergeSentence('就像是呃一些问题。', '就像是一些问题'), { text: '就像是{呃|∅}一些问题。', conflicts: 1 });
  });

  it('marks text missing at the end of the sentence', () => {
    assert.deepEqual(mergeSentence('谢谢', '谢谢大家'), { text: '谢谢{∅|大家}', conflicts: 1 });
  });

  it('compares English case-insensitively', () => {
    assert.equal(mergeSentence('用 GitHub 做', '用github做').conflicts, 0);
  });

  it('does not flag spellings that sound the same', () => {
    assert.equal(mergeSentence('它的跑得很快，有6个', '他地跑的很快有六个').conflicts, 0);
    assert.equal(mergeSentence('ＡＩ工程师', 'ai工程师').conflicts, 0);
  });

  it('compares English by word and shows model B words with spaces', () => {
    assert.deepEqual(mergeSentence('叫 open-slide 的框架', '叫 open slight 的框架'), { text: '叫 open-{slide|slight} 的框架', conflicts: 1 });
    assert.deepEqual(mergeSentence('用 agent 做', '用 coding agent 做'), { text: '用 {∅|coding}agent 做', conflicts: 1 });
  });

  it('matches acronyms that model B spells letter by letter', () => {
    assert.equal(mergeSentence('一位AI工程师，扫 QR Code', '一位a i工程师扫q r code').conflicts, 0);
    assert.equal(mergeSentence('用 a b 测试', '用ab测试').conflicts, 0);
  });
});

describe('buildDraft', () => {
  const a = { chunks: [
    { text: '开场。', timestamp: [0, 1] },
    { text: '大家好，', timestamp: [2, 3] },
    { text: '我是易伟。', timestamp: [3, 4.5] },
  ] };
  const b = { wordChunks: [
    { text: '开', timestamp: [0, 0.5] }, { text: '场', timestamp: [0.5, 1] },
    { text: '大', timestamp: [2, 2.2] }, { text: '家', timestamp: [2.2, 2.4] }, { text: '好', timestamp: [2.4, 2.6] },
    { text: '呃', timestamp: [2.7, 2.9] },
    { text: '我', timestamp: [3, 3.3] }, { text: '是', timestamp: [3.3, 3.6] }, { text: '一', timestamp: [3.6, 3.9] }, { text: '伟', timestamp: [3.9, 4.2] },
  ] };

  it('assigns model B words to model A sentences by time and keeps only the range', () => {
    const draft = buildDraft(a, b, { start: 2, end: 10 });
    assert.deepEqual(draft.map((s) => s.text), ['大家好，{∅|呃}', '我是{易|一}伟。']);
    assert.equal(draft[0].start, 2);
  });

  it('does not report a conflict when the models split sentences differently', () => {
    const shifted = { wordChunks: [
      { text: '大', timestamp: [2, 2.2] }, { text: '家', timestamp: [2.2, 2.4] },
      { text: '好', timestamp: [3.05, 3.1] }, { text: '我', timestamp: [3.1, 3.3] }, { text: '是', timestamp: [3.3, 3.6] },
      { text: '易', timestamp: [3.6, 3.9] }, { text: '伟', timestamp: [3.9, 4.2] },
    ] };
    assert.deepEqual(buildDraft(a, shifted, { start: 2, end: 10 }).map((s) => s.conflicts), [0, 0]);
  });

  it('splits a conflict that spans two sentences', () => {
    const merged = { wordChunks: [{ text: '大', timestamp: [2, 2.2] }, { text: '佳', timestamp: [2.2, 2.4] }, { text: '我', timestamp: [3, 3.3] }, { text: '是', timestamp: [3.3, 3.6] }, { text: '易', timestamp: [3.6, 3.9] }, { text: '伟', timestamp: [3.9, 4.2] }] };
    assert.deepEqual(buildDraft({ chunks: [{ text: '大家', timestamp: [2, 3] }, { text: '好我是易伟', timestamp: [3, 4.5] }] }, merged, { start: 2, end: 10 }).map((s) => s.text),
      ['大{家|佳}', '{好|∅}我是易伟']);
  });
});

describe('formatClock', () => {
  it('formats minutes and tenths of a second', () => {
    assert.equal(formatClock(49.24), '00:49.2');
    assert.equal(formatClock(1430.06), '23:50.1');
  });
});

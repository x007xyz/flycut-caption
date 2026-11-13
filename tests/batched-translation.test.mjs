import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_TRANSLATION_LIMITS,
  evaluateTranslationConstraints,
  groupTranslationSentences,
  splitTranslationBatches,
  validateTranslationResults,
} from '../shared/text/translation.ts';

describe('F-0031/AC-1 semantic sentence grouping & context-aware batching', () => {
  it('merges adjacent cues without terminal punctuation into one semantic sentence and breaks on period or pause', () => {
    const cues = [
      { id: 'c1', text: '今天我们来聊聊', timestamp: [0, 1.0] },
      { id: 'c2', text: '如何高效地剪辑口播视频。', timestamp: [1.0, 2.5] },
      { id: 'c3', text: '第一步是先删掉', timestamp: [2.8, 3.8] },
      { id: 'c4', text: '不需要的静音段', timestamp: [5.5, 6.8] }, // 1.7s pause before c4
    ];
    const groups = groupTranslationSentences(cues);
    assert.equal(groups.length, 3);
    assert.deepEqual(groups[0].itemIds, ['c1', 'c2']);
    assert.equal(groups[0].sentence, '今天我们来聊聊如何高效地剪辑口播视频。');
    assert.deepEqual(groups[1].itemIds, ['c3']);
    assert.deepEqual(groups[2].itemIds, ['c4']);
  });

  it('does not split a semantic sentence across batches and attaches surrounding context', () => {
    const cues = [
      { id: 'c1', text: '第一句前半', timestamp: [0, 1] },
      { id: 'c2', text: '第一句后半。', timestamp: [1, 2] },
      { id: 'c3', text: '第二句前半', timestamp: [2, 3] },
      { id: 'c4', text: '第二句后半。', timestamp: [3, 4] },
      { id: 'c5', text: '第三句。', timestamp: [4, 5] },
    ];
    const batches = splitTranslationBatches(cues, undefined, { maxItems: 3, contextWindow: 2 });
    assert.equal(batches.length, 2);
    assert.deepEqual(batches[0].items.map((i) => i.id), ['c1', 'c2']);
    assert.deepEqual(batches[0].contextBefore, []);
    assert.deepEqual(batches[0].contextAfter.map((i) => i.id), ['c3', 'c4']);

    assert.deepEqual(batches[1].items.map((i) => i.id), ['c3', 'c4', 'c5']);
    assert.deepEqual(batches[1].contextBefore.map((i) => i.id), ['c1', 'c2']);
    assert.deepEqual(batches[1].contextAfter, []);
  });

  it('supports selective outdated retranslation while keeping adjacent read-only context', () => {
    const cues = [
      { id: 'c1', text: '开场白。', timestamp: [0, 1] },
      { id: 'c2', text: '核心观点是', timestamp: [1, 2] },
      { id: 'c3', text: '保持节奏紧凑。', timestamp: [2, 3] },
      { id: 'c4', text: '谢谢大家。', timestamp: [3, 4] },
    ];
    const batches = splitTranslationBatches(cues, ['c2'], { contextWindow: 1 });
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].items, [{ id: 'c2', text: '核心观点是' }]);
    assert.deepEqual(batches[0].contextBefore, [{ id: 'c1', text: '开场白。' }]);
    assert.deepEqual(batches[0].contextAfter, [{ id: 'c3', text: '保持节奏紧凑。' }]);
  });
});

describe('F-0031/AC-2 strict batch validation without fallback', () => {
  const requested = [{ id: 'a', text: '你好' }, { id: 'b', text: '世界' }];

  it('rejects missing, extra/unknown, duplicate, empty, or non-array results', () => {
    assert.throws(() => validateTranslationResults(requested, [{ id: 'a', text: 'Hello' }]),
      /翻译结果无效.*Invalid translation result.*缺少 1 条/);
    assert.throws(() => validateTranslationResults(requested, [
      { id: 'a', text: 'Hello' }, { id: 'b', text: 'World' }, { id: 'c', text: 'Extra' },
    ]), /翻译结果无效.*多出 1 条未知 id/);
    assert.throws(() => validateTranslationResults(requested, [
      { id: 'a', text: 'Hello' }, { id: 'a', text: 'Hello 2' },
    ]), /翻译结果无效.*重复 1 条/);
    assert.throws(() => validateTranslationResults(requested, [
      { id: 'a', text: 'Hello' }, { id: 'b', text: '   ' },
    ]), /翻译结果无效.*空文本 1 条/);
    assert.throws(() => validateTranslationResults(requested, { bad: true }), /翻译结果无效/);
  });
});

describe('F-0031/AC-4 line length and reading speed constraints', () => {
  it('flags translations exceeding maxCharsPerLine or maxCps and clears when edited within limits', () => {
    assert.deepEqual(DEFAULT_TRANSLATION_LIMITS, { maxCharsPerLine: 42, maxCps: 20 });

    const longLine = evaluateTranslationConstraints(
      'This is an overly long single line translation exceeding limit',
      [0, 5],
      { maxCharsPerLine: 42, maxCps: 20 },
    );
    assert.equal(longLine.tooLong, true);
    assert.equal(longLine.exceedsLineLength, true);
    assert.equal(longLine.exceedsReadingSpeed, false);

    const fastSpeed = evaluateTranslationConstraints(
      'Too many words in one second',
      [0, 1],
      { maxCharsPerLine: 42, maxCps: 20 },
    );
    assert.equal(fastSpeed.tooLong, true);
    assert.equal(fastSpeed.exceedsLineLength, false);
    assert.equal(fastSpeed.exceedsReadingSpeed, true);

    const wrappedOk = evaluateTranslationConstraints(
      'This fits nicely across\ntwo balanced lines',
      [0, 3],
      { maxCharsPerLine: 42, maxCps: 20 },
    );
    assert.equal(wrappedOk.tooLong, false);
  });
});

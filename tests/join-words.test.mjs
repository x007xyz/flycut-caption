import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { joinWordTexts } from '../shared/text/joinWords.ts';
import { groupWordsIntoSentences } from '../src/utils/timeUtils.ts';

describe('joinWordTexts', () => {
  it('separates English words with spaces', () => {
    assert.equal(joinWordTexts(["NASA's", 'Kepler', 'mission.']), "NASA's Kepler mission.");
  });

  it('keeps Chinese characters together, including next to English', () => {
    assert.equal(joinWordTexts(['大', '家', '好，']), '大家好，');
    assert.equal(joinWordTexts(['用', 'Kepler', '望', '远', '镜']), '用Kepler望远镜');
  });

  it('does not put a space before punctuation', () => {
    assert.equal(joinWordTexts(['Hi', ',', 'there', '.']), 'Hi, there.');
  });

  it('keeps whitespace-prefixed (Whisper style) words as-is', () => {
    assert.equal(joinWordTexts([' don', "'t", ' stop']), "don't stop");
  });

  it('is used when grouping English words into sentences', () => {
    const words = [['Hello', 0, 0.3], ['brave', 0.3, 0.6], ['world.', 0.6, 0.9]]
      .map(([text, start, end], i) => ({ id: `w${i}`, text, timestamp: [start, end] }));
    assert.equal(groupWordsIntoSentences(words)[0].text, 'Hello brave world.');
  });
});

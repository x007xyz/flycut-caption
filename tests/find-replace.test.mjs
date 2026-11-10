import assert from 'node:assert/strict';
import test from 'node:test';
import {
  baseForMatches,
  findMatches,
  replaceAllMatches,
  replaceMatch,
} from '../shared/text/findReplace.ts';

const chunks = [
  { id: 'a', text: 'FlyCut 和 flycut 都是项目名' },
  { id: 'b', text: '这里没有' },
  { id: 'c', text: '项目.名称 需要使用项目.名称' },
  { id: 'd', text: '项目名', deleted: true },
  { id: 'e', text: '项目名', isBlankSpacer: true },
];

test('F-0012 literal find defaults to case-insensitive and skips deleted/blank rows', () => {
  const matches = findMatches(chunks, 'flycut');
  assert.deepEqual(matches.map(match => [match.chunkId, match.start, match.end]), [['a', 0, 6], ['a', 9, 15]]);
  assert.equal(findMatches(chunks, '').length, 0);
  assert.equal(findMatches(chunks, '项目名').length, 1);
});

test('F-0012 match case and Chinese characters are literal', () => {
  assert.equal(findMatches(chunks, 'FlyCut', true).length, 1);
  assert.equal(findMatches(chunks, 'flycut', true).length, 1);
  assert.equal(findMatches(chunks, '项目名').length, 1);
  assert.equal(findMatches(chunks, '項目名').length, 0);
});

test('F-0012 special characters are escaped instead of regex', () => {
  const matches = findMatches(chunks, '项目.名称');
  assert.equal(matches.length, 2);
  assert.equal(matches[0].chunkId, 'c');
});

test('F-0012 matches never cross sentence boundaries', () => {
  const split = [{ id: 'x', text: '项目' }, { id: 'y', text: '名称' }];
  assert.equal(findMatches(split, '项目名称').length, 0);
});

test('F-0012 replace one preserves the rest of the sentence', () => {
  assert.equal(replaceMatch('abcabc', { start: 3, end: 6 }, 'X'), 'abcX');
  assert.equal(replaceMatch('abc', { start: 1, end: 9 }, 'X'), 'abc');
});

test('F-0012 replace all applies right-to-left and returns one update per sentence', () => {
  const matches = findMatches(chunks, '项目.名称');
  const updates = replaceAllMatches(chunks, matches, '项目名称');
  assert.deepEqual(updates, [{ id: 'c', text: '项目名称 需要使用项目名称' }]);
});

test('F-0012 base only covers affected sentences', () => {
  const matches = findMatches(chunks, 'flycut');
  assert.equal(baseForMatches(chunks, matches), JSON.stringify([['a', 'FlyCut 和 flycut 都是项目名']]));
});

test('F-0012 60-minute transcript search stays bounded', () => {
  const many = Array.from({ length: 3000 }, (_, index) => ({
    id: `c${index}`,
    text: `第 ${index} 句，项目名称很重要，需要校对。`,
  }));
  const started = performance.now();
  const matches = findMatches(many, '项目名称');
  const elapsed = performance.now() - started;
  assert.equal(matches.length, many.length);
  assert.ok(elapsed < 500, `expected <500ms, got ${elapsed.toFixed(1)}ms`);
});

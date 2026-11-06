// F-0001 评测指标的单元测试（不需要模型和素材）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { characterErrorRate, evaluate, fillerRecall, markerRecall, parseReference } from './lib/asrEval.mjs';

test('F-0001 字错率去掉标点和语气词，按词元计替换、删除、插入', () => {
  assert.deepEqual(characterErrorRate('嗯，今天聊 GitHub 的 agent。', '今天聊 github 的 agent'), {
    cer: 0, errors: 0, substitutions: 0, deletions: 0, insertions: 0, referenceTokens: 6 });
  const result = characterErrorRate('视频号很好用', '视频好很好用啊吧');
  assert.equal(result.substitutions, 1); assert.equal(result.insertions, 1); assert.equal(result.referenceTokens, 6);
  assert.equal(result.cer, 2 / 6);
  // 读音相同的写法不算错
  assert.equal(characterErrorRate('她说了三次', '他说了3次').errors, 0);
});

test('F-0001 语气词召回按类比较，统计漏掉和多出的', () => {
  const r = fillerRecall('呃我觉得啊这个嗯很好', '额我觉得这个嗯很好哦');
  assert.equal(r.reference, 3); assert.equal(r.recalled, 2); assert.equal(r.extra, 1);
  assert.equal(r.byClass['<en>'].recalled, 2); assert.equal(r.byClass['<a>'].recalled, 0);
  assert.equal(fillerRecall('没有语气词', '没有语气词').recall, 1);
});

test('F-0001 口头禅召回：那个、就是', () => {
  assert.deepEqual(markerRecall('就是那个东西就是好', '就是这个东西就是好'), { 那个: { reference: 1, recalled: 0 }, 就是: { reference: 2, recalled: 2 } });
});

const markdown = `---
status: draft
range: [10, 40]
---

## 文本

- [00:10.0] 大家好，{呃|∅}今天聊{剪辑|简介}。
- [00:20.0] [非讲者] 主持人插话。
- [00:30.0] ⚠ 然后[?]我们开始。
`;

test('F-0001 参考文本：未听校时拒绝，--allow-draft 取 A；非讲者和听不清的部分不计', () => {
  assert.throws(() => parseReference(markdown), /2 处分歧/);
  const ref = parseReference(markdown, { allowDraft: true });
  assert.equal(ref.unresolved, 2); assert.equal(ref.reviewed, false);
  assert.deepEqual(ref.sentences.map((s) => [s.start, s.end, s.speaker, s.text]), [
    [10, 20, true, '大家好，呃今天聊剪辑。'], [20, 30, false, '主持人插话。'], [30, 40, true, '然后我们开始。']]);
  const transcript = { chunks: [
    { text: '开场白', timestamp: [2, 5] },
    { text: '大家好今天聊简介', timestamp: [10, 15] },
    { text: '主持人插话', timestamp: [21, 24] },
    { text: '然后我们开始', timestamp: [30, 33] },
  ] };
  const result = evaluate(ref, transcript);
  assert.equal(result.referenceTokens, 14); assert.equal(result.errors, 2);
  assert.equal(result.fillers.reference, 1); assert.equal(result.fillers.recalled, 0);
});

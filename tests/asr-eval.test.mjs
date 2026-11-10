// F-0001 评测指标的单元测试（不需要模型和素材）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { characterErrorRate, evaluate, fillerRecall, markerRecall, parseReference } from './lib/asrEval.mjs';

test('F-0001 字错率去掉标点和语气词，按词元计替换、删除、插入', () => {
  assert.deepEqual(characterErrorRate('嗯，今天聊 GitHub 的 agent。', '今天聊 github 的 agent'), {
    cer: 0, errors: 0, substitutions: 0, deletions: 0, insertions: 0, referenceTokens: 6 });
  const result = characterErrorRate('视频号很好用', '视频好很好用啊吧');
  assert.equal(result.substitutions, 1); assert.equal(result.insertions, 1); assert.equal(result.referenceTokens, 6);
  assert.equal(result.cer, 2 / 6);
  // 读音相同的写法不算错
  assert.equal(characterErrorRate('她说了三次', '他说了3次').errors, 0);
  // 繁简不算错（Whisper 常输出繁体）
  assert.equal(characterErrorRate('这件事情其实已经变成议题', '這件事情其實已經變成議題').errors, 0);
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

test('F-0001 未听校但已无分歧的参考仍不得用于正式评测', () => {
  const draft = markdown.replace(/\{([^|{}]*)\|[^{}]*\}/g, '$1');
  assert.throws(() => parseReference(draft), /尚未完成听校/);
  assert.equal(parseReference(draft, { allowDraft: true }).reviewed, false);
  const reviewed = draft.replace('status: draft', 'status: reviewed');
  assert.equal(parseReference(reviewed).reviewed, true);
});

test('F-0001 参考范围和句子为空或无效时拒绝评测', () => {
  for (const range of ['[40, 10]', '[10, 10]', '[NaN, 40]', '[10]']) {
    assert.throws(() => parseReference(markdown.replace('[10, 40]', range), { allowDraft: true }), /评测范围无效/);
  }
  assert.throws(() => parseReference('---\nstatus: reviewed\nrange: [0, 10]\n---\n'), /没有可评测的讲者文本/);
});

test('F-0001 就绪检查不启动推理，草稿与已听校文本返回不同退出码', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flycut-reference-check-'));
  try {
    const file = join(dir, 'reference.md');
    const run = () => spawnSync(process.execPath, [new URL('../scripts/eval-asr.mjs', import.meta.url).pathname,
      '--check-reference', '--reference', file], { encoding: 'utf8' });
    writeFileSync(file, markdown);
    const draft = run();
    assert.equal(draft.status, 1, draft.stderr);
    assert.equal(JSON.parse(draft.stdout).references[0].unresolved, 2);
    writeFileSync(file, markdown.replace(/\{([^|{}]*)\|[^{}]*\}/g, '$1').replace('status: draft', 'status: reviewed'));
    const reviewed = run();
    assert.equal(reviewed.status, 0, reviewed.stderr);
    assert.equal(JSON.parse(reviewed.stdout).ready, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('F-0001 字错率必须是最小编辑距离，不以最长公共子序列高估替换错误', () => {
  assert.deepEqual(characterErrorRate('甲乙丙', '丙乙甲'), {
    cer: 2 / 3, errors: 2, substitutions: 2, deletions: 0, insertions: 0, referenceTokens: 3,
  });
  assert.equal(characterErrorRate('甲乙丙丁', '乙丙丁甲').errors, 2);
});

test('F-0001 编辑距离与独立小样本矩阵一致，错误分类之和等于距离', () => {
  const samples = [''];
  let level = [''];
  for (let size = 1; size <= 3; size++) {
    level = level.flatMap((prefix) => [...'甲乙丙'].map((c) => prefix + c));
    samples.push(...level);
  }
  for (const a of samples) for (const b of samples) {
    const matrix = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
    for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
    for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + Number(a[i - 1] !== b[j - 1]));
    }
    const r = characterErrorRate(a, b);
    assert.equal(r.errors, matrix[a.length][b.length], `${a} -> ${b}`);
    assert.equal(r.errors, r.substitutions + r.deletions + r.insertions);
  }
});

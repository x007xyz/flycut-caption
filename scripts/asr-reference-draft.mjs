#!/usr/bin/env node
// 生成逐字参考文本初稿（F-0001）：两个模型的转写按时间对齐，分歧处标 {A|B}，交给人听校。
//
//   node scripts/asr-reference-draft.mjs --a <模型A.json> --b <模型B.json> --start <秒> --end <秒> \
//     --media <素材路径> --source <出处> --license <许可> --models "<A 名>,<B 名>" --out <输出.md>
//
// 输入是 funasr-asr 的 transcript JSON（chunks + wordChunks）。模型 A 提供句子切分和标点，
// 模型 B 只需要字词时间戳。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { buildDraft, formatClock } from '../tests/lib/referenceDraft.mjs';

const { values } = parseArgs({ options: {
  a: { type: 'string' }, b: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' },
  media: { type: 'string' }, source: { type: 'string' }, license: { type: 'string' },
  models: { type: 'string' }, out: { type: 'string' },
} });
for (const key of ['a', 'b', 'start', 'end', 'media', 'source', 'license', 'models', 'out']) {
  if (!values[key]) { console.error(`缺少 --${key}`); process.exit(1); }
}

const [nameA, nameB] = values.models.split(',').map((s) => s.trim());
const start = Number(values.start);
const end = Number(values.end);
const draft = buildDraft(JSON.parse(readFileSync(values.a, 'utf8')), JSON.parse(readFileSync(values.b, 'utf8')), { start, end });
const conflicts = draft.reduce((sum, s) => sum + s.conflicts, 0);
const flagged = draft.filter((s) => s.conflicts > 0).length;

const lines = [
  '---',
  'status: draft',
  `media: ${values.media}`,
  `source: ${values.source}`,
  `license: ${values.license}`,
  `range: [${start}, ${end}]`,
  `models: [${nameA}, ${nameB}]`,
  'reviewed_by:',
  'reviewed_at:',
  '---',
  '',
  `# 逐字参考文本：${values.media}`,
  '',
  `评测范围 ${formatClock(start)}–${formatClock(end)}，共 ${draft.length} 句，其中 ${flagged} 句有分歧（${conflicts} 处）。`,
  '',
  '## 听校规则',
  '',
  `- 每行开头是这句话在原视频里的时间。\`{A|B}\` 是两个模型的分歧：A 是 ${nameA}，B 是 ${nameB}；\`∅\` 表示这个模型没有识别出内容。`,
  '- 按实际读音改成正确的文字，删掉花括号。两个模型都错时直接改写；两个模型一致但听到的不一样时也要改。',
  '- **语气词和口误原样保留**：嗯、啊、呃、额、那个、就是、重复的字词、说错又改口的部分都照实写。',
  '- 英文按实际说的单词写（例如 GitHub、agent），中文用简体。标点只用来断句，不参与评测。',
  '- 听不清的地方写 `[?]`。整句不是讲者说的（主持人、观众）写在行首 `[非讲者]`。',
  '- 听校完成后把顶部的 `status` 改成 `reviewed`，填上 `reviewed_by` 和 `reviewed_at`。',
  '',
  '## 文本',
  '',
  ...draft.map((s) => `- [${formatClock(s.start)}] ${s.conflicts ? '⚠ ' : ''}${s.text}`),
  '',
];

mkdirSync(dirname(values.out), { recursive: true });
writeFileSync(values.out, lines.join('\n'));
console.log(`${values.out}：${draft.length} 句，${flagged} 句有分歧，${conflicts} 处`);

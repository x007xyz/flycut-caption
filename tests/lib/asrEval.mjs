// 转写质量评测（F-0001）：读逐字参考文本，对比模型输出，算字错率和语气词召回。
// 写法统一规则和参考文本初稿共用 tests/lib/referenceDraft.mjs，不另起一套。
import * as OpenCC from 'opencc-js';
import { diffChars, normalizeWithMap } from './referenceDraft.mjs';

/** 繁体转简体（Whisper、FireRedASR 等可能输出繁体），按词转换，比逐字更准。参考文本和模型输出都先过一遍。 */
const toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' });

/** 单字语气词。算字错率时去掉；语气词召回时按类比较（嗯 / 呃 / 额 听起来接近，视为同一类）。 */
export const FILLER_CLASS = new Map([
  ['嗯', 'en'], ['呃', 'en'], ['额', 'en'], ['唔', 'en'],
  ['啊', 'a'], ['阿', 'a'],
  ['哦', 'o'], ['噢', 'o'],
  ['诶', 'ei'], ['欸', 'ei'], ['哎', 'ei'], ['唉', 'ei'],
]);
/** 口头禅：不从字错率里去掉（它们也可能是正常用词），只单独统计召回。 */
export const DISCOURSE_MARKERS = ['那个', '就是'];

const CONFLICT = /\{([^{}|]*)\|([^{}]*)\}/g;

/**
 * 解析 tests/fixtures/asr-reference/*.md。
 * 返回 frontmatter、句子（起点、文字、是否讲者）和还没听校的分歧数。
 * `allowDraft`：分歧处先取 A（初稿用），结果只能当参考，不能当结论。
 */
export function parseReference(markdown, { allowDraft = false } = {}) {
  const front = /^---\n([\s\S]*?)\n---/.exec(markdown)?.[1] ?? '';
  const meta = Object.fromEntries(front.split('\n').map((line) => {
    const at = line.indexOf(':');
    return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
  }).filter(([key]) => key));
  const range = (meta.range ?? '').replace(/[[\]\s]/g, '').split(',').map(Number);
  let unresolved = 0;
  const sentences = [];
  for (const line of markdown.split('\n')) {
    const match = /^- \[(\d+):(\d{2}(?:\.\d+)?)\]\s*(?:⚠\s*)?(.*)$/.exec(line);
    if (!match) continue;
    let text = match[3];
    const speaker = !text.startsWith('[非讲者]');
    text = text.replace(/^\[非讲者\]\s*/, '');
    text = text.replace(CONFLICT, (_, a) => { unresolved += 1; return a === '∅' ? '' : a; });
    // 听不清的地方不计入
    text = text.replace(/\[\?\]/g, '');
    sentences.push({ start: Number(match[1]) * 60 + Number(match[2]), text, speaker });
  }
  if (unresolved && !allowDraft) {
    throw new Error(`参考文本还有 ${unresolved} 处分歧没有听校（status: ${meta.status ?? '?'}）。初稿试算请加 --allow-draft`);
  }
  sentences.forEach((sentence, index) => { sentence.end = sentences[index + 1]?.start ?? range[1]; });
  return { meta, range: { start: range[0], end: range[1] }, sentences, unresolved, reviewed: meta.status === 'reviewed' };
}

const mid = (ts) => (ts[0] + ts[1]) / 2;

/** 模型输出里属于评测范围、且不在非讲者句子时间段内的文字。 */
export function hypothesisText(transcript, reference) {
  const { start, end } = reference.range;
  const excluded = reference.sentences.filter((s) => !s.speaker);
  return transcript.chunks
    .filter((chunk) => mid(chunk.timestamp) >= start && mid(chunk.timestamp) < end)
    .filter((chunk) => !excluded.some((s) => mid(chunk.timestamp) >= s.start && mid(chunk.timestamp) < s.end))
    .map((chunk) => chunk.text).join(' ');
}

const tokens = (text) => normalizeWithMap(toSimplified(text)).chars;
const isFiller = (token) => FILLER_CLASS.has(token);

/**
 * 字错率：去掉标点和单字语气词后按词元比较。
 * 错误数按对齐的编辑片段计：替换片段算较长一侧的长度，删除、插入按长度，是 Levenshtein 距离的上界、通常相等。
 */
export function characterErrorRate(referenceText, hypothesis) {
  const ref = tokens(referenceText).filter((t) => !isFiller(t));
  const hyp = tokens(hypothesis).filter((t) => !isFiller(t));
  let substitutions = 0; let deletions = 0; let insertions = 0;
  for (const op of diffChars(ref, hyp)) {
    const a = op.i2 - op.i1; const b = op.j2 - op.j1;
    if (op.tag === 'replace') { substitutions += Math.min(a, b); if (a > b) deletions += a - b; else insertions += b - a; }
    else if (op.tag === 'delete') deletions += a;
    else if (op.tag === 'insert') insertions += b;
  }
  const errors = substitutions + deletions + insertions;
  return { cer: ref.length ? errors / ref.length : 0, errors, substitutions, deletions, insertions, referenceTokens: ref.length };
}

/**
 * 语气词召回：保留语气词再对齐一次，参考文本里的每个语气词，识别结果在对齐位置（相等或同一替换片段内）
 * 有同一类语气词就算召回。同时报告模型多出来的语气词（参考里没有的位置）。
 */
export function fillerRecall(referenceText, hypothesis) {
  const classify = (list) => list.map((t) => (FILLER_CLASS.has(t) ? `<${FILLER_CLASS.get(t)}>` : t));
  const ref = classify(tokens(referenceText));
  const hyp = classify(tokens(hypothesis));
  const isTag = (t) => t.startsWith('<');
  const byClass = {};
  const bump = (cls, key) => { byClass[cls] ??= { reference: 0, recalled: 0 }; byClass[cls][key] += 1; };
  let reference = 0; let recalled = 0; let extra = 0;
  for (const op of diffChars(ref, hyp)) {
    const refPart = ref.slice(op.i1, op.i2); const hypPart = hyp.slice(op.j1, op.j2);
    const pool = hypPart.filter(isTag);
    for (const t of refPart.filter(isTag)) {
      reference += 1; bump(t, 'reference');
      const at = pool.indexOf(t);
      if (at >= 0) { recalled += 1; bump(t, 'recalled'); pool.splice(at, 1); }
    }
    if (op.tag !== 'equal') extra += pool.length;
  }
  return { recall: reference ? recalled / reference : 1, reference, recalled, extra,
    hypothesisFillers: hyp.filter(isTag).length, byClass };
}

/** 口头禅（那个、就是）：参考里的每次出现，识别结果在对齐位置是否两个字都在。 */
export function markerRecall(referenceText, hypothesis) {
  const ref = tokens(referenceText); const hyp = tokens(hypothesis);
  const matched = new Uint8Array(ref.length);
  for (const op of diffChars(ref, hyp)) if (op.tag === 'equal') matched.fill(1, op.i1, op.i2);
  const result = {};
  for (const marker of DISCOURSE_MARKERS) {
    const chars = [...marker]; let reference = 0; let recalled = 0;
    for (let i = 0; i + chars.length <= ref.length; i++) {
      if (chars.every((c, k) => ref[i + k] === c)) { reference += 1; if (chars.every((_, k) => matched[i + k])) recalled += 1; }
    }
    result[marker] = { reference, recalled };
  }
  return result;
}

/** 一个样本、一个模型的全部指标。 */
export function evaluate(reference, transcript) {
  const referenceText = reference.sentences.filter((s) => s.speaker).map((s) => s.text).join(' ');
  const hypothesis = hypothesisText(transcript, reference);
  return { ...characterErrorRate(referenceText, hypothesis), fillers: fillerRecall(referenceText, hypothesis),
    markers: markerRecall(referenceText, hypothesis) };
}

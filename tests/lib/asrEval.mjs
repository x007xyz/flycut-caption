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
  if (range.length !== 2 || !range.every(Number.isFinite) || range[0] < 0 || range[1] <= range[0]) {
    throw new Error('参考文本评测范围无效：需要 [开始秒数, 结束秒数]，且结束晚于开始');
  }
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
  if (!sentences.some((sentence) => sentence.speaker && sentence.text.trim())) {
    throw new Error('参考文本没有可评测的讲者文本');
  }
  if (meta.status !== 'reviewed' && !allowDraft) {
    throw new Error('参考文本尚未完成听校：确认逐句听校后才能标记 status: reviewed；试算请加 --allow-draft');
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
 * 用精确 Levenshtein 距离统计替换/删除/插入。只保留两行，避免长口播的平方内存开销。
 * 同成本时优先对角线（匹配/替换），再删除、插入，以保证分类结果可复现。
 */
export function characterErrorRate(referenceText, hypothesis) {
  const ref = tokens(referenceText).filter((t) => !isFiller(t));
  const hyp = tokens(hypothesis).filter((t) => !isFiller(t));
  const row = () => Array.from({ length: 4 }, () => new Uint32Array(hyp.length + 1));
  let previous = row(); let current = row();
  for (let j = 0; j <= hyp.length; j++) { previous[0][j] = j; previous[3][j] = j; }
  for (let i = 1; i <= ref.length; i++) {
    current[0][0] = i; current[1][0] = 0; current[2][0] = i; current[3][0] = 0;
    for (let j = 1; j <= hyp.length; j++) {
      const substitution = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      const diagonal = previous[0][j - 1] + substitution;
      const deletion = previous[0][j] + 1;
      const insertion = current[0][j - 1] + 1;
      if (diagonal <= deletion && diagonal <= insertion) {
        current[0][j] = diagonal;
        current[1][j] = previous[1][j - 1] + substitution;
        current[2][j] = previous[2][j - 1]; current[3][j] = previous[3][j - 1];
      } else if (deletion <= insertion) {
        current[0][j] = deletion;
        current[1][j] = previous[1][j]; current[2][j] = previous[2][j] + 1; current[3][j] = previous[3][j];
      } else {
        current[0][j] = insertion;
        current[1][j] = current[1][j - 1]; current[2][j] = current[2][j - 1]; current[3][j] = current[3][j - 1] + 1;
      }
    }
    [previous, current] = [current, previous];
  }
  const [errors, substitutions, deletions, insertions] = previous.map((values) => values[hyp.length]);
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

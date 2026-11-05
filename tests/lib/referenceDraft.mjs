// 逐字参考文本初稿：把两个模型的转写按时间对齐，分歧处标成 {A|B}，交给人听校。
// 按「词元」比较：一个汉字是一个词元，连续的英文字母或数字是一个词元；去掉标点和空格、英文转小写。
// 听不出区别的写法（他/她/它、的/地/得、阿拉伯数字/中文数字）先统一再比较，不算分歧，输出保留模型 A 的写法。

const PUNCT = /[\s，。、！？；：,.!?;:'"“”‘’（）()《》【】\[\]…—\-·~「」/]/u;
const WORD = /[A-Za-z0-9\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A']/u;

/** 读音相同、听校时分辨不出来的写法，比较前统一成同一个字 */
const EQUIVALENT = new Map([
  ['她', '他'], ['它', '他'], ['祂', '他'],
  ['地', '的'], ['得', '的'],
  ['〇', '0'], ['零', '0'], ['一', '1'], ['二', '2'], ['三', '3'], ['四', '4'],
  ['五', '5'], ['六', '6'], ['七', '7'], ['八', '8'], ['九', '9'],
]);

export const EMPTY = '∅';

/** 比较用的统一写法：英文小写、全角转半角、同音写法合并 */
export function canonical(token) {
  const half = token.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).toLowerCase();
  return [...half].map((c) => EQUIVALENT.get(c) ?? c).join('');
}

/**
 * 切成词元，去掉标点和空白。chars 是比较用的统一写法，display 是原文，spans 是每个词元在原文中的区间。
 */
export function normalizeWithMap(text) {
  const src = [...text];
  const chars = [];
  const display = [];
  const spans = [];
  for (let i = 0; i < src.length;) {
    if (PUNCT.test(src[i])) { i++; continue; }
    let k = i + 1;
    if (WORD.test(src[i])) while (k < src.length && WORD.test(src[k])) k++;
    const token = src.slice(i, k).join('');
    // 逐个字母读出的缩写（Paraformer 输出 a i、q r）并成一个词元，和 AI、QR 对得上
    const prev = display.length - 1;
    if (/^[a-z]$/i.test(token) && prev >= 0 && /^[a-z]+$/i.test(display[prev]) && display[prev].length === chars[prev].length && spans[prev].single) {
      chars[prev] += canonical(token);
      display[prev] += token;
      spans[prev] = Object.assign([spans[prev][0], k], { single: true });
    } else {
      chars.push(canonical(token));
      display.push(token);
      spans.push(Object.assign([i, k], { single: /^[a-z]$/i.test(token) }));
    }
    i = k;
  }
  return { chars, display, spans };
}

/** 把词元拼回文字：相邻两个英文 / 数字词元之间加空格 */
export function joinTokens(tokens) {
  return tokens.reduce((out, t, i) => out + (i > 0 && WORD.test(tokens[i - 1].at(-1)) && WORD.test(t[0]) ? ' ' : '') + t, '');
}

/** 字符级最长公共子序列，返回 equal / replace / delete / insert 片段（区间左闭右开） */
export function diffChars(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  const push = (tag, i1, i2, j1, j2) => {
    const last = ops.at(-1);
    if (last && last.tag !== 'equal' && tag !== 'equal' && last.i2 === i1 && last.j2 === j1) {
      last.i2 = i2; last.j2 = j2; last.tag = last.i1 === last.i2 ? 'insert' : last.j1 === last.j2 ? 'delete' : 'replace';
    } else if (last && last.tag === tag && tag === 'equal') {
      last.i2 = i2; last.j2 = j2;
    } else {
      ops.push({ tag, i1, i2, j1, j2 });
    }
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { push('equal', i, i + 1, j, j + 1); i++; j++; }
    else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) { push('insert', i, i, j, j + 1); j++; }
    else { push('delete', i, i + 1, j, j); i++; }
  }
  return ops;
}

/** 按编辑列表（A 的词元区间 + B 的文字）给一句话加上 {A|B} 标记 */
function applyEdits(text, spans, edits) {
  const src = [...text];
  let out = '';
  let cursor = 0;
  for (const { i1, i2, bText } of edits) {
    const b = bText || EMPTY;
    if (i1 === i2) {
      const at = i1 < spans.length ? spans[i1][0] : src.length;
      out += src.slice(cursor, at).join('') + `{${EMPTY}|${b}}`;
      cursor = at;
    } else {
      const start = spans[i1][0];
      const end = spans[i2 - 1][1];
      out += src.slice(cursor, start).join('') + `{${src.slice(start, end).join('')}|${b}}`;
      cursor = end;
    }
  }
  return out + src.slice(cursor).join('');
}

/**
 * 把模型 B 的文字合并进模型 A 的一句话：分歧处写成 {A 的原文|B 的文字}，缺失的一侧写 ∅。
 */
export function mergeSentence(textA, textB) {
  const a = normalizeWithMap(textA);
  const b = normalizeWithMap(textB);
  const edits = diffChars(a.chars, b.chars)
    .filter((op) => op.tag !== 'equal')
    .map((op) => ({ i1: op.i1, i2: op.i2, bText: joinTokens(b.display.slice(op.j1, op.j2)) }));
  return { text: applyEdits(textA, a.spans, edits), conflicts: edits.length };
}

const mid = (ts) => (ts[0] + ts[1]) / 2;

/**
 * 整段对齐：模型 A 的句子（时间起点在 [start, end) 内）拼成一串，和同一时间范围内模型 B 的字词整体比较，
 * 再把分歧分回各句。整段比较避免两个模型断句位置不同造成的假分歧。
 * 跨句的分歧：B 的文字记在第一句，后面的句子标为 {A|∅}；只在 B 出现的文字记在前一句末尾。
 */
export function buildDraft(transcriptA, transcriptB, { start = 0, end = Infinity } = {}) {
  const sentences = transcriptA.chunks
    .filter((c) => c.timestamp[0] >= start && c.timestamp[0] < end)
    .map((c) => ({ chunk: c, ...normalizeWithMap(c.text), edits: [] }));
  const owner = [];
  const local = [];
  const aChars = [];
  sentences.forEach((s, si) => s.chars.forEach((ch, li) => { aChars.push(ch); owner.push(si); local.push(li); }));
  const b = normalizeWithMap((transcriptB.wordChunks ?? [])
    .filter((w) => mid(w.timestamp) >= start && mid(w.timestamp) < end)
    .map((w) => w.text).join(' '));
  const bChars = b.chars;

  for (const op of diffChars(aChars, bChars)) {
    if (op.tag === 'equal') continue;
    const bText = joinTokens(b.display.slice(op.j1, op.j2));
    if (op.i1 === op.i2) {
      const si = op.i1 > 0 ? owner[op.i1 - 1] : 0;
      const li = op.i1 > 0 ? local[op.i1 - 1] + 1 : 0;
      if (sentences[si]) sentences[si].edits.push({ i1: li, i2: li, bText });
      continue;
    }
    let first = true;
    for (let i = op.i1; i < op.i2;) {
      const si = owner[i];
      let k = i;
      while (k < op.i2 && owner[k] === si) k++;
      sentences[si].edits.push({ i1: local[i], i2: local[k - 1] + 1, bText: first ? bText : '' });
      first = false;
      i = k;
    }
  }

  return sentences.map((s) => ({
    start: s.chunk.timestamp[0],
    end: s.chunk.timestamp[1],
    text: applyEdits(s.chunk.text, s.spans, s.edits),
    conflicts: s.edits.length,
  }));
}

export function formatClock(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

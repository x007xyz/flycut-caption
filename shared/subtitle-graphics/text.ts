/** 画面上字幕展示时去掉的标点（ASR/编辑数据仍保留） */
const SUBTITLE_DISPLAY_PUNCTUATION_RE = /\p{P}/gu;
const SINGLE_PUNCT_RE = /^\p{P}$/u;

export function stripSubtitleDisplayPunctuation(text: string): string {
  if (!text) return text;
  return text.replace(SUBTITLE_DISPLAY_PUNCTUATION_RE, '').trim();
}

export interface RawRangeInput {
  start: number;
  end: number;
  text?: string;
}

export interface DisplayRangeResult {
  start: number;
  end: number;
  text: string;
}

/**
 * Map raw cue character ranges onto `stripSubtitleDisplayPunctuation(rawText)` character indices.
 * Walks code points so punctuation removal and outer trimming preserve exact non-overlapping spans.
 */
export function mapRawRangesToDisplay(
  rawText: string,
  ranges: readonly RawRangeInput[] | undefined,
): DisplayRangeResult[] {
  if (!rawText || !ranges?.length) return [];
  const pieces: Array<{ rawStart: number; rawEnd: number; char: string }> = [];
  for (let i = 0; i < rawText.length;) {
    const cp = rawText.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const next = i + ch.length;
    if (!SINGLE_PUNCT_RE.test(ch)) {
      pieces.push({ rawStart: i, rawEnd: next, char: ch });
    }
    i = next;
  }
  let lead = 0;
  while (lead < pieces.length && /^\s$/u.test(pieces[lead].char)) lead += 1;
  let tail = pieces.length;
  while (tail > lead && /^\s$/u.test(pieces[tail - 1].char)) tail -= 1;
  const trimmed = pieces.slice(lead, tail);
  if (!trimmed.length) return [];

  let displayStr = '';
  const indexed = trimmed.map(piece => {
    const displayStart = displayStr.length;
    displayStr += piece.char;
    return { ...piece, displayStart, displayEnd: displayStr.length };
  });

  const sorted = [...ranges]
    .filter(r =>
      Number.isInteger(r.start) && Number.isInteger(r.end)
      && r.start >= 0 && r.end <= rawText.length && r.end > r.start
      && (r.text === undefined || rawText.slice(r.start, r.end) === r.text),
    )
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const mapped: DisplayRangeResult[] = [];
  let prevDisplayEnd = 0;
  for (const r of sorted) {
    const inside = indexed.filter(p => p.rawEnd > r.start && p.rawStart < r.end);
    if (!inside.length) continue;
    let dStart = inside[0].displayStart;
    let dEnd = inside[inside.length - 1].displayEnd;
    while (dStart < dEnd && /^\s$/u.test(displayStr[dStart])) dStart += 1;
    while (dEnd > dStart && /^\s$/u.test(displayStr[dEnd - 1])) dEnd -= 1;
    if (dEnd <= dStart || dStart < prevDisplayEnd) continue;
    mapped.push({ start: dStart, end: dEnd, text: displayStr.slice(dStart, dEnd) });
    prevDisplayEnd = dEnd;
  }
  return mapped;
}

/** 行首禁则标点（避头） */
const LINE_START_FORBIDDEN = new Set('，。！？；：、」』）】》〉』”’'.split(''));

/** 行尾禁则标点（避尾） */
const LINE_END_FORBIDDEN = new Set('「『（【《〈『“‘'.split(''));

export function fixCjkLineStarts(lines: string[]): string[] {
  if (lines.length <= 1) return lines;
  const result = [...lines];
  for (let i = 1; i < result.length; i++) {
    let line = result[i];
    while (line.length > 0 && LINE_START_FORBIDDEN.has(line[0])) {
      const punct = line[0];
      result[i - 1] = result[i - 1] + punct;
      line = line.slice(1);
    }
    result[i] = line;
  }
  return result.filter((line) => line.length > 0);
}

export function applyCjkBreakHints(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    out += ch;
    if (LINE_END_FORBIDDEN.has(ch)) out += '\u200b';
  }
  return out;
}

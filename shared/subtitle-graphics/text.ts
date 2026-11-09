/** 画面上字幕展示时去掉的标点（ASR/编辑数据仍保留） */
const SUBTITLE_DISPLAY_PUNCTUATION_RE = /\p{P}/gu;

export function stripSubtitleDisplayPunctuation(text: string): string {
  if (!text) return text;
  return text.replace(SUBTITLE_DISPLAY_PUNCTUATION_RE, '').trim();
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

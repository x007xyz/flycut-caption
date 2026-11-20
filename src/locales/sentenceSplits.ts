const en = {
  entry: 'Line breaks', title: 'Sentence splitting', close: 'Close',
  maxChars: 'Max chars/screen', analyzeAgain: 'Analyze again',
  suggestions: '{count} sentences to split', affected: '{count} affected subtitles',
  skipped: '{count} skipped (no reliable timing, text mismatch, translation, keywords or dubbing)',
  overLimit: '{count} pieces still exceed the limit (one word token is too long)',
  noWords: 'This transcript has no word timestamps, so it cannot be split safely',
  empty: 'Nothing here yet', noLong: 'No long sentences to split',
  before: 'Current', after: 'Suggested', keepOriginal: 'Keep original', keepOriginalBadge: 'Keep original',
  pieceEmpty: 'Text cannot be empty', reasonLength: 'Word-boundary split', reasonPunctuation: 'Punctuation and pause split',
  apply: 'Apply {count} changes', applying: 'Applying…', applied: 'Completed',
  stale: 'Subtitles changed. Review again.', staleHint: 'Nothing was applied. Analyze again to use the current subtitles.',
  failed: 'Cannot apply. Try again.', retry: 'Retry', back: 'Back', cancel: 'Cancel',
};
const zh: typeof en = {
  entry: '断句', title: '字幕断句', close: '关闭',
  maxChars: '每屏字数上限', analyzeAgain: '重新分析',
  suggestions: '{count} 句可拆分', affected: '受影响字幕 {count} 条',
  skipped: '已跳过 {count} 句（缺少可靠时间、文字与字词不一致、译文、关键词或配音）',
  overLimit: '{count} 段超过字数上限（单个词过长，无法安全再切）',
  noWords: '当前字幕没有字词时间戳，无法安全拆分',
  empty: '暂无内容', noLong: '没有需要拆分的长句',
  before: '原文', after: '建议', keepOriginal: '保留原文', keepOriginalBadge: '保留原文',
  pieceEmpty: '文字不能为空', reasonLength: '按词边界拆分', reasonPunctuation: '按标点与停顿拆分',
  apply: '确认应用 {count} 处修改', applying: '正在应用…', applied: '已完成',
  stale: '字幕已更新，请重新检查', staleHint: '本次修改没有应用。请重新分析当前字幕。',
  failed: '应用失败，请重试', retry: '重试', back: '返回', cancel: '取消',
};
export const sentenceSplitCopy = (language: string) => language.startsWith('zh') ? zh : en;
export const fillSentenceSplit = (text: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((next, [key, value]) => next.replaceAll(`{${key}}`, String(value)), text);

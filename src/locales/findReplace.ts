const en = {
  find: 'Find', replaceWith: 'Replace with', previous: 'Previous match', next: 'Next match',
  matchCase: 'Match case', replace: 'Replace', replaceAll: 'Replace all', close: 'Close find',
  noMatches: 'No matches', stale: 'Subtitles changed. Review replacements again.',
  failed: 'Replace failed. Try again.', confirmTitle: 'Replace all', confirmHint: '{total} matches in {count} subtitles',
  cancel: 'Cancel', confirm: 'Confirm replacement', replaceOneDone: 'Replaced 1 match',
  replaceAllDone: 'Replaced {count} matches', findLabel: 'Find', replaceLabel: 'Replace with',
  snippet: 'Find', matchLabel: 'Match: {text}', preview: 'Preview, not applied',
};
const zh: typeof en = {
  find: '查找', replaceWith: '替换为', previous: '上一处', next: '下一处',
  matchCase: '区分大小写', replace: '替换', replaceAll: '全部替换', close: '关闭查找',
  noMatches: '没有匹配结果', stale: '字幕已更新，请重新检查替换',
  failed: '替换失败，请重试', confirmTitle: '替换全部', confirmHint: '共 {total} 处匹配，涉及 {count} 条字幕',
  cancel: '取消', confirm: '确认替换', replaceOneDone: '已替换 1 处',
  replaceAllDone: '已替换 {count} 处', findLabel: '查找', replaceLabel: '替换为',
  snippet: '查找', matchLabel: '匹配：{text}', preview: '预览，尚未应用',
};
export const findCopy = (language: string) => language.startsWith('zh') ? zh : en;

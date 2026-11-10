const en = {
  entry: 'Remove silence', analyzing: 'Analyzing pauses…', cancel: 'Cancel', retry: 'Retry',
  noModel: 'No voice detection model available', model: 'Voice detection model',
  minPause: 'Minimum pause (s)', guard: 'Guard (s)', retain: 'Keep (s)', mode: 'Mode',
  joinFade: 'Join fade (5 ms)',
  shorten: 'Shorten pauses', remove: 'Remove pauses', checkParams: 'Check these settings',
  failed: 'Analysis failed. Try again.', empty: 'No pauses to remove', noSpeech: 'No speech detected',
  stale: 'Suggestions are outdated. Analyze again.', apply: 'Apply selected suggestions',
  applying: 'Applying cuts…', applyFailed: 'Cannot apply cuts. Try again.',
  progress: 'Analyzing media…', noTranscript: 'This video has no transcript yet',
  wordWarning: 'Reliable word timestamps are unavailable. Uncertain speech boundaries will be kept.',
};
const zh: typeof en = {
  entry: '去静音', analyzing: '正在分析停顿…', cancel: '取消', retry: '重试',
  noModel: '没有可用的人声检测模型', model: '人声检测模型',
  minPause: '最短静音（秒）', guard: '前后保护（秒）', retain: '保留（秒）', mode: '模式',
  joinFade: '接点平滑（5ms）',
  shorten: '压缩停顿', remove: '删除停顿', checkParams: '请检查参数',
  failed: '分析失败，请重试', empty: '没有可移除的停顿', noSpeech: '没有检测到人声',
  stale: '建议已过期，请重新分析', apply: '应用选中建议',
  applying: '正在应用…', applyFailed: '应用失败，请重试',
  progress: '正在分析媒体…', noTranscript: '这个视频还没有转写',
  wordWarning: '缺少可靠字词时间戳，疑似发音边界不默认剪切',
};
export const silenceCopy = (language: string) => language.startsWith('zh') ? zh : en;

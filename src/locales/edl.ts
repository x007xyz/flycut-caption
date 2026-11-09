// Editing messages kept together so the same states are used by the player, timeline and history panel.
const en = { history: 'Edit history', loading: 'Loading edit history…', noHistory: 'No cut history yet',
  failed: "Couldn't load edit history", retry: 'Retry', back: 'Back to projects', preview: 'Preview, not applied',
  previewCuts: 'Preview proposed cuts', current: 'Current confirmed cuts', pending: 'Pending deletion',
  apply: 'Confirm cuts', cancel: 'Cancel', close: 'Close', restore: 'Restore this version', restoreTitle: 'Restore these cuts?',
  restoreHint: 'The selected version will replace the current cuts. This restore will also be recorded.',
  restoreFailed: "Couldn't restore. Current cuts are unchanged", restoring: 'Restoring cuts…',
  empty: 'No content to play', emptyHint: 'Undo the last action to restore content.',
  invalid: "Couldn't update cuts", invalidHint: "The cut data or media duration is invalid. This operation hasn't overwritten the original project.",
  updating: 'Updating cuts…', stale: 'Suggestions are outdated. Analyze again.',
};
const zh: typeof en = { history: '操作历史', loading: '正在读取操作历史…', noHistory: '暂无剪辑记录',
  failed: '无法读取操作历史', retry: '重试', back: '返回项目', preview: '预览，尚未应用',
  previewCuts: '预览剪辑效果', current: '当前已确认版本', pending: '待确认删除',
  apply: '确认剪辑', cancel: '取消', close: '关闭', restore: '回退到此版本', restoreTitle: '回退剪辑？',
  restoreHint: '当前剪辑将被所选版本替换，回退操作也会记录到历史中。', restoreFailed: '回退失败，当前剪辑未改变', restoring: '正在回退剪辑…',
  empty: '没有可播放的内容', emptyHint: '撤销上次操作可恢复内容。', invalid: '无法更新剪辑',
  invalidHint: '剪辑数据或媒体时长无效，原项目未被此操作覆盖。', updating: '正在更新剪辑…', stale: '建议已过期，请重新分析',
};
export const edlCopy = (language: string) => language.startsWith('zh') ? zh : en;

export const cutKindLabel = (kind: string, language: string) => {
  const english = !language.startsWith('zh');
  const labels: Record<string, [string, string]> = {
    baseline: ['初始剪辑版本', 'Initial cut version'], delete: ['删除片段', 'Delete segments'], restore: ['恢复片段', 'Restore segments'],
    silence: ['剪除空白', 'Remove silence'], suggestions: ['确认剪辑建议', 'Apply cut suggestions'],
    undo: ['撤销剪辑', 'Undo cuts'], redo: ['重做剪辑', 'Redo cuts'],
    'history-restore': ['回退剪辑版本', 'Restore cut version'], edit: ['编辑剪辑', 'Edit cuts'],
  };
  return (labels[kind] ?? labels.edit)[english ? 1 : 0];
};

const en = {
  section: 'Custom presets', saveAs: 'Save as preset', empty: 'Nothing here yet',
  unavailable: 'Open a project to save custom presets',
  namePlaceholder: 'Preset name', preview: 'Preview', save: 'Save preset', cancel: 'Cancel',
  apply: 'Apply', remove: 'Delete', confirmRemove: 'Delete this preset?', confirm: 'Delete', keep: 'Keep',
  overwriteTitle: 'A preset with this name already exists. Overwrite it?', overwrite: 'Overwrite',
  saved: 'Completed', deleted: 'Preset deleted', applied: 'Applied to the current style',
  fontMissing: 'The saved font is unavailable; the current font was kept',
  loading: 'Loading…', saving: 'Processing…', stale: 'Content changed. Review again.',
  staleHint: 'Reload the latest presets before saving again.', reload: 'Review again',
  failed: 'Cannot save. Try again.', retry: 'Retry', back: 'Back', count: '{count} presets',
};
const zh: typeof en = {
  section: '自定义预设', saveAs: '保存为预设', empty: '暂无内容',
  unavailable: '打开项目后可保存自定义预设',
  namePlaceholder: '预设名称', preview: '预览', save: '保存预设', cancel: '取消',
  apply: '应用', remove: '删除', confirmRemove: '确认删除这个预设？', confirm: '删除', keep: '保留',
  overwriteTitle: '已存在同名预设，确认覆盖？', overwrite: '覆盖',
  saved: '已完成', deleted: '预设已删除', applied: '已应用到当前样式',
  fontMissing: '预设使用的字体不可用，已保留当前字体',
  loading: '正在加载…', saving: '正在处理…', stale: '内容已更新，请重新检查',
  staleHint: '请重新读取最新预设后再保存。', reload: '重新检查',
  failed: '保存失败，请重试', retry: '重试', back: '返回', count: '{count} 个预设',
};
export const customPresetCopy = (language: string) => language.startsWith('zh') ? zh : en;
export const fillCustomPreset = (text: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((next, [key, value]) => next.replaceAll(`{${key}}`, String(value)), text);

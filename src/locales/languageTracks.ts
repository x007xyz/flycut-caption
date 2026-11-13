// F-0030 language-track UI copy. Kept together so every state has both locales.
const en = {
  title: 'Language tracks', add: 'Add language', rename: 'Rename', delete: 'Delete', close: 'Close', cancel: 'Cancel', save: 'Save',
  language: 'Language', name: 'Track name', unspecified: 'Unspecified', setLanguage: 'Set language',
  unknownLanguage: 'This legacy track has no language. Choose one or keep it unspecified.',
  legacyName: 'Legacy translation', empty: 'Nothing here yet', emptyTrack: 'No translation for this language',
  outdated: 'Translation is outdated', outdatedCount: '{count} outdated', translatedCount: '{count} translations',
  keep: 'Keep translation', retranslate: 'Retranslate', review: 'Review',
  addTitle: 'Add a language track', editTitle: 'Language track settings',
  addHint: 'The track shares this video’s subtitle timing and edit decisions.',
  editHint: 'Changing the language updates metadata only. Existing translations stay in place.',
  deleteTitle: 'Delete “{name}”?', deleteHint: 'All translations in this language will be removed. Existing subtitles and edit decisions stay unchanged.',
  confirmDelete: 'Delete track', countLabel: '{count} translations',
  loading: 'Loading…', processing: 'Processing…', completed: 'Completed',
  failed: 'Could not save language tracks', retry: 'Retry', back: 'Back',
  conflict: 'Content changed. Review again.', reviewConflict: 'Review changes',
  offline: 'Host is offline. Your changes stay in this editor.', required: 'Choose a language and enter a track name.',
};
const zh: typeof en = {
  title: '语言轨道', add: '添加语言', rename: '重命名', delete: '删除', close: '关闭', cancel: '取消', save: '保存',
  language: '语言', name: '轨道名称', unspecified: '未指定', setLanguage: '设置语言',
  unknownLanguage: '这条旧译文轨没有语言信息，请指定语言或保留为未指定。',
  legacyName: '旧副字幕', empty: '暂无内容', emptyTrack: '此语言尚无译文',
  outdated: '译文已过期', outdatedCount: '{count} 条过期', translatedCount: '{count} 条译文',
  keep: '保留译文', retranslate: '重新翻译', review: '检查',
  addTitle: '添加语言轨道', editTitle: '语言轨道设置',
  addHint: '轨道共用当前视频的字幕时间和编辑决定。',
  editHint: '修改语言只更新元数据，已有译文位置不变。',
  deleteTitle: '删除「{name}」？', deleteHint: '这条语言轨的全部译文会被删除；现有字幕和编辑决定保持不变。',
  confirmDelete: '删除轨道', countLabel: '{count} 条译文',
  loading: '正在加载…', processing: '正在处理…', completed: '已完成',
  failed: '语言轨道保存失败', retry: '重试', back: '返回',
  conflict: '内容已更新，请重新检查', reviewConflict: '检查更新',
  offline: 'Host 已离线，修改仍保留在当前编辑器。', required: '请选择语言并填写轨道名称。',
};
export const languageTrackCopy = (language: string) => language.startsWith('zh') ? zh : en;
export const fillLanguageTrack = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''));

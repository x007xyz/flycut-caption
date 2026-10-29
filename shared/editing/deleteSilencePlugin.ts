import { computeSmartCutBlank } from './smartCutBlankCore';
import type { EditorPlugin } from '../../src/types/plugin';

/** Built-in editor plugin: find long subtitle gaps and mark them for deletion. */
export const deleteSilencePlugin: EditorPlugin = {
  manifest: {
    schemaVersion: 1,
    id: 'delete-silence',
    name: '删除静音片段',
    description: '根据字幕时间间隙识别长静音段，并生成可预览、可撤销的删除操作。',
    kind: 'editor-action',
    status: 'available',
    input: ['transcript', 'timestamps'],
    output: ['edit-operations'],
    configFields: {
      threshold: { type: 'number', label: '最小静音时长（秒）', default: 1.5, min: 0.2, max: 10, step: 0.1 },
    },
  },

  analyze: (input, config) => {
    const threshold = typeof config.threshold === 'number' ? config.threshold : 1.5;
    const result = computeSmartCutBlank(input.chunks, threshold, input.totalDuration);
    return {
      ranges: result.segments.map((segment) => ({ ...segment, reason: 'silence' })),
      totalDuration: result.totalBlankSeconds,
      metadata: { threshold },
    };
  },

  buildOperations: (result) => result.ranges.map((range) => ({
    type: 'delete-range',
    start: range.start,
    end: range.end,
    reason: range.reason,
  })),
};

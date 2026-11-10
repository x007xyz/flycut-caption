import { analyzeFillers } from './fillerRules';
import type { EditorPlugin } from '../../src/types/plugin';

/** F-0007: rule-only filler analyzer shared by Workflow and Agent consumers. */
export const removeFillersPlugin: EditorPlugin = {
  manifest: {
    schemaVersion: 1,
    id: 'remove-fillers',
    name: '去口癖规则层',
    description: '按字词时间戳和规则词表生成独立语气词、叠词候选；只建议，不自动应用。',
    kind: 'editor-action',
    status: 'available',
    input: ['transcript', 'timestamps', 'words'],
    output: ['edit-operations'],
  },
  analyze: (input) => {
    const result = analyzeFillers({
      chunks: input.chunks.map(chunk => ({
        id: chunk.id ?? '', text: chunk.text ?? '', timestamp: chunk.timestamp,
        deleted: chunk.deleted, wordIds: chunk.wordIds, edlWordProjection: chunk.edlWordProjection,
      })),
      wordChunks: input.wordChunks,
      hasWordTimestamps: input.hasWordTimestamps,
      sourceDuration: input.totalDuration ?? 0,
    });
    return {
      ranges: result.candidates.map(candidate => ({
        start: candidate.start, end: candidate.end, reason: candidate.reason,
        category: candidate.category, label: candidate.label, confidence: candidate.confidence,
      })),
      totalDuration: result.stats.durationSeconds,
      metadata: {
        gate: result.gate.ok ? 'ok' : result.gate.reasons.join(','),
        skipped: result.stats.skipped,
        standalone: result.stats.standalone,
        repeated: result.stats.repeated,
      },
    };
  },
  buildOperations: (result) => result.ranges.map(range => ({
    type: 'delete-range', start: range.start, end: range.end, reason: range.reason,
    category: range.category, label: range.label, confidence: range.confidence,
  })),
};

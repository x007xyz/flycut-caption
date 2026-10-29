import type { SubtitleChunk } from '@/types/subtitle';
import { deleteSilencePlugin } from '../../shared/editing/deleteSilencePlugin';
export { computeSmartCutBlank, type SmartCutBlankResult } from '../../shared/editing/smartCutBlankCore';
import type { SmartCutBlankResult } from '../../shared/editing/smartCutBlankCore';

/**
 * 将空白段插入为已删除的占位 chunk（与 historyStore.insertBlankChunks 逻辑一致，纯函数版本供测试）
 */
export function applyBlankChunksPure(
  chunks: SubtitleChunk[],
  segments: Array<{ start: number; end: number }>,
): SubtitleChunk[] {
  if (segments.length === 0) return chunks;

  const existingIds = new Set(chunks.map((chunk) => chunk.id));
  const newBlankChunks: SubtitleChunk[] = [];

  for (const seg of segments) {
    const id = `blank-${seg.start.toFixed(3)}-${seg.end.toFixed(3)}`;
    if (existingIds.has(id)) continue;
    newBlankChunks.push({
      id,
      text: '',
      timestamp: [seg.start, seg.end],
      deleted: true,
      isBlankSpacer: true,
    });
  }

  if (newBlankChunks.length === 0) return chunks;

  return [...chunks, ...newBlankChunks].sort((a, b) => a.timestamp[0] - b.timestamp[0]);
}

export interface RunSmartCutBlankOptions {
  chunks: Array<{ timestamp: [number, number]; deleted?: boolean }>;
  threshold: number;
  totalDuration?: number;
  onEmpty: () => void;
  onDone: (result: SmartCutBlankResult) => void;
  insertBlankChunks: (segments: Array<{ start: number; end: number }>) => void;
}

/** UI 层共用的智能剪空白编排 */
export function runSmartCutBlank({
  chunks,
  threshold,
  totalDuration,
  onEmpty,
  onDone,
  insertBlankChunks,
}: RunSmartCutBlankOptions): void {
  const analysis = deleteSilencePlugin.analyze({ chunks, totalDuration }, { threshold });
  if (analysis.ranges.length === 0) {
    onEmpty();
    return;
  }
  const segments = analysis.ranges.map(({ start, end }) => ({ start, end }));
  insertBlankChunks(segments);
  onDone({ segments, totalBlankSeconds: analysis.totalDuration });
}

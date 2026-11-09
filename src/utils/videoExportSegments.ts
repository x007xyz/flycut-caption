import { createEdl, exportSegments, type Edl } from '../../shared/editing/edl';
import type { SubtitleChunk } from '@/types/subtitle';
import type { VideoSegment } from '@/types/video';
import { getCuttingChunks } from '@/utils/asrTranscriptUtils';

/** 相邻片段合并时允许的时间缝隙（秒） */
const ADJACENT_SEGMENT_GAP_TOLERANCE = 0.001;

export function hasDeletedCuttingChunks(
  chunks: SubtitleChunk[],
  wordChunks: SubtitleChunk[] | undefined,
  hasWordTimestamps: boolean,
): boolean {
  const cuttingChunks = getCuttingChunks(chunks, wordChunks, hasWordTimestamps);
  return cuttingChunks.some((chunk) => chunk.deleted);
}

/**
 * 合并相邻且 keep 状态相同的片段，减少 trim/concat 段数。
 * 字级删除场景下可把成百上千微片段收成连续 keep/delete 区间。
 */
export function mergeAdjacentExportSegments(segments: VideoSegment[]): VideoSegment[] {
  if (segments.length <= 1) return segments;

  const sorted = [...segments]
    .filter((seg) => seg.end > seg.start)
    .sort((a, b) => a.start - b.start);

  if (sorted.length <= 1) return sorted;

  const merged: VideoSegment[] = [];
  for (const seg of sorted) {
    const last = merged[merged.length - 1];
    if (
      last
      && last.keep === seg.keep
      && seg.start <= last.end + ADJACENT_SEGMENT_GAP_TOLERANCE
    ) {
      last.end = Math.max(last.end, seg.end);
      continue;
    }
    merged.push({
      start: seg.start,
      end: seg.end,
      keep: seg.keep,
      text: seg.text,
      secondText: seg.secondText,
      id: seg.id,
    });
  }
  return merged;
}

/** F-0005: only explicitly deleted ranges are removed; untouched silence is retained. */
export function buildVideoExportSegments(params: {
  chunks: SubtitleChunk[]; wordChunks?: SubtitleChunk[]; hasWordTimestamps: boolean; duration: number; edl?: Edl | null;
}): VideoSegment[] {
  const edl = params.edl ?? createEdl(params.duration, getCuttingChunks(params.chunks, params.wordChunks, params.hasWordTimestamps)
    .filter(c => c.deleted).map(c => ({ start: c.timestamp[0], end: c.timestamp[1] })));
  return exportSegments(edl);
}

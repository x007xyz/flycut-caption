import type { SubtitleChunk } from '@/types/subtitle';
import type { VideoSegment } from '@/types/video';
import { chunksToVtt } from './exportFormats';
import { projectFromKept } from '../../shared/editing/edl';
import { stripSubtitleDisplayPunctuation } from './cjkPunctuation';
import type { SubtitleDisplayMode } from './subtitleRenderer';

export interface BuildBurnTextSubtitleOptions {
  chunks: SubtitleChunk[];
  keptSegments: VideoSegment[];
  exportMode: SubtitleDisplayMode;
}

function remapBurnSubtitleChunks(
  chunks: SubtitleChunk[],
  keptSegments: VideoSegment[],
): SubtitleChunk[] {
  // 合成进视频的字幕去掉标点（与预览画面一致），但不影响独立导出的字幕文件与编辑器原文。
  const activeChunks = chunks
    .filter((c) => !c.deleted)
    .map((c) => ({
      ...c,
      text: stripSubtitleDisplayPunctuation(c.text ?? ''),
      secondText: c.secondText
        ? stripSubtitleDisplayPunctuation(c.secondText)
        : c.secondText,
    }))
    .filter((c) => c.text.trim() || c.secondText?.trim());
  return projectFromKept(activeChunks, keptSegments);
}

/** 为软字幕轨生成时间轴已重映射的 WebVTT 内容。 */
export function buildBurnTextSubtitleContent(options: BuildBurnTextSubtitleOptions): string {
  const { chunks, keptSegments, exportMode } = options;
  const remapped = remapBurnSubtitleChunks(chunks, keptSegments);
  return chunksToVtt(remapped, exportMode);
}

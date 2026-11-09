import type { SubtitleChunk } from '@/types/subtitle';
import type { VideoSegment } from '@/types/video';
import type { SubtitleStylePair } from './subtitleStyle';
import type { SubtitleDisplayMode } from './subtitleRenderer';
import { chunksToAss, chunksToVtt } from './exportFormats';
import { projectFromKept } from '../../shared/editing/edl';
import { stripSubtitleDisplayPunctuation } from './cjkPunctuation';

export interface BuildBurnAssOptions {
  chunks: SubtitleChunk[];
  keptSegments: VideoSegment[];
  stylePair: SubtitleStylePair;
  exportMode: SubtitleDisplayMode;
  playResX: number;
  playResY: number;
  /** 软烧录（mov_text）：Bilingual 降级为单样式合并文本，避免重叠 Dialogue 时长被截断 */
  softSubtitle?: boolean;
}

export interface BuildBurnTextSubtitleOptions {
  chunks: SubtitleChunk[];
  keptSegments: VideoSegment[];
  exportMode: SubtitleDisplayMode;
}

function remapBurnSubtitleChunks(
  chunks: SubtitleChunk[],
  keptSegments: VideoSegment[],
): SubtitleChunk[] {
  // 合成/烧录进视频的字幕去掉标点（与预览画面一致），但不影响独立导出的字幕文件与编辑器原文。
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

/** 为 FFmpeg 硬/软烧录生成时间轴已重映射的 ASS 内容 */
export function buildBurnAssContent(options: BuildBurnAssOptions): string {
  const { chunks, keptSegments, stylePair, exportMode, playResX, playResY, softSubtitle } = options;

  const remapped = remapBurnSubtitleChunks(chunks, keptSegments);

  // 直接传原始 chunks + stylePair + exportMode 给 chunksToAss：
  // - 'Main'/'Second' 单样式；'Bilingual' 双样式（Primary layer 0 + Secondary layer 1）
  // - 时间重映射已在 remapped 中完成，文本合并/分层由 chunksToAss 按 exportMode 处理
  return chunksToAss(remapped, {
    playResX,
    playResY,
    stylePair,
    exportMode,
    softSubtitle,
    title: 'FlyCut Caption Burn',
  });
}

/** 为软字幕轨生成时间轴已重映射的 WebVTT 内容。 */
export function buildBurnTextSubtitleContent(options: BuildBurnTextSubtitleOptions): string {
  const { chunks, keptSegments, exportMode } = options;
  const remapped = remapBurnSubtitleChunks(chunks, keptSegments);
  return chunksToVtt(remapped, exportMode);
}

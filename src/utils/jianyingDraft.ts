import type { Edl } from '../../shared/editing/edl';
import type { JianyingSnapshot, JianyingStyle } from '../../shared/jianying/draft';
import type { SubtitleChunk } from '@/types/subtitle';
import type { SubtitleStyle } from '@/subtitle';
import type { VideoFile } from '@/types/video';
import { isTauriRuntime } from '@/utils/runtime';

export interface JianyingSnapshotContext {
  edl: Edl;
  chunks: SubtitleChunk[];
  style: SubtitleStyle;
  videoMeta: { width: number; height: number };
  videoFile: VideoFile;
  project?: { projectId: string; videoId: string; name: string };
}

export interface SelectedJianyingDirectory { grant: string; expiresAt: string }

export function toJianyingStyle(style: SubtitleStyle): JianyingStyle {
  return {
    fontId: style.fontId,
    fontSizeRatio: style.fontSizeRatio,
    bottomOffsetRatio: style.bottomOffsetRatio,
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle,
    textDecoration: style.textDecoration,
    color: style.color,
    colorOpacity: style.colorOpacity,
    backgroundColor: style.backgroundColor,
    borderColor: style.borderColor,
    borderOpacity: style.borderOpacity,
    textAlign: style.textAlign,
    lineHeight: style.lineHeight,
    letterSpacing: style.letterSpacing,
    borderWidth: style.borderWidth,
    backgroundOpacity: style.backgroundOpacity,
  };
}

/** Freeze the formal edit state at preparation time. Pending suggestions are never passed here. */
export function buildJianyingSnapshot(context: JianyingSnapshotContext): JianyingSnapshot {
  return {
    edl: structuredClone(context.edl),
    cues: context.chunks.filter(cue => !cue.deleted && !cue.isBlankSpacer).map(cue => ({
      id: cue.id, text: cue.text, ...(cue.secondText ? { secondText: cue.secondText } : {}), timestamp: [...cue.timestamp] as [number, number],
    })),
    style: toJianyingStyle(context.style),
    videoWidth: context.videoMeta.width,
    videoHeight: context.videoMeta.height,
    ...(context.project ? { projectId: context.project.projectId, projectName: context.project.name, videoId: context.project.videoId } : {}),
    videoName: context.videoFile.name,
  };
}

export async function pickJianyingOutputDirectory(): Promise<SelectedJianyingDirectory | null> {
  if (!isTauriRuntime()) throw new Error('剪映草稿目录只能由桌面外壳选择');
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<SelectedJianyingDirectory | null>('pick_jianying_output_directory');
}

export function formatJianyingBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

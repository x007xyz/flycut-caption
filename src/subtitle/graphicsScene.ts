import type { SubtitleChunk } from '@/types/subtitle';
import type { VideoSegment } from '@/types/video';
import { projectFromKept } from '../../shared/editing/edl';
import {
  emptySubtitleGraphicStyle,
  resolveSubtitleFontFamily,
  stripSubtitleDisplayPunctuation,
  type SubtitleDisplayMode,
  type SubtitleGraphicCue,
  type SubtitleGraphicScene,
  type SubtitleGraphicStyle,
} from '../../shared/subtitle-graphics';
import { getMaxWidthRatio } from './subtitlePresets';
import type { SubtitleStyle, SubtitleStylePair } from './subtitleStyle';

export function toGraphicStyle(style: SubtitleStyle): SubtitleGraphicStyle {
  const base = emptySubtitleGraphicStyle(style.fontId);
  return {
    ...base,
    fontId: style.fontId,
    fontFamily: resolveSubtitleFontFamily(style.fontId),
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
    shadowColor: style.shadowColor,
    textAlign: style.textAlign,
    lineHeight: style.lineHeight,
    letterSpacing: style.letterSpacing,
    borderWidth: style.borderWidth,
    shadowOffsetX: style.shadowOffsetX,
    shadowOffsetY: style.shadowOffsetY,
    shadowBlur: style.shadowBlur,
    backgroundOpacity: style.backgroundOpacity,
    backgroundRadius: style.backgroundRadius,
    backgroundPadding: style.backgroundPadding,
    visible: style.visible,
  };
}

interface SceneInput {
  chunks: SubtitleChunk[];
  stylePair: SubtitleStylePair;
  displayMode?: SubtitleDisplayMode;
  videoWidth: number;
  videoHeight: number;
  fps?: number;
  duration: number;
}

function displayText(text: string | undefined): string {
  return stripSubtitleDisplayPunctuation(text ?? '');
}

function sceneShell(input: SceneInput, cues: SubtitleGraphicCue[]): SubtitleGraphicScene {
  const primary = toGraphicStyle(input.stylePair.primary);
  const secondary = toGraphicStyle(input.stylePair.secondary);
  const width = Math.max(2, Math.round(input.videoWidth || 1920));
  const height = Math.max(2, Math.round(input.videoHeight || 1080));
  const duration = Math.max(0, input.duration || Math.max(0, ...cues.map((cue) => cue.end), 0));
  return {
    version: 1,
    width,
    height,
    fps: Math.max(0.1, input.fps ?? 30),
    duration,
    fontId: primary.fontId,
    fontFamily: primary.fontFamily,
    displayMode: input.displayMode ?? 'Bilingual',
    maxWidthRatio: getMaxWidthRatio(input.stylePair.primary.aspectPreset),
    primary,
    secondary,
    cues,
  };
}

function toCue(chunk: SubtitleChunk, offset = 0): SubtitleGraphicCue | undefined {
  const start = Math.max(0, chunk.timestamp[0] + offset);
  const end = Math.max(0, chunk.timestamp[1] + offset);
  if (!(end > start)) return undefined;
  const text = displayText(chunk.text);
  const secondText = displayText(chunk.secondText);
  if (!text && !secondText) return undefined;
  return { id: chunk.id, start, end, text, secondText: secondText || undefined };
}

/** 预览场景：时间轴仍是原始媒体时间，删除的片段由播放器可见性控制。 */
export function buildPreviewSubtitleScene(input: SceneInput): SubtitleGraphicScene {
  const cues = input.chunks
    .filter((chunk) => !chunk.deleted && !chunk.isBlankSpacer)
    .map((chunk) => toCue(chunk))
    .filter((cue): cue is SubtitleGraphicCue => Boolean(cue))
    .sort((a, b) => a.start - b.start);
  return sceneShell(input, cues);
}

/** 导出场景：先按现有 EDL 投影到成片时间轴，再交给 Host。 */
export function buildExportSubtitleScene(input: SceneInput & { keptSegments: VideoSegment[] }): SubtitleGraphicScene {
  const active = input.chunks
    .filter((chunk) => !chunk.deleted && !chunk.isBlankSpacer)
    .map((chunk) => ({
      ...chunk,
      text: displayText(chunk.text),
      secondText: displayText(chunk.secondText),
    }))
    .filter((chunk) => chunk.text.trim() || chunk.secondText?.trim());
  const projected = projectFromKept(active, input.keptSegments);
  const cues = projected
    .map((chunk) => toCue({ ...chunk, id: chunk.id }))
    .filter((cue): cue is SubtitleGraphicCue => Boolean(cue))
    .sort((a, b) => a.start - b.start);
  return sceneShell(input, cues);
}

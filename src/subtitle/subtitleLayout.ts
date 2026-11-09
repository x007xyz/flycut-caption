import type { SubtitleStyle } from './subtitleStyle';
import { getStyleFontFamily } from './subtitleStyle';
import { resolveVideoFontSize } from './subtitleMetrics';
import { getMaxWidthRatio } from './subtitlePresets';
import { layoutTextLines } from '../../shared/subtitle-graphics/layout';

export interface LayoutSubtitleOptions {
  maxWidth: number;
  videoHeight: number;
  fontSizePx?: number;
  aspectPreset?: SubtitleStyle['aspectPreset'];
}

/**
 * 使用 Pretext 对字幕文本换行，并应用中文标点禁则后处理。
 */
export function layoutSubtitleLines(
  text: string,
  style: SubtitleStyle,
  options: LayoutSubtitleOptions,
): string[] {
  const { maxWidth, videoHeight, fontSizePx } = options;
  const fontSize = fontSizePx ?? resolveVideoFontSize(style, videoHeight);
  return layoutTextLines(text, {
    fontFamily: getStyleFontFamily(style),
    fontStyle: style.fontStyle,
    fontWeight: style.fontWeight,
    lineHeight: style.lineHeight,
    letterSpacing: style.letterSpacing,
  }, fontSize, maxWidth).map((line) => line.text);
}

/** 计算视频坐标系下的最大文本宽度 */
export function resolveLayoutMaxWidth(
  videoWidth: number,
  style: SubtitleStyle,
): number {
  const ratio = getMaxWidthRatio(style.aspectPreset);
  return Math.max(100, Math.round(videoWidth * ratio));
}

/** 将主/副字幕格式化为带换行的导出文本 */
export function formatBilingualText(
  primary: string,
  secondText: string | undefined,
  style: SubtitleStyle,
  videoWidth: number,
  videoHeight: number,
): string {
  const maxWidth = resolveLayoutMaxWidth(videoWidth, style);
  const primaryLines = layoutSubtitleLines(primary, style, { maxWidth, videoHeight });
  const parts = [primaryLines.join('\n')];

  if (secondText?.trim()) {
    const secondarySize = Math.round(resolveVideoFontSize(style, videoHeight) * 0.75);
    const secondaryLines = layoutSubtitleLines(secondText, style, {
      maxWidth,
      videoHeight,
      fontSizePx: secondarySize,
    });
    if (secondaryLines.length > 0) {
      parts.push(secondaryLines.join('\n'));
    }
  }

  return parts.filter(Boolean).join('\n');
}

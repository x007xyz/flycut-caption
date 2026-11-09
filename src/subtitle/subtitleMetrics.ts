import type { SubtitleStyle } from './subtitleStyle';
import { getStyleFontFamily } from './subtitleStyle';

/** 视频坐标系中的字号（px） */
export function resolveVideoFontSize(style: SubtitleStyle, videoHeight: number): number {
  if (!videoHeight || videoHeight <= 0) {
    return Math.round(1080 * style.fontSizeRatio);
  }
  return Math.max(8, Math.round(videoHeight * style.fontSizeRatio));
}

/** 视频坐标系中的底边距（px） */
export function resolveBottomOffset(style: SubtitleStyle, videoHeight: number): number {
  if (!videoHeight || videoHeight <= 0) {
    return Math.round(1080 * style.bottomOffsetRatio);
  }
  return Math.max(0, Math.round(videoHeight * style.bottomOffsetRatio));
}

/** 预览容器缩放：视频空间 px → 屏幕显示 px */
export function scaleVideoMetric(videoPixels: number, displayHeight: number, videoHeight: number): number {
  if (!videoHeight || videoHeight <= 0) return videoPixels;
  return Math.round(videoPixels * (displayHeight / videoHeight));
}

/** Canvas ctx.font 字符串 */
export function buildCanvasFont(style: SubtitleStyle, fontSizePx: number): string {
  return `${style.fontStyle} ${style.fontWeight} ${fontSizePx}px ${getStyleFontFamily(style)}`;
}


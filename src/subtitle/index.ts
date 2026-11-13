export {
  defaultSubtitleStyle,
  defaultSecondarySubtitleStyle,
  defaultSubtitleStylePair,
  migrateSubtitleStyle,
  fontSizeAtReference,
  bottomOffsetAtReference,
  fontSizeRatioFromReference,
  bottomOffsetRatioFromReference,
  getStyleFontFamily,
  applyShadowSize,
  type ShadowSize,
  DEFAULT_FONT_SIZE_RATIO,
  DEFAULT_BOTTOM_OFFSET_RATIO,
} from './subtitleStyle';
export type { SubtitleStyle, SubtitleStylePair } from './subtitleStyle';

export {
  resolveVideoFontSize,
  resolveBottomOffset,
  scaleVideoMetric,
  buildCanvasFont,
} from './subtitleMetrics';

export {
  registerSubtitleFonts,
  ensureSubtitleFont,
  ensureSubtitleFonts,
  retrySubtitleFonts,
  getSubtitleFontState,
  subscribeSubtitleFontState,
} from './subtitleFonts';
export type { SubtitleFontState, SubtitleFontStatus } from './subtitleFonts';

export {
  layoutSubtitleLines,
  resolveLayoutMaxWidth,
} from './subtitleLayout';

export { renderSubtitleFrame } from './subtitleRenderer';
export type { SubtitleRenderContent, SubtitleRenderFrame, SubtitleDisplayMode } from './subtitleRenderer';

export { toGraphicStyle, buildPreviewSubtitleScene, buildExportSubtitleScene, hasReliableWordHighlight } from './graphicsScene';

export {
  ASPECT_PRESETS,
  STYLE_PRESETS,
  DEFAULT_STYLE_PRESET_ID,
  applyAspectPreset,
  applyStylePreset,
  matchActiveStylePreset,
  inferAspectPreset,
  getMaxWidthRatio,
} from './subtitlePresets';
export type { AspectPreset, StylePresetId } from './subtitlePresets';

export {
  PLATFORM_PRESET_REFERENCE_DATE,
  PLATFORM_PRESETS,
  PLATFORM_PRESET_IDS,
  isPlatformPresetId,
  getPlatformPreset,
  clampSafeZoneInsets,
  resolveSafeZoneInsets,
  isBottomInSafeZoneOcclusion,
  getFontLanguageCoverage,
  hasUncoveredCjkSubtitles,
  applyPlatformPreset,
  toggleSafeZoneGuide,
  selectSafeZonePlatform,
  updateSafeZoneInsets,
  resetSafeZoneInsets,
  alignSubtitleAboveSafeZone,
  resolveEffectiveSafeZone,
  matchActivePlatformPreset,
  type PlatformPresetId,
  type PlatformAspectPreset,
  type SafeZoneInsets,
  type PlatformVerificationInfo,
  type PlatformPresetStylePatch,
  type PlatformPresetDefinition,
  type ResolvedSafeZoneState,
} from './platformPresets';

export {
  chunksToSrt,
  chunksToVtt,
  chunksToJson,
  chunksToAss,
  serializeSubtitleExport,
  getExportFilename,
  getExportMimeType,
  getExportFileTypes,
} from './exportFormats';
export type { SubtitleExportFormat, AssExportOptions } from './exportFormats';

export { stripSubtitleDisplayPunctuation } from './cjkPunctuation';

export { buildBurnTextSubtitleContent } from './softSubtitles';
export { mapSubtitleTimingsToCutVideo, applyMappedTimings } from './subtitleTimeMapping';

export { SUBTITLE_FONTS, REFERENCE_VIDEO_HEIGHT, DEFAULT_SUBTITLE_FONT_ID } from '@/config/subtitleFonts';
export type { SubtitleFontDefinition } from '@/config/subtitleFonts';

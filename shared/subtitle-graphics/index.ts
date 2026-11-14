export {
  subtitleGraphicStyleSchema,
  subtitleGraphicWordSchema,
  subtitleGraphicKeywordSchema,
  subtitleGraphicCueSchema,
  subtitleGraphicSceneSchema,
  emptySubtitleGraphicStyle,
  validateSubtitleGraphicScene,
} from './scene';
export type {
  SubtitleGraphicStyle,
  SubtitleGraphicWord,
  SubtitleGraphicKeyword,
  SubtitleGraphicCue,
  SubtitleGraphicScene,
  SubtitleDisplayMode,
} from './scene';

export {
  BLOCK_GAP_RATIO,
  resolveKeywordMetrics,
  resolveVideoFontSize,
  resolveBottomOffset,
  buildCanvasFont,
  resolveLayoutMaxWidth,
  layoutCue,
  layoutScene,
  layoutTextLines,
  getCueLayout,
  findCue,
  mapCueWordRanges,
  findActiveWordRange,
  type TextLine,
  type LayoutItem,
  type LayoutRun,
  type LayoutLine,
  type LayoutBlock,
  type CueLayout,
  type LayoutWordRange,
  type KeywordMetrics,
} from './layout';

export { drawFrame, frameKey, subtitleBand, findVisibleCue, type SubtitleDrawOptions } from './draw';

export {
  SUBTITLE_FONT_ASSETS,
  DEFAULT_SUBTITLE_FONT_ID,
  getSubtitleFontAsset,
  resolveSubtitleFontFamily,
  type SubtitleFontAsset,
} from './fonts';

export {
  stripSubtitleDisplayPunctuation,
  mapRawRangesToDisplay,
  fixCjkLineStarts,
  applyCjkBreakHints,
  type RawRangeInput,
  type DisplayRangeResult,
} from './text';

export {
  defaultExportStylePair,
  resolveProjectExportStylePair,
  buildProjectExportSubtitleScene,
  serializeProjectSubtitles,
  type ExportableChunk,
  type ExportStyleConfig,
  type ExportStylePair,
} from './projectExport';

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
  type PlatformPresetId,
  type PlatformAspectPreset,
  type SafeZoneInsets,
  type PlatformVerificationInfo,
  type PlatformPresetStylePatch,
  type PlatformPresetDefinition,
} from './platformPresets';

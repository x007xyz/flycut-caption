export {
  subtitleGraphicStyleSchema,
  subtitleGraphicWordSchema,
  subtitleGraphicCueSchema,
  subtitleGraphicSceneSchema,
  emptySubtitleGraphicStyle,
  validateSubtitleGraphicScene,
} from './scene';
export type {
  SubtitleGraphicStyle,
  SubtitleGraphicWord,
  SubtitleGraphicCue,
  SubtitleGraphicScene,
  SubtitleDisplayMode,
} from './scene';

export {
  BLOCK_GAP_RATIO,
  resolveVideoFontSize,
  resolveBottomOffset,
  buildCanvasFont,
  resolveLayoutMaxWidth,
  layoutCue,
  layoutScene,
  layoutTextLines,
  getCueLayout,
  findCue,
  type TextLine,
  type LayoutItem,
  type LayoutLine,
  type LayoutBlock,
  type CueLayout,
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
  fixCjkLineStarts,
  applyCjkBreakHints,
} from './text';

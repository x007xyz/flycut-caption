import type { CustomStylePreset } from '../../shared/stylePresets';
import { SUBTITLE_FONTS } from '@/config/subtitleFonts';
import type { SubtitleStyle, SubtitleStylePair } from './subtitleStyle';

export interface AppliedCustomPreset {
  pair: SubtitleStylePair;
  missingFont: boolean;
}

/** Apply the saved text style but keep this video's aspect preset and bottom offset. */
export function applyCustomStylePreset(current: SubtitleStylePair, preset: Pick<CustomStylePreset, 'primary' | 'secondary'>): AppliedCustomPreset {
  let missingFont = false;
  const merge = (style: SubtitleStyle, raw: Record<string, unknown>): SubtitleStyle => {
    const next = { ...style, ...raw } as SubtitleStyle & { aspectPreset?: unknown };
    next.aspectPreset = style.aspectPreset;
    next.bottomOffsetRatio = style.bottomOffsetRatio;
    if (!SUBTITLE_FONTS.some(font => font.id === next.fontId)) {
      next.fontId = style.fontId;
      missingFont = true;
    }
    return next;
  };
  return { pair: { primary: merge(current.primary, preset.primary), secondary: merge(current.secondary, preset.secondary) }, missingFont };
}

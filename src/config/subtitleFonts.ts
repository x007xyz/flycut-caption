// 字幕字体清单（自托管 via @fontsource，OFL 协议）

export interface SubtitleFontDefinition {
  id: string;
  label: string;
  /** CSS font-family，用于 Canvas */
  family: string;
  recommended?: boolean;
  languages: string[];
}

export const REFERENCE_VIDEO_HEIGHT = 1080;

export const SUBTITLE_FONTS: SubtitleFontDefinition[] = [
  {
    id: 'noto-sans-sc',
    label: 'Noto Sans SC',
    family: '"Noto Sans SC", sans-serif',
    recommended: true,
    languages: ['zh', 'en'],
  },
  {
    id: 'inter',
    label: 'Inter',
    family: 'Inter, sans-serif',
    recommended: false,
    languages: ['en'],
  },
  {
    id: 'arial',
    label: 'Arial',
    family: 'Arial, sans-serif',
    recommended: false,
    languages: ['en'],
  },
  {
    id: 'georgia',
    label: 'Georgia',
    family: 'Georgia, serif',
    recommended: false,
    languages: ['en'],
  },
];

export const DEFAULT_SUBTITLE_FONT_ID = 'noto-sans-sc';

export function getSubtitleFont(fontId: string): SubtitleFontDefinition | undefined {
  return SUBTITLE_FONTS.find((f) => f.id === fontId);
}

export function resolveFontFamily(fontId: string): string {
  return getSubtitleFont(fontId)?.family ?? SUBTITLE_FONTS[0].family;
}

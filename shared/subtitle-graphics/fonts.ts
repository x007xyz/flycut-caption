/** 两端共用的字幕字体清单。文件由 scripts/fetch-subtitle-fonts.sh 下载到同一组文件名。 */

export interface SubtitleFontAsset {
  id: string;
  /** Canvas font-family，浏览器 FontFace 与 Host GlobalFonts 都用这个名字 */
  family: string;
  regular?: string;
  bold?: string;
  bundled: boolean;
}

export const SUBTITLE_FONT_ASSETS: Record<string, SubtitleFontAsset> = {
  'noto-sans-sc': {
    id: 'noto-sans-sc',
    family: 'FlyCutNotoSansSC',
    regular: 'NotoSansSC-Regular.otf',
    bold: 'NotoSansSC-Bold.otf',
    bundled: true,
  },
  inter: {
    id: 'inter',
    family: 'FlyCutInter',
    regular: 'Inter-Regular.ttf',
    bold: 'Inter-Bold.ttf',
    bundled: true,
  },
  arial: { id: 'arial', family: 'Arial', bundled: false },
  georgia: { id: 'georgia', family: 'Georgia', bundled: false },
};

export const DEFAULT_SUBTITLE_FONT_ID = 'noto-sans-sc';

export function getSubtitleFontAsset(fontId: string): SubtitleFontAsset {
  return SUBTITLE_FONT_ASSETS[fontId] ?? SUBTITLE_FONT_ASSETS[DEFAULT_SUBTITLE_FONT_ID];
}

export function resolveSubtitleFontFamily(fontId: string): string {
  return getSubtitleFontAsset(fontId).family;
}

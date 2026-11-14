import type { SubtitleGraphicStyle } from './scene';

export type PlatformPresetId =
  | 'douyin'
  | 'wechat-channels'
  | 'xiaohongshu'
  | 'bilibili'
  | 'youtube-shorts';

export type PlatformAspectPreset = 'landscape' | 'portrait_9_16' | 'square_1_1';

/** Normalized occlusion margins from each frame edge (0..0.45). */
export interface SafeZoneInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PlatformVerificationInfo {
  verified: boolean;
  referenceDate: string;
  appVersion?: string;
  noteZh: string;
  noteEn: string;
}

export interface PlatformPresetStylePatch extends Partial<Omit<SubtitleGraphicStyle, 'fontFamily' | 'visible'>> {
  fontId: string;
  aspectPreset: PlatformAspectPreset;
  bottomOffsetRatio: number;
  fontSizeRatio: number;
  wordHighlightMode: 'none' | 'word';
  wordHighlightColor: string;
  keywordColorEnabled: boolean;
  keywordColor: string;
  keywordScale: number;
  keywordBackgroundColor: string;
  keywordBackgroundOpacity: number;
}

export interface PlatformPresetDefinition {
  id: PlatformPresetId;
  nameZh: string;
  nameEn: string;
  aspectPreset: PlatformAspectPreset;
  aspectLabel: string;
  descriptionZh: string;
  descriptionEn: string;
  safeZone: SafeZoneInsets;
  verification: PlatformVerificationInfo;
  stylePatch: PlatformPresetStylePatch;
}

export const PLATFORM_PRESET_REFERENCE_DATE = '2026-11-13';

export const PLATFORM_PRESETS: readonly PlatformPresetDefinition[] = [
  {
    id: 'douyin',
    nameZh: '抖音',
    nameEn: 'Douyin',
    aspectPreset: 'portrait_9_16',
    aspectLabel: '9:16',
    descriptionZh: '竖屏口播高对比白字黑边，明黄逐字与关键词强调，避开底部文案及右侧互动栏',
    descriptionEn: 'Vertical 9:16 high-contrast white stroke with yellow word & keyword highlight above bottom feed UI',
    safeZone: { top: 0.13, bottom: 0.24, left: 0.06, right: 0.16 },
    verification: {
      verified: false,
      referenceDate: PLATFORM_PRESET_REFERENCE_DATE,
      noteZh: '参考，未验证（尚未用实机抖音客户端界面截图标定）',
      noteEn: 'Reference, unverified (not yet calibrated against a live Douyin app capture)',
    },
    stylePatch: {
      fontId: 'noto-sans-sc',
      aspectPreset: 'portrait_9_16',
      fontSizeRatio: 0.034,
      bottomOffsetRatio: 0.255,
      fontWeight: 'bold',
      fontStyle: 'normal',
      textDecoration: 'none',
      color: '#FFFFFF',
      colorOpacity: 1,
      borderColor: '#000000',
      borderOpacity: 1,
      borderWidth: 2.5,
      backgroundColor: '#000000',
      backgroundOpacity: 0,
      backgroundRadius: 6,
      backgroundPadding: 8,
      shadowColor: '#000000',
      shadowBlur: 0,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      textAlign: 'center',
      lineHeight: 1.2,
      letterSpacing: 0,
      wordHighlightMode: 'word',
      wordHighlightColor: '#FFE100',
      keywordColorEnabled: true,
      keywordColor: '#FFE100',
      keywordScale: 1.25,
      keywordBackgroundColor: '#FF3B5C',
      keywordBackgroundOpacity: 0,
    },
  },
  {
    id: 'wechat-channels',
    nameZh: '视频号',
    nameEn: 'WeChat Channels',
    aspectPreset: 'portrait_9_16',
    aspectLabel: '9:16',
    descriptionZh: '竖屏半透明深底白字，绿底关键词突出，预留底部账号标题与右侧点赞区',
    descriptionEn: 'Vertical 9:16 crisp dark pill with green keyword badge above bottom account bar',
    safeZone: { top: 0.12, bottom: 0.22, left: 0.06, right: 0.15 },
    verification: {
      verified: false,
      referenceDate: PLATFORM_PRESET_REFERENCE_DATE,
      noteZh: '参考，未验证（尚未用实机视频号客户端界面截图标定）',
      noteEn: 'Reference, unverified (not yet calibrated against a live WeChat Channels capture)',
    },
    stylePatch: {
      fontId: 'noto-sans-sc',
      aspectPreset: 'portrait_9_16',
      fontSizeRatio: 0.033,
      bottomOffsetRatio: 0.235,
      fontWeight: 'bold',
      fontStyle: 'normal',
      textDecoration: 'none',
      color: '#FFFFFF',
      colorOpacity: 1,
      borderColor: '#111111',
      borderOpacity: 1,
      borderWidth: 1.5,
      backgroundColor: '#000000',
      backgroundOpacity: 0.6,
      backgroundRadius: 6,
      backgroundPadding: 8,
      shadowColor: '#000000',
      shadowBlur: 0,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      textAlign: 'center',
      lineHeight: 1.25,
      letterSpacing: 0,
      wordHighlightMode: 'word',
      wordHighlightColor: '#FFD60A',
      keywordColorEnabled: true,
      keywordColor: '#FFFFFF',
      keywordScale: 1.18,
      keywordBackgroundColor: '#07C160',
      keywordBackgroundOpacity: 0.85,
    },
  },
  {
    id: 'xiaohongshu',
    nameZh: '小红书',
    nameEn: 'Xiaohongshu',
    aspectPreset: 'portrait_9_16',
    aspectLabel: '9:16',
    descriptionZh: '竖屏暖白黑边搭配品牌红底关键词卡片，适配种草与知识笔记图文感',
    descriptionEn: 'Vertical 9:16 warm white text with coral-red keyword badge for editorial clips',
    safeZone: { top: 0.12, bottom: 0.21, left: 0.06, right: 0.15 },
    verification: {
      verified: false,
      referenceDate: PLATFORM_PRESET_REFERENCE_DATE,
      noteZh: '参考，未验证（尚未用实机小红书客户端界面截图标定）',
      noteEn: 'Reference, unverified (not yet calibrated against a live Xiaohongshu capture)',
    },
    stylePatch: {
      fontId: 'noto-sans-sc',
      aspectPreset: 'portrait_9_16',
      fontSizeRatio: 0.033,
      bottomOffsetRatio: 0.225,
      fontWeight: 'bold',
      fontStyle: 'normal',
      textDecoration: 'none',
      color: '#FFFDF7',
      colorOpacity: 1,
      borderColor: '#1F1F1F',
      borderOpacity: 0.95,
      borderWidth: 2,
      backgroundColor: '#000000',
      backgroundOpacity: 0,
      backgroundRadius: 6,
      backgroundPadding: 8,
      shadowColor: '#000000',
      shadowBlur: 0,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      textAlign: 'center',
      lineHeight: 1.25,
      letterSpacing: 0.5,
      wordHighlightMode: 'word',
      wordHighlightColor: '#FF4D6D',
      keywordColorEnabled: true,
      keywordColor: '#FFFFFF',
      keywordScale: 1.2,
      keywordBackgroundColor: '#FF2442',
      keywordBackgroundOpacity: 0.9,
    },
  },
  {
    id: 'bilibili',
    nameZh: 'B 站',
    nameEn: 'Bilibili',
    aspectPreset: 'landscape',
    aspectLabel: '16:9',
    descriptionZh: '横屏 16:9 清晰白字黑边搭配 B 站蓝逐字与重点色，避开底部播放进度栏',
    descriptionEn: 'Landscape 16:9 white stroke with cyan word highlight above player control bar',
    safeZone: { top: 0.1, bottom: 0.12, left: 0.05, right: 0.05 },
    verification: {
      verified: false,
      referenceDate: PLATFORM_PRESET_REFERENCE_DATE,
      noteZh: '参考，未验证（尚未用实机 B 站客户端/网页播放器截图标定）',
      noteEn: 'Reference, unverified (not yet calibrated against a live Bilibili player capture)',
    },
    stylePatch: {
      fontId: 'noto-sans-sc',
      aspectPreset: 'landscape',
      fontSizeRatio: 0.045,
      bottomOffsetRatio: 0.135,
      fontWeight: 'bold',
      fontStyle: 'normal',
      textDecoration: 'none',
      color: '#FFFFFF',
      colorOpacity: 1,
      borderColor: '#000000',
      borderOpacity: 1,
      borderWidth: 2,
      backgroundColor: '#000000',
      backgroundOpacity: 0,
      backgroundRadius: 4,
      backgroundPadding: 8,
      shadowColor: '#000000',
      shadowBlur: 0,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      textAlign: 'center',
      lineHeight: 1.2,
      letterSpacing: 0,
      wordHighlightMode: 'word',
      wordHighlightColor: '#00AEEC',
      keywordColorEnabled: true,
      keywordColor: '#00AEEC',
      keywordScale: 1.22,
      keywordBackgroundColor: '#FB7299',
      keywordBackgroundOpacity: 0,
    },
  },
  {
    id: 'youtube-shorts',
    nameZh: 'YouTube Shorts',
    nameEn: 'YouTube Shorts',
    aspectPreset: 'portrait_9_16',
    aspectLabel: '9:16',
    descriptionZh: '竖屏高饱和黑底白字与强黄高亮、红色关键词底框，避开底部频道与右侧操作区',
    descriptionEn: 'Vertical 9:16 high-contrast dark box with yellow word highlight & red keyword badge',
    safeZone: { top: 0.12, bottom: 0.23, left: 0.06, right: 0.16 },
    verification: {
      verified: false,
      referenceDate: PLATFORM_PRESET_REFERENCE_DATE,
      noteZh: '参考，未验证（尚未用实机 YouTube Shorts 界面截图标定）',
      noteEn: 'Reference, unverified (not yet calibrated against a live YouTube Shorts capture)',
    },
    stylePatch: {
      fontId: 'noto-sans-sc',
      aspectPreset: 'portrait_9_16',
      fontSizeRatio: 0.036,
      bottomOffsetRatio: 0.245,
      fontWeight: 'bold',
      fontStyle: 'normal',
      textDecoration: 'none',
      color: '#FFFFFF',
      colorOpacity: 1,
      borderColor: '#000000',
      borderOpacity: 1,
      borderWidth: 2,
      backgroundColor: '#000000',
      backgroundOpacity: 0.78,
      backgroundRadius: 8,
      backgroundPadding: 10,
      shadowColor: '#000000',
      shadowBlur: 0,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      textAlign: 'center',
      lineHeight: 1.2,
      letterSpacing: 0,
      wordHighlightMode: 'word',
      wordHighlightColor: '#FFDE00',
      keywordColorEnabled: true,
      keywordColor: '#FFFFFF',
      keywordScale: 1.25,
      keywordBackgroundColor: '#FF0000',
      keywordBackgroundOpacity: 0.88,
    },
  },
];

export const PLATFORM_PRESET_IDS: readonly PlatformPresetId[] = PLATFORM_PRESETS.map(p => p.id);

export function isPlatformPresetId(value: unknown): value is PlatformPresetId {
  return typeof value === 'string' && PLATFORM_PRESET_IDS.includes(value as PlatformPresetId);
}

export function getPlatformPreset(id: PlatformPresetId | undefined): PlatformPresetDefinition | undefined {
  return id ? PLATFORM_PRESETS.find(preset => preset.id === id) : undefined;
}

const clampEdge = (value: number, fallback: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(0.45, Math.max(0, Math.round(value * 1000) / 1000));
};

export function clampSafeZoneInsets(insets: SafeZoneInsets, fallback: SafeZoneInsets = { top: 0.1, bottom: 0.2, left: 0.05, right: 0.05 }): SafeZoneInsets {
  const top = clampEdge(insets.top, fallback.top);
  let bottom = clampEdge(insets.bottom, fallback.bottom);
  const left = clampEdge(insets.left, fallback.left);
  let right = clampEdge(insets.right, fallback.right);
  if (top + bottom > 0.85) {
    const excess = top + bottom - 0.85;
    bottom = Math.max(0, Math.round((bottom - excess) * 1000) / 1000);
  }
  if (left + right > 0.85) {
    const excess = left + right - 0.85;
    right = Math.max(0, Math.round((right - excess) * 1000) / 1000);
  }
  return { top, bottom, left, right };
}

export function resolveSafeZoneInsets(platformId: PlatformPresetId, override?: Partial<SafeZoneInsets>): SafeZoneInsets {
  const base = getPlatformPreset(platformId)?.safeZone ?? PLATFORM_PRESETS[0].safeZone;
  if (!override) return { ...base };
  return clampSafeZoneInsets({
    top: override.top ?? base.top,
    bottom: override.bottom ?? base.bottom,
    left: override.left ?? base.left,
    right: override.right ?? base.right,
  }, base);
}

export function isBottomInSafeZoneOcclusion(bottomOffsetRatio: number, insets: SafeZoneInsets): boolean {
  return Number.isFinite(bottomOffsetRatio) && bottomOffsetRatio < insets.bottom - 0.001;
}

const CJK_CHAR_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/;

const FONT_SUPPORTED_LANGUAGES: Record<string, readonly string[]> = {
  'noto-sans-sc': ['zh', 'en'],
  inter: ['en'],
  arial: ['en'],
  georgia: ['en'],
};

export function getFontLanguageCoverage(fontId: string): readonly string[] {
  return FONT_SUPPORTED_LANGUAGES[fontId] ?? ['en'];
}

export function hasUncoveredCjkSubtitles(fontId: string, texts: readonly string[]): boolean {
  const langs = getFontLanguageCoverage(fontId);
  if (langs.includes('zh')) return false;
  return texts.some(text => CJK_CHAR_RE.test(text));
}

import type { SubtitleStyle } from './subtitleStyle';
import { DEFAULT_BOTTOM_OFFSET_RATIO } from './subtitleStyle';

export type AspectPreset = 'landscape' | 'portrait_9_16' | 'square_1_1';
export type StylePresetId =
  | 'white-black'
  | 'word-highlight'
  | 'none'
  | 'white-outline'
  | 'yellow-black'
  | 'red-white'
  | 'blue-black'
  | 'pink-white'
  | 'cyan-white'
  | 'lime-black'
  | 'gray-blue'
  | 'red-white-bold'
  | 'brown-white'
  | 'cream-brown'
  | 'rose-white'
  | 'black-bg'
  | 'white-bg'
  | 'yellow-bg'
  | 'red-bg'
  | 'green-bg'
  | 'blue-bg'
  | 'pink-bg'
  | 'peach-plain'
  | 'orange-red'
  | 'green-black';

export interface StylePresetPreview {
  textColor: string;
  backgroundColor?: string;
  borderColor?: string;
  showNone?: boolean;
}

export interface AspectPresetConfig {
  id: AspectPreset;
  label: string;
  bottomOffsetRatio: number;
  maxWidthRatio: number;
}

export const ASPECT_PRESETS: AspectPresetConfig[] = [
  {
    id: 'landscape',
    label: '横屏 16:9',
    bottomOffsetRatio: DEFAULT_BOTTOM_OFFSET_RATIO,
    maxWidthRatio: 0.9,
  },
  {
    id: 'portrait_9_16',
    label: '竖屏 9:16',
    bottomOffsetRatio: 130 / 1080,
    maxWidthRatio: 0.85,
  },
  {
    id: 'square_1_1',
    label: '方形 1:1',
    bottomOffsetRatio: 80 / 1080,
    maxWidthRatio: 0.88,
  },
];

/** 预设公共基线：切换预设时重置背景/阴影/字重，避免残留上一套样式 */
const BASE_TEXT_PRESET: Partial<SubtitleStyle> = {
  backgroundColor: '#000000',
  backgroundOpacity: 0,
  shadowBlur: 0,
  shadowOffsetX: 0,
  shadowOffsetY: 0,
  fontWeight: 'bold',
  fontStyle: 'normal',
  textDecoration: 'none',
  borderOpacity: 1,
  colorOpacity: 1,
  wordHighlightMode: 'none',
  wordHighlightColor: '#FFE100',
};

/**
 * 样式预设列表。
 * 第一个（white-black / 白字黑边）即默认样式，与 defaultSubtitleStyle 保持一致。
 */
export const STYLE_PRESETS: Array<{
  id: StylePresetId;
  label: string;
  patch: Partial<SubtitleStyle>;
  preview: StylePresetPreview;
}> = [
  {
    id: 'white-black',
    label: '白字黑边',
    patch: { ...BASE_TEXT_PRESET, color: '#FFFFFF', borderColor: '#000000', borderWidth: 2 },
    preview: { textColor: '#FFFFFF', borderColor: '#000000' },
  },
  {
    id: 'word-highlight',
    label: '逐字高亮',
    patch: {
      ...BASE_TEXT_PRESET,
      color: '#FFFFFF',
      borderColor: '#000000',
      borderWidth: 2,
      wordHighlightMode: 'word',
      wordHighlightColor: '#FFE100',
    },
    preview: { textColor: '#FFFFFF', borderColor: '#000000' },
  },
  {
    id: 'none',
    label: '无样式',
    patch: {
      ...BASE_TEXT_PRESET,
      color: '#FFFFFF',
      borderColor: '#000000',
      borderWidth: 0,
      fontWeight: 'normal',
    },
    preview: { textColor: '#8d9095', showNone: true },
  },
  {
    id: 'white-outline',
    label: '白字描边',
    patch: { ...BASE_TEXT_PRESET, color: '#FFFFFF', borderColor: '#111111', borderWidth: 1 },
    preview: { textColor: '#FFFFFF', borderColor: '#111111' },
  },
  {
    id: 'yellow-black',
    label: '黄字黑边',
    patch: { ...BASE_TEXT_PRESET, color: '#FFE100', borderColor: '#000000', borderWidth: 2 },
    preview: { textColor: '#FFE100', borderColor: '#000000' },
  },
  {
    id: 'red-white',
    label: '红字白边',
    patch: { ...BASE_TEXT_PRESET, color: '#FF5B57', borderColor: '#FFFFFF', borderWidth: 2 },
    preview: { textColor: '#FF5B57', borderColor: '#FFFFFF' },
  },
  {
    id: 'blue-black',
    label: '蓝灰字黑边',
    patch: { ...BASE_TEXT_PRESET, color: '#B7C9D6', borderColor: '#000000', borderWidth: 2 },
    preview: { textColor: '#B7C9D6', borderColor: '#000000' },
  },
  {
    id: 'pink-white',
    label: '粉字白边',
    patch: { ...BASE_TEXT_PRESET, color: '#FF4F9A', borderColor: '#FFFFFF', borderWidth: 2 },
    preview: { textColor: '#FF4F9A', borderColor: '#FFFFFF' },
  },
  {
    id: 'cyan-white',
    label: '蓝字白边',
    patch: { ...BASE_TEXT_PRESET, color: '#2298FF', borderColor: '#FFFFFF', borderWidth: 2 },
    preview: { textColor: '#2298FF', borderColor: '#FFFFFF' },
  },
  {
    id: 'lime-black',
    label: '绿字黑边',
    patch: { ...BASE_TEXT_PRESET, color: '#91B727', borderColor: '#000000', borderWidth: 2 },
    preview: { textColor: '#91B727', borderColor: '#000000' },
  },
  {
    id: 'gray-blue',
    label: '灰字蓝边',
    patch: { ...BASE_TEXT_PRESET, color: '#7894A8', borderColor: '#23495E', borderWidth: 2 },
    preview: { textColor: '#7894A8', borderColor: '#23495E' },
  },
  {
    id: 'red-white-bold',
    label: '红字白边',
    patch: { ...BASE_TEXT_PRESET, color: '#FF1735', borderColor: '#FFFFFF', borderWidth: 2 },
    preview: { textColor: '#FF1735', borderColor: '#FFFFFF' },
  },
  {
    id: 'brown-white',
    label: '棕字白边',
    patch: { ...BASE_TEXT_PRESET, color: '#8A4B3F', borderColor: '#FFFFFF', borderWidth: 2 },
    preview: { textColor: '#8A4B3F', borderColor: '#FFFFFF' },
  },
  {
    id: 'cream-brown',
    label: '米字棕边',
    patch: { ...BASE_TEXT_PRESET, color: '#FFE7A6', borderColor: '#7B5333', borderWidth: 2 },
    preview: { textColor: '#FFE7A6', borderColor: '#7B5333' },
  },
  {
    id: 'rose-white',
    label: '玫红白边',
    patch: { ...BASE_TEXT_PRESET, color: '#E65E69', borderColor: '#FFFFFF', borderWidth: 2 },
    preview: { textColor: '#E65E69', borderColor: '#FFFFFF' },
  },
  // 带背景色的实心底框预设
  {
    id: 'black-bg',
    label: '白字黑底',
    patch: {
      ...BASE_TEXT_PRESET,
      color: '#FFFFFF',
      backgroundColor: '#000000',
      backgroundOpacity: 0.85,
      borderWidth: 0,
    },
    preview: { textColor: '#FFFFFF', backgroundColor: '#000000' },
  },
  {
    id: 'white-bg',
    label: '黑字白底',
    patch: {
      ...BASE_TEXT_PRESET,
      color: '#000000',
      backgroundColor: '#FFFFFF',
      backgroundOpacity: 0.95,
      borderWidth: 0,
    },
    preview: { textColor: '#000000', backgroundColor: '#FFFFFF' },
  },
  {
    id: 'yellow-bg',
    label: '黑字黄底',
    patch: {
      ...BASE_TEXT_PRESET,
      color: '#000000',
      backgroundColor: '#FFE100',
      backgroundOpacity: 0.95,
      borderWidth: 0,
    },
    preview: { textColor: '#000000', backgroundColor: '#FFE100' },
  },
  {
    id: 'red-bg',
    label: '红底白字',
    patch: {
      ...BASE_TEXT_PRESET,
      color: '#FFFFFF',
      backgroundColor: '#B8505C',
      backgroundOpacity: 0.9,
      borderWidth: 0,
    },
    preview: { textColor: '#FFFFFF', backgroundColor: '#B8505C' },
  },
  {
    id: 'green-bg',
    label: '绿字黑底',
    patch: {
      ...BASE_TEXT_PRESET,
      color: '#62F69C',
      backgroundColor: '#000000',
      backgroundOpacity: 0.85,
      borderWidth: 0,
    },
    preview: { textColor: '#62F69C', backgroundColor: '#000000' },
  },
  {
    id: 'blue-bg',
    label: '白字蓝底',
    patch: {
      ...BASE_TEXT_PRESET,
      color: '#FFFFFF',
      backgroundColor: '#4A92D9',
      backgroundOpacity: 0.9,
      borderWidth: 0,
    },
    preview: { textColor: '#FFFFFF', backgroundColor: '#4A92D9' },
  },
  {
    id: 'pink-bg',
    label: '白字粉底',
    patch: {
      ...BASE_TEXT_PRESET,
      color: '#FFFFFF',
      backgroundColor: '#F0538C',
      backgroundOpacity: 0.9,
      borderWidth: 0,
    },
    preview: { textColor: '#FFFFFF', backgroundColor: '#F0538C' },
  },
  {
    id: 'peach-plain',
    label: '米字粉边',
    patch: { ...BASE_TEXT_PRESET, color: '#FFEAC0', borderColor: '#D56F78', borderWidth: 2 },
    preview: { textColor: '#FFEAC0', borderColor: '#D56F78' },
  },
  {
    id: 'orange-red',
    label: '橙字红边',
    patch: { ...BASE_TEXT_PRESET, color: '#FF9D20', borderColor: '#FF2734', borderWidth: 2 },
    preview: { textColor: '#FF9D20', borderColor: '#FF2734' },
  },
  {
    id: 'green-black',
    label: '绿字黑边',
    patch: { ...BASE_TEXT_PRESET, color: '#16F06A', borderColor: '#000000', borderWidth: 2 },
    preview: { textColor: '#16F06A', borderColor: '#000000' },
  },
];

/** 默认使用的预设（列表第一个） */
export const DEFAULT_STYLE_PRESET_ID: StylePresetId = STYLE_PRESETS[0].id;

const PRESET_MATCH_KEYS: Array<keyof SubtitleStyle> = [
  'color',
  'colorOpacity',
  'backgroundColor',
  'borderColor',
  'borderOpacity',
  'borderWidth',
  'backgroundOpacity',
  'shadowBlur',
  'shadowOffsetX',
  'shadowOffsetY',
  'fontWeight',
  'fontStyle',
  'textDecoration',
  'wordHighlightMode',
  'wordHighlightColor',
];

function styleMatchesPreset(style: SubtitleStyle, presetId: StylePresetId): boolean {
  const preset = STYLE_PRESETS.find((p) => p.id === presetId);
  if (!preset) return false;
  return PRESET_MATCH_KEYS.every((key) => {
    const expected = preset.patch[key];
    if (expected === undefined) return true;
    if (key === 'wordHighlightColor' && style.wordHighlightMode !== 'word') return true;
    return style[key] === expected;
  });
}

export function matchActiveStylePreset(style: SubtitleStyle): StylePresetId | null {
  const match = STYLE_PRESETS.find((preset) => styleMatchesPreset(style, preset.id));
  return match?.id ?? null;
}

export function getAspectPresetConfig(preset: AspectPreset): AspectPresetConfig {
  return ASPECT_PRESETS.find((p) => p.id === preset) ?? ASPECT_PRESETS[0];
}

export function getMaxWidthRatio(preset: AspectPreset): number {
  return getAspectPresetConfig(preset).maxWidthRatio;
}

export function applyAspectPreset(
  style: SubtitleStyle,
  preset: AspectPreset,
): SubtitleStyle {
  const config = getAspectPresetConfig(preset);
  return {
    ...style,
    aspectPreset: preset,
    bottomOffsetRatio: config.bottomOffsetRatio,
  };
}

export function applyStylePreset(
  style: SubtitleStyle,
  presetId: StylePresetId,
): SubtitleStyle {
  const preset = STYLE_PRESETS.find((p) => p.id === presetId);
  if (!preset) return style;
  return { ...style, ...preset.patch };
}

export function inferAspectPreset(videoWidth: number, videoHeight: number): AspectPreset {
  if (!videoWidth || !videoHeight) return 'landscape';
  const ratio = videoWidth / videoHeight;
  if (ratio < 0.85) return 'portrait_9_16';
  if (ratio > 1.15) return 'landscape';
  return 'square_1_1';
}

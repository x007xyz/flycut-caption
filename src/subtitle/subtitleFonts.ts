// 加载前后端共用的完整字幕字体文件；不再用 @fontsource 的分片 woff2 画最终字幕。

import { SUBTITLE_FONT_ASSETS, getSubtitleFontAsset } from '../../shared/subtitle-graphics/fonts';
import type { SubtitleStyle } from './subtitleStyle';

export type SubtitleFontStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface SubtitleFontState {
  status: SubtitleFontStatus;
  error?: string;
}

let state: SubtitleFontState = { status: 'idle' };
let loadPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function setState(next: SubtitleFontState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function getSubtitleFontState(): SubtitleFontState {
  return state;
}

export function subscribeSubtitleFontState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function ensureSubtitleFonts(force = false): Promise<void> {
  if (typeof document === 'undefined') return;
  if (!force && state.status === 'ready') return;
  if (!force && loadPromise) return loadPromise;
  setState({ status: 'loading' });
  loadPromise = (async () => {
    const loaded: FontFace[] = [];
    for (const asset of Object.values(SUBTITLE_FONT_ASSETS)) {
      if (!asset.bundled) continue;
      loaded.push(...await Promise.all([['400', asset.regular], ['700', asset.bold]]
        .filter((entry): entry is [string, string] => Boolean(entry[1]))
        .map(async ([weight, file]) => {
          const face = new FontFace(asset.family, `url(/fonts/subtitle/${file})`, { weight, style: 'normal' });
          await face.load();
          return face;
        })));
    }
    for (const face of loaded) document.fonts.add(face);
    await document.fonts.ready;
    setState({ status: 'ready' });
  })().catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    setState({ status: 'error', error: reason });
    throw new Error(reason);
  }).finally(() => {
    loadPromise = null;
  });
  return loadPromise;
}

export async function retrySubtitleFonts(): Promise<void> {
  await ensureSubtitleFonts(true);
}

/** 兼容旧渲染器：系统字体直接可用；内置字体等待完整文件加载。 */
export async function ensureSubtitleFont(style: SubtitleStyle, _fontSizePx: number): Promise<void> {
  void _fontSizePx;
  if (!getSubtitleFontAsset(style.fontId).bundled) return;
  await ensureSubtitleFonts();
}

export function registerSubtitleFonts(): void {
  void ensureSubtitleFonts().catch(() => undefined);
}

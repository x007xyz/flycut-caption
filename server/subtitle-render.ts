import { access } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { SKRSContext2D } from '@napi-rs/canvas';
import {
  drawFrame,
  frameKey,
  layoutScene,
  subtitleBand,
  getSubtitleFontAsset,
  type SubtitleGraphicScene,
} from '../shared/subtitle-graphics';

export interface SubtitleBandRenderer {
  readonly band: { x: number; y: number; width: number; height: number };
  render(t: number): { key: string; buffer: Buffer; drawn: boolean };
}

let canvasModule: Promise<typeof import('@napi-rs/canvas')> | null = null;

async function loadCanvasModule(): Promise<typeof import('@napi-rs/canvas')> {
  canvasModule ??= import('@napi-rs/canvas').catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`字幕渲染不可用：无法加载 Skia 原生模块（${reason}）`);
  });
  return canvasModule;
}

export async function findFontDir(resourceRoot: string): Promise<string | undefined> {
  const candidates = [
    join(resourceRoot, 'shared_assets', 'subtitle-fonts'),
    // macOS bundles place models.json under Resources/_up_ and fonts under Resources.
    ...(basename(resourceRoot) === '_up_' ? [join(resourceRoot, '..', 'shared_assets', 'subtitle-fonts')] : []),
    join(resourceRoot, 'src-tauri', 'shared_assets', 'subtitle-fonts'),
  ];
  for (const dir of candidates) {
    const exists = await access(join(dir, 'NotoSansSC-Regular.otf')).then(() => true).catch(() => false);
    if (exists) return dir;
  }
  return undefined;
}

/** 为场景需要的字体注册同一份完整文件；系统字体只检查是否可用，不静默替代。 */
async function registerSceneFonts(
  scene: SubtitleGraphicScene,
  resourceRoot: string,
  GlobalFonts: typeof import('@napi-rs/canvas').GlobalFonts,
): Promise<void> {
  const needed = new Set<string>();
  for (const style of [scene.primary, scene.secondary]) {
    if (style) needed.add(style.fontId);
  }
  const bundled = [...needed].filter((id) => getSubtitleFontAsset(id).bundled);
  if (bundled.length > 0) {
    const fontDir = await findFontDir(resourceRoot);
    if (!fontDir) throw new Error('字幕渲染不可用：Host 找不到随包完整字体目录');
    for (const id of bundled) {
      const asset = getSubtitleFontAsset(id);
      if (GlobalFonts.has(asset.family)) continue;
      for (const file of [asset.regular, asset.bold]) {
        if (!file) continue;
        const key = GlobalFonts.registerFromPath(join(fontDir, file), asset.family);
        if (!key) throw new Error(`字幕渲染不可用：无法注册字体 ${file}`);
      }
      if (!GlobalFonts.has(asset.family)) throw new Error(`字幕渲染不可用：字体 ${asset.family} 注册后不可用`);
    }
  }
  for (const id of needed) {
    const asset = getSubtitleFontAsset(id);
    if (!asset.bundled && !GlobalFonts.has(asset.family)) {
      throw new Error(`字幕渲染不可用：Host 缺少系统字体「${asset.family}」`);
    }
  }
}

export async function createSubtitleBandRenderer(
  scene: SubtitleGraphicScene,
  resourceRoot: string,
): Promise<SubtitleBandRenderer> {
  const { createCanvas, GlobalFonts } = await loadCanvasModule();
  await registerSceneFonts(scene, resourceRoot, GlobalFonts);
  // Pretext uses OffscreenCanvas for font measurement; Skia is the Host's canvas implementation.
  const globals = globalThis as unknown as { OffscreenCanvas?: new (width: number, height: number) => { getContext(type: '2d'): unknown } };
  if (!globals.OffscreenCanvas) {
    globals.OffscreenCanvas = class {
      private readonly canvas: { getContext(type: '2d'): unknown };
      constructor(width: number, height: number) { this.canvas = createCanvas(width, height); }
      getContext(type: '2d') { return this.canvas.getContext(type); }
    };
  }
  const measureCanvas = createCanvas(8, 8);
  const measureContext = measureCanvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  const layouts = layoutScene(measureContext, scene);
  const band = subtitleBand(scene, layouts);
  const canvas = createCanvas(band.width, band.height);
  const context = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  let lastKey = '';
  let lastBuffer: Buffer | undefined;
  return {
    band,
    render(t: number) {
      const key = frameKey(scene, t);
      if (lastBuffer && key === lastKey) return { key, buffer: lastBuffer, drawn: false };
      drawFrame(context, scene, t, { layer: band, layouts });
      const image = (context as unknown as SKRSContext2D).getImageData(0, 0, band.width, band.height);
      lastBuffer = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
      lastKey = key;
      return { key, buffer: lastBuffer, drawn: true };
    },
  };
}

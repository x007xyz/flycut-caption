import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import {
  emptySubtitleGraphicStyle,
  drawFrame,
  frameKey,
  layoutScene,
  subtitleBand,
  subtitleGraphicSceneSchema,
  type SubtitleGraphicScene,
} from '../../shared/subtitle-graphics/index.ts';

// Pretext measures with OffscreenCanvas; in Node the measurement canvas is Skia.
(globalThis as unknown as { OffscreenCanvas?: unknown }).OffscreenCanvas = class {
  private readonly canvas: ReturnType<typeof createCanvas>;
  constructor(width: number, height: number) { this.canvas = createCanvas(width, height); }
  getContext(type: '2d') { return this.canvas.getContext(type); }
};

const FONT_DIR = new URL('../../src-tauri/shared_assets/subtitle-fonts/', import.meta.url).pathname;
const FAMILY = 'FlyCutNotoSansSC';
if (!GlobalFonts.has(FAMILY)) {
  assert.ok(GlobalFonts.registerFromPath(`${FONT_DIR}NotoSansSC-Regular.otf`, FAMILY), 'regular font registered');
  assert.ok(GlobalFonts.registerFromPath(`${FONT_DIR}NotoSansSC-Bold.otf`, FAMILY), 'bold font registered');
}

function scene(overrides: Partial<SubtitleGraphicScene> = {}): SubtitleGraphicScene {
  const primary = { ...emptySubtitleGraphicStyle(), fontFamily: FAMILY, fontSizeRatio: 0.05 };
  const secondary = { ...primary, fontSizeRatio: 0.034 };
  return {
    version: 1, width: 1920, height: 1080, fps: 30, duration: 10,
    fontId: 'noto-sans-sc', fontFamily: FAMILY, displayMode: 'Bilingual', maxWidthRatio: 0.9,
    primary, secondary,
    cues: [
      { id: 'a', start: 0, end: 2, text: '今天我们来聊一聊 React 19 的新特性，看看换行和描边是否一致，以及更多内容需要换行', secondText: 'Today we talk about React 19' },
      { id: 'b', start: 2.5, end: 4, text: '第二句没有副字幕' },
    ],
    ...overrides,
  };
}

function alphaBox(data: Uint8ClampedArray, width: number, height: number) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

test('F-0028/AC-1 shared scene schema validates version, cue order and positive duration', () => {
  assert.ok(subtitleGraphicSceneSchema.parse(scene()));
  assert.throws(() => subtitleGraphicSceneSchema.parse({ ...scene(), version: 2 }));
  assert.throws(() => subtitleGraphicSceneSchema.parse({ ...scene(), cues: [{ id: 'x', start: 2, end: 2, text: 'x' }] }));
});

test('F-0028/AC-1 layout preserves current CJK wrapping, punctuation stripping and bilingual blocks', () => {
  const s = scene();
  const ctx = createCanvas(8, 8).getContext('2d') as unknown as CanvasRenderingContext2D;
  const layouts = layoutScene(ctx, s);
  const first = layouts[0];
  assert.ok(first.primary);
  assert.ok(first.secondary);
  assert.ok(first.primary.lines.length > 1, 'long primary text wraps at 1080p');
  assert.ok(first.primary.lines.every((line) => !/[，。！？；：]/.test(line.text)), 'display punctuation removed');
  assert.ok(first.primary.lines.every((line) => line.width <= 1920 * s.maxWidthRatio + 1), 'line stays inside max width');
  assert.equal(first.secondary.lines.map((line) => line.text).join(''), 'Today we talk about React 19');
  assert.ok(first.primaryBottom! < first.secondaryBottom!, 'primary is above secondary (smaller y)');
});

test('F-0028/AC-1 band crop keeps the same bbox as a full-frame render (offset <= 2px)', () => {
  const s = scene({ cues: [{ id: 'a', start: 0, end: 2, text: '今天我们来聊一聊 React 19 的新特性，看看换行和描边是否一致', secondText: 'Today we talk about React 19' }] });
  const ctx = createCanvas(8, 8).getContext('2d') as unknown as CanvasRenderingContext2D;
  const layouts = layoutScene(ctx, s);
  const band = subtitleBand(s, layouts);
  assert.equal(band.width % 2, 0);
  assert.equal(band.height % 2, 0);

  const full = createCanvas(s.width, s.height);
  const fullCtx = full.getContext('2d');
  assert.equal(drawFrame(fullCtx as unknown as CanvasRenderingContext2D, s, 0.5), true);
  const fullBox = alphaBox(fullCtx.getImageData(0, 0, s.width, s.height).data, s.width, s.height);
  assert.ok(fullBox);

  const cropped = createCanvas(band.width, band.height);
  const croppedCtx = cropped.getContext('2d');
  assert.equal(drawFrame(croppedCtx as unknown as CanvasRenderingContext2D, s, 0.5, { layer: band, layouts }), true);
  const croppedBox = alphaBox(croppedCtx.getImageData(0, 0, band.width, band.height).data, band.width, band.height);
  assert.ok(croppedBox);
  assert.ok(Math.abs(fullBox.minX - croppedBox.minX) <= 2);
  assert.ok(Math.abs((fullBox.minY - band.y) - croppedBox.minY) <= 2);
  assert.ok(Math.abs((fullBox.maxY - band.y) - croppedBox.maxY) <= 2);

  const empty = scene({ cues: [{ id: 'empty', start: 0, end: 1, text: '' }] });
  assert.deepEqual(subtitleBand(empty, layoutScene(ctx, empty)), { x: 0, y: 0, width: 1920, height: 2 });
});

test('F-0028/AC-1 three aspect presets, styles and display modes produce visible pixels', () => {
  for (const [width, height, ratio] of [[1920, 1080, 0.9], [1080, 1920, 0.85], [1080, 1080, 0.88]] as const) {
    for (const mode of ['Bilingual', 'Main', 'Second'] as const) {
      const primary = { ...emptySubtitleGraphicStyle(), fontFamily: FAMILY, backgroundOpacity: 0.7, backgroundRadius: 10, backgroundPadding: 12, shadowBlur: 4, shadowOffsetX: 2, shadowOffsetY: 2, borderWidth: 3, letterSpacing: 1, textAlign: 'left' as const, textDecoration: 'underline' as const };
      const s = scene({ width, height, maxWidthRatio: ratio, displayMode: mode, primary, secondary: { ...primary, fontStyle: 'italic' as const, textAlign: 'right' as const } });
      const ctx = createCanvas(8, 8).getContext('2d') as unknown as CanvasRenderingContext2D;
      const layouts = layoutScene(ctx, s);
      const band = subtitleBand(s, layouts);
      const canvas = createCanvas(band.width, band.height);
      const c = canvas.getContext('2d');
      assert.equal(drawFrame(c as unknown as CanvasRenderingContext2D, s, 0.5, { layer: band, layouts }), true, `${width}x${height} ${mode}`);
      const box = alphaBox(c.getImageData(0, 0, band.width, band.height).data, band.width, band.height);
      assert.ok(box, `${width}x${height} ${mode} has pixels`);
    }
  }
});

test('F-0028/AC-2 frameKey is stable inside one cue and changes on text or cue boundaries', () => {
  const s = scene();
  assert.equal(frameKey(s, 0.1), frameKey(s, 1.9));
  assert.notEqual(frameKey(s, 0.1), frameKey(s, 2.6));
  const changed = scene({ cues: [{ ...s.cues[0], text: '改过的文字' }, s.cues[1]] });
  assert.notEqual(frameKey(s, 0.1), frameKey(changed, 0.1));
  assert.match(frameKey(s, 0.1), /^1\|Bilingual\|1920x1080\|noto-sans-sc\|/);
});


import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import {
  drawFrame,
  emptySubtitleGraphicStyle,
  findActiveWordRange,
  frameKey,
  layoutScene,
  mapCueWordRanges,
  subtitleBand,
  subtitleGraphicSceneSchema,
  type SubtitleGraphicScene,
  type SubtitleGraphicStyle,
} from '../../shared/subtitle-graphics/index.ts';
import { buildPreviewSubtitleScene, hasReliableWordHighlight } from '../../src/subtitle/graphicsScene.ts';
import { defaultSubtitleStylePair } from '../../src/subtitle/subtitleStyle.ts';
import type { SubtitleChunk } from '../../src/types/subtitle.ts';

(globalThis as unknown as { OffscreenCanvas?: unknown }).OffscreenCanvas = class {
  private readonly canvas: ReturnType<typeof createCanvas>;
  constructor(width: number, height: number) { this.canvas = createCanvas(width, height); }
  getContext(type: '2d') { return this.canvas.getContext(type); }
};

const FONT_DIR = new URL('../../src-tauri/shared_assets/subtitle-fonts/', import.meta.url).pathname;
const FAMILY = 'FlyCutWordHighlightNotoSansSC';
if (!GlobalFonts.has(FAMILY)) {
  assert.ok(GlobalFonts.registerFromPath(`${FONT_DIR}NotoSansSC-Regular.otf`, FAMILY));
  assert.ok(GlobalFonts.registerFromPath(`${FONT_DIR}NotoSansSC-Bold.otf`, FAMILY));
}

function graphicStyle(overrides: Partial<SubtitleGraphicStyle> = {}): SubtitleGraphicStyle {
  return {
    ...emptySubtitleGraphicStyle(),
    fontFamily: FAMILY,
    fontSizeRatio: 0.09,
    borderWidth: 0,
    color: '#FFFFFF',
    wordHighlightMode: 'word',
    wordHighlightColor: '#FF0000',
    ...overrides,
  };
}

function scene(overrides: Partial<SubtitleGraphicScene> = {}): SubtitleGraphicScene {
  return {
    version: 1,
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 4,
    fontId: 'noto-sans-sc',
    fontFamily: FAMILY,
    displayMode: 'Bilingual',
    maxWidthRatio: 0.9,
    primary: graphicStyle(),
    secondary: graphicStyle({ fontSizeRatio: 0.055, wordHighlightMode: 'none' }),
    cues: [{
      id: 's1',
      start: 0,
      end: 2,
      text: '大家好世界',
      secondText: 'Hello world',
      words: [
        { text: '大', start: 0.1, end: 0.3 },
        { text: '家', start: 0.35, end: 0.55 },
        { text: '好', start: 0.6, end: 0.8 },
        { text: '世界', start: 0.9, end: 1.4 },
      ],
    }],
    ...overrides,
  };
}

function redPixels(canvas: ReturnType<typeof createCanvas>) {
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 180 && data[i + 1] < 100 && data[i + 2] < 100 && data[i + 3] > 80) count += 1;
  }
  return count;
}

function coloredBox(canvas: ReturnType<typeof createCanvas>) {
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let minX = canvas.width; let minY = canvas.height; let maxX = -1; let maxY = -1;
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const i = (y * canvas.width + x) * 4;
      if (data[i] > 180 && data[i + 1] < 100 && data[i + 2] < 100 && data[i + 3] > 80) {
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

test('F-0024/AC-1 AC-2 scene rejects invalid word timing and maps only exact word text', () => {
  const valid = scene();
  assert.ok(subtitleGraphicSceneSchema.parse(valid));
  assert.throws(() => subtitleGraphicSceneSchema.parse(scene({
    cues: [{ ...valid.cues[0], words: [{ text: '大', start: 2.1, end: 2.2 }] }],
  })), /outside its cue/);
  assert.throws(() => subtitleGraphicSceneSchema.parse(scene({
    cues: [{ ...valid.cues[0], words: [{ text: '大', start: 0.5, end: 0.4 }] }],
  })), /positive duration/);
  assert.throws(() => subtitleGraphicSceneSchema.parse(scene({
    cues: [{ ...valid.cues[0], words: [
      { text: '大', start: 0.5, end: 0.8 },
      { text: '家', start: 0.6, end: 0.9 },
    ] }],
  })), /time order without overlap/);

  const ranges = mapCueWordRanges(valid.cues[0]);
  assert.deepEqual(ranges?.map(range => [range.text, range.charStart, range.charEnd]), [
    ['大', 0, 1], ['家', 1, 2], ['好', 2, 3], ['世界', 3, 5],
  ]);
  assert.equal(mapCueWordRanges({ ...valid.cues[0], text: '大家坏世界' }), undefined, 'mismatched text must fail closed');
  assert.equal(mapCueWordRanges({ ...valid.cues[0], words: undefined }), undefined, 'missing words must fall back');
  assert.equal(findActiveWordRange(ranges, 0.2)?.text, '大');
  assert.equal(findActiveWordRange(ranges, 0.32), undefined, 'gaps do not invent a current word');
  assert.equal(findActiveWordRange(ranges, 0.95)?.text, '世界');
});

test('F-0024/AC-1 AC-2 preview scene carries only verified words and reports sentence fallback', () => {
  const chunks: SubtitleChunk[] = [{
    id: 's1', text: '大家好世界', timestamp: [0, 2], wordIds: ['w1', 'w2', 'w3', 'w4'],
  }];
  const words: SubtitleChunk[] = [
    { id: 'w1', text: '大', timestamp: [0.1, 0.3], sentenceId: 's1' },
    { id: 'w2', text: '家', timestamp: [0.35, 0.55], sentenceId: 's1' },
    { id: 'w3', text: '好', timestamp: [0.6, 0.8], sentenceId: 's1' },
    { id: 'w4', text: '世界', timestamp: [0.9, 1.4], sentenceId: 's1' },
  ];
  const input = { chunks, wordChunks: words, hasWordTimestamps: true, stylePair: defaultSubtitleStylePair,
    videoWidth: 1920, videoHeight: 1080, duration: 4 };
  assert.equal(buildPreviewSubtitleScene(input).cues[0].words?.length, 4);
  assert.equal(hasReliableWordHighlight(chunks, words, true), true);
  assert.equal(hasReliableWordHighlight(chunks, undefined, false), false);
  const bad = words.map((word, index) => index === 2 ? { ...word, text: '坏' } : word);
  assert.equal(buildPreviewSubtitleScene({ ...input, wordChunks: bad }).cues[0].words, undefined);
  assert.equal(hasReliableWordHighlight(chunks, bad, true), false);
});

test('F-0024/AC-1 current word changes color and word gaps restore the normal color', () => {
  const s = scene();
  const current = createCanvas(s.width, s.height);
  assert.equal(drawFrame(current.getContext('2d') as unknown as CanvasRenderingContext2D, s, 0.2), true);
  assert.ok(redPixels(current) > 100, 'current word uses the highlight color');

  const gap = createCanvas(s.width, s.height);
  drawFrame(gap.getContext('2d') as unknown as CanvasRenderingContext2D, s, 0.32);
  assert.equal(redPixels(gap), 0, 'word gaps keep the normal fill');

  const next = createCanvas(s.width, s.height);
  drawFrame(next.getContext('2d') as unknown as CanvasRenderingContext2D, s, 1);
  assert.ok(redPixels(next) > redPixels(current), 'the two-character word highlights both glyphs');

  const noWords = scene({ cues: [{ ...s.cues[0], words: undefined }] });
  const sentence = createCanvas(s.width, s.height);
  drawFrame(sentence.getContext('2d') as unknown as CanvasRenderingContext2D, noWords, 1.8);
  assert.ok(redPixels(sentence) > redPixels(next) * 1.5, 'missing timing falls back to the whole sentence');
});

test('F-0024/AC-1 frameKey changes at word boundaries and stays stable within a word or fallback', () => {
  const s = scene();
  assert.equal(frameKey(s, 0.15), frameKey(s, 0.25));
  assert.notEqual(frameKey(s, 0.25), frameKey(s, 0.32));
  assert.notEqual(frameKey(s, 0.32), frameKey(s, 0.4));
  const fallback = scene({ cues: [{ ...s.cues[0], words: undefined }] });
  assert.equal(frameKey(fallback, 0.2), frameKey(fallback, 1.2));
  assert.notEqual(frameKey(s, 0.2), frameKey(fallback, 0.2));
});

test('F-0024/AC-3 all aspects and display modes highlight through the same scene, with band bbox <= 2px', () => {
  for (const [width, height, maxWidthRatio] of [[1920, 1080, 0.9], [1080, 1920, 0.85], [1080, 1080, 0.88]] as const) {
    for (const displayMode of ['Bilingual', 'Main', 'Second'] as const) {
      const primary = graphicStyle({ wordHighlightMode: 'word' });
      const secondary = graphicStyle({ wordHighlightMode: 'word', fontSizeRatio: 0.055 });
      const s = scene({ width, height, maxWidthRatio, displayMode, primary, secondary });
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
      assert.equal(drawFrame(ctx, s, 0.2), true, `${width}x${height} ${displayMode}`);
      assert.ok(redPixels(canvas) > 20, `${width}x${height} ${displayMode} has highlighted text`);
    }
  }

  const s = scene();
  const layoutCtx = createCanvas(8, 8).getContext('2d') as unknown as CanvasRenderingContext2D;
  const layouts = layoutScene(layoutCtx, s);
  const band = subtitleBand(s, layouts);
  const full = createCanvas(s.width, s.height);
  const bandCanvas = createCanvas(band.width, band.height);
  drawFrame(full.getContext('2d') as unknown as CanvasRenderingContext2D, s, 0.2);
  drawFrame(bandCanvas.getContext('2d') as unknown as CanvasRenderingContext2D, s, 0.2, { layer: band, layouts });
  const fullBox = coloredBox(full);
  const bandBox = coloredBox(bandCanvas);
  assert.ok(fullBox && bandBox);
  assert.ok(Math.abs(fullBox.minX - bandBox.minX) <= 2);
  assert.ok(Math.abs((fullBox.minY - band.y) - bandBox.minY) <= 2);
  assert.ok(Math.abs((fullBox.maxY - band.y) - bandBox.maxY) <= 2);
});

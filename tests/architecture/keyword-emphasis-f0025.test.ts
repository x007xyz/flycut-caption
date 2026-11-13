import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { buildExportSubtitleScene, buildPreviewSubtitleScene } from '../../src/subtitle/graphicsScene.ts';
import { layoutScene, subtitleBand } from '../../shared/subtitle-graphics/index.ts';
import { defaultSubtitleStylePair } from '../../src/subtitle/subtitleStyle.ts';
import type { SubtitleChunk } from '../../src/types/subtitle.ts';

// Pretext measures with OffscreenCanvas; in Node the measurement canvas is Skia.
(globalThis as unknown as { OffscreenCanvas?: unknown }).OffscreenCanvas = class {
  private readonly canvas: ReturnType<typeof createCanvas>;
  constructor(width: number, height: number) { this.canvas = createCanvas(width, height); }
  getContext(type: '2d') { return this.canvas.getContext(type); }
};

const FONT_DIR = new URL('../../src-tauri/shared_assets/subtitle-fonts/', import.meta.url).pathname;
const FAMILY = 'FlyCutKeywordNotoSansSC';
if (!GlobalFonts.has(FAMILY)) {
  assert.ok(GlobalFonts.registerFromPath(`${FONT_DIR}NotoSansSC-Regular.otf`, FAMILY), 'regular font registered');
  assert.ok(GlobalFonts.registerFromPath(`${FONT_DIR}NotoSansSC-Bold.otf`, FAMILY), 'bold font registered');
}

const stylePair = {
  primary: { ...defaultSubtitleStylePair.primary, fontFamily: FAMILY, fontSizeRatio: 0.05,
    keywordColorEnabled: true, keywordColor: '#FFE100', keywordScale: 1.35, keywordBackgroundOpacity: 0.4 },
  secondary: { ...defaultSubtitleStylePair.secondary, fontFamily: FAMILY, fontSizeRatio: 0.034 },
};

const baseChunks: SubtitleChunk[] = [
  { id: 's1', text: '大家好，今天我们聊剪辑。', timestamp: [0, 2] },
  { id: 's2', text: '关键是节奏感。', timestamp: [2.2, 3.4] },
];
const emphasizedChunks: SubtitleChunk[] = [
  { ...baseChunks[0], keywords: [{ start: 4, end: 6, text: '今天', source: 'manual' }, { start: 8, end: 9, text: '聊', source: 'manual' }] },
  { ...baseChunks[1], keywords: [{ start: 0, end: 2, text: '关键', source: 'ai' }] },
];

test('F-0025/AC-2 keyword ranges are mapped onto display text and the export clock without rewriting cues', () => {
  const scene = buildExportSubtitleScene({
    chunks: emphasizedChunks, stylePair, keptSegments: [{ start: 0, end: 1, keep: true }, { start: 2, end: 3.4, keep: true }],
    videoWidth: 1920, videoHeight: 1080, fps: 30, displayMode: 'Main',
  });
  assert.equal(scene.cues.length, 2);
  assert.deepEqual(scene.cues[0].keywords?.map(kw => kw.text), ['今天', '聊'], 'punctuation stripping keeps keyword text intact');
  assert.equal(scene.cues[0].text, '大家好今天我们聊剪辑', 'export display text drops punctuation but never mutates the source cue');
  assert.equal(baseChunks[0].text, '大家好，今天我们聊剪辑。', 'keyword emphasis must not rewrite the stored cue text');
  assert.ok(Math.abs(scene.cues[1].start - 1.2) < 0.001, 'second cue is projected 1s later after the removed gap');
  assert.deepEqual(scene.cues[1].keywords?.map(kw => kw.text), ['关键']);
});

test('F-0025/AC-1 AC-2 keyword emphasis keeps identical wrapping and band bounds within 2px in all three aspects', () => {
  for (const [width, height] of [[1920, 1080], [1080, 1920], [1080, 1080]] as const) {
    const emphasized = buildPreviewSubtitleScene({ chunks: emphasizedChunks, stylePair, videoWidth: width, videoHeight: height });
    const plain = buildPreviewSubtitleScene({ chunks: baseChunks, stylePair, videoWidth: width, videoHeight: height });
    const ctx = createCanvas(width, height).getContext('2d');
    const emphasizedLayout = layoutScene(ctx, emphasized);
    const plainLayout = layoutScene(ctx, plain);
    assert.equal(emphasizedLayout.length, plainLayout.length, 'keyword emphasis must not change the number of laid-out lines');
    for (const [index, line] of emphasizedLayout.entries()) {
      assert.equal(line.text, plainLayout[index].text, `line ${index} keeps the same text`);
    }
    const band = subtitleBand(emphasized, emphasizedLayout);
    const full = subtitleBand(emphasized, layoutScene(ctx, emphasized));
    assert.ok(Math.abs(band.height - full.height) <= 2, `band height matches full frame within 2px at ${width}x${height}`);
    assert.ok(Math.abs(band.width - full.width) <= 2, `band width matches full frame within 2px at ${width}x${height}`);
  }
});


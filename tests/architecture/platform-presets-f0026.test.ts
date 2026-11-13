import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import {
  PLATFORM_PRESETS,
  clampSafeZoneInsets,
  getFontLanguageCoverage,
  hasUncoveredCjkSubtitles,
  isBottomInSafeZoneOcclusion,
  resolveSafeZoneInsets,
} from '../../shared/subtitle-graphics/platformPresets.ts';
import { buildProjectExportSubtitleScene, drawFrame, layoutScene } from '../../shared/subtitle-graphics/index.ts';
import {
  alignSubtitleAboveSafeZone,
  applyPlatformPreset,
  matchActivePlatformPreset,
  resetSafeZoneInsets,
  resolveEffectiveSafeZone,
  toggleSafeZoneGuide,
  updateSafeZoneInsets,
} from '../../src/subtitle/platformPresets.ts';
import { buildExportSubtitleScene, buildPreviewSubtitleScene, hasReliableWordHighlight } from '../../src/subtitle/graphicsScene.ts';
import { defaultSubtitleStyle, defaultSubtitleStylePair } from '../../src/subtitle/subtitleStyle.ts';
import type { SubtitleChunk } from '../../src/types/subtitle.ts';

(globalThis as unknown as { OffscreenCanvas?: unknown }).OffscreenCanvas = class {
  private readonly canvas: ReturnType<typeof createCanvas>;
  constructor(width: number, height: number) { this.canvas = createCanvas(width, height); }
  getContext(type: '2d') { return this.canvas.getContext(type); }
};

const FONT_DIR = new URL('../../src-tauri/shared_assets/subtitle-fonts/', import.meta.url).pathname;
const FAMILY = 'FlyCutPlatformPresetsNotoSansSC';
if (!GlobalFonts.has(FAMILY)) {
  assert.ok(GlobalFonts.registerFromPath(`${FONT_DIR}NotoSansSC-Regular.otf`, FAMILY));
  assert.ok(GlobalFonts.registerFromPath(`${FONT_DIR}NotoSansSC-Bold.otf`, FAMILY));
}

test('F-0026/AC-1 AC-4 catalog defines all five platforms with unverified reference metadata', () => {
  const ids = PLATFORM_PRESETS.map(p => p.id);
  assert.deepEqual(ids, ['douyin', 'wechat-channels', 'xiaohongshu', 'bilibili', 'youtube-shorts']);
  for (const preset of PLATFORM_PRESETS) {
    assert.equal(preset.verification.verified, false, `${preset.id} remains unverified without live app capture`);
    assert.match(preset.verification.referenceDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(preset.verification.noteZh, /参考，未验证/);
    assert.match(preset.verification.noteEn, /Reference, unverified/);
    assert.ok(preset.stylePatch.bottomOffsetRatio >= preset.safeZone.bottom, `${preset.id} default bottom clears safe zone`);
  }
});

test('F-0026/AC-1 AC-2 applying platform preset and tuning safe zones leaves defaults clean and clamps margins', () => {
  assert.equal('platformPresetId' in defaultSubtitleStyle, false, 'defaultSubtitleStyle keeps canonical keys for recovery');
  const douyin = applyPlatformPreset(defaultSubtitleStyle, 'douyin');
  assert.equal(matchActivePlatformPreset(douyin), 'douyin');
  assert.equal(douyin.aspectPreset, 'portrait_9_16');
  assert.equal(douyin.safeZoneVisible, true);
  assert.equal(douyin.wordHighlightMode, 'word');
  assert.equal(douyin.keywordColorEnabled, true);

  const hidden = toggleSafeZoneGuide(douyin, false);
  assert.equal(hidden.safeZoneVisible, false);
  assert.equal(resolveEffectiveSafeZone(hidden).visible, false);

  const adjusted = updateSafeZoneInsets(hidden, { bottom: 0.35, top: 0.9 });
  assert.deepEqual(adjusted.safeZoneInsets, clampSafeZoneInsets({ top: 0.9, bottom: 0.35, left: 0.06, right: 0.16 }));
  assert.equal(isBottomInSafeZoneOcclusion(adjusted.bottomOffsetRatio, adjusted.safeZoneInsets!), true);

  const aligned = alignSubtitleAboveSafeZone(adjusted);
  assert.equal(isBottomInSafeZoneOcclusion(aligned.bottomOffsetRatio, aligned.safeZoneInsets!), false);

  const reset = resetSafeZoneInsets(aligned, 'douyin');
  assert.deepEqual(reset.safeZoneInsets, resolveSafeZoneInsets('douyin'));
});

test('F-0026/AC-1 font coverage warns on CJK text with English-only font without making false promises', () => {
  assert.deepEqual(getFontLanguageCoverage('noto-sans-sc'), ['zh', 'en']);
  assert.deepEqual(getFontLanguageCoverage('inter'), ['en']);
  assert.equal(hasUncoveredCjkSubtitles('noto-sans-sc', ['大家好', 'Hello']), false);
  assert.equal(hasUncoveredCjkSubtitles('inter', ['大家好', 'Hello']), true);
  assert.equal(hasUncoveredCjkSubtitles('inter', ['Hello world']), false);
});

test('F-0026/AC-2 AC-3 all five presets reuse shared graphics layer across three aspects and omit safe zones from export scenes', () => {
  const chunks: SubtitleChunk[] = [
    { id: 'c1', text: '大家好，今天聊剪辑。', timestamp: [0.1, 1.8], keywords: [{ start: 4, end: 6, text: '今天', source: 'manual' }] },
  ];
  assert.equal(hasReliableWordHighlight(chunks, undefined, false), false, 'missing words clearly fall back');

  for (const preset of PLATFORM_PRESETS) {
    const primary = applyPlatformPreset(defaultSubtitleStyle, preset.id);
    const pair = { primary, secondary: defaultSubtitleStylePair.secondary };
    for (const [width, height] of [[1920, 1080], [1080, 1920], [1080, 1080]] as const) {
      const preview = buildPreviewSubtitleScene({ chunks, stylePair: pair, videoWidth: width, videoHeight: height, duration: 2 });
      const exported = buildExportSubtitleScene({ chunks, stylePair: pair, keptSegments: [{ start: 0, end: 2, keep: true }], videoWidth: width, videoHeight: height, duration: 2 });
      const projectExported = buildProjectExportSubtitleScene({
        chunks, keptSegments: [{ start: 0, end: 2, keep: true }], stylePair: pair, videoWidth: width, videoHeight: height, duration: 2,
      });
      assert.equal((preview.primary as Record<string, unknown>).safeZoneVisible, undefined, 'preview graphic scene omits safe zone guide');
      assert.equal((exported.primary as Record<string, unknown>).safeZoneInsets, undefined, 'export graphic scene omits safe zone guide');
      assert.deepEqual(exported.cues[0].keywords, projectExported.cues[0].keywords, `${preset.id} forwards keywords in projectExport`);
      assert.equal(exported.primary.keywordBackgroundColor, projectExported.primary.keywordBackgroundColor);
      assert.equal(exported.primary.wordHighlightColor, projectExported.primary.wordHighlightColor);

      const ctx = createCanvas(width, height).getContext('2d') as unknown as CanvasRenderingContext2D;
      const pScene = { ...preview, fontFamily: FAMILY, primary: { ...preview.primary, fontFamily: FAMILY }, secondary: preview.secondary ? { ...preview.secondary, fontFamily: FAMILY } : undefined };
      const eScene = { ...exported, fontFamily: FAMILY, primary: { ...exported.primary, fontFamily: FAMILY }, secondary: exported.secondary ? { ...exported.secondary, fontFamily: FAMILY } : undefined };
      const pLines = layoutScene(ctx, pScene).map(l => l.text);
      const eLines = layoutScene(ctx, eScene).map(l => l.text);
      assert.deepEqual(pLines, eLines, `${preset.id} ${width}x${height} preview and export wrap identically`);
      assert.equal(drawFrame(ctx, eScene, 0.5), true, `${preset.id} draws on shared graphics layer`);
    }
  }
});

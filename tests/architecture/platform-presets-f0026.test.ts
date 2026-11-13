import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { Context } from '@deepseek-ai/cordis';
import { createHost } from '../../server/app.ts';
import { ProjectService } from '../../src/services/projectService.ts';
import { storesPlugin } from '../../src/runtime/client.ts';
import type { RemoteConnection } from '../../src/runtime/connection.ts';
import type { RecoveryStorage } from '../../src/recovery/storage.ts';
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

const memStorage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => memStorage.get(key) ?? null,
    setItem: (key: string, value: string) => { memStorage.set(key, String(value)); },
    removeItem: (key: string) => { memStorage.delete(key); },
    clear: () => { memStorage.clear(); },
  },
});

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

function memoryRecoveryStorage(): RecoveryStorage {
  const rows = new Map<string, any>();
  return {
    async list(scope: string) {
      return [...rows.values()].filter(r => r.scope === scope).map(copy => ({ ok: true as const, copy }));
    },
    async put(copy) { rows.set(copy.key, copy); },
    async delete(key: string, sequence?: number) {
      const existing = rows.get(key);
      if (existing && sequence !== undefined && existing.sequence !== sequence) return false;
      rows.delete(key);
      return true;
    },
  };
}

async function makeClient(base: string, token: string, intercept?: (method: string, payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) {
  const ctx = new Context();
  await ctx.plugin(storesPlugin()).await();
  const calls: Array<{ method: string; payload: unknown }> = [];
  const conn = {
    isReady: () => true,
    snapshot: () => 'connected' as const,
    subscribe: () => () => undefined,
    on: () => () => undefined,
    resourceUrl: (path: string) => `${base}${path}`,
    async call(method: string, payload?: unknown) {
      calls.push({ method, payload });
      const exec = async () => {
        const response = await fetch(`${base}/rpc`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: 'f0026', method, payload: payload ?? {} }),
        });
        const envelope = await response.json();
        if (!envelope?.result?.ok) throw new Error(envelope?.result?.error?.message ?? JSON.stringify(envelope));
        return envelope.result.value;
      };
      return intercept ? intercept(method, payload, exec) : exec();
    },
  } as unknown as RemoteConnection;
  ctx.provide('connection', conn);
  const service = new ProjectService(ctx, memoryRecoveryStorage());
  return { ctx, service, calls };
}

test('F-0026/AC-1 AC-2 AC-6 AC-7 AC-8 ProjectService persists platform presets across second client, verifies lost receipts, reverts unsaved style, and rechecks conflicts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0026-ps-'));
  const token = 'f0026-ps-token';
  const host = await createHost({ home, token, port: 0, resourceRoot: resolve('src-tauri') }, { profile: 'desktop', providers: [], patches: [] });
  const base = `http://127.0.0.1:${(host.httpServer.address() as { port: number }).port}`;
  try {
    const upload = await (await fetch(`${base}/assets`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: 'mp4' })).json();
    const createRes = await (await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: '1', method: 'projects.create', payload: {
        name: 'F-0026', videoName: 'clip.mp4', durationSeconds: 4, media: { assetId: upload.assetId, mimeType: 'video/mp4' },
      } }),
    })).json();
    const { projectId, videoId } = createRes.result.value;
    await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: '2', method: 'projects.saveTranscript', payload: {
        projectId, videoId, transcript: { text: '大家好', language: 'zh', duration: 4, chunks: [{ id: 's1', text: '大家好', timestamp: [0.2, 1.5] }] },
      } }),
    });

    let dropNextStyleReceipt = false;
    const clientA = await makeClient(base, token, async (method, _payload, next) => {
      const value = await next();
      if (method === 'projects.saveProjectStyle' && dropNextStyleReceipt) {
        dropNextStyleReceipt = false;
        throw new Error('simulated dropped receipt after Host write');
      }
      return value;
    });
    const clientB = await makeClient(base, token);

    try {
      await clientA.service.open(projectId, videoId);
      const appA = clientA.ctx.stores.app;
      const historyA = clientA.ctx.stores.history;
      const douyin = updateSafeZoneInsets(applyPlatformPreset(appA.getState().subtitleStylePair.primary, 'douyin'), { bottom: 0.26 });
      appA.getState().setSubtitleStylePair({ ...appA.getState().subtitleStylePair, primary: douyin });
      assert.equal(await clientA.service.flush(), true);
      assert.equal(historyA.getState().chunks[0].text, '大家好', 'preset application preserves subtitle text');
      assert.deepEqual(historyA.getState().chunks[0].timestamp, [0.2, 1.5], 'preset application preserves timestamps');

      // AC-7: Second client reads identical platform preset, safe-zone state, and aspect ratio from Host.
      await clientB.service.open(projectId, videoId);
      const styleB = clientB.ctx.stores.app.getState().subtitleStylePair.primary;
      assert.equal(styleB.platformPresetId, 'douyin');
      assert.equal(styleB.safeZoneVisible, true);
      assert.equal(styleB.safeZonePlatformId, 'douyin');
      assert.equal(styleB.safeZoneInsets?.bottom, 0.26);
      assert.equal(styleB.aspectPreset, 'portrait_9_16');

      // AC-8: Lost-receipt retry checks Host first via verifyCurrentEditsSaved and avoids duplicate writes.
      dropNextStyleReceipt = true;
      const xhs = applyPlatformPreset(appA.getState().subtitleStylePair.primary, 'xiaohongshu');
      appA.getState().setSubtitleStylePair({ ...appA.getState().subtitleStylePair, primary: xhs });
      assert.equal(await clientA.service.flush(), false);
      assert.equal(clientA.ctx.stores.project.getState().save.status, 'failed');
      const writesBeforeRetry = clientA.calls.filter(c => c.method === 'projects.saveProjectStyle').length;
      assert.equal(await clientA.service.retryStyleSave(), true);
      assert.equal(clientA.calls.filter(c => c.method === 'projects.saveProjectStyle').length, writesBeforeRetry, 'retry verified Host state without blind duplicate write');
      assert.equal(clientA.ctx.stores.project.getState().save.status, 'saved');

      // AC-6: revertUnsavedStyle restores Host-confirmed style while keeping unsaved text edits intact.
      historyA.getState().updateChunkText('s1', '大家好啊');
      const bili = applyPlatformPreset(appA.getState().subtitleStylePair.primary, 'bilibili');
      appA.getState().setSubtitleStylePair({ ...appA.getState().subtitleStylePair, primary: bili });
      assert.equal(clientA.service.revertUnsavedStyle(), true);
      assert.equal(appA.getState().subtitleStylePair.primary.platformPresetId, 'xiaohongshu');
      assert.equal(historyA.getState().chunks[0].text, '大家好啊', 'reverting style keeps subtitle text edits');
      assert.equal(await clientA.service.flush(), true);

      // AC-8: Version conflict blocks submit until recheckStyleConflict refreshes revisions and preserves user input.
      await clientB.service.open(projectId, videoId);
      const appB = clientB.ctx.stores.app;
      const yt = applyPlatformPreset(appB.getState().subtitleStylePair.primary, 'youtube-shorts');
      appB.getState().setSubtitleStylePair({ ...appB.getState().subtitleStylePair, primary: yt });
      assert.equal(await clientB.service.flush(), true);

      appA.getState().setSubtitleStylePair({ ...appA.getState().subtitleStylePair, primary: applyPlatformPreset(appA.getState().subtitleStylePair.primary, 'bilibili') });
      assert.equal(await clientA.service.flush(), false);
      assert.equal(clientA.ctx.stores.project.getState().save.status, 'conflict');
      assert.equal(await clientA.service.flush(), false, 'conflict blocks further submits until re-check');

      const reviewed = await clientA.service.recheckStyleConflict();
      assert.equal(reviewed.status, 'reviewed');
      assert.equal(appA.getState().subtitleStylePair.primary.platformPresetId, 'bilibili', 'recheck preserves user selection');
      assert.equal(clientA.ctx.stores.project.getState().save.status, 'pending');
      assert.equal(await clientA.service.flush(), true);
      assert.equal(clientA.ctx.stores.project.getState().save.status, 'saved');
    } finally {
      await clientA.ctx.fiber.dispose();
      await clientB.ctx.fiber.dispose();
    }
  } finally {
    await host.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  }
});

const FFMPEG = resolve('src-tauri/binaries/ffmpeg');
const REAL_BILI_MP4 = resolve('tests/media/external/bili-BV1Rex26dEWF.mp4');
const REAL_BILI_TRANSCRIPT = resolve('tests/media/external/bili-BV1Rex26dEWF.transcript.json');

function runFfmpeg(args: string[]) {
  const result = spawnSync(FFMPEG, ['-hide_banner', '-y', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function readRgbFrame(file: string, time: number, width: number, height: number): Buffer {
  const result = spawnSync(
    FFMPEG,
    ['-v', 'error', '-ss', String(time), '-i', file, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stdout.length, width * height * 3);
  return result.stdout;
}

function countBandMatches(
  buffer: Buffer,
  width: number,
  height: number,
  yMinRatio: number,
  yMaxRatio: number,
  predicate: (r: number, g: number, b: number) => boolean,
): number {
  const yStart = Math.max(0, Math.floor(height * yMinRatio));
  const yEnd = Math.min(height, Math.ceil(height * yMaxRatio));
  let count = 0;
  for (let y = yStart; y < yEnd; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 3;
      if (predicate(buffer[idx], buffer[idx + 1], buffer[idx + 2])) count += 1;
    }
  }
  return count;
}

test('F-0026/AC-2 AC-3 AC-4 AC-9 real Host Skia + FFmpeg exports platform presets across 16:9, 9:16, 1:1 with zero safe-zone guide leakage', { timeout: 180_000 }, async (t) => {
  if (!existsSync(REAL_BILI_MP4) || !existsSync(REAL_BILI_TRANSCRIPT)) {
    t.skip('Real media fixture bili-BV1Rex26dEWF is not installed');
    return;
  }
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0026-export-'));
  const token = 'f0026-export-token';
  const host = await createHost({ home, token, port: 0, resourceRoot: resolve('src-tauri') }, { profile: 'desktop', providers: [], patches: [] });
  const base = `http://127.0.0.1:${(host.httpServer.address() as { port: number }).port}`;
  const call = async (method: string, payload: unknown) => {
    const response = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'f0026-exp', method, payload }),
    });
    const envelope = await response.json();
    assert.equal(envelope.result.ok, true, JSON.stringify(envelope.result));
    return envelope.result.value;
  };
  try {
    const raw = JSON.parse(await readFile(REAL_BILI_TRANSCRIPT, 'utf8')) as {
      chunks: SubtitleChunk[];
      wordChunks: SubtitleChunk[];
      hasWordTimestamps: boolean;
    };
    assert.equal(raw.hasWordTimestamps, true);
    const firstCue = raw.chunks.find(c => c.timestamp[1] > c.timestamp[0] && c.wordIds?.length);
    assert.ok(firstCue, 'real transcript provides a word-timed cue');
    const cueWords = raw.wordChunks.filter(w => w.sentenceId === firstCue.id);
    const firstWord = cueWords[0];
    assert.ok(firstWord, 'real transcript provides word timing');
    const wordTime = Math.min(2.0, Math.max(0.2, (firstWord.timestamp[0] + firstWord.timestamp[1]) / 2 - firstCue.timestamp[0] + 0.3));

    const chunks: SubtitleChunk[] = [
      {
        ...firstCue,
        id: 'real-s1',
        timestamp: [0.3, 2.2],
        keywords: [{ start: 0, end: Math.min(2, firstCue.text.length), text: firstCue.text.slice(0, 2), source: 'manual' }],
      },
      {
        id: 'fallback-s2',
        text: '无词元整句降级示例',
        timestamp: [2.4, 3.8],
      },
    ];
    const words: SubtitleChunk[] = cueWords.map((w, index) => ({
      ...w,
      id: `rw-${index}`,
      sentenceId: 'real-s1',
      timestamp: [
        0.3 + Math.max(0, w.timestamp[0] - firstCue.timestamp[0]) * 0.5,
        0.3 + Math.max(0.05, w.timestamp[1] - firstCue.timestamp[0]) * 0.5,
      ] as [number, number],
    }));
    chunks[0].wordIds = words.map(w => w.id);

    const cases = [
      { presetId: 'bilibili' as const, width: 640, height: 360, vf: 'scale=640:360', label: '16:9', checkColor: (r: number, g: number, b: number) => b > 150 && g > 120 && r < 110 },
      { presetId: 'douyin' as const, width: 360, height: 640, vf: 'crop=ih*9/16:ih,scale=360:640', label: '9:16', checkColor: (r: number, g: number, b: number) => r > 170 && g > 150 && b < 110 },
      { presetId: 'youtube-shorts' as const, width: 480, height: 480, vf: 'crop=ih:ih,scale=480:480', label: '1:1', checkColor: (r: number, g: number, b: number) => r > 150 && g < 90 && b < 90 },
    ];

    for (const item of cases) {
      const samplePath = join(home, `sample-${item.presetId}.mp4`);
      runFfmpeg(['-ss', '0', '-t', '4', '-i', REAL_BILI_MP4, '-vf', item.vf, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', samplePath]);

      const primary = {
        ...applyPlatformPreset(defaultSubtitleStyle, item.presetId),
        fontSizeRatio: 0.08,
      };
      const scene = buildExportSubtitleScene({
        chunks,
        wordChunks: words,
        hasWordTimestamps: true,
        stylePair: { primary, secondary: defaultSubtitleStylePair.secondary },
        keptSegments: [{ start: 0, end: 4, keep: true }],
        videoWidth: item.width,
        videoHeight: item.height,
        fps: 30,
        duration: 4,
      });
      assert.equal((scene.primary as Record<string, unknown>).safeZoneVisible, undefined);
      assert.equal((scene.primary as Record<string, unknown>).safeZoneInsets, undefined);
      const sceneWithoutGuide = buildExportSubtitleScene({
        chunks,
        wordChunks: words,
        hasWordTimestamps: true,
        stylePair: { primary: toggleSafeZoneGuide(primary, false), secondary: defaultSubtitleStylePair.secondary },
        keptSegments: [{ start: 0, end: 4, keep: true }],
        videoWidth: item.width,
        videoHeight: item.height,
        fps: 30,
        duration: 4,
      });
      assert.deepEqual(scene, sceneWithoutGuide, `${item.presetId} export scene is identical with safe-zone guide on or off`);

      const asset = await (await fetch(`${base}/assets`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: await readFile(samplePath),
      })).json();
      const queued = await call('export.start', {
        assetId: asset.assetId,
        segments: [{ start: 0, end: 4, keep: true }],
        options: {
          format: 'mp4',
          quality: 'low',
          preserveAudio: false,
          subtitleProcessing: 'hard',
          subtitleTransport: 'skia-band',
          subtitleScene: scene,
        },
      });
      let state = queued;
      const deadline = Date.now() + 90_000;
      while (state.status === 'running' || state.status === 'queued') {
        assert.ok(Date.now() < deadline, `${item.presetId} export timeout`);
        await new Promise(done => setTimeout(done, 40));
        state = await call('jobs.get', { id: queued.id });
      }
      assert.equal(state.status, 'complete', state.error);
      const outputPath = host.assets.path(state.result.assetId);
      const outFrame = readRgbFrame(outputPath, Math.min(1.5, wordTime), item.width, item.height);
      const srcFrame = readRgbFrame(samplePath, Math.min(1.5, wordTime), item.width, item.height);

      const bandHighlight = countBandMatches(outFrame, item.width, item.height, 0.45, 0.92, item.checkColor);
      assert.ok(bandHighlight > 30, `${item.presetId} (${item.label}) renders highlight/keyword pixels in subtitle band (got ${bandHighlight})`);

      let topDiffSum = 0;
      let topPixels = 0;
      for (let y = 4; y < Math.min(28, item.height); y += 1) {
        for (let x = 4; x < Math.min(160, item.width); x += 1) {
          const idx = (y * item.width + x) * 3;
          topDiffSum += Math.abs(outFrame[idx] - srcFrame[idx]) + Math.abs(outFrame[idx + 1] - srcFrame[idx + 1]) + Math.abs(outFrame[idx + 2] - srcFrame[idx + 2]);
          topPixels += 3;
        }
      }
      const meanTopDiff = topDiffSum / Math.max(1, topPixels);
      assert.ok(meanTopDiff < 18, `${item.presetId} (${item.label}) top region stays clean without SafeZoneOverlay badge (meanChannelDiff=${meanTopDiff.toFixed(2)})`);

      const fallbackFrame = readRgbFrame(outputPath, 3.0, item.width, item.height);
      const fallbackMatches = countBandMatches(fallbackFrame, item.width, item.height, 0.45, 0.92, (r, g, b) => r > 170 || b > 150);
      assert.ok(fallbackMatches > 40, `${item.presetId} fallback cue without words renders visible sentence highlight`);
    }

    const exportFiles = await readdir(join(home, 'exports'));
    assert.deepEqual(exportFiles.filter(file => file.endsWith('.ass')), [], 'platform preset export uses shared Skia path, never ASS');
  } finally {
    await host.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  }
});

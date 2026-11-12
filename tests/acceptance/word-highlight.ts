import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Browser } from 'webdriverio';
import { buildExportSubtitleScene } from '../../src/subtitle/graphicsScene';
import { defaultSubtitleStylePair } from '../../src/subtitle/subtitleStyle';
import type { SubtitleChunk } from '../../src/types/subtitle';
import type { host } from './fixture';

const SOURCE = resolve('tests/media/external/bili-BV1Rex26dEWF.mp4');
const TRANSCRIPT = resolve('tests/media/external/bili-BV1Rex26dEWF.transcript.json');
const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const DURATION = 8;
const WIDTH = 852;
const HEIGHT = 480;

interface RealTranscript {
  text: string;
  chunks: SubtitleChunk[];
  wordChunks: SubtitleChunk[];
  hasWordTimestamps: boolean;
  language: string;
  duration: number;
}

async function realTranscript(): Promise<RealTranscript> {
  const raw = JSON.parse(await readFile(TRANSCRIPT, 'utf8')) as { chunks: SubtitleChunk[]; wordChunks: SubtitleChunk[];
    hasWordTimestamps: boolean; language: string };
  assert.equal(raw.hasWordTimestamps, true, 'F-0024 real fixture must contain verified word timestamps');
  const chunks = raw.chunks.filter(chunk => chunk.timestamp[0] < DURATION && chunk.timestamp[1] > 0);
  const sentenceIds = new Set(chunks.map(chunk => chunk.id));
  const wordChunks = raw.wordChunks.filter(word => sentenceIds.has(word.sentenceId ?? ''));
  assert.ok(wordChunks.length > 10, 'F-0024 real fixture has enough word timing for the sample');
  return { text: chunks.map(chunk => chunk.text).join(' '), chunks, wordChunks, hasWordTimestamps: true, language: raw.language, duration: DURATION };
}

export async function prepareWordHighlightMedia(dir: string) {
  const source = join(dir, 'f0024-real.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-t', String(DURATION), '-i', SOURCE,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', source],
  { stdio: 'pipe' });
  return { source, transcript: await realTranscript() };
}

async function pixelStats(browser: Browser) {
  return browser.execute(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="subtitle-overlay-canvas"]');
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return { count: 0, x: -1 };
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0; let x = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 180 && data[i + 1] > 140 && data[i + 2] < 110 && data[i + 3] > 80) {
        count += 1; x += ((i / 4) % canvas.width);
      }
    }
    return { count, x: count ? x / count : -1 };
  });
}

async function seek(browser: Browser, time: number) {
  await browser.execute(async (target: number) => {
    const video = document.querySelector('video');
    if (!video) throw new Error('video element missing');
    if (video.readyState < 1) await new Promise<void>(resolve => video.addEventListener('loadedmetadata', () => resolve(), { once: true }));
    video.pause();
    video.currentTime = target;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`video seek timeout at ${target}s`)), 5_000);
      video.addEventListener('seeked', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }, time);
  await browser.pause(500);
}

function frame(path: string, time: number) {
  return execFileSync(FFMPEG, ['-v', 'error', '-ss', String(time), '-i', path, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
    { maxBuffer: 16 * 1024 * 1024 });
}

function redPixels(buffer: Buffer) {
  let count = 0; let xTotal = 0;
  for (let offset = 0; offset < buffer.length; offset += 3) {
    const r = buffer[offset]; const g = buffer[offset + 1]; const b = buffer[offset + 2];
    if (r > 140 && r > g * 1.7 && r > b * 1.7) { count += 1; xTotal += (offset / 3) % WIDTH; }
  }
  return { count, x: count ? xTotal / count : -1 };
}

export async function wordHighlightAcceptance(browser: Browser, api: ReturnType<typeof host>, dir: string, platform: string) {
  if (!existsSync(SOURCE) || !existsSync(TRANSCRIPT)) {
    console.log('SKIP F-0024/AC-9: real-media fixtures are not installed');
    return;
  }
  const { source, transcript } = await prepareWordHighlightMedia(dir);
  const assetId = await api.upload(source);
  const ids = await api.call<{ projectId: string; videoId: string }>('projects.create', {
    name: 'F-0024 逐字高亮验收', videoName: 'f0024-real.mp4', durationSeconds: DURATION,
    media: { assetId, mimeType: 'video/mp4' },
  });
  await api.call('projects.saveTranscript', { ...ids, durationSeconds: DURATION, transcript });

  await browser.refresh();
  const project = await browser.$('button*=F-0024 逐字高亮验收');
  await project.waitForDisplayed({ timeout: 20_000 });
  await project.click();
  await browser.waitUntil(async () => browser.execute(() => (document.querySelector<HTMLVideoElement>('video')?.readyState ?? 0) >= 1),
    { timeout: 15_000, timeoutMsg: 'F-0024 real video did not load' });
  await browser.execute(() => {
    const video = document.querySelector<HTMLVideoElement>('video');
    if (!video) throw new Error('video element missing');
    video.dispatchEvent(new Event('loadedmetadata'));
  });
  await browser.waitUntil(async () => browser.execute(() => Boolean(document.querySelector('[data-testid="subtitle-overlay-canvas"]'))),
    { timeout: 10_000, timeoutMsg: 'F-0024 subtitle canvas did not mount' });
  const preset = await browser.$('button[aria-label="逐字高亮"]');
  await preset.waitForDisplayed({ timeout: 15_000 });
  await preset.click();
  await seek(browser, 0.35);
  await browser.waitUntil(async () => (await pixelStats(browser)).count > 20,
    { timeout: 20_000, timeoutMsg: 'F-0024 real preview did not draw the current word' });
  const first = await pixelStats(browser);
  await seek(browser, 0.55);
  const second = await pixelStats(browser);
  assert.ok(first.count > 20 && second.count > 20, 'F-0024 real preview highlights real timestamped words');
  assert.ok(second.x - first.x > 5, `F-0024 real preview advances the highlighted glyph (${first.x} -> ${second.x})`);
  await mkdir('test-results', { recursive: true });
  await browser.saveScreenshot(`test-results/f0024-${platform}-real-preview.png`);

  const primary = { ...defaultSubtitleStylePair.primary, fontSizeRatio: 0.12, bottomOffsetRatio: 30 / HEIGHT,
    borderWidth: 2, color: '#FFFFFF', wordHighlightMode: 'word' as const, wordHighlightColor: '#FF0000' };
  const scene = buildExportSubtitleScene({ chunks: transcript.chunks, wordChunks: transcript.wordChunks,
    hasWordTimestamps: true, stylePair: { primary, secondary: defaultSubtitleStylePair.secondary },
    keptSegments: [{ start: 0, end: DURATION, keep: true }], videoWidth: WIDTH, videoHeight: HEIGHT, fps: 30, duration: DURATION });
  const exportAsset = await api.upload(source);
  const job = await api.call<{ id: string; status: string }>('export.start', { assetId: exportAsset,
    segments: [{ start: 0, end: DURATION, keep: true }], options: { format: 'mp4', quality: 'low', preserveAudio: true,
      subtitleProcessing: 'hard', subtitleTransport: 'skia-band', subtitleScene: scene } });
  let state = job;
  const deadline = Date.now() + 90_000;
  while (state.status === 'running' || state.status === 'queued') {
    assert.ok(Date.now() < deadline, 'F-0024 real Host export timed out');
    await new Promise(done => setTimeout(done, 50));
    state = await api.call('jobs.get', { id: job.id });
  }
  assert.equal(state.status, 'complete', (state as { error?: string }).error);
  const result = state as unknown as { result: { assetId: string } };
  const output = join('test-results', `f0024-${platform}-real-export.mp4`);
  const outputBytes = await api.download(result.result.assetId);
  await writeFile(output, outputBytes);
  const firstFrame = redPixels(frame(output, 0.35));
  const secondFrame = redPixels(frame(output, 0.55));
  assert.ok(firstFrame.count > 20 && secondFrame.count > 20, 'F-0024 real Host output contains the highlighted word');
  assert.ok(secondFrame.x - firstFrame.x > 5, `F-0024 real Host output advances the word (${firstFrame.x} -> ${secondFrame.x})`);
  const playback = await browser.execute(async (base64: string) => new Promise<{ duration: number; width: number; height: number }>((resolve, reject) => {
    const video = document.createElement('video');
    const timer = setTimeout(() => reject(new Error('exported video playback timeout')), 10_000);
    video.src = `data:video/mp4;base64,${base64}`;
    video.addEventListener('loadedmetadata', () => {
      clearTimeout(timer);
      resolve({ duration: video.duration, width: video.videoWidth, height: video.videoHeight });
    }, { once: true });
    video.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`exported video error ${video.error?.code}`)); }, { once: true });
  }), outputBytes.toString('base64'));
  assert.ok(Math.abs(playback.duration - DURATION) < 0.2, 'F-0024 exported video opens in a media player');
  assert.ok(Math.abs(playback.width - WIDTH) <= 1 && playback.height === HEIGHT, 'exported video dimensions remain playable');
  console.log(`PASS F-0024/AC-4/AC-9: ${platform} real preview and Host export use verified word timestamps`);
}

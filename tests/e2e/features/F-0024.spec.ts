// F-0024 word highlighting: real editor canvas, style controls, fallback and locale states.
import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { shot } from '../lib/evidence';
import { mockHost, prepare, projectItem, uuid, VIDEO_ID, type MockHandlers } from '../lib/mockHost';

// 录屏证据与多个 canvas 同时加载时保持单 worker，避免开发服务器在并行媒体读取下退出。
test.describe.configure({ mode: 'serial' });

const F = 'F-0024';
const THEMES = ['light', 'dark'] as const;
type Theme = typeof THEMES[number];
const P = uuid(240);
const NAME = '口播：逐字高亮';
const NOW = '2026-11-12T12:00:00.000Z';
const FFMPEG = resolve('src-tauri/binaries/ffmpeg');

let mediaPath = '';
let tempDir = '';

test.beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'flycut-f0024-e2e-'));
  mediaPath = join(tempDir, 'clip.mp4');
  const result = spawnSync(FFMPEG, ['-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x202020:size=640x360:rate=30:duration=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mediaPath], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
});

test.afterAll(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

const reliableChunks = [
  {
    id: 's1',
    text: '大家好世界',
    secondText: 'Hello world',
    timestamp: [0.3, 2.5] as [number, number],
    wordIds: ['w1', 'w2', 'w3', 'w4'],
  },
];
const reliableWords = [
  { id: 'w1', text: '大', timestamp: [0.35, 0.55] as [number, number], sentenceId: 's1' },
  { id: 'w2', text: '家', timestamp: [0.6, 0.8] as [number, number], sentenceId: 's1' },
  { id: 'w3', text: '好', timestamp: [0.9, 1.1] as [number, number], sentenceId: 's1' },
  { id: 'w4', text: '世界', timestamp: [1.2, 1.7] as [number, number], sentenceId: 's1' },
];

function openResult(reliable = true, projectStyle?: Record<string, unknown>, styleRevision = 0) {
  return {
    status: 'ok',
    project: { formatVersion: 3, id: P, name: NAME, createdAt: NOW, updatedAt: NOW, revision: 3, styleRevision, videos: [] },
    video: { id: VIDEO_ID, name: `${NAME}.mp4`, durationSeconds: 4, createdAt: NOW, updatedAt: NOW, hasTranscript: true, revision: 3,
      styleSource: 'project', media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1, mimeType: 'video/mp4' } },
    videos: [{ id: VIDEO_ID, name: `${NAME}.mp4`, durationSeconds: 4, createdAt: NOW, updatedAt: NOW, hasTranscript: true,
      mediaMissing: false, hasThumbnail: false, styleSource: 'project', revision: 3 }],
    transcript: {
      text: reliableChunks[0].text,
      chunks: reliableChunks,
      wordChunks: reliable ? reliableWords : undefined,
      hasWordTimestamps: reliable,
      language: 'zh',
      duration: 4,
    },
    edits: undefined,
    projectStyle,
    media: { status: 'ok', name: `${NAME}.mp4`, playback: { kind: 'url', path: `/projects/${P}/media/${VIDEO_ID}` } },
  };
}

const handlers = (reliable = true): MockHandlers => ({
  'projects.open': () => openResult(reliable),
  'projects.list': () => [projectItem(P, NAME)],
  'projects.saveVideoEdits': () => ({ status: 'saved', revision: 4, updatedAt: NOW }),
  'projects.saveProjectStyle': () => ({ status: 'saved', revision: 1, updatedAt: NOW }),
});

async function openEditor(page: Page, theme: Theme, reliable = true) {
  await prepare(page, theme);
  const host = await mockHost(page, handlers(reliable));
  await page.route('**/projects/*/media/*', serveMedia);
  await page.goto(`/#/projects/${P}/videos/${VIDEO_ID}`);
  await expect(page.locator('video')).toBeVisible();
  await page.locator('video').evaluate(async (video: HTMLVideoElement) => {
    if (video.readyState >= 1) return;
    await new Promise<void>(resolve => video.addEventListener('loadedmetadata', () => resolve(), { once: true }));
  });
  return host;
}

async function serveMedia(route: import('@playwright/test').Route): Promise<void> {
  const body = await readFile(mediaPath);
  const range = route.request().headers()['range'];
  const match = range ? /bytes=(\d+)-(\d*)/.exec(range) : null;
  if (match) {
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : body.length - 1;
    await route.fulfill({ status: 206, headers: { 'Accept-Ranges': 'bytes', 'Content-Type': 'video/mp4',
      'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': String(end - start + 1) }, body: body.subarray(start, end + 1) });
    return;
  }
  await route.fulfill({ status: 200, headers: { 'Accept-Ranges': 'bytes', 'Content-Type': 'video/mp4', 'Content-Length': String(body.length) }, body });
}

async function seek(page: Page, time: number) {
  await page.locator('video').evaluate(async (video: HTMLVideoElement, target: number) => {
    if (Math.abs(video.currentTime - target) < 0.001) {
      video.dispatchEvent(new Event('seeked'));
      return;
    }
    await new Promise<void>(resolve => {
      const done = () => { video.removeEventListener('seeked', done); resolve(); };
      video.addEventListener('seeked', done);
      video.currentTime = target;
    });
  }, time);
  await page.waitForTimeout(150);
}

function coloredPixels(page: Page, color: 'red' | 'yellow') {
  return page.getByTestId('subtitle-overlay-canvas').evaluate((canvas, requested) => {
    const context = (canvas as HTMLCanvasElement).getContext('2d');
    if (!context) return 0;
    const { width, height } = canvas as HTMLCanvasElement;
    const data = context.getImageData(0, 0, width, height).data;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      if (requested === 'red' && r > 170 && g < 100 && b < 100 && a > 80) count += 1;
      if (requested === 'yellow' && r > 180 && g > 150 && b < 110 && a > 80) count += 1;
    }
    return count;
  }, color);
}

function canvasAlpha(page: Page) {
  return page.getByTestId('subtitle-overlay-canvas').evaluate(canvas => {
    const context = (canvas as HTMLCanvasElement).getContext('2d');
    if (!context) return 0;
    const { width, height } = canvas as HTMLCanvasElement;
    const data = context.getImageData(0, 0, width, height).data;
    let count = 0;
    for (let index = 3; index < data.length; index += 4) if (data[index]) count += 1;
    return count;
  });
}

for (const theme of THEMES) {
  test(`F-0024/AC-1 AC-9 选择预设并改色后，当前词按真实时间换色 (${theme})`, async ({ page }) => {
    await openEditor(page, theme);
    await expect(page.getByText('正在加载字幕字体…')).toHaveCount(0, { timeout: 20_000 });
    await page.getByRole('button', { name: '逐字高亮', exact: true }).click();
    await page.getByTestId('subtitle-base-color').fill('#FFFFFF');
    await page.getByTestId('word-highlight-color').fill('#FF0000');
    await page.getByTestId('subtitle-base-color').blur();
    await page.getByTestId('word-highlight-color').blur();

    await seek(page, 0.45);
    await expect.poll(() => coloredPixels(page, 'red'), { timeout: 10_000 }).toBeGreaterThan(20);
    await shot(page, F, `word-highlight-current-${theme}`);

    await seek(page, 0.825);
    expect(await coloredPixels(page, 'red')).toBe(0);
    await shot(page, F, `word-highlight-gap-${theme}`);

    await page.locator('video').evaluate((video: HTMLVideoElement) => { video.playbackRate = 2; });
    await seek(page, 1.3);
    await expect.poll(() => coloredPixels(page, 'red'), { timeout: 10_000 }).toBeGreaterThan(60);
  });

  test(`F-0024/AC-2 AC-5 AC-9 无可靠词元时显示整句降级，不伪造逐字时间 (${theme})`, async ({ page }) => {
    await openEditor(page, theme, false);
    await page.getByRole('button', { name: '逐字高亮', exact: true }).click();
    await page.getByTestId('word-highlight-color').fill('#FF0000');
    await page.getByTestId('word-highlight-color').blur();
    await expect(page.getByTestId('word-highlight-fallback')).toHaveText('使用整句高亮');
    await seek(page, 0.45);
    await expect.poll(() => coloredPixels(page, 'red'), { timeout: 10_000 }).toBeGreaterThan(100);
    await shot(page, F, `word-highlight-fallback-${theme}`);

    await page.getByRole('button', { name: '白字黑边' }).click();
    await expect(page.getByTestId('word-highlight-fallback')).toHaveCount(0);
    expect(await coloredPixels(page, 'red')).toBe(0);
  });

  test(`F-0024/AC-9 英文界面显示逐字预设与整句降级文案 (${theme})`, async ({ page }) => {
    await openEditor(page, theme, false);
    await page.getByRole('button', { name: '选择语言' }).click();
    await page.getByRole('menuitem', { name: /English/ }).click();
    await page.getByRole('button', { name: 'Word highlight' }).click();
    await expect(page.getByTestId('word-highlight-fallback')).toHaveText('Using sentence highlighting');
    await seek(page, 0.45);
    await shot(page, F, `word-highlight-fallback-en-${theme}`);
  });
}

for (const theme of THEMES) {
  test(`F-0024/AC-5 AC-9 空字幕不绘制也不显示整句降级 (${theme})`, async ({ page }) => {
    const base = openResult(true);
    const empty = { ...base, transcript: { ...base.transcript, text: '', chunks: [], wordChunks: undefined, hasWordTimestamps: false } };
    const stateful = handlers();
    stateful['projects.open'] = () => empty;
    await prepare(page, theme);
    await mockHost(page, stateful);
    await page.route('**/projects/*/media/*', serveMedia);
    await page.goto(`/#/projects/${P}/videos/${VIDEO_ID}`);
    await expect(page.locator('video')).toBeVisible();
    await page.getByRole('button', { name: '逐字高亮', exact: true }).click();
    await expect(page.getByTestId('word-highlight-fallback')).toHaveCount(0);
    await seek(page, 0.45);
    expect(await canvasAlpha(page)).toBe(0);
    await shot(page, F, `word-highlight-empty-${theme}`);
  });
}

for (const theme of THEMES) {
  test(`F-0024/AC-6 AC-9 字体加载中保留逐字预设，加载完成后才绘制高亮 (${theme})`, async ({ page }) => {
    await prepare(page, theme);
    await mockHost(page, handlers());
    await page.route('**/projects/*/media/*', serveMedia);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/fonts/subtitle/**', async route => {
      await gate;
      const file = new URL(route.request().url()).pathname.split('/').at(-1)!;
      await route.fulfill({ path: join(process.cwd(), 'public/fonts/subtitle', file) });
    });
    await page.goto(`/#/projects/${P}/videos/${VIDEO_ID}`);
    await expect(page.locator('video')).toBeVisible();
    await page.getByRole('button', { name: '逐字高亮', exact: true }).click();
    await expect(page.getByText('正在加载字幕字体…')).toBeVisible();
    await shot(page, F, `word-highlight-loading-${theme}`);
    release();
    await expect(page.getByText('正在加载字幕字体…')).toHaveCount(0, { timeout: 20_000 });
    await seek(page, 0.45);
    await expect.poll(() => coloredPixels(page, 'yellow'), { timeout: 10_000 }).toBeGreaterThan(20);
  });

  test(`F-0024/AC-8 AC-9 字体失败显示原因和重试，重试后逐字高亮恢复 (${theme})`, async ({ page }) => {
    let fail = true;
    await prepare(page, theme);
    await mockHost(page, handlers());
    await page.route('**/projects/*/media/*', serveMedia);
    await page.route('**/fonts/subtitle/**', async route => {
      if (fail) { await route.abort('failed'); return; }
      const file = new URL(route.request().url()).pathname.split('/').at(-1)!;
      await route.fulfill({ path: join(process.cwd(), 'public/fonts/subtitle', file) });
    });
    await page.goto(`/#/projects/${P}/videos/${VIDEO_ID}`);
    await expect(page.locator('video')).toBeVisible();
    await page.getByRole('button', { name: '逐字高亮', exact: true }).click();
    await expect(page.getByText('字幕渲染不可用')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: '重试' })).toBeVisible();
    await shot(page, F, `word-highlight-error-${theme}`);
    fail = false;
    await page.getByRole('button', { name: '重试' }).click();
    await expect(page.getByText('字幕渲染不可用')).toHaveCount(0, { timeout: 20_000 });
    await seek(page, 0.45);
    await expect.poll(() => coloredPixels(page, 'yellow'), { timeout: 10_000 }).toBeGreaterThan(20);
  });
}

test('F-0024/AC-4 AC-7 保存高亮样式后重新打开项目，预设和颜色保持不变', async ({ page }) => {
  let savedStyle: Record<string, unknown> | undefined;
  const stateful = handlers();
  stateful['projects.open'] = () => openResult(true, savedStyle, savedStyle ? 1 : 0);
  stateful['projects.saveProjectStyle'] = (payload: { style: Record<string, unknown> }) => {
    savedStyle = payload.style;
    return { status: 'saved', revision: 1, updatedAt: NOW };
  };
  await prepare(page, 'light');
  await mockHost(page, stateful);
  await page.route('**/projects/*/media/*', serveMedia);
  await page.goto(`/#/projects/${P}/videos/${VIDEO_ID}`);
  await expect(page.locator('video')).toBeVisible();
  await page.getByRole('button', { name: '逐字高亮', exact: true }).click();
  await page.getByTestId('subtitle-base-color').fill('#00FF00');
  await page.getByTestId('word-highlight-color').fill('#FF0000');
  await expect.poll(() => {
    const primary = savedStyle?.primary as Record<string, unknown> | undefined;
    return [primary?.wordHighlightMode, primary?.color, primary?.wordHighlightColor];
  }, { timeout: 12_000 }).toEqual(['word', '#00FF00', '#FF0000']);

  await page.reload();
  await expect(page.locator('video')).toBeVisible();
  await expect(page.getByText('正在加载字幕字体…')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByTestId('subtitle-base-color')).toHaveValue('#00FF00');
  await expect(page.getByTestId('word-highlight-color')).toHaveValue('#ff0000');
  await seek(page, 0.45);
  await expect.poll(() => coloredPixels(page, 'red'), { timeout: 10_000 }).toBeGreaterThan(20);
  await shot(page, F, 'word-highlight-reopened-light');
});

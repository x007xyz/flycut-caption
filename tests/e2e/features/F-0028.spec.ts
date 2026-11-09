// F-0028 共用字幕图形层：预览状态、失败重试与明暗主题（AC-5、AC-6、AC-8、AC-9）。
// 视频用本地 ffmpeg 生成的 4 秒暗色素材，通过 page.route 提供给播放器；Host 用 mockHost。
import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { shot } from '../lib/evidence';
import { mockHost, prepare, projectItem, uuid, VIDEO_ID, type MockHandlers } from '../lib/mockHost';

const F = 'F-0028';
const THEMES = ['light', 'dark'] as const;
type Theme = typeof THEMES[number];
const P = uuid(280);
const NAME = '口播：共用字幕图形层';
const NOW = '2026-11-09T08:00:00.000Z';
const FFMPEG = resolve('src-tauri/binaries/ffmpeg');

let mediaPath = '';
let tempDir = '';

test.beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'flycut-f0028-e2e-'));
  mediaPath = join(tempDir, 'clip.mp4');
  const result = spawnSync(FFMPEG, ['-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x202020:size=640x360:rate=30:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', mediaPath], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
});

test.afterAll(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

const transcript = {
  text: '大家好 今天聊聊字幕渲染', language: 'zh', duration: 4, hasWordTimestamps: false,
  chunks: [
    { id: 's1', text: '大家好，今天聊聊字幕渲染', secondText: 'Hello, today we talk about subtitle rendering', timestamp: [0.5, 2] as [number, number] },
    { id: 's2', text: '第二句字幕', timestamp: [2.5, 3.5] as [number, number] },
  ],
};

function openResult(chunks = transcript.chunks) {
  return {
    status: 'ok',
    project: { formatVersion: 2, id: P, name: NAME, createdAt: NOW, updatedAt: NOW, revision: 3, styleRevision: 0, videos: [] },
    video: { id: VIDEO_ID, name: `${NAME}.mp4`, durationSeconds: 4, createdAt: NOW, updatedAt: NOW, hasTranscript: true, revision: 3,
      styleSource: 'project', media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1, mimeType: 'video/mp4' } },
    videos: [{ id: VIDEO_ID, name: `${NAME}.mp4`, durationSeconds: 4, createdAt: NOW, updatedAt: NOW, hasTranscript: true,
      mediaMissing: false, hasThumbnail: false, styleSource: 'project', revision: 3 }],
    transcript: { ...transcript, chunks },
    edits: undefined,
    projectStyle: undefined,
    media: { status: 'ok', name: `${NAME}.mp4`, playback: { kind: 'url', path: `/projects/${P}/media/${VIDEO_ID}` } },
  };
}

const handlers = (chunks = transcript.chunks): MockHandlers => ({
  'projects.open': () => openResult(chunks),
  'projects.list': () => [projectItem(P, NAME)],
  'projects.saveVideoEdits': () => ({ status: 'saved', revision: 4, updatedAt: NOW }),
  'projects.saveProjectStyle': () => ({ status: 'saved', revision: 1, updatedAt: NOW }),
});

async function waitForVideo(page: Page) {
  await expect(page.locator('video')).toBeVisible();
  await page.locator('video').evaluate(async (video: HTMLVideoElement) => {
    if (video.readyState >= 1) return;
    await new Promise<void>(resolve => video.addEventListener('loadedmetadata', () => resolve(), { once: true }));
  });
}

async function openEditor(page: Page, theme: Theme, chunks = transcript.chunks) {
  await prepare(page, theme);
  await mockHost(page, handlers(chunks));
  await page.route('**/projects/*/media/*', serveMedia);
  await page.goto(`/#/projects/${P}/videos/${VIDEO_ID}`);
  await waitForVideo(page);
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
  await page.waitForTimeout(120);
}

const canvasAlpha = (page: Page) => page.getByTestId('subtitle-overlay-canvas').evaluate(canvas => {
  const context = (canvas as HTMLCanvasElement).getContext('2d');
  if (!context) return 0;
  const { width, height } = canvas as HTMLCanvasElement;
  const data = context.getImageData(0, 0, width, height).data;
  let count = 0;
  for (let index = 3; index < data.length; index += 4) if (data[index]) count += 1;
  return count;
});

for (const theme of THEMES) {
  test.describe(`${theme}`, () => {
    test(`F-0028/AC-5 AC-6 AC-9 字体加载后按帧绘制，seeked 补画，字幕外透明 (${theme})`, async ({ page }) => {
      await openEditor(page, theme);
      await expect(page.getByText('正在加载字幕字体…')).toHaveCount(0, { timeout: 20_000 });
      const canvas = page.getByTestId('subtitle-overlay-canvas');
      await expect(canvas).toHaveAttribute('data-subtitle-scene-version', '1');
      await seek(page, 1);
      await expect.poll(() => canvasAlpha(page), { timeout: 15_000 }).toBeGreaterThan(50);
      await shot(page, F, `subtitle-normal-${theme}`);
      // 字幕间隙必须完全透明，不能残留上一帧
      await seek(page, 2.25);
      expect(await canvasAlpha(page)).toBe(0);
      await seek(page, 3);
      await expect.poll(() => canvasAlpha(page), { timeout: 15_000 }).toBeGreaterThan(20);
    });

    test(`F-0028/AC-5 AC-9 空字幕不绘制、不显示加载提示 (${theme})`, async ({ page }) => {
      await openEditor(page, theme, []);
      await expect(page.getByText('正在加载字幕字体…')).toHaveCount(0);
      await seek(page, 1);
      expect(await canvasAlpha(page)).toBe(0);
      await shot(page, F, `subtitle-empty-${theme}`);
    });

    test(`F-0028/AC-8 字体失败显示原因和重试，重试成功后恢复绘制 (${theme})`, async ({ page }) => {
      let fail = true;
      await prepare(page, theme);
      await mockHost(page, handlers());
      await page.route('**/projects/*/media/*', serveMedia);
      await page.route('**/fonts/subtitle/**', async route => {
        if (fail) { await route.abort('failed'); return; }
        const file = basename(new URL(route.request().url()).pathname);
        await route.fulfill({ path: join(process.cwd(), 'public/fonts/subtitle', file) });
      });
      await page.goto(`/#/projects/${P}/videos/${VIDEO_ID}`);
      await waitForVideo(page);
      await expect(page.getByText('字幕渲染不可用')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole('button', { name: '重试' })).toBeVisible();
      await shot(page, F, `subtitle-error-${theme}`);
      fail = false;
      await page.getByRole('button', { name: '重试' }).click();
      await expect(page.getByText('字幕渲染不可用')).toHaveCount(0, { timeout: 20_000 });
      await seek(page, 1);
      await expect.poll(() => canvasAlpha(page), { timeout: 20_000 }).toBeGreaterThan(50);
    });
  });
}

test('F-0028/AC-5 AC-9 英文界面显示英文加载文案', async ({ page }) => {
  await prepare(page, 'light');
  await mockHost(page, handlers());
  await page.route('**/projects/*/media/*', serveMedia);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/fonts/subtitle/**', async route => {
    await gate;
    const file = basename(new URL(route.request().url()).pathname);
    await route.fulfill({ path: join(process.cwd(), 'public/fonts/subtitle', file) });
  });
  await page.goto(`/#/projects/${P}/videos/${VIDEO_ID}`);
  await waitForVideo(page);
  await page.getByRole('button', { name: '选择语言' }).click();
  await page.getByRole('menuitem', { name: /English/ }).click();
  await expect(page.getByText('Loading subtitle fonts…')).toBeVisible();
  await shot(page, F, 'subtitle-loading-en');
  release();
  await expect(page.getByText('Loading subtitle fonts…')).toHaveCount(0, { timeout: 20_000 });
});

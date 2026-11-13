// F-0057 桌面安装包签名与公证：AC-5（不新增产品内签名页面）与 AC-9（复用既有导入/识别/导出状态检查明暗主题与中英文）。
import { expect, test, type Page, type Route } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { shot } from '../lib/evidence';
import { mockHost, prepare, projectItem, uuid, VIDEO_ID, type MockHandlers } from '../lib/mockHost';

const F = 'F-0057';
const THEMES = ['light', 'dark'] as const;
const P = uuid(570);
const NAME = '口播：签名发布基线验收';
const NOW = '2026-11-13T08:00:00.000Z';
const FFMPEG = resolve('src-tauri/binaries/ffmpeg');

let mediaPath = '';
let tempDir = '';

test.beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'flycut-f0057-e2e-'));
  mediaPath = join(tempDir, 'clip.mp4');
  const result = spawnSync(FFMPEG, [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x1e293b:size=640x360:rate=30:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', mediaPath,
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
});

test.afterAll(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

const transcript = {
  text: '大家好 今天检查桌面发布流程',
  language: 'zh',
  duration: 3,
  hasWordTimestamps: false,
  chunks: [
    { id: 's1', text: '大家好，今天检查桌面发布流程', timestamp: [0.3, 1.6] as [number, number] },
    { id: 's2', text: '确保导入识别与导出正常', timestamp: [1.7, 2.8] as [number, number] },
  ],
};

function openResult() {
  return {
    status: 'ok',
    project: { formatVersion: 2, id: P, name: NAME, createdAt: NOW, updatedAt: NOW, revision: 2, styleRevision: 0, videos: [] },
    video: {
      id: VIDEO_ID, name: `${NAME}.mp4`, durationSeconds: 3, createdAt: NOW, updatedAt: NOW, hasTranscript: true, revision: 2,
      styleSource: 'project', media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1, mimeType: 'video/mp4' },
    },
    videos: [{
      id: VIDEO_ID, name: `${NAME}.mp4`, durationSeconds: 3, createdAt: NOW, updatedAt: NOW, hasTranscript: true,
      mediaMissing: false, hasThumbnail: false, styleSource: 'project', revision: 2,
    }],
    transcript,
    edits: undefined,
    projectStyle: undefined,
    media: { status: 'ok', name: `${NAME}.mp4`, playback: { kind: 'url', path: `/projects/${P}/media/${VIDEO_ID}` } },
  };
}

async function serveMedia(route: Route): Promise<void> {
  const body = await readFile(mediaPath);
  const range = route.request().headers()['range'];
  const match = range ? /bytes=(\d+)-(\d*)/.exec(range) : null;
  if (match) {
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : body.length - 1;
    await route.fulfill({
      status: 206,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes ${start}-${end}/${body.length}`,
        'Content-Length': String(end - start + 1),
      },
      body: body.subarray(start, end + 1),
    });
    return;
  }
  await route.fulfill({
    status: 200,
    headers: { 'Accept-Ranges': 'bytes', 'Content-Type': 'video/mp4', 'Content-Length': String(body.length) },
    body,
  });
}

function makeHandlers(initialCreated = false): MockHandlers {
  let created = initialCreated;
  return {
    'host.info': () => ({
      protocolVersion: 2,
      generation: 'e2e',
      methods: ['export.start', 'export.capabilities', 'projects.open', 'projects.create'],
      events: [],
      providers: [],
      capabilities: { projects: true, browserSession: true, cookieMedia: true, resumableUpload: true, export: true },
    }),
    'export.capabilities': () => ({ available: true, ffmpeg: true, skia: true }),
    'projects.list': () => created ? [projectItem(P, NAME)] : [],
    'projects.create': () => {
      created = true;
      return { projectId: P, videoId: VIDEO_ID, revision: 1, project: { videos: [{ id: VIDEO_ID, name: `${NAME}.mp4`, durationSeconds: 3, createdAt: NOW }] } };
    },
    'projects.open': () => openResult(),
    'projects.saveVideoEdits': () => ({ status: 'saved', revision: 3, updatedAt: NOW }),
  };
}

async function waitForVideo(page: Page) {
  await expect(page.locator('video')).toBeVisible();
  await page.locator('video').evaluate(async (video: HTMLVideoElement) => {
    if (video.readyState >= 1) return;
    await new Promise<void>((resolve) => video.addEventListener('loadedmetadata', () => resolve(), { once: true }));
  });
}

for (const theme of THEMES) {
  test.describe(`${theme}`, () => {
    test(`F-0057/AC-5 AC-9 无产品内签名页面，既有导入/识别/导出对话框在中文 ${theme} 下正常`, async ({ page }) => {
      await prepare(page, theme);
      await mockHost(page, makeHandlers(false));
      await page.route('**/projects/*/media/*', serveMedia);
      await page.goto('/#/projects');

      await expect(page.getByRole('button', { name: '选择文件' })).toBeEnabled();
      await expect(page.getByText(/签名配置|公证状态|CI 日志/)).toHaveCount(0);
      await shot(page, F, `home-import-${theme}-zh`);

      const mediaBytes = await readFile(mediaPath);
      await page.getByTestId('project-file-input').setInputFiles({
        name: `${NAME}.mp4`,
        mimeType: 'video/mp4',
        buffer: mediaBytes,
      });

      await expect(page).toHaveURL(new RegExp(`#/projects/${P}/videos/${VIDEO_ID}`), { timeout: 15_000 });
      // 重新打开已转写项目，检查识别字幕与导出流程
      await page.reload();
      await waitForVideo(page);
      await expect(page.getByPlaceholder('请输入主字幕').first()).toHaveValue('大家好，今天检查桌面发布流程', { timeout: 15_000 });
      await shot(page, F, `editor-transcribed-${theme}-zh`);

      await page.getByRole('button', { name: '导出', exact: true }).click();
      await page.getByRole('menuitem', { name: /导出视频/ }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByText('导出视频', { exact: true })).toBeVisible();
      await expect(dialog.getByText('Host 导出就绪')).toBeVisible();
      await expect(dialog.getByRole('button', { name: '开始导出' })).toBeEnabled();
      await shot(page, F, `export-dialog-${theme}-zh`);
    });
  });
}

test('F-0057/AC-5 AC-9 英文界面下既有导入与导出流程可用且无签名页面', async ({ page }) => {
  await prepare(page, 'light');
  await mockHost(page, makeHandlers(true));
  await page.route('**/projects/*/media/*', serveMedia);
  await page.goto(`/#/projects/${P}/videos/${VIDEO_ID}`);
  await waitForVideo(page);

  await page.getByRole('button', { name: '选择语言' }).click();
  await page.getByRole('menuitem', { name: /English/ }).click();
  await expect(page.getByRole('button', { name: /Export/i })).toBeVisible();
  await expect(page.getByText(/Code Signing|Notarization|CI Logs/i)).toHaveCount(0);
  await shot(page, F, 'editor-transcribed-light-en');

  await page.getByRole('button', { name: /My Projects/i }).click();
  await expect(page).toHaveURL(/#\/projects$/);
  await expect(page.getByRole('button', { name: /Select file|Choose file/i })).toBeEnabled();
  await shot(page, F, 'home-import-light-en');
});

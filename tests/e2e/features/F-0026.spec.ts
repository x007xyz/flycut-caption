/* eslint-disable @typescript-eslint/no-explicit-any -- mock Host payloads mirror JSON RPC shapes. */
import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { shot } from '../lib/evidence';
import { mockHost, prepare, projectItem, RpcError, uuid, VIDEO_ID, type MockHandlers, type MockHost } from '../lib/mockHost';

test.describe.configure({ mode: 'serial' });

const F = 'F-0026';
const P = uuid(2601);
const NAME = '口播：平台风格预设';
const NOW = '2026-11-13T12:00:00.000Z';
const FFMPEG = resolve('src-tauri/binaries/ffmpeg');

let mediaPath = '';
let tempDir = '';

test.beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'flycut-f0026-e2e-'));
  mediaPath = join(tempDir, 'clip.mp4');
  const result = spawnSync(FFMPEG, [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x1e2430:size=640x360:rate=30:duration=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    mediaPath,
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
});

test.afterAll(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

const baseChunks = [
  {
    id: 's1',
    text: '大家好，今天聊聊剪辑。',
    secondText: 'Hello, today we talk about editing.',
    timestamp: [0.2, 2.0] as [number, number],
    wordIds: ['w1', 'w2', 'w3'],
    keywords: [{ start: 4, end: 6, text: '今天', source: 'manual' }],
  },
  {
    id: 's2',
    text: '没有字词时间会降级。',
    timestamp: [2.2, 3.6] as [number, number],
  },
];

const baseWords = [
  { id: 'w1', text: '大家好', timestamp: [0.2, 0.8] as [number, number], sentenceId: 's1' },
  { id: 'w2', text: '今天', timestamp: [0.9, 1.4] as [number, number], sentenceId: 's1' },
  { id: 'w3', text: '聊聊剪辑', timestamp: [1.4, 2.0] as [number, number], sentenceId: 's1' },
];

interface HostState {
  projectStyle?: Record<string, unknown>;
  edits?: Record<string, unknown>;
  styleRevision: number;
  videoRevision: number;
  projectRevision: number;
  chunks: typeof baseChunks;
  mediaMissing?: boolean;
}

function makeOpenPayload(state: HostState) {
  return {
    status: 'ok',
    project: {
      formatVersion: 4,
      id: P,
      name: NAME,
      createdAt: NOW,
      updatedAt: NOW,
      revision: state.projectRevision,
      styleRevision: state.styleRevision,
      videos: [],
    },
    video: {
      id: VIDEO_ID,
      name: `${NAME}.mp4`,
      durationSeconds: 4,
      createdAt: NOW,
      updatedAt: NOW,
      hasTranscript: true,
      revision: state.videoRevision,
      styleSource: 'project',
      media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1, mimeType: 'video/mp4' },
    },
    videos: [{
      id: VIDEO_ID,
      name: `${NAME}.mp4`,
      durationSeconds: 4,
      createdAt: NOW,
      updatedAt: NOW,
      hasTranscript: true,
      mediaMissing: Boolean(state.mediaMissing),
      hasThumbnail: false,
      styleSource: 'project',
      revision: state.videoRevision,
    }],
    transcript: {
      text: state.chunks.map(c => c.text).join(''),
      chunks: state.chunks,
      wordChunks: state.chunks.length ? baseWords : undefined,
      hasWordTimestamps: state.chunks.length > 0,
      language: 'zh',
      duration: 4,
    },
    edits: state.edits,
    projectStyle: state.projectStyle,
    media: state.mediaMissing
      ? { status: 'missing', name: `${NAME}.mp4` }
      : { status: 'ok', name: `${NAME}.mp4`, playback: { kind: 'url', path: `/projects/${P}/media/${VIDEO_ID}` } },
  };
}

async function serveMedia(route: import('@playwright/test').Route): Promise<void> {
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

async function openEditor(
  page: Page,
  theme: 'light' | 'dark',
  lang: 'zh' | 'en',
  options: { empty?: boolean; mediaMissing?: boolean; handlers?: MockHandlers } = {},
) {
  await prepare(page, theme);
  const state: HostState = {
    styleRevision: 0,
    videoRevision: 3,
    projectRevision: 3,
    chunks: options.empty ? [] : baseChunks,
    mediaMissing: options.mediaMissing,
  };
  const host: MockHost = await mockHost(page, {
    'projects.list': () => [projectItem(P, NAME, { mediaMissing: Boolean(options.mediaMissing) })],
    'projects.open': () => makeOpenPayload(state),
    'projects.thumbnail': () => ({ dataUrl: null }),
    'projects.saveVideoEdits': (payload: any) => {
      state.videoRevision += 1;
      state.projectRevision += 1;
      state.edits = payload.edits;
      return { status: 'saved', revision: state.videoRevision, projectRevision: state.projectRevision, updatedAt: NOW };
    },
    'projects.saveProjectStyle': (payload: any) => {
      state.styleRevision += 1;
      state.projectRevision += 1;
      state.projectStyle = payload.style;
      return { status: 'saved', revision: state.styleRevision, projectRevision: state.projectRevision, updatedAt: NOW };
    },
    ...options.handlers,
  });
  await page.route('**/projects/*/media/*', serveMedia);
  const listsBefore = host.calls.filter(c => c.method === 'projects.list').length;
  await page.goto('/#/projects');
  await expect.poll(() => host.calls.filter(c => c.method === 'projects.list').length, { timeout: 10_000 }).toBeGreaterThan(listsBefore);
  await page.evaluate(({ projectId, videoId }) => {
    window.location.hash = `/projects/${projectId}/videos/${videoId}`;
  }, { projectId: P, videoId: VIDEO_ID });

  await expect(page.getByTestId('platform-presets-section')).toBeVisible({ timeout: 15_000 });
  if (!options.mediaMissing) {
    await expect(page.locator('video')).toBeVisible({ timeout: 15_000 });
    await page.locator('video').evaluate(async (video: HTMLVideoElement) => {
      if (video.readyState >= 1) return;
      await new Promise<void>(resolve => video.addEventListener('loadedmetadata', () => resolve(), { once: true }));
    });
  }
  if (lang === 'en') {
    await page.getByRole('button', { name: '选择语言' }).click();
    await page.getByRole('menuitem', { name: /English/ }).click();
  }
  return { host, state };
}

for (const theme of ['light', 'dark'] as const) {
  for (const lang of ['zh', 'en'] as const) {
    const isZh = lang === 'zh';

    test.describe(`${F} ${theme}-${lang}`, () => {
      test(`${F}/AC-1 AC-2 AC-3 AC-4 AC-9 预设展示、字体覆盖提醒、安全区辅助线与三画幅微调`, async ({ page }) => {
        await openEditor(page, theme, lang);
        await expect(page.getByText(isZh ? '正在加载字幕字体…' : 'Loading subtitle fonts…')).toHaveCount(0, { timeout: 20_000 });

        const section = page.getByTestId('platform-presets-section');
        for (const id of ['douyin', 'wechat-channels', 'xiaohongshu', 'bilibili', 'youtube-shorts']) {
          await expect(section.getByTestId(`platform-preset-${id}`)).toBeVisible();
          await expect(section.getByTestId(`platform-thumb-${id}`)).toBeVisible();
          await expect(section.getByTestId(`platform-verified-${id}`)).toHaveText(isZh ? '参考，未验证' : 'Reference, unverified');
        }

        // Aspect filter: 1:1 shows empty filter notice; All restores all 5 presets.
        await section.getByTestId('platform-filter-square_1_1').click();
        await expect(section.getByTestId('platform-empty-filter')).toContainText(isZh ? '暂无内容' : 'Nothing here yet');
        await section.getByTestId('platform-filter-all').click();

        // Apply Douyin preset without modifying subtitle text or timestamps.
        await section.getByTestId('platform-preset-douyin').click();
        await expect(page.getByTestId('safe-zone-overlay')).toBeVisible();
        await expect(page.getByTestId('safe-zone-overlay')).toHaveAttribute('data-platform', 'douyin');
        await expect(page.getByTestId('safe-zone-overlay')).toHaveAttribute('data-verified', 'false');
        await expect(page.getByTestId('safe-zone-badge')).toContainText(isZh ? '抖音 · 9:16 · 参考 2026-11-13 · 参考，未验证' : 'Douyin · 9:16 · Ref 2026-11-13 · Reference, unverified');

        // Verify cue text & fallback notice (s2 has no word timestamps -> sentence fallback).
        await expect(page.getByTestId('word-highlight-fallback')).toHaveText(isZh ? '使用整句高亮' : 'Using sentence highlighting');
        await expect(page.locator('[data-chunk-id="s1"] [data-testid="subtitle-main-text"]')).toHaveValue('大家好，今天聊聊剪辑。');

        // Raise bottom safe-zone inset so subtitle enters bottom occlusion zone -> warning & align button fix it.
        await section.getByTestId('safe-zone-inset-bottom').fill('32');
        await expect(section.getByTestId('safe-zone-occlusion-warning')).toBeVisible();
        await expect(page.getByTestId('safe-zone-occlusion-alert')).toBeVisible();
        await seek(page, 1.1);
        await shot(page, F, `preset-safezone-${theme}-${lang}`);

        await section.getByTestId('safe-zone-align-btn').click();
        await expect(section.getByTestId('safe-zone-occlusion-warning')).toHaveCount(0);
        await expect(page.getByTestId('safe-zone-occlusion-alert')).toHaveCount(0);

        // Font coverage warning when switching to Inter on CJK subtitles.
        await page.getByTestId('subtitle-font-select').click();
        await page.getByRole('option', { name: 'Inter' }).click();
        await expect(section.getByTestId('platform-font-coverage-warning')).toBeVisible();
        await page.getByTestId('subtitle-font-select').click();
        await page.getByRole('option', { name: 'Noto Sans SC' }).click();
        await expect(section.getByTestId('platform-font-coverage-warning')).toHaveCount(0);

        // Toggle safe-zone guide off and back on, and test aspect switcher in Position & Size.
        await section.getByTestId('safe-zone-toggle').click();
        await expect(page.getByTestId('safe-zone-overlay')).toHaveCount(0);
        await section.getByTestId('safe-zone-toggle').click();
        await expect(page.getByTestId('safe-zone-overlay')).toBeVisible();
        await section.getByTestId('safe-zone-reset-btn').click();
        await page.getByTestId('aspect-preset-square_1_1').click();
        await expect(page.getByTestId('aspect-preset-square_1_1')).toHaveAttribute('aria-pressed', 'true');
      });

      test(`${F}/AC-5 AC-6 AC-9 空态、缺失视频、加载中与提交处理/取消`, async ({ page, context }) => {
        // 1. Empty subtitles + missing media keep preset controls and editor available without fake Completed state.
        await openEditor(page, theme, lang, { empty: true, mediaMissing: true });
        const section = page.getByTestId('platform-presets-section');
        await expect(section.getByTestId('platform-empty-subtitles')).toContainText(isZh ? '暂无内容' : 'Nothing here yet');
        await expect(section.getByTestId('platform-missing-media')).toBeVisible();
        await expect(section.getByTestId('platform-locate-media')).toBeVisible();
        await expect(section.getByTestId('platform-save-completed')).toHaveCount(0);
        await shot(page, F, `empty-missing-${theme}-${lang}`);

        // 2. Loading state during gated font load, and processing + cancel when saving to Host.
        let releaseFont!: () => void;
        const fontGate = new Promise<void>(resolve => { releaseFont = resolve; });
        let releaseSave!: () => void;
        const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
        const loadingPage = await context.newPage();
        try {
        await prepare(loadingPage, theme);
        const state: HostState = { styleRevision: 0, videoRevision: 3, projectRevision: 3, chunks: baseChunks };
        await mockHost(loadingPage, {
          'projects.list': () => [projectItem(P, NAME)],
          'projects.open': () => makeOpenPayload(state),
          'projects.saveVideoEdits': () => ({ status: 'saved', revision: 4, projectRevision: 4, updatedAt: NOW }),
          'projects.saveProjectStyle': async (payload: any) => {
            await saveGate;
            state.styleRevision += 1;
            state.projectRevision += 1;
            state.projectStyle = payload.style;
            return { status: 'saved', revision: state.styleRevision, projectRevision: state.projectRevision, updatedAt: NOW };
          },
        });
        await loadingPage.route('**/projects/*/media/*', serveMedia);
        await loadingPage.route('**/fonts/subtitle/**', async route => {
          await fontGate;
          const file = basename(new URL(route.request().url()).pathname);
          await route.fulfill({ path: join(process.cwd(), 'public/fonts/subtitle', file) });
        });
        await loadingPage.goto(`/#/projects/${P}/videos/${VIDEO_ID}`);
        await expect(loadingPage.locator('video')).toBeVisible({ timeout: 15_000 });
        await loadingPage.locator('video').evaluate(async (video: HTMLVideoElement) => {
          if (video.readyState >= 1) return;
          await new Promise<void>(resolve => video.addEventListener('loadedmetadata', () => resolve(), { once: true }));
        });
        if (lang === 'en') {
          await loadingPage.getByRole('button', { name: '选择语言' }).click();
          await loadingPage.getByRole('menuitem', { name: /English/ }).click();
        }
        await expect(loadingPage.getByTestId('platform-presets-loading')).toContainText(isZh ? '正在加载…' : 'Loading…');
        await shot(loadingPage, F, `loading-${theme}-${lang}`);
        releaseFont();
        await expect(loadingPage.getByTestId('platform-presets-loading')).toHaveCount(0, { timeout: 20_000 });

        // Select Douyin and test Cancel before debounce sends; then test Processing + Cancel while Host save is in flight.
        await loadingPage.getByTestId('platform-preset-douyin').click();
        await expect(loadingPage.getByTestId('platform-save-cancel')).toBeVisible();
        await loadingPage.getByTestId('platform-save-cancel').click();
        await expect(loadingPage.getByTestId('platform-preset-douyin')).toHaveAttribute('aria-pressed', 'false');

        await loadingPage.getByTestId('platform-preset-bilibili').click();
        await loadingPage.getByTestId('platform-save-btn').click();
        await expect(loadingPage.getByTestId('platform-save-processing')).toContainText(isZh ? '正在处理…' : 'Processing…');
        await expect(loadingPage.getByTestId('platform-save-btn')).toBeDisabled();
        await loadingPage.getByTestId('platform-save-cancel').click();
        await expect(loadingPage.getByTestId('platform-cancel-note')).toBeVisible();
        await expect(loadingPage.getByTestId('platform-save-completed')).toHaveCount(0);
        releaseSave();
        } finally {
          await loadingPage.close();
        }
      });

      test(`${F}/AC-7 AC-8 AC-9 Host 持久化重开一致、失败查询重试、冲突重新检查`, async ({ page }) => {
        let saveMode: 'ok' | 'lost-receipt' | 'fail' | 'conflict' = 'ok';
        const { host, state } = await openEditor(page, theme, lang, {
          handlers: {
            'projects.saveProjectStyle': (payload: any) => {
              if (saveMode === 'fail') throw new RpcError('Host disk read-only');
              if (saveMode === 'conflict') return { status: 'conflict', revision: state.styleRevision + 1, updatedAt: NOW };
              state.styleRevision += 1;
              state.projectRevision += 1;
              state.projectStyle = payload.style;
              if (saveMode === 'lost-receipt') {
                saveMode = 'ok';
                throw new RpcError('Simulated network drop after commit');
              }
              return { status: 'saved', revision: state.styleRevision, projectRevision: state.projectRevision, updatedAt: NOW };
            },
          },
        });

        const section = page.getByTestId('platform-presets-section');

        // 1. Save Douyin preset -> Completed -> Reload page restores identical preset & safe-zone state.
        await section.getByTestId('platform-preset-douyin').click();
        await section.getByTestId('platform-save-btn').click();
        await expect(section.getByTestId('platform-save-completed')).toContainText(isZh ? '已完成' : 'Completed');
        await shot(page, F, `completed-${theme}-${lang}`);

        await page.reload();
        if (lang === 'en') {
          await page.getByRole('button', { name: '选择语言' }).click();
          await page.getByRole('menuitem', { name: /English/ }).click();
        }
        await expect(page.getByTestId('platform-preset-douyin')).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
        await expect(page.getByTestId('safe-zone-overlay')).toHaveAttribute('data-platform', 'douyin');

        // 2. Hard failure -> shows reason, Retry, Back, preserves user's Xiaohongshu selection.
        saveMode = 'fail';
        await page.getByTestId('platform-preset-xiaohongshu').click();
        await page.getByTestId('platform-save-btn').click();
        await expect(page.getByTestId('platform-save-failed')).toContainText('Host disk read-only');
        await expect(page.getByTestId('platform-preset-xiaohongshu')).toHaveAttribute('aria-pressed', 'true');
        await shot(page, F, `failed-${theme}-${lang}`);

        // Clicking Back keeps user selection; next lost-receipt retry verifies Host state first via projects.open.
        await page.getByTestId('platform-save-back').click();
        await expect(page.getByTestId('platform-save-failed')).toHaveCount(0);
        saveMode = 'lost-receipt';
        await page.getByTestId('platform-save-btn').click();
        await expect(page.getByTestId('platform-save-failed')).toBeVisible();
        const styleWritesBeforeRetry = host.calls.filter(c => c.method === 'projects.saveProjectStyle').length;
        const opensBeforeRetry = host.calls.filter(c => c.method === 'projects.open').length;
        await page.getByTestId('platform-save-retry').click();
        await expect(page.getByTestId('platform-save-completed')).toContainText(isZh ? '已完成' : 'Completed');
        expect(host.calls.filter(c => c.method === 'projects.open').length).toBeGreaterThan(opensBeforeRetry);
        expect(host.calls.filter(c => c.method === 'projects.saveProjectStyle').length).toBe(styleWritesBeforeRetry);

        // 3. Version conflict -> Content changed. Review again. -> must Re-check before submitting.
        saveMode = 'conflict';
        await page.getByTestId('platform-preset-bilibili').click();
        await page.getByTestId('platform-save-btn').click();
        await expect(page.getByTestId('platform-save-conflict')).toContainText(isZh ? '内容已更新，请重新检查' : 'Content changed. Review again.');
        await expect(page.getByTestId('platform-save-btn')).toBeDisabled();
        await shot(page, F, `conflict-${theme}-${lang}`);

        saveMode = 'ok';
        await page.getByTestId('platform-conflict-recheck').click();
        await expect(page.getByTestId('platform-rechecked-note')).toBeVisible();
        await expect(page.getByTestId('platform-preset-bilibili')).toHaveAttribute('aria-pressed', 'true');
        await expect(page.getByTestId('platform-save-btn')).toBeEnabled();
        await page.getByTestId('platform-save-btn').click();
        await expect(page.getByTestId('platform-save-completed')).toContainText(isZh ? '已完成' : 'Completed');
      });
    });
  }
}

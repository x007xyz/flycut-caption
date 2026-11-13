// F-0018 默认模型推荐与下载引导：界面与生命周期验收（AC-1 到 AC-9）。
// Host 真实下载进度、SHA-256 校验、磁盘检查与真实 funasr-asr 识别闭环由 tests/architecture/default-asr-model.test.ts 覆盖。
import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { shot } from '../lib/evidence';
import { MOCK_HOST, mockHost, pending, prepare, uuid, VIDEO_ID, type MockHandlers } from '../lib/mockHost';

const F = 'F-0018';
const P = uuid(180);
const JOB_DL = uuid(918);
const T = '2026-11-13T12:00:00.000Z';
const SENSEVOICE_ID = 'sensevoice-small-int8-zh-en-ja-ko-yue-2024-07-17';
const PARAFORMER_ID = 'paraformer-zh-int8-2023-09-14';

const THEMES = ['light', 'dark'] as const;
const LANGS = [false, true] as const;

let mediaDir: string;
let mediaFile: string;

test.beforeAll(() => {
  mediaDir = mkdtempSync(join(tmpdir(), 'flycut-f0018-e2e-'));
  mediaFile = join(mediaDir, 'sample.mp4');
  const run = spawnSync(
    resolve('src-tauri/binaries/ffmpeg'),
    ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=2', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '2', '-c:v', 'libx264', '-c:a', 'aac', mediaFile],
    { encoding: 'utf8' },
  );
  if (run.status !== 0) throw new Error(run.stderr);
});

test.afterAll(() => rmSync(mediaDir, { recursive: true, force: true }));

function makeModels(options: {
  svStatus?: 'download' | 'ready' | 'unavailable';
  svReason?: string;
  paraformerStatus?: 'download' | 'ready' | 'unavailable';
  includeCloud?: boolean;
} = {}) {
  const {
    svStatus = 'download',
    svReason,
    paraformerStatus = 'download',
    includeCloud = false,
  } = options;
  const groups: Array<Record<string, unknown>> = [
    {
      provider: { id: 'sherpa-onnx', name: 'sherpa-onnx（本地）', kind: 'builtin' },
      models: [
        {
          id: SENSEVOICE_ID,
          name: 'SenseVoice Small INT8',
          role: 'asr',
          description: '通用推荐模型，支持中文、英文、日文、韩文、粤语。',
          languages: ['auto', 'zh', 'en', 'ja', 'ko', 'yue'],
          timestampLevel: 'segment',
          size: '230 MB',
          status: svStatus,
          ...(svReason ? { reason: svReason } : {}),
          recommended: true,
          offline: true,
          recommendation: {
            benchmarkId: 'F-0001',
            cer: '6.29%',
            fillerRecall: '98.65%',
            sampleCount: 2,
            sentenceCount: 1028,
            comparedWith: [PARAFORMER_ID],
          },
        },
        {
          id: PARAFORMER_ID,
          name: 'Paraformer 中文 INT8 2023-09-14',
          role: 'asr',
          description: '中文字幕优先模型。',
          languages: ['zh', 'en'],
          timestampLevel: 'segment',
          size: '234.1 MB',
          status: paraformerStatus,
          recommended: false,
          offline: true,
        },
      ],
    },
  ];
  if (includeCloud) {
    groups.push({
      provider: { id: 'flycut-cloud', name: 'FlyCut Cloud', kind: 'builtin' },
      models: [
        {
          id: 'cloud-asr-pro',
          name: 'FlyCut Cloud ASR',
          role: 'asr',
          languages: ['auto', 'zh', 'en'],
          timestampLevel: 'word',
          status: 'ready',
          recommended: false,
          offline: false,
        },
      ],
    });
  }
  return groups;
}

function openUntranscribedProject() {
  return {
    status: 'ok',
    project: { id: P, name: '口播测试', formatVersion: 4, revision: 1, styleRevision: 0, videos: [], createdAt: T, updatedAt: T },
    video: {
      id: VIDEO_ID, name: 'talking.mp4', durationSeconds: 2, revision: 1, styleSource: 'project',
      hasTranscript: false, createdAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1, mimeType: 'video/mp4' },
    },
    videos: [{
      id: VIDEO_ID, name: 'talking.mp4', durationSeconds: 2, createdAt: T, updatedAt: T,
      hasTranscript: false, mediaMissing: false, hasThumbnail: false, styleSource: 'project', revision: 1,
    }],
    media: { status: 'ok', name: 'talking.mp4', playback: { kind: 'url', path: `/projects/${P}/media/${VIDEO_ID}` } },
  };
}

function openTranscribedProject() {
  return {
    ...openUntranscribedProject(),
    video: { ...openUntranscribedProject().video, hasTranscript: true },
    transcript: {
      text: '已有字幕可以继续编辑',
      language: 'zh',
      duration: 2,
      hasWordTimestamps: false,
      chunks: [{ id: 'c1', text: '已有字幕可以继续编辑', timestamp: [0, 2] as [number, number] }],
    },
  };
}

async function routeProjectMedia(page: Page) {
  await page.route(`${MOCK_HOST}/projects/**/media/**`, route => {
    const bytes = readFileSync(mediaFile);
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    return route.fulfill({
      status: range ? 206 : 200,
      contentType: 'video/mp4',
      body: bytes.subarray(start, end + 1),
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}),
      },
    });
  });
}

async function setupPage(page: Page, theme: 'light' | 'dark', handlers: MockHandlers = {}, extraStorage: Record<string, string> = {}) {
  await prepare(page, theme, extraStorage);
  const host = await mockHost(page, handlers);
  await routeProjectMedia(page);
  return host;
}

for (const theme of THEMES) {
  for (const english of LANGS) {
    const lang = english ? 'en' : 'zh';
    const qs = `?ui=${lang}`;

    test.describe(`F-0018 ${theme}-${lang}`, () => {
      test(`F-0018/AC-1 AC-5 AC-6 loading, empty state, and recommended card metadata (${theme}-${lang})`, async ({ page }) => {
        test.setTimeout(60_000);
        // 1. Loading state
        await setupPage(page, theme, { 'providers.models': pending });
        await page.goto(`/${qs}#/projects`);
        await page.getByRole('button', { name: english ? 'Settings' : '设置' }).click();
        await expect(page.getByTestId('recommended-model-loading')).toContainText(english ? 'Loading…' : '正在加载…');
        await shot(page, F, `models-loading-${theme}-${lang}`);

        // 2. Empty state ("Nothing here yet / 暂无内容")
        await page.goto('about:blank');
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await setupPage(page, theme, { 'providers.models': () => [] });
        await page.goto(`/${qs}#/projects`);
        await page.getByRole('button', { name: english ? 'Settings' : '设置' }).click();
        await expect(page.getByTestId('models-empty')).toHaveText(english ? 'Nothing here yet' : '暂无内容');
        await expect(page.getByTestId('recommended-model-missing')).toBeVisible();
        await shot(page, F, `models-empty-${theme}-${lang}`);

        // 3. Recommended model metadata (F-0001 scope, size, offline, segment timestamp)
        await page.goto('about:blank');
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await setupPage(page, theme, { 'providers.models': () => makeModels({ svStatus: 'download' }) });
        await page.goto(`/${qs}#/projects`);
        await page.getByRole('button', { name: english ? 'Settings' : '设置' }).click();
        const card = page.getByTestId('recommended-model-card');
        await expect(card).toContainText('SenseVoice Small INT8');
        await expect(card).toContainText('sherpa-onnx');
        await expect(card).toContainText('230 MB');
        await expect(card).toContainText(english ? 'Offline' : '离线可用');
        await expect(card).toContainText(english ? 'Segment-level' : '句段级');
        await expect(card).toContainText('F-0001');
        await expect(card).toContainText('6.29%');
        await expect(card.getByRole('button', { name: english ? 'Download recommended model' : '下载推荐模型' })).toBeVisible();
        await shot(page, F, `models-recommended-${theme}-${lang}`);
      });

      test(`F-0018/AC-2 AC-5 AC-6 AC-7 editor guide, byte progress, cancel, verification guard, completion & second client (${theme}-${lang})`, async ({ page, browser }) => {
        test.setTimeout(60_000);
        let svStatus: 'download' | 'ready' = 'download';
        let jobPhase: 'downloading' | 'verifying' | 'complete' | 'cancelled' = 'downloading';
        let pollCount = 0;

        const host = await setupPage(page, theme, {
          'projects.open': openUntranscribedProject,
          'providers.models': () => makeModels({ svStatus }),
          'providers.prepare': () => {
            pollCount = 0;
            jobPhase = 'downloading';
            return { id: JOB_DL, status: 'running', createdAt: T, updatedAt: T };
          },
          'jobs.cancel': () => {
            jobPhase = 'cancelled';
            return { id: JOB_DL, status: 'cancelled', createdAt: T, updatedAt: T };
          },
          'jobs.get': () => {
            pollCount += 1;
            if (jobPhase === 'cancelled') {
              return { id: JOB_DL, status: 'cancelled', createdAt: T, updatedAt: T };
            }
            if (pollCount === 1) {
              return {
                id: JOB_DL,
                status: 'running',
                progress: {
                  status: 'progress',
                  purpose: 'download',
                  phase: 'downloading',
                  progress: 50,
                  downloadedBytes: 115_000_000,
                  totalBytes: 230_000_000,
                  data: 'model.int8.onnx',
                },
                createdAt: T,
                updatedAt: T,
              };
            }
            if (pollCount === 2) {
              jobPhase = 'verifying';
              return {
                id: JOB_DL,
                status: 'running',
                progress: {
                  status: 'progress',
                  purpose: 'download',
                  phase: 'verifying',
                  progress: 98,
                  downloadedBytes: 230_000_000,
                  totalBytes: 230_000_000,
                  data: 'verifying',
                },
                createdAt: T,
                updatedAt: T,
              };
            }
            svStatus = 'ready';
            jobPhase = 'complete';
            return { id: JOB_DL, status: 'complete', result: { providerId: 'sherpa-onnx', modelId: SENSEVOICE_ID }, createdAt: T, updatedAt: T };
          },
        });

        await page.goto(`/${qs}#/projects/${P}/videos/${VIDEO_ID}`);
        const guide = page.getByTestId('subtitle-model-guide');
        await expect(guide).toBeVisible();
        const startBtn = guide.getByRole('button', { name: english ? 'Start ASR' : '开始识别' });
        await expect(startBtn).toBeDisabled();
        expect(host.calls.some(c => c.method === 'workflow.start')).toBe(false);
        await shot(page, F, `editor-guide-${theme}-${lang}`);

        // Start download -> observe byte progress & cancel
        await guide.getByRole('button', { name: english ? 'Download recommended model' : '下载推荐模型' }).click();
        await expect(page.getByTestId('recommended-download-progress')).toContainText(english ? 'Processing…' : '正在处理…');
        await expect(page.getByTestId('recommended-download-progress')).toContainText('115.0 MB / 230.0 MB');
        await shot(page, F, `editor-downloading-${theme}-${lang}`);

        // Cancel stops download and keeps Start ASR disabled
        await guide.getByRole('button', { name: english ? 'Cancel' : '取消' }).click();
        await expect(guide.getByRole('button', { name: english ? 'Download recommended model' : '下载推荐模型' })).toBeVisible();
        await expect(startBtn).toBeDisabled();

        // Download again to completion & Host verification
        await guide.getByRole('button', { name: english ? 'Download recommended model' : '下载推荐模型' }).click();
        await expect(page.getByTestId('recommended-model-completed')).toHaveText(english ? 'Completed' : '已完成', { timeout: 15_000 });
        await expect(startBtn).toBeEnabled();
        await shot(page, F, `editor-completed-${theme}-${lang}`);

        // Second client connected to the same Host reads consistent ready state
        const secondContext = await browser.newContext();
        const secondPage = await secondContext.newPage();
        try {
          await setupPage(secondPage, theme, { 'providers.models': () => makeModels({ svStatus: 'ready' }) });
          await secondPage.goto(`/${qs}#/projects`);
          await secondPage.getByRole('button', { name: english ? 'Settings' : '设置' }).click();
          const secondCard = secondPage.getByTestId('recommended-model-card');
          await expect(secondCard).toHaveAttribute('data-model-status', 'ready');
          await expect(secondCard).toContainText(english ? 'In use' : '使用中');
        } finally {
          await secondContext.close();
        }
      });

      test(`F-0018/AC-3 AC-5 AC-8 error retry/back, preserve user model, never switch to cloud, stale conflict, existing editing (${theme}-${lang})`, async ({ page }) => {
        test.setTimeout(60_000);
        const persistedSelection = JSON.stringify({
          state: {
            language: 'zh',
            deviceType: 'wasm',
            asrModel: { providerId: 'sherpa-onnx', modelId: PARAFORMER_ID },
            asrOptions: {},
          },
          version: 2,
        });

        let staleChanged = false;
        let currentSvStatus: 'download' | 'unavailable' = 'download';
        await setupPage(
          page,
          theme,
          {
            'projects.open': openTranscribedProject,
            'providers.models': () => makeModels({ svStatus: currentSvStatus, paraformerStatus: 'ready', includeCloud: true }),
            'providers.prepare': () => ({ id: JOB_DL, status: 'running', createdAt: T, updatedAt: T }),
            'jobs.get': () => ({ id: JOB_DL, status: 'error', error: '磁盘空间不足：需要约 264.5 MB，当前可用 50.0 MB', createdAt: T, updatedAt: T }),
          },
          { 'app-settings': persistedSelection },
        );

        await page.goto(`/${qs}#/projects`);
        await page.getByRole('button', { name: english ? 'Settings' : '设置' }).click();
        const card = page.getByTestId('recommended-model-card');
        await card.getByRole('button', { name: english ? 'Download recommended model' : '下载推荐模型' }).click();

        const errorBox = page.getByTestId('recommended-download-error');
        await expect(errorBox).toContainText('264.5 MB');
        await expect(card.getByRole('button', { name: english ? 'Retry' : '重试' })).toBeVisible();
        await expect(card.getByRole('button', { name: english ? 'Back' : '返回' })).toBeVisible();
        // Existing ready selection preserved and never switched to paid FlyCut Cloud
        await expect(card).toContainText(english ? 'Choose existing model' : '改选已有模型');
        await expect(page.locator('li', { hasText: 'FlyCut Cloud ASR' })).not.toContainText(english ? 'In use' : '使用中');
        await expect(page.locator('li', { hasText: 'Paraformer' })).toContainText(english ? 'In use' : '使用中');
        await shot(page, F, `models-error-${theme}-${lang}`);

        // Click Back -> clears error and preserves Paraformer selection
        await card.getByRole('button', { name: english ? 'Back' : '返回' }).click();
        await expect(errorBox).toHaveCount(0);
        const storedAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('app-settings') ?? '{}'));
        expect(storedAfter.state?.asrModel?.modelId).toBe(PARAFORMER_ID);

        // Stale conflict: model transitions to unavailable on Host after initial load
        await page.route(`${MOCK_HOST}/rpc`, async route => {
          const req = route.request();
          const body = req.postDataJSON() as { method: string };
          if (!staleChanged && body.method === 'providers.models') {
            staleChanged = true;
            currentSvStatus = 'unavailable';
          }
          await route.fallback();
        });
        await card.getByRole('button', { name: english ? 'Download recommended model' : '下载推荐模型' }).click();
        await expect(page.getByTestId('recommended-download-error')).toContainText(
          english ? 'Content changed. Review again.' : '内容已更新，请重新检查',
        );
        await shot(page, F, `models-stale-${theme}-${lang}`);

        // AC-5: existing transcribed project remains editable even with no models available
        await page.goto('about:blank');
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await setupPage(page, theme, {
          'projects.open': openTranscribedProject,
          'providers.models': () => [],
        });
        await page.goto(`/${qs}#/projects/${P}/videos/${VIDEO_ID}`);
        await expect(page.getByPlaceholder(english ? 'Enter main subtitle' : '请输入主字幕').first()).toHaveValue('已有字幕可以继续编辑');
      });
    });
  }
}

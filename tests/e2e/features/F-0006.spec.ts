import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { mockHost, prepare, uuid, VIDEO_ID, MOCK_HOST, RpcError, type MockHandlers } from '../lib/mockHost';
import { shot } from '../lib/evidence';

const P = uuid(106); const F = 'F-0006'; const T = '2026-11-09T12:00:00Z'; const JOB = uuid(906);
const transcript = { text: '第一句 第二句', language: 'zh', duration: 10, hasWordTimestamps: true,
  chunks: [
    { id: 'a', text: '第一句', timestamp: [0, 3], wordIds: ['w1'] },
    { id: 'b', text: '第二句', timestamp: [6, 9], wordIds: ['w2'] },
  ],
  wordChunks: [{ id: 'w1', text: '第一句', timestamp: [0, 3], sentenceId: 'a' },
    { id: 'w2', text: '第二句', timestamp: [6, 9], sentenceId: 'b' }] };
const result = { vadType: 'fsmn', durationSeconds: 10, hasReliableWordTimestamps: true, warnings: [],
  candidates: [{ id: 'silence-3000000-5750000', start: 3.15, end: 5.85, reason: 'silence.vad-pause', category: 'pause', confidence: 0.9, defaultSelected: true }] };

let mediaDir: string; let media: string;
test.beforeAll(() => {
  mediaDir = mkdtempSync(join(tmpdir(), 'flycut-f0006-ui-')); media = join(mediaDir, 'marker.mp4');
  const run = spawnSync(resolve('src-tauri/binaries/ffmpeg'), ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=10',
    '-c:v', 'libx264', '-preset', 'ultrafast', media], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr);
});
test.afterAll(() => rmSync(mediaDir, { recursive: true, force: true }));

async function connect(page: Page, handlers: Partial<MockHandlers> = {}) {
  let edits: Record<string, unknown> | undefined; let revision = 1;
  const base: MockHandlers = {
    'projects.open': () => ({ status: 'ok',
      project: { id: P, name: 'Silence', formatVersion: 3, revision, styleRevision: 0, videos: [], createdAt: T, updatedAt: T },
      video: { id: VIDEO_ID, name: 'Silence.mp4', durationSeconds: 10, revision, styleSource: 'project', hasTranscript: true,
        createdAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1, mimeType: 'video/mp4' } },
      videos: [], transcript, edits, media: { status: 'ok', name: 'Silence.mp4', playback: { kind: 'url', path: `/projects/${P}/media/${VIDEO_ID}` } } }),
    'projects.saveVideoEdits': payload => { edits = payload.edits; revision++; return { status: 'saved', revision, projectRevision: revision, updatedAt: T }; },
    'projects.saveProjectStyle': () => ({ status: 'saved', revision: 1, projectRevision: revision, updatedAt: T }),
    'providers.models': () => [{ provider: { id: 'sherpa-onnx', name: 'sherpa-onnx', kind: 'builtin' },
      models: [{ id: 'fsmn-vad', name: 'FSMN-VAD', role: 'vad', status: 'ready' }] }],
    'silence.analyze': () => ({ id: JOB, status: 'queued', createdAt: T, updatedAt: T }),
    'jobs.get': () => ({ id: JOB, status: 'complete', result, createdAt: T, updatedAt: T }),
  };
  const host = await mockHost(page, { ...base, ...handlers });
  await page.route(`${MOCK_HOST}/projects/**/media/**`, route => {
    const bytes = readFileSync(media); const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
    const start = range ? Number(range[1]) : 0; const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    return route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4', body: bytes.subarray(start, end + 1),
      headers: { 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1),
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) } });
  });
  return { host, saved: () => edits };
}

test('F-0006/AC-7 save failure keeps the pending candidates and the formal edit', async ({ page }) => {
  await prepare(page, 'light', { 'flycut-locale': 'zh' });
  await connect(page, { 'projects.saveVideoEdits': () => { throw new RpcError('save failed'); } });
  await page.goto(`/#/projects/${P}/videos/${VIDEO_ID}`);
  await page.getByRole('button', { name: /去静音|Remove silence/ }).click();
  await page.getByTestId('silence-analyze').click();
  await expect(page.getByTestId('cut-suggestions')).toBeVisible();
  await page.getByRole('button', { name: /确认剪辑|Confirm cuts/ }).click();
  await expect(page.getByTestId('cut-suggestions')).toBeVisible();
  await expect(page.getByText(/应用失败|Cannot apply/)).toBeVisible();
});

test('F-0006/AC-3 cancel leaves no candidates or formal edit', async ({ page }) => {
  await prepare(page, 'light', { 'flycut-locale': 'zh' });
  await connect(page, {
    'silence.analyze': () => ({ id: JOB, status: 'queued', createdAt: T, updatedAt: T }),
    'jobs.get': () => ({ id: JOB, status: 'running', createdAt: T, updatedAt: T }),
    'jobs.cancel': () => ({ id: JOB, status: 'cancelled', createdAt: T, updatedAt: T }),
  });
  await page.goto(`/#/projects/${P}/videos/${VIDEO_ID}`);
  await page.getByRole('button', { name: /去静音|Remove silence/ }).click();
  await page.getByTestId('silence-analyze').click();
  await expect(page.getByTestId('silence-panel').getByRole('button', { name: /取消|Cancel/ }).first()).toBeVisible();
  await page.getByTestId('silence-panel').getByRole('button', { name: /取消|Cancel/ }).first().click();
  await expect(page.getByTestId('cut-suggestions')).toHaveCount(0);
});

test('F-0006/AC-7 stale analysis never applies', async ({ page }) => {
  await prepare(page, 'light', { 'flycut-locale': 'zh' });
  await connect(page);
  await page.goto(`/#/projects/${P}/videos/${VIDEO_ID}`);
  await page.getByRole('button', { name: /去静音|Remove silence/ }).click();
  await page.getByTestId('silence-analyze').click();
  await expect(page.getByTestId('cut-suggestions')).toBeVisible();
  await page.getByTestId('pending-suggestion-item').first().getByRole('checkbox').check();
  const first = page.getByTestId('subtitle-main-text').first();
  await first.fill('编辑后的字幕'); await first.blur();
  await page.getByRole('button', { name: /确认剪辑|Confirm cuts/ }).click();
  await expect(page.getByText(/建议已过期|Suggestions are outdated/).first()).toBeVisible();
  await expect(page.getByTestId('cut-suggestions')).toBeVisible();
});

async function setEnglish(page: Page) {
  await page.getByRole('button', { name: '选择语言' }).click();
  await page.getByRole('menuitem', { name: /English/ }).click();
}

for (const theme of ['light', 'dark'] as const) for (const english of [false, true]) {
  const lang = english ? 'en' : 'zh';
  test.describe(`${theme}-${lang}`, () => {
    test('F-0006/AC-1 AC-2 AC-3 AC-4 AC-5 AC-7 silence analysis, preview and apply', async ({ page }) => {
      test.setTimeout(90_000);
      await prepare(page, theme, { 'flycut-locale': lang });
      const { host, saved } = await connect(page);
      await page.goto(`/?lang=${lang}#/projects/${P}/videos/${VIDEO_ID}`);
      if (english) await setEnglish(page);
      await page.getByRole('button', { name: /去静音|Remove silence/ }).click();
      await expect(page.getByTestId('silence-panel').locator('select').first()).toHaveValue('fsmn-vad');
      await page.getByTestId('silence-analyze').click();
      await expect(page.getByTestId('cut-suggestions')).toBeVisible();
      await expect(page.getByTestId('pending-suggestion-item')).toHaveCount(1);
      await shot(page, F, `silence-${theme}-${lang}`);
      await page.getByRole('button', { name: /预览剪辑效果|Preview proposed cuts/ }).click();
      await expect(page.getByText(/预览，尚未应用|Preview, not applied/).first()).toBeVisible();
      await page.getByRole('button', { name: /确认剪辑|Confirm cuts/ }).click();
      await expect(page.getByTestId('cut-suggestions')).toHaveCount(0);
      await expect.poll(() => (saved()?.editing as { edl?: { deleted?: unknown[] } } | undefined)?.edl?.deleted?.length).toBeGreaterThan(0);
      expect(host.calls.some(call => call.method === 'silence.analyze')).toBe(true);
    });

    test('F-0006/AC-1 no VAD model shows the setting state', async ({ page }) => {
      await prepare(page, theme, { 'flycut-locale': lang });
      await connect(page, { 'providers.models': () => [] });
      await page.goto(`/?lang=${lang}#/projects/${P}/videos/${VIDEO_ID}`);
      if (english) await setEnglish(page);
      await page.getByRole('button', { name: /去静音|Remove silence/ }).click();
      await expect(page.getByText(/没有可用的人声检测模型|No voice detection model available/)).toBeVisible();
      await expect(page.getByTestId('silence-analyze')).toBeDisabled();
      await shot(page, F, `no-model-${theme}-${lang}`);
    });
  });
}

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { mockHost, prepare, uuid, VIDEO_ID, MOCK_HOST, type MockHandlers } from '../lib/mockHost';
import { shot } from '../lib/evidence';

const P = uuid(113); const F = 'F-0013'; const T = '2026-11-09T12:00:00Z';
const transcript = { text: '我觉得这个很好 但是那个东西', language: 'zh', duration: 8, hasWordTimestamps: false,
  chunks: [
    { id: 'a', text: '我觉得这个很好', timestamp: [0, 3], secondText: '译文A' },
    { id: 'b', text: '但是那个东西', timestamp: [4, 7], secondText: '译文B' },
  ] };
const aiSettings = JSON.stringify({ state: { aiModels: [{ id: 'mock-ai', name: 'Mock AI', baseUrl: 'http://ai.test/v1',
  apiKey: 'test-key', model: 'mock-model' }], selectedAIModelId: 'mock-ai' }, version: 1 });

let mediaDir: string; let media: string;
test.beforeAll(() => {
  mediaDir = mkdtempSync(join(tmpdir(), 'flycut-f0013-ui-')); media = join(mediaDir, 'marker.mp4');
  const run = spawnSync(resolve('src-tauri/binaries/ffmpeg'), ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=60',
    '-c:v', 'libx264', '-preset', 'ultrafast', media], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr);
});
test.afterAll(() => rmSync(mediaDir, { recursive: true, force: true }));

interface ConnectOptions {
  data?: unknown;
  edits?: Record<string, unknown> | undefined;
  /** `undefined` leaves the job running; the test can complete it later. */
  resultFor?: (payload: { items: Array<{ id: string; text: string }> }, index: number) => unknown;
  handlers?: Partial<MockHandlers>;
}

async function connect(page: Page, options: ConnectOptions = {}) {
  let edits = options.edits; let revision = 1; let jobSeq = 0;
  const jobs = new Map<string, { result?: unknown }>();
  const data = options.data ?? transcript;
  const resultFor = options.resultFor ?? ((payload: { items: Array<{ id: string; text: string }> }) =>
    payload.items.map(item => ({ id: item.id, text: `${item.text}。` })));
  const handlers: MockHandlers = {
    'projects.open': () => ({ status: 'ok',
      project: { id: P, name: 'Correction', formatVersion: 3, revision, styleRevision: 0, videos: [], createdAt: T, updatedAt: T },
      video: { id: VIDEO_ID, name: 'Correction.mp4', durationSeconds: 60, revision, styleSource: 'project', hasTranscript: true,
        createdAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1, mimeType: 'video/mp4' } },
      videos: [], transcript: data, edits, media: { status: 'ok', name: 'Correction.mp4', playback: { kind: 'url', path: `/projects/${P}/media/${VIDEO_ID}` } } }),
    'projects.saveVideoEdits': payload => { edits = payload.edits; revision++; return { status: 'saved', revision, projectRevision: revision, updatedAt: T }; },
    'projects.saveProjectStyle': () => ({ status: 'saved', revision: 1, projectRevision: revision, updatedAt: T }),
    'text.start': payload => {
      const id = uuid(950 + jobSeq); const index = jobSeq++; jobs.set(id, { result: resultFor(payload, index) });
      return { id, status: 'queued', createdAt: T, updatedAt: T };
    },
    'jobs.get': payload => {
      const job = jobs.get(payload.id);
      return job?.result === undefined ? { id: payload.id, status: 'running', createdAt: T, updatedAt: T }
        : { id: payload.id, status: 'complete', result: job.result, createdAt: T, updatedAt: T };
    },
    'jobs.cancel': payload => ({ id: payload.id, status: 'cancelled', createdAt: T, updatedAt: T }),
    ...options.handlers,
  };
  const host = await mockHost(page, handlers);
  await page.route(`${MOCK_HOST}/projects/**/media/**`, route => {
    const bytes = readFileSync(media); const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
    const start = range ? Number(range[1]) : 0; const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    return route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4', body: bytes.subarray(start, end + 1),
      headers: { 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1),
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) } });
  });
  return { host, jobs, saved: () => edits };
}

async function setEnglish(page: Page) {
  await page.getByRole('button', { name: '选择语言' }).click();
  await page.getByRole('menuitem', { name: /English/ }).click();
}

const openEditor = async (page: Page, theme: 'light' | 'dark', lang: string, withModel = true) => {
  await prepare(page, theme, { 'flycut-locale': lang, ...(withModel ? { 'app-settings': aiSettings } : {}) });
  await page.goto(`/?lang=${lang}#/projects/${P}/videos/${VIDEO_ID}`);
  if (lang === 'en') await setEnglish(page);
};

for (const theme of ['light', 'dark'] as const) for (const english of [false, true]) {
  const lang = english ? 'en' : 'zh';
  test.describe(`${theme}-${lang}`, () => {
    test('F-0013/AC-2 AC-3 AC-5 AC-6 AC-7 AC-9 review, edit, keep original, unified apply, undo/redo and history restore', async ({ page }) => {
      test.setTimeout(90_000);
      const { host, saved } = await connect(page);
      await openEditor(page, theme, lang);
      const boxes = page.getByTestId('subtitle-main-text');
      await expect(boxes.first()).toHaveValue('我觉得这个很好');

      await page.getByTestId('correction-open').click();
      const panel = page.getByTestId('correction-review');
      await expect(panel).toBeVisible();
      await expect(panel).toContainText(/将发送 2 条字幕|Sending 2 subtitles/);
      await shot(page, F, `correction-ready-${theme}-${lang}`);

      await page.getByTestId('correction-start').click();
      await expect(panel.getByTestId('correction-preview-toggle')).toBeVisible();
      await expect(boxes.first()).toHaveValue('我觉得这个很好。');
      await expect(boxes.nth(1)).toHaveValue('但是那个东西。');
      await expect(panel).toContainText(/预览，尚未应用|Preview, not applied/);
      await expect(page.getByTestId('correction-row-badge').first()).toBeVisible();

      await boxes.first().fill('我觉得这个特别好');
      await expect(panel.getByTestId('correction-suggestion-item').first()).toContainText(/已手动调整|Manually adjusted/);
      await expect(panel.getByTestId('correction-apply')).toContainText(/2/);
      await shot(page, F, `correction-manual-${theme}-${lang}`);

      await panel.getByTestId('correction-suggestion-item').nth(1).getByTestId('correction-keep-original').click();
      await expect(panel.getByTestId('correction-apply')).toContainText(/1/);
      await expect(boxes.nth(1)).toHaveValue('但是那个东西');
      await panel.getByTestId('correction-suggestion-item').nth(1).getByTestId('correction-restore-ai').click();
      await expect(boxes.nth(1)).toHaveValue('但是那个东西。');
      await expect(panel.getByTestId('correction-apply')).toContainText(/2/);

      await page.getByTestId('correction-current-toggle').click();
      await expect(boxes.first()).toHaveValue('我觉得这个很好');
      await page.getByTestId('correction-preview-toggle').click();
      await expect(boxes.first()).toHaveValue('我觉得这个特别好');

      await page.getByTestId('correction-apply').click();
      await expect(panel).toContainText(/已应用 2 处修改|Applied 2 changes/);
      await expect(boxes.first()).toHaveValue('我觉得这个特别好');
      await expect(boxes.nth(1)).toHaveValue('但是那个东西。');
      await expect.poll(() => saved()?.textHistory as Array<{ kind: string; before: unknown[]; after: unknown[] }> | undefined)
        .toHaveLength(1);
      const record = (saved()?.textHistory as Array<{ kind: string; before: unknown[]; after: unknown[] }>)[0];
      expect(record.kind).toBe('ai-correction');
      expect(record.before).toHaveLength(2);
      expect(record.after).toHaveLength(2);
      expect((saved()?.chunks as Array<{ secondText?: string }>)[0].secondText).toBe('译文A');
      expect(host.calls.filter(call => call.method === 'text.start')).toHaveLength(1);
      await shot(page, F, `correction-applied-${theme}-${lang}`);

      await page.getByTitle(/撤销删除|Undo delete/i).click();
      await expect(boxes.first()).toHaveValue('我觉得这个很好');
      await page.getByTitle(/重做删除|Redo delete/i).click();
      await expect(boxes.first()).toHaveValue('我觉得这个特别好');

      await page.reload();
      await expect(boxes.first()).toHaveValue('我觉得这个特别好');
      await page.getByRole('button', { name: /操作历史|Edit history/, exact: true }).click();
      await expect(page.getByText(/AI 纠错|AI correction/)).toBeVisible();
      await shot(page, F, `history-${theme}-${lang}`);
      // Undo/redo above append their own text records (newest first); preview and restore the newest one.
      await expect(page.getByText(/撤销文字修改|Undo text change/)).toBeVisible();
      await page.getByRole('button', { name: /预览文字修改|Preview text changes/ }).first().click();
      await expect(page.getByTestId('text-history-preview')).toBeVisible();
      await page.getByRole('button', { name: /回退到此版本|Restore this version/, exact: true }).first().click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText(/回退这次文字修改|Restore these text changes/);
      await dialog.getByRole('button', { name: /回退到此版本|Restore this version/ }).click();
      await expect(boxes.first()).toHaveValue('我觉得这个很好');
      await expect(boxes.nth(1)).toHaveValue('但是那个东西');
      await expect.poll(() => (saved()?.textHistory as Array<{ kind: string }> | undefined)?.map(item => item.kind))
        .toEqual(['ai-correction', 'undo', 'redo', 'history-restore']);
      await expect(page.getByText(/回退文字版本|Restore text version/)).toBeVisible();
      await shot(page, F, `history-restored-${theme}-${lang}`);
    });
  });
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`${theme}-zh`, () => {
    test('F-0013/AC-1 no model shows settings and editing stays available', async ({ page }) => {
      const { saved } = await connect(page);
      await openEditor(page, theme, 'zh', false);
      const boxes = page.getByTestId('subtitle-main-text');
      await page.getByTestId('correction-open').click();
      const panel = page.getByTestId('correction-review');
      await expect(panel).toContainText('请先配置AI模型');
      await expect(panel.getByTestId('correction-settings')).toBeVisible();
      await boxes.first().fill('编辑仍然可用');
      await page.locator('body').click({ position: { x: 5, y: 5 } });
      await expect.poll(() => (saved()?.chunks as Array<{ text: string }> | undefined)?.[0]?.text).toBe('编辑仍然可用');
      await expect(boxes.first()).toHaveValue('编辑仍然可用');
      await panel.getByTestId('correction-settings').click();
      await expect(page.getByText('AI 模型管理').first()).toBeVisible();
      await shot(page, F, `no-model-${theme}-zh`);
    });

    test('F-0013/AC-3 AC-4 generating, cancel and partial results only', async ({ page }) => {
      test.setTimeout(90_000);
      const many = { ...transcript, text: Array.from({ length: 26 }, (_, index) => `第${index}句`).join(' '), duration: 60,
        chunks: Array.from({ length: 26 }, (_, index) => ({ id: `c${index}`, text: `第${index}句`, timestamp: [index * 2, index * 2 + 1] })) };
      let starts = 0;
      const { host, jobs, saved } = await connect(page, { data: many,
        resultFor: payload => { const first = starts++ === 0; return first ? payload.items.map(item => ({ id: item.id, text: `${item.text}。` })) : undefined; } });
      await openEditor(page, theme, 'zh');
      await page.getByTestId('correction-open').click();
      const panel = page.getByTestId('correction-review');
      await expect(panel).toContainText('将发送 26 条字幕');
      await page.getByTestId('correction-start').click();
      await expect(panel).toContainText('正在生成纠错建议');
      await expect.poll(() => host.calls.filter(call => call.method === 'text.start').length).toBe(2);
      await page.getByTestId('correction-cancel').click();
      await expect(panel).toContainText('仅完成部分批次');
      await shot(page, F, `partial-${theme}-zh`);
      const second = [...jobs.keys()][1];
      jobs.set(second, { result: (jobs.get(second) ? [] : []) });
      await page.waitForTimeout(400);
      await page.getByTestId('correction-review-partial').click();
      await expect(panel.getByTestId('correction-apply')).toContainText('25');
      await page.getByTestId('correction-apply').click();
      await expect(panel).toContainText('已应用 25 处修改');
      await expect.poll(() => (saved()?.textHistory as Array<{ after: unknown[] }> | undefined)?.[0]?.after.length).toBe(25);
    });

    test('F-0013/AC-4 invalid batch can retry then exclude', async ({ page }) => {
      const { host } = await connect(page, { resultFor: () => [{ id: 'wrong-id', text: '错误结果' }] });
      await openEditor(page, theme, 'zh');
      await page.getByTestId('correction-open').click();
      await page.getByTestId('correction-start').click();
      const panel = page.getByTestId('correction-review');
      await expect(panel).toContainText('纠错结果无效');
      await expect(panel.getByTestId('correction-apply')).toBeDisabled();
      await shot(page, F, `invalid-${theme}-zh`);
      await panel.getByTestId('correction-retry').click();
      await expect(panel).toContainText('纠错结果无效');
      await expect.poll(() => host.calls.filter(call => call.method === 'text.start').length).toBe(2);
      await panel.getByTestId('correction-exclude').click();
      await expect(panel).toContainText('没有需要确认的修改');
      await expect(panel.getByTestId('correction-apply')).toBeDisabled();
    });

    test('F-0013/AC-7 stale review never partially writes', async ({ page }) => {
      const { saved } = await connect(page);
      await openEditor(page, theme, 'zh');
      const boxes = page.getByTestId('subtitle-main-text');
      await page.getByTestId('correction-open').click();
      await page.getByTestId('correction-start').click();
      const panel = page.getByTestId('correction-review');
      await expect(panel.getByTestId('correction-preview-toggle')).toBeVisible();
      await page.getByTestId('correction-current-toggle').click();
      await boxes.first().fill('我改了原文');
      await page.getByTestId('correction-preview-toggle').click();
      await page.getByTestId('correction-apply').click();
      await expect(page.getByTestId('correction-stale')).toBeVisible();
      await expect(page.getByText('原文已更新，请重新检查')).toBeVisible();
      expect((saved()?.textHistory as unknown[] | undefined)?.length ?? 0).toBe(0);
      await page.getByRole('button', { name: '保留当前字幕' }).click();
      await expect(panel).toHaveCount(0);
      await expect(boxes.first()).toHaveValue('我改了原文');
      await shot(page, F, `stale-${theme}-zh`);
    });
  });
}

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { shot } from '../lib/evidence';
import { E2E_HOST_ID, MOCK_HOST, mockHost, prepare, projectItem, uuid, type MockHandlers } from '../lib/mockHost';
import { makeF0017Transcript } from '../lib/longTranscript';

const F = 'F-0017';
const P = '00000000-0000-4000-8000-000000000017';
const LONG = '00000000-0000-4000-8000-0000000000aa';
const SHORT = '00000000-0000-4000-8000-0000000000ab';
const T = '2026-11-09T12:00:00.000Z';
const NAME = '六十小时口播';
const longTranscript = makeF0017Transcript();
const shortTranscript = {
  text: '短视频第一句',
  language: 'zh',
  duration: 10,
  hasWordTimestamps: false,
  chunks: [{ id: 'short-1', text: '短视频第一句', timestamp: [0, 10] as [number, number] }],
};

let mediaDir = '';
let longMedia = '';
let asrMedia = '';
test.beforeAll(() => {
  mediaDir = mkdtempSync(join(tmpdir(), 'flycut-f0017-ui-'));
  longMedia = join(mediaDir, 'sixty-minutes.mp4');
  asrMedia = join(mediaDir, 'provider-return.mp4');
  const run = spawnSync(resolve('src-tauri/binaries/ffmpeg'), ['-y', '-v', 'error', '-f', 'lavfi',
    '-i', 'color=c=black:s=160x90:r=1:d=3600', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', longMedia], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr);
  const audio = spawnSync(resolve('src-tauri/binaries/ffmpeg'), ['-y', '-v', 'error', '-f', 'lavfi',
    '-i', 'color=c=black:s=160x90:r=25:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=2',
    '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', asrMedia], { encoding: 'utf8' });
  if (audio.status !== 0) throw new Error(audio.stderr);
});
test.afterAll(() => rmSync(mediaDir, { recursive: true, force: true }));

const video = (id: string, name: string, durationSeconds: number) => ({
  id, name, durationSeconds, createdAt: T, updatedAt: T, hasTranscript: true, mediaMissing: true,
  hasThumbnail: false, styleSource: 'project', revision: 1,
  media: { kind: 'stored', file: `media/${id}.mp4`, size: 1, mimeType: 'video/mp4' },
});

function openResult(videoId = LONG, transcript = longTranscript, extra: Record<string, unknown> = {}, mediaOk = false) {
  const videos = [video(LONG, '六十分钟.mp4', 3600), video(SHORT, '短视频.mp4', 10)]
    .map(item => ({ ...item, mediaMissing: !mediaOk }));
  const current = videos.find(item => item.id === videoId)!;
  return {
    status: 'ok',
    project: { formatVersion: 3, id: P, name: NAME, createdAt: T, updatedAt: T, revision: 1, styleRevision: 0, videos: [] },
    video: current,
    videos,
    transcript,
    media: mediaOk
      ? { status: 'ok', name: current.name, playback: { kind: 'url', path: `/projects/${P}/media/${current.id}` } }
      : { status: 'missing', name: current.name },
    ...extra,
  };
}

async function routeMedia(page: Page, file: string) {
  const bytes = readFileSync(file);
  await page.route(`${MOCK_HOST}/projects/**/media/**`, route => {
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    return route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4', body: bytes.subarray(start, end + 1),
      headers: { 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1),
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) } });
  });
}

async function routeLongMedia(page: Page) {
  await routeMedia(page, longMedia);
}

async function findVirtualRow(page: Page, text: string) {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
  await page.getByTestId('find-input').fill(text);
  await expect(page.getByTestId('find-count')).toHaveText(/1\//);
  await page.getByTestId('find-next').click();
  const row = page.locator('[data-chunk-id="row-1172"]');
  await expect(row).toBeVisible();
  await page.getByTestId('find-close').click();
  return row;
}

async function openEditor(page: Page, theme: 'light' | 'dark', handlers: MockHandlers = {},
  options: { mediaOk?: boolean; storage?: Record<string, string> } = {}) {
  await prepare(page, theme, options.storage);
  const host = await mockHost(page, {
    'projects.list': () => [projectItem(P, NAME, { durationSeconds: 3600, videoId: LONG })],
    'projects.detail': () => ({ status: 'ok', project: { id: P, name: NAME, createdAt: T, updatedAt: T, revision: 1, styleRevision: 0 }, videos: [video(LONG, '六十分钟.mp4', 3600), video(SHORT, '短视频.mp4', 10)] }),
    'projects.open': ({ videoId }: { videoId?: string }) => openResult(videoId ?? LONG,
      videoId === SHORT ? shortTranscript : longTranscript, {}, options.mediaOk),
    'projects.saveVideoEdits': () => ({ status: 'saved', revision: 2, projectRevision: 2, updatedAt: T }),
    ...handlers,
  });
  if (options.mediaOk) await routeLongMedia(page);
  await page.goto(`/#/projects/${P}/videos/${LONG}`);
  await expect(page.getByTestId('subtitle-main-text').first()).toBeVisible();
  return host;
}

for (const theme of ['light', 'dark'] as const) {
  test(`F-0017/AC-1 AC-3 AC-4 AC-10 AC-11 long mount is bounded and opening stays visible (${theme})`, async ({ page }) => {
    await prepare(page, theme);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const host = await mockHost(page, {
      'projects.list': () => [projectItem(P, NAME, { durationSeconds: 3600, videoId: LONG })],
      'projects.open': async () => { await gate; return openResult(); },
      'projects.saveVideoEdits': () => ({ status: 'saved', revision: 2, projectRevision: 2, updatedAt: T }),
    });
    await page.goto('/#/projects');
    const started = Date.now();
    await page.getByRole('button', { name: new RegExp(NAME) }).click();
    await expect(page.getByText('正在打开…')).toBeVisible();
    await shot(page, F, `long-opening-${theme}`);
    release();
    const first = page.getByTestId('subtitle-main-text').first();
    await expect(first).toHaveValue(/第 1 句/);
    await first.focus();
    await page.keyboard.type('测');
    expect(Date.now() - started).toBeLessThan(3000);
    expect(host.calls.filter(call => call.method === 'projects.open')).toHaveLength(1);

    const rows = page.locator('[data-chunk-id]');
    expect(await rows.count()).toBeLessThan(30);
    expect(await page.locator('textarea').count()).toBeLessThan(60);
    await expect(page.getByText(/总计: 1173 \| 有效: 1173/)).toBeVisible();
    await shot(page, F, `long-editor-${theme}`);

    const scroll = page.getByTestId('subtitle-virtual-scroll');
    await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(page.locator('[data-chunk-id="row-1172"]')).toBeVisible();
    await expect(page.getByText(/总计: 1173 \| 有效: 1173/)).toBeVisible();
    await shot(page, F, `long-bottom-${theme}`);
  });

  test(`F-0017/AC-3 AC-10 AC-11 provider job completion injects a long transcript into the bounded editor (${theme})`, async ({ page }) => {
    const asrSettings = JSON.stringify({ state: { language: 'zh', asrModel: { providerId: 'test-provider', modelId: 'long-video' } }, version: 1 });
    await prepare(page, theme, { 'app-settings': asrSettings });
    await page.addInitScript(() => {
      const target = window as Window & { __f0017LongTasks?: Array<{ startTime: number; duration: number }>; __f0017ProviderReturnedAt?: number };
      target.__f0017LongTasks = [];
      if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
        new PerformanceObserver(list => {
          for (const entry of list.getEntries()) target.__f0017LongTasks!.push({ startTime: entry.startTime, duration: entry.duration });
        }).observe({ type: 'longtask', buffered: true });
      }
    });
    let release!: () => void;
    const providerGate = new Promise<void>(resolve => { release = resolve; });
    const transcriptWithoutLoadedState = { ...longTranscript, editing: undefined };
    let workflowOpId: unknown;
    const host = await mockHost(page, {
      'projects.list': () => [projectItem(P, NAME, { durationSeconds: 3600, videoId: LONG })],
      'projects.open': () => ({
        ...openResult(LONG, undefined, {}, true),
        video: { ...video(LONG, '六十分钟.mp4', 3600), hasTranscript: false },
        videos: [{ ...video(LONG, '六十分钟.mp4', 3600), hasTranscript: false }, video(SHORT, '短视频.mp4', 10)],
        transcript: undefined,
      }),
      'projects.saveTranscript': () => ({ status: 'saved', revision: 2, updatedAt: T }),
      'workflow.start': payload => {
        workflowOpId = payload?.operationId;
        return { id: uuid(991), operationId: workflowOpId, status: 'queued', createdAt: T, updatedAt: T };
      },
      'jobs.get': async () => {
        await providerGate;
        await page.evaluate(() => {
          (window as Window & { __f0017ProviderReturnedAt?: number }).__f0017ProviderReturnedAt = performance.now();
        });
        return { id: uuid(991), operationId: workflowOpId, status: 'complete', result: { transcript: transcriptWithoutLoadedState, cuts: [] }, createdAt: T, updatedAt: T };
      },
      'assets.delete': () => ({ deleted: true }),
    });
    await routeMedia(page, asrMedia);
    await page.goto(`/#/projects/${P}/videos/${LONG}`);
    await expect.poll(() => host.calls.some(call => call.method === 'workflow.start')).toBe(true);
    release();
    const first = page.locator('[data-chunk-id="row-0"]').getByTestId('subtitle-main-text');
    await expect(first).toHaveValue(/第 1 句/);
    await first.fill('ASR 返回后可编辑');
    await expect(first).toHaveValue('ASR 返回后可编辑');
    const editableAt = await page.evaluate(() => performance.now());
    const elapsedMs = await page.evaluate(() => performance.now()
      - (window as Window & { __f0017ProviderReturnedAt?: number }).__f0017ProviderReturnedAt!);
    expect(elapsedMs).toBeLessThan(3000);
    expect(await page.locator('[data-chunk-id]').count()).toBeLessThan(30);
    expect(await page.locator('textarea').count()).toBeLessThan(60);
    await expect(page.getByText(/总计: 1173 \| 有效: 1173/)).toBeVisible();
    await page.waitForTimeout(1000);
    const maxLongTaskMs = await page.evaluate(start => Math.max(0, ...((window as Window & {
      __f0017LongTasks?: Array<{ startTime: number; duration: number }> }).__f0017LongTasks ?? [])
      .filter(entry => entry.startTime + entry.duration >= start).map(entry => entry.duration)), editableAt);
    expect(maxLongTaskMs).toBeLessThanOrEqual(200);
    await expect.poll(() => host.calls.filter(call => call.method === 'projects.saveTranscript').length).toBe(1);
    const saved = host.calls.find(call => call.method === 'projects.saveTranscript')!.payload;
    expect(saved.providerId).toBeUndefined();
    expect((saved.transcript as { chunks: unknown[] }).chunks).toHaveLength(1173);
    await shot(page, F, `long-provider-return-${theme}`);
  });
}

test('F-0017/AC-5 unfocused offscreen draft saves, survives reload, and never follows a video switch', async ({ page }) => {
  const state = { transcript: longTranscript as typeof longTranscript, saves: [] as Record<string, unknown>[] };
  await openEditor(page, 'light', {
    'projects.open': ({ videoId }: { videoId?: string }) => openResult(videoId ?? LONG, videoId === SHORT ? shortTranscript : state.transcript),
    'projects.saveVideoEdits': payload => { state.saves.push(payload as Record<string, unknown>); return { status: 'saved', revision: 2, projectRevision: 2, updatedAt: T }; },
  });
  const first = page.getByTestId('subtitle-main-text').first();
  await first.fill('未失焦的长视频修改');
  const scroll = page.getByTestId('subtitle-virtual-scroll');
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => (state.saves.at(-1)?.edits as { chunks?: Array<{ id: string; text: string }> } | undefined)?.chunks?.find(chunk => chunk.id === 'row-0')?.text, { timeout: 5000 })
    .toBe('未失焦的长视频修改');
  state.transcript = {
    ...state.transcript,
    chunks: state.transcript.chunks.map(chunk => chunk.id === 'row-0' ? { ...chunk, text: '未失焦的长视频修改' } : chunk),
  };
  await page.reload();
  await expect(page.getByTestId('subtitle-main-text').first()).toHaveValue('未失焦的长视频修改');

  await page.getByTestId('subtitle-main-text').first().fill('切换前最后输入');
  await page.getByRole('button', { name: '切换视频' }).click();
  await page.getByRole('menuitem').filter({ hasText: '短视频.mp4' }).click();
  await expect(page).toHaveURL(new RegExp(`videos/${SHORT}`));
  await expect(page.getByTestId('subtitle-main-text').first()).toHaveValue('短视频第一句');
  expect(state.saves.some(save => ((save.edits as { chunks?: Array<{ id: string; text: string }> }).chunks ?? [])
    .some(chunk => chunk.id === 'row-0' && chunk.text === '切换前最后输入'))).toBe(true);
});

test('F-0017/AC-4 AC-5 AC-6 AC-7 AC-10 offscreen selection, delete, restore, edit and undo stay exact', async ({ page }) => {
  const host = await openEditor(page, 'light', {
    'projects.saveVideoEdits': () => ({ status: 'saved', revision: 2, projectRevision: 2, updatedAt: T }),
  });
  const scroll = page.getByTestId('subtitle-virtual-scroll');
  await page.getByRole('button', { name: '全选' }).click();
  await expect(page.getByRole('button', { name: '删除选中 (1173)' })).toBeEnabled();
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(page.locator('[data-chunk-id="row-1172"]')).toBeVisible();
  await page.getByRole('button', { name: '清除选择' }).click();
  await page.getByRole('checkbox').first().check();
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.getByRole('button', { name: '删除选中 (1)' }).click();
  await expect(page.getByText(/总计: 1173 \| 有效: 1172/)).toBeVisible();
  await expect(page.getByRole('button', { name: '恢复 (1)' })).toBeVisible();
  await page.getByRole('button', { name: '恢复 (1)' }).click();
  await scroll.evaluate(element => { element.scrollTop = 0; });
  await expect(page.locator('[data-chunk-id="row-0"]')).toBeVisible();
  await expect(page.getByText(/总计: 1173 \| 有效: 1173/)).toBeVisible();

  const first = page.locator('[data-chunk-id="row-0"]').getByTestId('subtitle-main-text');
  const original = await first.inputValue();
  await first.fill('编辑后滚走再撤销');
  await first.blur();
  await expect.poll(() => host.calls.filter(call => call.method === 'projects.saveVideoEdits').length, { timeout: 5000 }).toBeGreaterThan(0);
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.getByTitle(/撤销删除/).last().click();
  await scroll.evaluate(element => { element.scrollTop = 0; });
  await expect(page.locator('[data-chunk-id="row-0"]').getByTestId('subtitle-main-text')).toHaveValue(original);
  await shot(page, F, 'long-selection-undo-light');
});

test('F-0017/AC-4 AC-8 find reaches virtual rows and Tab crosses the mounted boundary', async ({ page }) => {
  await openEditor(page, 'light');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
  await page.getByTestId('find-input').fill('第 1161 句');
  await expect(page.getByTestId('find-count')).toHaveText(/1\//);
  await page.getByTestId('find-next').click();
  await expect(page.locator('[data-chunk-id="row-1160"]')).toBeVisible();
  await expect(page.locator('[data-chunk-id="row-0"]')).toHaveCount(0);
  await page.getByTestId('find-close').click();

  const scroll = page.getByTestId('subtitle-virtual-scroll');
  await scroll.evaluate(element => { element.scrollTop = 0; });
  await expect(page.locator('[data-chunk-id="row-0"]')).toBeVisible();
  const boundary = await page.locator('[data-virtual-row-index]').last().evaluate(row => {
    const controls = [...row.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled])')];
    controls.at(-1)?.focus();
    return {
      index: Number((row as HTMLElement).dataset.virtualRowIndex),
      focusedRow: Number((document.activeElement?.closest('[data-virtual-row-index]') as HTMLElement | null)?.dataset.virtualRowIndex),
    };
  });
  expect(boundary.focusedRow).toBe(boundary.index);
  await page.keyboard.press('Tab');
  await expect.poll(() => page.evaluate(() => Number((document.activeElement?.closest('[data-virtual-row-index]') as HTMLElement | null)?.dataset.virtualRowIndex)))
    .toBe(boundary.index + 1);
});

test('F-0017/AC-8 playback follows virtual rows unless the user is editing or recently scrolled', async ({ page }) => {
  await openEditor(page, 'light', {}, { mediaOk: true });
  const video = page.locator('video');
  await expect(video).toBeVisible();
  await page.waitForFunction(() => {
    const element = document.querySelector('video');
    return element instanceof HTMLVideoElement && element.readyState >= 1 && element.duration >= 3590;
  });
  const seek = async (time: number) => {
    await video.evaluate((element, next) => { element.currentTime = next; }, time);
    await expect.poll(() => video.evaluate(element => element.currentTime)).toBeCloseTo(time, 0);
    await video.evaluate(element => element.dispatchEvent(new Event('timeupdate')));
  };

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await seek(3500);
  await expect(page.locator('[data-chunk-id="row-1140"]')).toBeVisible();
  await expect(page.locator('[data-chunk-id="row-0"]')).toHaveCount(0);

  const scroll = page.getByTestId('subtitle-virtual-scroll');
  const box = await scroll.boundingBox();
  if (!box) throw new Error('subtitle scroll container is not visible');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await scroll.evaluate(element => {
    element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
    element.scrollTop = 0;
  });
  await expect(page.locator('[data-chunk-id="row-0"]')).toBeVisible();
  const manualTop = await scroll.evaluate(element => element.scrollTop);
  await seek(10);
  expect(await scroll.evaluate(element => element.scrollTop)).toBeCloseTo(manualTop, 0);
  await expect(page.locator('[data-chunk-id="row-0"]')).toBeVisible();

  const focused = page.locator('[data-chunk-id="row-0"]').getByTestId('subtitle-main-text');
  await focused.focus();
  const focusedTop = await scroll.evaluate(element => element.scrollTop);
  await seek(1000);
  expect(await scroll.evaluate(element => element.scrollTop)).toBeCloseTo(focusedTop, 0);
  await expect(page.locator('[data-chunk-id="row-325"]')).toHaveCount(0);

  await focused.blur();
  await page.waitForTimeout(3100);
  await seek(2000);
  await expect(page.locator('[data-chunk-id="row-651"]')).toBeVisible();
  expect(await scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(focusedTop + 1000);
  await shot(page, F, 'long-playback-follow-light');
});

test('F-0017/AC-9 translation and AI correction write back offscreen virtual rows and undo exactly', async ({ page }) => {
  let sequence = 0;
  const jobs = new Map<string, { mode: 'correction' | 'translation'; items: Array<{ id: string; text: string }> }>();
  await openEditor(page, 'light', {
    'aiSettings.list': () => ({ hostId: E2E_HOST_ID, revision: 1, selectedId: 'mock-ai',
      configs: [{ id: 'mock-ai', name: 'Mock AI', baseUrl: 'http://ai.test/v1', model: 'mock-model', hasApiKey: true }] }),
    'text.start': payload => {
      const id = uuid(970 + sequence++);
      jobs.set(id, payload as { mode: 'correction' | 'translation'; items: Array<{ id: string; text: string }> });
      return { id, status: 'queued', createdAt: T, updatedAt: T };
    },
    'jobs.get': ({ id }: { id: string }) => {
      const job = jobs.get(id)!;
      const result = job.items.map(item => ({ id: item.id,
        text: job.mode === 'translation' ? `译文 ${item.text}` : `${item.text}。` }));
      return { id, status: 'complete', result, createdAt: T, updatedAt: T };
    },
  });

  await page.getByTestId('translation-open').click();
  await page.getByTestId('translation-start').click();
  await expect(page.getByTestId('translation-apply')).toBeVisible({ timeout: 25_000 });
  await page.getByTestId('translation-apply').click();
  await expect(page.getByText(/字幕翻译完成/)).toBeVisible();
  await page.getByTestId('translation-close').click();
  const last = await findVirtualRow(page, '第 1173 句');
  await expect(last.getByTestId('subtitle-secondary-text')).toHaveValue(/译文 第 1173 句/);

  await page.getByTitle(/撤销删除/).last().click();
  await expect(last.getByTestId('subtitle-secondary-text')).toHaveValue('');

  await page.getByTestId('correction-open').click();
  await page.getByTestId('correction-start').click();
  await expect(page.getByTestId('correction-apply')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('correction-apply').click();
  const corrected = await findVirtualRow(page, '第 1173 句');
  await expect(corrected.getByTestId('subtitle-main-text')).toHaveValue(/第 1173 句.*。/);
  await page.getByTitle(/撤销删除/).last().click();
  const restored = await findVirtualRow(page, '第 1173 句');
  await expect(restored.getByTestId('subtitle-main-text'))
    .not.toHaveValue(/。$/);
  await shot(page, F, 'long-ai-writeback-light');
});

test('F-0017/AC-7 AC-9 smart cut blank stays bounded and writes back through the long list', async ({ page }) => {
  const cutTranscript = {
    ...longTranscript,
    chunks: longTranscript.chunks.map((chunk, index) => index < 4
      ? { ...chunk, timestamp: [chunk.timestamp[0], chunk.timestamp[1] - 2] as [number, number] }
      : chunk),
  };
  await openEditor(page, 'light', {
    'projects.open': () => openResult(LONG, cutTranscript),
  });
  await page.getByRole('button', { name: '智能剪切空白' }).last().click();
  await expect(page.getByTestId('cut-suggestions')).toBeVisible();
  await expect(page.getByTestId('pending-suggestion-item')).toHaveCount(4);
  await page.getByRole('button', { name: /确认剪辑/ }).click();
  await expect(page.getByTestId('cut-suggestions')).toHaveCount(0);
  await expect(page.getByText(/总计: 1173 \| 有效: 1173/)).toBeVisible();
  await page.getByTitle(/撤销删除/).last().click();
  await expect(page.getByText(/总计: 1173 \| 有效: 1173/)).toBeVisible();
  await shot(page, F, 'long-smart-cut-light');
});


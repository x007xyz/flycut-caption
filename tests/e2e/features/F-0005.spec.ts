import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { mockHost, prepare, uuid, VIDEO_ID, MOCK_HOST, RpcError, pending, type MockHandlers } from '../lib/mockHost';
import { shot } from '../lib/evidence';

const P = uuid(105); const F = 'F-0005'; const T = '2026-11-08T12:00:00Z';
const transcript = { text: '第一句 第二句', language: 'zh', duration: 10, hasWordTimestamps: false,
  chunks: [{ id: 'a', text: '第一句', timestamp: [1, 3] }, { id: 'b', text: '第二句', timestamp: [6, 8] }] };
let mediaDir: string; let media: string;
test.beforeAll(() => {
  mediaDir = mkdtempSync(join(tmpdir(), 'flycut-f0005-ui-')); media = join(mediaDir, 'marker.mp4');
  const run = spawnSync(resolve('src-tauri/binaries/ffmpeg'), ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=10',
    '-c:v', 'libx264', '-preset', 'ultrafast', media], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr);
});
test.afterAll(() => rmSync(mediaDir, { recursive: true, force: true }));
async function connect(page: Page, handlers: MockHandlers) {
  const host = await mockHost(page, handlers);
  await page.route(`${MOCK_HOST}/projects/**/media/**`, route => {
    const bytes = readFileSync(media); const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
    const start = range ? Number(range[1]) : 0; const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    return route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4', body: bytes.subarray(start, end + 1),
      headers: { 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1),
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) } });
  });
  return host;
}
function fixture() {
  let edits: Record<string, unknown> | undefined; let revision = 1;
  const open = () => ({ status: 'ok',
    project: { id: P, name: 'EDL', formatVersion: 3, revision, styleRevision: 0, videos: [], createdAt: T, updatedAt: T },
    video: { id: VIDEO_ID, name: 'EDL.mp4', durationSeconds: 10, revision, styleSource: 'project', hasTranscript: true,
      createdAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1, mimeType: 'video/mp4' } },
    videos: [], transcript, edits, media: { status: 'ok', name: 'EDL.mp4', playback: { kind: 'url', path: `/projects/${P}/media/${VIDEO_ID}` } } });
  const handlers: MockHandlers = { 'projects.open': open,
    'projects.saveVideoEdits': p => { edits = p.edits; revision++; return { status: 'saved', revision, projectRevision: revision, updatedAt: T }; },
    'projects.saveProjectStyle': () => ({ status: 'saved', revision: 1, projectRevision: revision, updatedAt: T }),
  };
  return { handlers, open, saved: () => edits };
}
async function setEnglish(page: Page, english: boolean) {
  if (english) {
    await page.getByRole('button', { name: '选择语言' }).click();
    await page.getByRole('menuitem', { name: /English/ }).click();
  }
}
for (const theme of ['light', 'dark'] as const) for (const english of [false, true]) {
  const lang = english ? 'en' : 'zh';
  test.describe(`${theme}-${lang}`, () => {
    test('F-0005/AC-1 AC-6 AC-7 AC-12 deletion, history preview, persistent restore and later correction', async ({ page }) => {
      await prepare(page, theme, { 'flycut-locale': lang });
      const f = fixture(); const host = await connect(page, f.handlers);
      await page.goto(`/?lang=${lang}#/projects/${P}/videos/${VIDEO_ID}`);
      await setEnglish(page, english);
      const boxes = page.getByPlaceholder(/请输入主字幕|Enter main subtitle/);
      await expect(boxes.first()).toHaveValue('第一句');
      await page.getByTitle(/删除片段|Delete segment/).first().click();
      await expect(boxes).toHaveCount(1);
      await page.getByRole('button', { name: /操作历史|Edit history/, exact: true }).click();
      await expect(page.getByRole('dialog', { name: /操作历史|Edit history/ })).toBeVisible();
      await expect(page.getByText(/初始剪辑版本|Initial cut version/)).toBeVisible();
      await shot(page, F, `history-${theme}-${lang}`);
      await page.getByRole('button', { name: /关闭|Close/, exact: true }).last().click();
      const current = boxes.first(); await current.fill('第二句已校对'); await current.blur();
      await page.getByRole('button', { name: /操作历史|Edit history/, exact: true }).click();
      const baseline = page.getByText(/初始剪辑版本|Initial cut version/).locator('..');
      await baseline.getByRole('button', { name: /预览剪辑效果|Preview proposed cuts/ }).click();
      await expect(boxes).toHaveCount(1); // preview never applies the historic flags.
      await baseline.getByRole('button', { name: /回退到此版本|Restore this version/ }).click();
      await expect(page.getByRole('alertdialog')).toBeVisible();
      await shot(page, F, `restore-confirm-${theme}-${lang}`);
      await page.getByRole('alertdialog').getByRole('button', { name: /回退到此版本|Restore this version/ }).click();
      await expect(boxes).toHaveCount(2);
      await expect(boxes.nth(1)).toHaveValue('第二句已校对');
      await page.getByRole('button', { name: /关闭|Close/, exact: true }).last().click();
      await page.reload(); await setEnglish(page, english); await expect(boxes).toHaveCount(2);
      await expect(boxes.nth(1)).toHaveValue('第二句已校对');
      expect(host.calls.some(c => c.method === 'projects.saveVideoEdits' && !!(c.payload.edits as Record<string, unknown>)?.editing)).toBe(true);
    });
    for (const lostResponse of [false, true]) test(`F-0005/AC-8 AC-12 restore ${lostResponse ? 'verifies a lost save response' : 'rolls back a failed write'}`, async ({ page }) => {
      await prepare(page, theme); const f = fixture(); const host = await connect(page, f.handlers);
      await page.goto(`/#/projects/${P}/videos/${VIDEO_ID}`);
      const boxes = page.getByPlaceholder(/请输入主字幕|Enter main subtitle/);
      await expect(boxes.first()).toBeVisible(); await setEnglish(page, english);
      await page.getByTitle(/删除片段|Delete segment/).first().click();
      await page.getByRole('button', { name: /操作历史|Edit history/, exact: true }).click();
      const baseline = page.getByText(/初始剪辑版本|Initial cut version/).locator('..');
      await baseline.getByRole('button', { name: /回退到此版本|Restore this version/ }).click();
      let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
      host.set('projects.saveVideoEdits', async payload => {
        await held;
        if (lostResponse) f.handlers['projects.saveVideoEdits']!(payload);
        throw new RpcError('save response lost');
      });
      await page.getByRole('alertdialog').getByRole('button', { name: /回退到此版本|Restore this version/ }).click();
      await expect(page.getByText(/正在更新剪辑|Updating cuts/)).toBeVisible();
      await shot(page, F, `restore-updating-${theme}-${lang}-${lostResponse}`);
      release();
      if (lostResponse) {
        await expect(page.getByRole('alertdialog')).toHaveCount(0); await expect(boxes).toHaveCount(2);
        await page.reload(); await expect(boxes).toHaveCount(2);
      } else {
        await expect(page.getByText(/回退失败|Couldn't restore/)).toBeVisible();
        await expect(boxes).toHaveCount(1);
        await shot(page, F, `restore-failed-${theme}-${lang}`);
        host.set('projects.saveVideoEdits', f.handlers['projects.saveVideoEdits']!);
        await page.getByRole('alertdialog').getByRole('button', { name: /回退到此版本|Restore this version/ }).click();
        await expect(page.getByRole('alertdialog')).toHaveCount(0); await expect(boxes).toHaveCount(2);
      }
    });
    test('F-0005/AC-2 AC-11 silence suggestions are marked and previewed before confirm; cancellation writes nothing', async ({ page }) => {
      await prepare(page, theme); const f = fixture(); const host = await connect(page, f.handlers);
      await page.goto(`/#/projects/${P}/videos/${VIDEO_ID}`);
      await expect(page.getByPlaceholder(/请输入主字幕|Enter main subtitle/).first()).toBeVisible();
      await setEnglish(page, english);
      await page.getByRole('button', { name: /智能剪切空白|Smart.*silence|Smart Cut/i }).first().click();
      await expect(page.getByTestId('cut-suggestions')).toBeVisible();
      await expect(page.getByTestId('pending-cut').first()).toBeVisible();
      await page.getByTestId('cut-suggestions').getByRole('button', { name: /预览剪辑效果|Preview proposed cuts/ }).click();
      await expect(page.getByText(/预览，尚未应用|Preview, not applied/).first()).toBeVisible();
      await shot(page, F, `suggestions-${theme}-${lang}`);
      expect(host.calls.filter(c => c.method === 'projects.saveVideoEdits')).toHaveLength(0);
      await page.getByTestId('cut-suggestions').getByRole('button', { name: /取消|Cancel/, exact: true }).click();
      await expect(page.getByTestId('cut-suggestions')).toHaveCount(0);
      expect(host.calls.filter(c => c.method === 'projects.saveVideoEdits')).toHaveLength(0);
      await page.getByRole('button', { name: /智能剪切空白|Smart.*silence|Smart Cut/i }).first().click();
      await page.getByTestId('cut-suggestions').getByRole('button', { name: /确认剪辑|Confirm cuts/ }).click();
      await expect(page.getByTestId('cut-suggestions')).toHaveCount(0);
      await page.getByRole('button', { name: /操作历史|Edit history/, exact: true }).click();
      await expect(page.getByText(/确认剪辑建议|Apply cut suggestions/)).toBeVisible();
    });
    test('F-0005/AC-12 history waits for newer edits that arrive during an in-flight save', async ({ page }) => {
      await prepare(page, theme); const f = fixture(); let release: (() => void) | undefined;
      const host = await connect(page, { ...f.handlers, 'projects.saveVideoEdits': async payload => {
        if (!release) await new Promise<void>(resolve => { release = resolve; });
        return f.handlers['projects.saveVideoEdits']!(payload);
      } });
      await page.goto(`/#/projects/${P}/videos/${VIDEO_ID}`);
      const boxes = page.getByPlaceholder(/请输入主字幕|Enter main subtitle/);
      await expect(boxes.first()).toBeVisible(); await setEnglish(page, english);
      await page.getByTitle(/删除片段|Delete segment/).first().click();
      await page.getByRole('button', { name: /操作历史|Edit history/, exact: true }).click();
      await expect.poll(() => !!release).toBe(true);
      await boxes.first().fill('保存中的后续校对'); await boxes.first().blur(); release!();
      await expect(page.getByText(/初始剪辑版本|Initial cut version/)).toBeVisible();
      expect(host.calls.filter(c => c.method === 'projects.saveVideoEdits').length).toBeGreaterThanOrEqual(2);
      expect((f.saved()!.chunks as {text: string}[])[1].text).toBe('保存中的后续校对');
    });
    test('F-0005/AC-3 progress percentage stays finite before media metadata loads', async ({ page }) => {
      await prepare(page, theme); const f = fixture(); await mockHost(page, f.handlers);
      await page.goto(`/#/projects/${P}/videos/${VIDEO_ID}`);
      await expect(page.getByPlaceholder(/请输入主字幕|Enter main subtitle/).first()).toBeVisible();
      await expect(page.getByText(/100.0% 保留/)).toBeVisible();
      await expect(page.getByText(/Infinity|NaN/)).toHaveCount(0);
    });
    test('F-0005/AC-3 real player seeks join to the next retained source frame', async ({ page }) => {
      await prepare(page, theme); const f = fixture(); await connect(page, f.handlers);
      await page.goto(`/#/projects/${P}/videos/${VIDEO_ID}`);
      await expect(page.getByPlaceholder(/请输入主字幕|Enter main subtitle/).first()).toBeVisible();
      await setEnglish(page, english);
      await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThan(0);
      await page.getByTitle(/删除片段|Delete segment/).first().click();
      const progress = page.getByTestId('cut-preview-progress'); const rect = await progress.boundingBox();
      await progress.click({ position: { x: rect!.width / 8 + 2, y: rect!.height / 2 } });
      await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(3, 1);
      await shot(page, F, `preview-join-${theme}-${lang}`);
    });
    test('F-0005/AC-9 all-cut opens with empty preview and disabled export', async ({ page }) => {
      await prepare(page, theme); const f = fixture(); const opened = f.open();
      const edits = { chunks: transcript.chunks.map(c => ({ ...c, deleted: true })), deletedWordIds: [],
        editing: { edl: { version: 1, sourceDurationUs: 10e6, origin: 'explicit', deleted: [{ startUs: 0, endUs: 10e6 }] }, history: [] } };
      await connect(page, { ...f.handlers, 'projects.open': () => ({ ...opened, edits }) });
      await page.goto(`/#/projects/${P}/videos/${VIDEO_ID}`); await expect(page.getByTestId('cuts-empty')).toBeVisible();
      await setEnglish(page, english);
      await expect(page.getByText(/没有可播放的内容|No content to play/, { exact: true })).toBeVisible();
      await page.getByRole('button', { name: /导出|Export/, exact: true }).click();
      await expect(page.getByRole('menuitem', { name: /导出视频|Export Video/i })).toBeDisabled();
      await shot(page, F, `empty-cuts-${theme}-${lang}`);
    });
    test('F-0005/AC-10 invalid saved EDL blocks editing and retry reopens without overwriting data', async ({ page }) => {
      await prepare(page, theme); const f = fixture(); const opened = f.open();
      const host = await connect(page, { ...f.handlers, 'projects.open': () => ({ ...opened,
        edits: { chunks: transcript.chunks, deletedWordIds: [], editing: { edl: { version: 1, sourceDurationUs: 10e6,
          origin: 'explicit', deleted: [{ startUs: 0, endUs: 11e6 }] }, history: [] } } }) });
      await page.goto(`/#/projects/${P}/videos/${VIDEO_ID}`);
      await expect(page.getByText(/无法更新剪辑|Couldn't update cuts/, { exact: true })).toBeVisible();
      await setEnglish(page, english); await shot(page, F, `invalid-cuts-${theme}-${lang}`);
      expect(host.calls.filter(c => c.method === 'projects.saveVideoEdits')).toHaveLength(0);
      host.set('projects.open', f.open); await page.getByTestId('cut-controls').getByRole('button', { name: /重试|Retry/ }).click();
      await expect(page.getByPlaceholder(/请输入主字幕|Enter main subtitle/).first()).toHaveValue('第一句');
    });
    test('F-0005/AC-12 history empty, loading, failure and retry are visible', async ({ page }) => {
      await prepare(page, theme); const f = fixture(); const host = await connect(page, f.handlers);
      await page.goto(`/#/projects/${P}/videos/${VIDEO_ID}`);
      await expect(page.getByPlaceholder(/请输入主字幕|Enter main subtitle/).first()).toBeVisible();
      await setEnglish(page, english);
      await page.getByRole('button', { name: /操作历史|Edit history/, exact: true }).click();
      await expect(page.getByText(/暂无剪辑记录|No cut history yet/)).toBeVisible();
      await shot(page, F, `history-empty-${theme}-${lang}`);
      await page.getByRole('button', { name: /关闭|Close/, exact: true }).last().click();
      host.set('projects.open', () => pending());
      await page.getByRole('button', { name: /操作历史|Edit history/, exact: true }).click();
      await expect(page.getByText(/正在读取操作历史|Loading edit history/)).toBeVisible();
      await shot(page, F, `history-loading-${theme}-${lang}`);
      // Restart the UI to discard the deliberately unresolved read, then inject a real error.
      host.set('projects.open', f.open); await page.reload();
      await expect(page.getByPlaceholder(/请输入主字幕|Enter main subtitle/).first()).toBeVisible();
      await setEnglish(page, english);
      host.set('projects.open', () => { throw new RpcError('read failed'); });
      await page.getByRole('button', { name: /操作历史|Edit history/, exact: true }).click();
      await expect(page.getByText(/无法读取操作历史|Couldn't load edit history/)).toBeVisible();
      await shot(page, F, `history-failed-${theme}-${lang}`);
      host.set('projects.open', f.open); await page.getByRole('dialog').getByRole('button', { name: /重试|Retry/ }).click();
      await expect(page.getByText(/暂无剪辑记录|No cut history yet/)).toBeVisible();
    });
  });
}


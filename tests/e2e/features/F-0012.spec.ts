import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { mockHost, prepare, uuid, VIDEO_ID, MOCK_HOST, type MockHandlers } from '../lib/mockHost';
import { shot } from '../lib/evidence';

const P = uuid(112); const F = 'F-0012'; const T = '2026-11-09T12:00:00Z';
const transcript = { text: '项目名称很重要 第二个项目名称', language: 'zh', duration: 10, hasWordTimestamps: false,
  chunks: [
    { id: 'a', text: '项目名称很重要', timestamp: [1, 3] },
    { id: 'b', text: '第二个项目名称', timestamp: [4, 6] },
  ] };

let mediaDir: string; let media: string;
test.beforeAll(() => {
  mediaDir = mkdtempSync(join(tmpdir(), 'flycut-f0012-ui-')); media = join(mediaDir, 'marker.mp4');
  const run = spawnSync(resolve('src-tauri/binaries/ffmpeg'), ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=10',
    '-c:v', 'libx264', '-preset', 'ultrafast', media], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr);
});
test.afterAll(() => rmSync(mediaDir, { recursive: true, force: true }));

async function connect(page: Page) {
  let edits: Record<string, unknown> | undefined; let revision = 1;
  const handlers: MockHandlers = {
    'projects.open': () => ({ status: 'ok',
      project: { id: P, name: 'Proofread', formatVersion: 3, revision, styleRevision: 0, videos: [], createdAt: T, updatedAt: T },
      video: { id: VIDEO_ID, name: 'Proofread.mp4', durationSeconds: 10, revision, styleSource: 'project', hasTranscript: true,
        createdAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1, mimeType: 'video/mp4' } },
      videos: [], transcript, edits, media: { status: 'ok', name: 'Proofread.mp4', playback: { kind: 'url', path: `/projects/${P}/media/${VIDEO_ID}` } } }),
    'projects.saveVideoEdits': payload => { edits = payload.edits; revision++; return { status: 'saved', revision, projectRevision: revision, updatedAt: T }; },
    'projects.saveProjectStyle': () => ({ status: 'saved', revision: 1, projectRevision: revision, updatedAt: T }),
  };
  const host = await mockHost(page, handlers);
  await page.route(`${MOCK_HOST}/projects/**/media/**`, route => {
    const bytes = readFileSync(media); const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
    const start = range ? Number(range[1]) : 0; const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    return route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4', body: bytes.subarray(start, end + 1),
      headers: { 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1),
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) } });
  });
  return { host, saved: () => edits };
}

async function setEnglish(page: Page) {
  await page.getByRole('button', { name: '选择语言' }).click();
  await page.getByRole('menuitem', { name: /English/ }).click();
}

for (const theme of ['light', 'dark'] as const) for (const english of [false, true]) {
  const lang = english ? 'en' : 'zh';
  test.describe(`${theme}-${lang}`, () => {
    test('F-0012/AC-1 AC-2 AC-3 AC-4 AC-5 AC-6 AC-7 find, preview, replace all and undo', async ({ page }) => {
      test.setTimeout(90_000);
      await prepare(page, theme, { 'flycut-locale': lang });
      const { host, saved } = await connect(page);
      await page.goto(`/?lang=${lang}#/projects/${P}/videos/${VIDEO_ID}`);
      if (english) await setEnglish(page);
      const boxes = page.getByPlaceholder(/请输入主字幕|Enter main subtitle/);
      await expect(boxes.first()).toHaveValue('项目名称很重要');

      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
      const bar = page.getByTestId('find-replace');
      await expect(bar).toBeVisible();
      const input = page.getByTestId('find-input');
      await input.click();
      await input.fill('项目');
      await expect(page.getByTestId('find-count')).toHaveText('1/2');
      await expect(page.getByTestId('find-snippet').first()).toBeVisible();
      await shot(page, F, `find-${theme}-${lang}`);

      await page.getByTestId('find-next').click();
      await expect(page.getByTestId('find-count')).toHaveText('2/2');
      await page.getByTestId('find-previous').click();
      await expect(page.getByTestId('find-count')).toHaveText('1/2');

      await page.getByTestId('replace-input').fill('工程');
      await page.getByTestId('find-replace-one').click();
      await expect(boxes.first()).toHaveValue('工程名称很重要');
      await page.getByTitle(/撤销删除|Undo delete/i).click();
      await expect(boxes.first()).toHaveValue('项目名称很重要');

      await page.getByTestId('find-replace-all').click();
      const dialog = page.getByTestId('find-preview');
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('2');
      await shot(page, F, `replace-preview-${theme}-${lang}`);
      await page.getByTestId('find-confirm').click();
      await expect(dialog).toHaveCount(0);
      await expect(boxes.first()).toHaveValue('工程名称很重要');
      await expect(boxes.nth(1)).toHaveValue('第二个工程名称');

      await expect.poll(() => (saved()?.chunks as { text: string }[] | undefined)?.map(chunk => chunk.text))
        .toEqual(['工程名称很重要', '第二个工程名称']);
      expect(host.calls.some(call => call.method === 'projects.saveVideoEdits')).toBe(true);

      await page.getByTitle(/撤销删除|Undo delete/i).click();
      await expect(boxes.first()).toHaveValue('项目名称很重要');
      await expect(boxes.nth(1)).toHaveValue('第二个项目名称');
      await page.getByTestId('find-input').fill('不存在');
      await expect(page.getByText(/没有匹配结果|No matches/)).toBeVisible();
      await shot(page, F, `no-matches-${theme}-${lang}`);
      await page.getByTestId('find-close').click();
      await expect(bar).toHaveCount(0);
    });
  });
}

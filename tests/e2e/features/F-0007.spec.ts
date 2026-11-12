import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { mockHost, prepare, uuid, VIDEO_ID, MOCK_HOST, RpcError, type MockHandlers } from '../lib/mockHost';
import { shot } from '../lib/evidence';

const P = uuid(107); const F = 'F-0007'; const T = '2026-11-09T12:00:00Z';
const transcript = { text: '嗯我觉得很好 那个那个东西', language: 'zh', duration: 8, hasWordTimestamps: true,
  chunks: [
    { id: 'a', text: '嗯我觉得很好', timestamp: [0, 3], wordIds: ['w1', 'w2', 'w3', 'w4'] },
    { id: 'b', text: '那个那个东西', timestamp: [4, 7], wordIds: ['w5', 'w6', 'w7'] },
  ],
  wordChunks: [
    { id: 'w1', text: '嗯', timestamp: [0, 0.2], sentenceId: 'a' },
    { id: 'w2', text: '我', timestamp: [0.3, 0.5], sentenceId: 'a' },
    { id: 'w3', text: '觉得', timestamp: [0.6, 1], sentenceId: 'a' },
    { id: 'w4', text: '很好', timestamp: [1.1, 2.5], sentenceId: 'a' },
    { id: 'w5', text: '那个', timestamp: [4, 4.2], sentenceId: 'b' },
    { id: 'w6', text: '那个', timestamp: [4.25, 4.45], sentenceId: 'b' },
    { id: 'w7', text: '东西', timestamp: [4.5, 6], sentenceId: 'b' },
  ] };
const noWords = { ...transcript, hasWordTimestamps: false, wordChunks: undefined,
  chunks: transcript.chunks.map(chunk => ({ id: chunk.id, text: chunk.text, timestamp: chunk.timestamp })) };

let mediaDir: string; let media: string;
test.beforeAll(() => {
  mediaDir = mkdtempSync(join(tmpdir(), 'flycut-f0007-ui-')); media = join(mediaDir, 'marker.mp4');
  const run = spawnSync(resolve('src-tauri/binaries/ffmpeg'), ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=10',
    '-c:v', 'libx264', '-preset', 'ultrafast', media], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr);
});
test.afterAll(() => rmSync(mediaDir, { recursive: true, force: true }));

async function connect(page: Page, data = transcript, overrides: Partial<MockHandlers> = {}) {
  let edits: Record<string, unknown> | undefined; let revision = 1;
  const handlers: MockHandlers = {
    'projects.open': () => ({ status: 'ok',
      project: { id: P, name: 'Fillers', formatVersion: 3, revision, styleRevision: 0, videos: [], createdAt: T, updatedAt: T },
      video: { id: VIDEO_ID, name: 'Fillers.mp4', durationSeconds: 10, revision, styleSource: 'project', hasTranscript: true,
        createdAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1, mimeType: 'video/mp4' } },
      videos: [], transcript: data, edits, media: { status: 'ok', name: 'Fillers.mp4', playback: { kind: 'url', path: `/projects/${P}/media/${VIDEO_ID}` } } }),
    'projects.saveVideoEdits': payload => { edits = payload.edits; revision++; return { status: 'saved', revision, projectRevision: revision, updatedAt: T }; },
    'projects.saveProjectStyle': () => ({ status: 'saved', revision: 1, projectRevision: revision, updatedAt: T }),
  };
  const host = await mockHost(page, { ...handlers, ...overrides });
  await page.route(`${MOCK_HOST}/projects/**/media/**`, route => {
    const bytes = readFileSync(media); const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
    const start = range ? Number(range[1]) : 0; const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    return route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4', body: bytes.subarray(start, end + 1),
      headers: { 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1),
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) } });
  });
  return { host, saved: () => edits };
}

test('F-0007/AC-7 save failure keeps the candidates and the formal subtitles', async ({ page }) => {
  await prepare(page, 'light', { 'flycut-locale': 'zh' });
  await connect(page, transcript, { 'projects.saveVideoEdits': () => { throw new RpcError('save failed'); } });
  await page.goto(`/#/projects/${P}/videos/${VIDEO_ID}`);
  const boxes = page.getByPlaceholder(/请输入主字幕|Enter main subtitle/);
  await page.getByRole('button', { name: /^(去口癖|Remove fillers)$/ }).click();
  await expect(page.getByTestId('cut-suggestions')).toBeVisible();
  await page.getByRole('button', { name: /应用选中建议|Apply selected suggestions/ }).click();
  await expect(page.getByTestId('cut-suggestions')).toBeVisible();
  await expect(page.getByText(/应用失败|Cannot apply/)).toBeVisible();
  await expect(boxes.first()).toHaveValue('嗯我觉得很好');
});

test('F-0007/AC-6 stale suggestions never partially apply', async ({ page }) => {
  await prepare(page, 'light', { 'flycut-locale': 'zh' });
  await connect(page);
  await page.goto(`/#/projects/${P}/videos/${VIDEO_ID}`);
  await page.getByRole('button', { name: /^(去口癖|Remove fillers)$/ }).click();
  await expect(page.getByTestId('cut-suggestions')).toBeVisible();
  await page.getByTestId('pending-suggestion-item').first().getByRole('checkbox').check().catch(() => undefined);
  const first = page.getByTestId('subtitle-main-text').first();
  await first.fill('编辑后的字幕'); await first.blur();
  await page.getByRole('button', { name: /应用选中建议|Apply selected suggestions/ }).click();
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
    test('F-0007/AC-1 AC-2 AC-3 AC-4 AC-6 AC-7 AC-9 filler candidates, preview/apply and undo', async ({ page }) => {
      test.setTimeout(90_000);
      await prepare(page, theme, { 'flycut-locale': lang });
      const { host, saved } = await connect(page);
      await page.goto(`/?lang=${lang}#/projects/${P}/videos/${VIDEO_ID}`);
      if (english) await setEnglish(page);
      const boxes = page.getByPlaceholder(/请输入主字幕|Enter main subtitle/);
      await expect(boxes.first()).toHaveValue('嗯我觉得很好');
      await page.getByRole('button', { name: /^(去口癖|Remove fillers)$/ }).click();
      await expect(page.getByTestId('cut-suggestions')).toBeVisible();
      const items = page.getByTestId('pending-suggestion-item');
      await expect(items).toHaveCount(2);
      const marker = page.getByTestId('pending-cut').first();
      await expect(marker).toHaveAttribute('aria-label', /待确认删除|Pending deletion/);
      await marker.hover();
      await expect(page.getByText(/前后有停顿|Adjacent repeated/).first()).toBeVisible();
      await expect(items.nth(0).getByRole('checkbox')).toBeChecked();
      await expect(items.nth(1).getByRole('checkbox')).not.toBeChecked();
      await shot(page, F, `candidates-${theme}-${lang}`);
      await items.nth(1).getByRole('checkbox').check();
      await page.getByRole('button', { name: /预览剪辑效果|Preview proposed cuts/ }).click();
      await expect(page.getByText(/预览，尚未应用|Preview, not applied/).first()).toBeVisible();
      await page.getByRole('button', { name: /应用选中建议|Apply selected suggestions/ }).click();
      await expect(page.getByTestId('cut-suggestions')).toHaveCount(0);
      await expect(boxes.first()).toHaveValue('我觉得很好');
      await expect(boxes.nth(1)).toHaveValue('那个东西');
      await expect.poll(() => (saved()?.chunks as Array<{ text: string; isBlankSpacer?: boolean }> | undefined)
        ?.filter(chunk => !chunk.isBlankSpacer).map(chunk => chunk.text))
        .toEqual(['我觉得很好', '那个东西']);
      expect(host.calls.some(call => call.method === 'projects.saveVideoEdits')).toBe(true);
      await page.getByRole('button', { name: /操作历史|Edit history/, exact: true }).click();
      await expect(page.getByText(/确认去口癖|Apply filler cuts/)).toBeVisible();
      await page.getByRole('button', { name: /关闭|Close/, exact: true }).last().click();
      await page.getByTitle(/撤销删除|Undo delete/i).click();
      await expect(boxes.first()).toHaveValue('嗯我觉得很好');
      await expect(boxes.nth(1)).toHaveValue('那个那个东西');
    });

    test('F-0007/AC-1 gate blocks precise filler cuts without word timestamps', async ({ page }) => {
      await prepare(page, theme, { 'flycut-locale': lang });
      await connect(page, noWords);
      await page.goto(`/?lang=${lang}#/projects/${P}/videos/${VIDEO_ID}`);
      if (english) await setEnglish(page);
      await page.getByRole('button', { name: /^(去口癖|Remove fillers)$/ }).click();
      await expect(page.getByText(/缺少可靠字词时间戳|Reliable word timestamps/)).toBeVisible();
      await expect(page.getByTestId('cut-suggestions')).toHaveCount(0);
      await shot(page, F, `gate-${theme}-${lang}`);
    });
  });
}

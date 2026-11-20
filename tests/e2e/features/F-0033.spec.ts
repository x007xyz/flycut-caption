import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MOCK_HOST, mockHost, prepare, uuid, VIDEO_ID } from '../lib/mockHost';
import { shot } from '../lib/evidence';

const F = 'F-0033';
const P = uuid(330);
const T = '2026-11-16T12:00:00Z';
let mediaDir: string;
let mediaFile: string;

test.beforeAll(() => {
  mediaDir = mkdtempSync(join(tmpdir(), 'flycut-f0033-e2e-'));
  mediaFile = join(mediaDir, 'sample.mp4');
  const run = spawnSync(resolve('src-tauri/binaries/ffmpeg'),
    ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=3', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '3', '-c:v', 'libx264', '-c:a', 'aac', mediaFile],
    { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr);
});
test.afterAll(() => rmSync(mediaDir, { recursive: true, force: true }));

const chunks = [
  { id: 'c1', text: '第一句', timestamp: [0, 1] },
  { id: 'c2', text: '第二句', timestamp: [1, 2] },
  { id: 'c3', text: '第三句', timestamp: [2, 3] },
];
const languageTracks = [
  { id: 'en', name: 'English', languageCode: 'en', origin: 'manual', entries: {
    c1: { text: 'First', sourceText: '第一句', updatedAt: T }, c2: { text: 'Second', sourceText: '旧文本', updatedAt: T }, c3: { text: 'Third', sourceText: '第三句', updatedAt: T } } },
  { id: 'ja', name: 'Japanese', languageCode: 'ja', origin: 'manual', entries: {
    c1: { text: '一番', sourceText: '第一句', updatedAt: T }, c2: { text: '二番', sourceText: '第二句', updatedAt: T }, c3: { text: '三番', sourceText: '第三句', updatedAt: T } } },
];
const openPayload = () => ({
  status: 'ok',
  project: { formatVersion: 4, id: P, name: '多语导出项目', createdAt: T, updatedAt: T, revision: 1, styleRevision: 0,
    videos: [{ id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 3, createdAt: T, updatedAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1000, mimeType: 'video/mp4' }, hasTranscript: true, revision: 1, styleSource: 'project' }] },
  video: { id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 3, createdAt: T, updatedAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1000, mimeType: 'video/mp4' }, hasTranscript: true, revision: 1, styleSource: 'project' },
  transcript: { text: '第一句第二句第三句', language: 'zh', duration: 3, chunks },
  edits: { chunks, deletedWordIds: [], languageTracks, activeLanguageTrackId: 'ja' },
  media: { status: 'ok', name: 'sample.mp4', playback: { kind: 'url', path: `/projects/${P}/media/${VIDEO_ID}` } },
  videos: [{ id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 3, createdAt: T, updatedAt: T, hasTranscript: true, mediaMissing: false, hasThumbnail: false, styleSource: 'project', revision: 1 }],
});

for (const theme of ['light', 'dark'] as const) {
  for (const lang of ['zh', 'en'] as const) {
    test(`F-0033/AC-1 AC-2 AC-4 AC-5 AC-6 soft track selection and burn-in gating (${theme}-${lang})`, async ({ page }) => {
      await prepare(page, theme);
      await mockHost(page, {
        'host.info': () => ({ protocolVersion: 2, generation: 'e2e', methods: [], events: [], providers: [],
          capabilities: { projects: true, browserSession: true, cookieMedia: true, resumableUpload: true, export: true } }),
        'projects.open': () => openPayload(),
      });
      await page.route(`${MOCK_HOST}/projects/*/media/*`, async route => {
        const request = route.request();
        const headers = { 'Access-Control-Allow-Origin': request.headers().origin ?? '*', 'Access-Control-Allow-Credentials': 'true', 'Content-Type': 'video/mp4' };
        if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
        await route.fulfill({ status: 200, headers, body: readFileSync(mediaFile) });
      });
      const url = lang === 'en' ? `/?ui=en#/projects/${P}/videos/${VIDEO_ID}` : `/#/projects/${P}/videos/${VIDEO_ID}`;
      await page.goto(url);
      await page.getByRole('button', { name: lang === 'zh' ? '导出' : 'Export', exact: true }).click();
      await page.getByText(/导出视频|Export video/i).click();

      const dialog = page.getByRole('dialog');
      await expect(dialog.getByText('软烧录')).toBeVisible();
      await dialog.getByText('软烧录').first().click();
      const selector = page.getByTestId('soft-track-selector');
      await expect(selector).toBeVisible();
      await expect(selector.getByText('English')).toBeVisible();
      await expect(selector.getByText('Japanese')).toBeVisible();
      await expect(selector.getByText('1 条缺译/过期')).toBeVisible();

      const en = page.getByTestId('soft-track-en');
      const ja = page.getByTestId('soft-track-ja');
      await expect(en).toBeDisabled();
      await expect(ja).toBeChecked();
      await shot(page, F, `soft-tracks-${theme}-${lang}`);

      await page.getByTestId('soft-track-partial').check();
      await expect(en).toBeEnabled();
      await en.check();
      await shot(page, F, `partial-enabled-${theme}-${lang}`);

      await expect(dialog.getByRole('button', { name: /硬烧录/ })).toBeDisabled();
      await expect(dialog.getByText('此语言暂不支持烧录 / Burn-in is not available for this language')).toBeVisible();
      await shot(page, F, `burn-in-blocked-${theme}-${lang}`);
    });

    test(`F-0033/AC-1 AC-3 subtitle file language track selection (${theme}-${lang})`, async ({ page }) => {
      await prepare(page, theme);
      await mockHost(page, { 'projects.open': () => openPayload() });
      await page.route(`${MOCK_HOST}/projects/*/media/*`, async route => {
        const request = route.request();
        const headers = { 'Access-Control-Allow-Origin': request.headers().origin ?? '*', 'Access-Control-Allow-Credentials': 'true', 'Content-Type': 'video/mp4' };
        if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
        await route.fulfill({ status: 200, headers, body: readFileSync(mediaFile) });
      });
      const url = lang === 'en' ? `/?ui=en#/projects/${P}/videos/${VIDEO_ID}` : `/#/projects/${P}/videos/${VIDEO_ID}`;
      await page.goto(url);
      await page.getByRole('button', { name: lang === 'zh' ? '导出' : 'Export', exact: true }).click();
      await page.getByText(/导出字幕|Export subtitles/i).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: /双字幕|Bilingual/i }).click();
      await expect(dialog.getByText(/语言轨 \/ Language track/)).toBeVisible();
      await expect(dialog.getByText('Japanese')).toBeVisible();
      await dialog.getByText('Japanese').click();
      await shot(page, F, `subtitle-track-${theme}-${lang}`);
    });
  }
}

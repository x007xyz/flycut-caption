/* eslint-disable @typescript-eslint/no-explicit-any -- mock Host payloads */
import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MOCK_HOST, mockHost, prepare, RpcError, uuid, VIDEO_ID } from '../lib/mockHost';
import { shot } from '../lib/evidence';

const F = 'F-0020';
const P = uuid(200);
const T = '2026-11-16T12:00:00Z';

let mediaDir: string;
let mediaFile: string;

test.beforeAll(() => {
  mediaDir = mkdtempSync(join(tmpdir(), 'flycut-f0020-e2e-'));
  mediaFile = join(mediaDir, 'sample.mp4');
  const run = spawnSync(
    resolve('src-tauri/binaries/ffmpeg'),
    ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=4', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '4', '-c:v', 'libx264', '-c:a', 'aac', mediaFile],
    { encoding: 'utf8' },
  );
  if (run.status !== 0) throw new Error(run.stderr);
});

test.afterAll(() => rmSync(mediaDir, { recursive: true, force: true }));

const word = (id: string, text: string, start: number, end: number) => ({ id, text, timestamp: [start, end], sentenceId: 'c1' });
const words = [
  word('w1', '我', 0, 0.1), word('w2', '们', 0.1, 0.2), word('w3', '今', 0.2, 0.3), word('w4', '天', 0.3, 0.4),
  word('w5', '来', 0.4, 0.5), word('w6', '聊', 0.5, 0.6), word('w7', '聊', 0.6, 0.7), word('w8', '，', 0.7, 0.8),
  word('w9', '字', 0.8, 0.9), word('w10', '幕', 0.9, 1.0), word('w11', '断', 1.0, 1.1), word('w12', '句', 1.1, 1.2),
  word('w13', '的', 1.2, 1.3), word('w14', '问', 1.3, 1.4), word('w15', '题', 1.4, 1.5), word('w16', '。', 1.5, 1.6),
];
const longChunk = { id: 'c1', text: '我们今天来聊聊，字幕断句的问题。', timestamp: [0, 1.6], wordIds: words.map(item => item.id) };
const noWordChunk = { id: 'c2', text: '这一段字幕没有字词时间戳，所以不能安全拆分。', timestamp: [2, 4] };

const openPayload = (chunks: any[], wordChunks: any[], revision = 0) => ({
  status: 'ok',
  project: {
    formatVersion: 4, id: P, name: '断句测试项目', createdAt: T, updatedAt: T, revision: revision + 1, styleRevision: 0,
    videos: [{ id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 4, createdAt: T, updatedAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1000, mimeType: 'video/mp4' }, hasTranscript: true, revision, styleSource: 'project' }],
  },
  video: { id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 4, createdAt: T, updatedAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1000, mimeType: 'video/mp4' }, hasTranscript: true, revision, styleSource: 'project' },
  transcript: { text: chunks.map((chunk: any) => chunk.text).join(''), language: 'zh', duration: 4, chunks, ...(wordChunks.length ? { wordChunks, hasWordTimestamps: true } : {}) },
  edits: { chunks, deletedWordIds: [] },
  media: { status: 'ok', name: 'sample.mp4', playback: { kind: 'url', path: `/projects/${P}/media/${VIDEO_ID}` } },
  videos: [{ id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 4, createdAt: T, updatedAt: T, hasTranscript: true, mediaMissing: false, hasThumbnail: false, styleSource: 'project', revision: 0 }],
});

async function boot(page: import('@playwright/test').Page, theme: 'light' | 'dark', lang: 'zh' | 'en',
  initialChunks: any[], initialWords: any[], options: { saveFails?: boolean } = {}) {
  await prepare(page, theme);
  const entryUrl = lang === 'en' ? `/?ui=en#/projects/${P}/videos/${VIDEO_ID}` : `/#/projects/${P}/videos/${VIDEO_ID}`;
  const calls: any[] = [];
  let fixture = { chunks: initialChunks, words: initialWords };
  let saveAttempt = 0;
  let revision = 0;
  let rejectFirst: (() => void) | null = null;
  await mockHost(page, {
    'projects.open': () => openPayload(fixture.chunks, fixture.words, revision),
    'projects.saveVideoEdits': (payload: any) => {
      saveAttempt += 1;
      calls.push(payload);
      if (options.saveFails && saveAttempt === 1) {
        return new Promise((_, reject) => { rejectFirst = () => reject(new RpcError('磁盘只读')); });
      }
      revision += 1;
      fixture = { ...fixture, chunks: payload.edits.chunks };
      return { status: 'saved', revision, projectRevision: revision + 1, updatedAt: T };
    },
  });
  await page.route(`${MOCK_HOST}/projects/*/media/*`, async route => {
    const request = route.request();
    const headers = { 'Access-Control-Allow-Origin': request.headers().origin ?? '*', 'Access-Control-Allow-Credentials': 'true', 'Content-Type': 'video/mp4' };
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    await route.fulfill({ status: 200, headers, body: readFileSync(mediaFile) });
  });
  await page.goto(entryUrl);
  return {
    calls,
    failFirstSave: () => rejectFirst?.(),
    setFixture: async (chunks: any[], nextWords: any[]) => {
      fixture = { chunks, words: nextWords };
      await page.reload();
    },
  };
}

for (const theme of ['light', 'dark'] as const) {
  for (const lang of ['zh', 'en'] as const) {
    test(`F-0020/AC-1 AC-2 AC-5 AC-6 AC-7 AC-8 split preview, edit, failure retry and completion (${theme}-${lang})`, async ({ page }) => {
      const { calls, failFirstSave } = await boot(page, theme, lang, [longChunk, noWordChunk], words, { saveFails: true });
      const zh = lang === 'zh';
      await page.getByTestId('sentence-split-open').click();
      const panel = page.getByTestId('sentence-split-panel');
      await expect(panel).toBeVisible();
      await expect(panel.getByTestId('sentence-split-none')).toBeVisible();
      await panel.getByTestId('sentence-split-max').fill('10');
      await expect(panel.getByTestId('sentence-split-suggestion')).toHaveCount(1);
      await expect(panel.getByTestId('sentence-split-skipped')).toContainText(zh ? '已跳过 1 句' : '1 skipped');
      await shot(page, F, `ready-${theme}-${lang}`);

      await panel.getByTestId('sentence-split-max').fill('10');
      await expect(panel.getByTestId('sentence-split-suggestion')).toHaveCount(1);

      const firstPiece = panel.getByTestId('sentence-split-piece').first();
      await firstPiece.fill('');
      await expect(panel.getByRole('alert')).toContainText(zh ? '文字不能为空' : 'Text cannot be empty');
      await expect(panel.getByTestId('sentence-split-apply')).toBeDisabled();
      await shot(page, F, `invalid-${theme}-${lang}`);
      await firstPiece.fill('我们今天来聊聊，');

      await panel.getByTestId('sentence-split-keep').check();
      await expect(panel.getByTestId('sentence-split-apply')).toBeDisabled();
      await panel.getByTestId('sentence-split-keep').uncheck();
      await expect(panel.getByTestId('sentence-split-apply')).toBeEnabled();

      await panel.getByTestId('sentence-split-apply').click();
      await expect(panel.getByTestId('sentence-split-applying')).toBeVisible();
      await expect(panel.getByTestId('sentence-split-apply')).toHaveCount(0);
      await shot(page, F, `applying-${theme}-${lang}`);
      failFirstSave();
      await expect(panel.getByTestId('sentence-split-error')).toBeVisible();
      await shot(page, F, `error-${theme}-${lang}`);
      await panel.getByTestId('sentence-split-retry').click();
      await expect(panel.getByTestId('sentence-split-completed')).toContainText(zh ? '已完成' : 'Completed');
      await shot(page, F, `completed-${theme}-${lang}`);

      const saved = calls.at(-1);
      expect(saved).toBeTruthy();
      expect(Array.isArray(saved.edits.chunks)).toBe(true);
      expect(saved.edits.chunks.length).toBeGreaterThan(1);
      expect(saved.edits.deletedWordIds).toEqual([]);
    });

    test(`F-0020/AC-3 AC-8 stale analysis blocks overwriting changed subtitles (${theme}-${lang})`, async ({ page }) => {
      await boot(page, theme, lang, [longChunk], words);
      const zh = lang === 'zh';
      await page.getByTestId('sentence-split-open').click();
      const panel = page.getByTestId('sentence-split-panel');
      await panel.getByTestId('sentence-split-max').fill('10');
      await expect(panel.getByTestId('sentence-split-suggestion')).toHaveCount(1);

      await page.getByTestId('subtitle-main-text').fill(zh ? '改短了' : 'short now');
      await page.getByTestId('subtitle-main-text').press('Tab');
      await panel.getByTestId('sentence-split-apply').click();
      await expect(panel.getByTestId('sentence-split-stale')).toContainText(zh ? '字幕已更新，请重新检查' : 'Subtitles changed. Review again.');
      await expect(page.getByTestId('subtitle-main-text')).toHaveCount(1);
      await shot(page, F, `stale-${theme}-${lang}`);

      await panel.getByTestId('sentence-split-analyze-again').click();
      await expect(panel.getByTestId('sentence-split-none')).toBeVisible();
      await shot(page, F, `none-${theme}-${lang}`);
    });

    test(`F-0020/AC-5 empty and missing word timestamps states (${theme}-${lang})`, async ({ page }) => {
      const { setFixture } = await boot(page, theme, lang, [noWordChunk], []);
      const zh = lang === 'zh';
      await page.getByTestId('sentence-split-open').click();
      await expect(page.getByTestId('sentence-split-no-words')).toContainText(zh ? '没有字词时间戳' : 'no word timestamps');
      await shot(page, F, `no-words-${theme}-${lang}`);

      await setFixture([], []);
      await page.getByTestId('sentence-split-open').click();
      await expect(page.getByTestId('sentence-split-empty')).toContainText(zh ? '暂无内容' : 'Nothing here yet');
      await shot(page, F, `empty-${theme}-${lang}`);
    });
  }
}

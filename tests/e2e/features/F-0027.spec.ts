/* eslint-disable @typescript-eslint/no-explicit-any -- mock Host payloads */
import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MOCK_HOST, mockHost, prepare, RpcError, uuid, VIDEO_ID } from '../lib/mockHost';
import { shot } from '../lib/evidence';

const F = 'F-0027';
const P = uuid(270);
const T = '2026-11-16T12:00:00Z';

let mediaDir: string;
let mediaFile: string;

test.beforeAll(() => {
  mediaDir = mkdtempSync(join(tmpdir(), 'flycut-f0027-e2e-'));
  mediaFile = join(mediaDir, 'sample.mp4');
  const run = spawnSync(resolve('src-tauri/binaries/ffmpeg'),
    ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=1', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '1', '-c:v', 'libx264', '-c:a', 'aac', mediaFile],
    { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr);
});
test.afterAll(() => rmSync(mediaDir, { recursive: true, force: true }));

const transcript = { text: '测试字幕', language: 'zh', duration: 1, chunks: [{ id: 'c1', text: '测试字幕', timestamp: [0, 1] }] };
const openPayload = () => ({
  status: 'ok',
  project: { formatVersion: 4, id: P, name: '预设测试项目', createdAt: T, updatedAt: T, revision: 1, styleRevision: 0,
    videos: [{ id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 1, createdAt: T, updatedAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1000, mimeType: 'video/mp4' }, hasTranscript: true, revision: 0, styleSource: 'project' }] },
  video: { id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 1, createdAt: T, updatedAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1000, mimeType: 'video/mp4' }, hasTranscript: true, revision: 0, styleSource: 'project' },
  transcript,
  edits: { chunks: transcript.chunks, deletedWordIds: [] },
  media: { status: 'ok', name: 'sample.mp4', playback: { kind: 'url', path: `/projects/${P}/media/${VIDEO_ID}` } },
  videos: [{ id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 1, createdAt: T, updatedAt: T, hasTranscript: true, mediaMissing: false, hasThumbnail: false, styleSource: 'project', revision: 0 }],
});
const style = (patch: Record<string, unknown> = {}) => ({ fontId: 'noto-sans-sc', color: '#FFFFFF', borderColor: '#000000', borderWidth: 2, ...patch });
const preset = (id: string, name: string, patch: Record<string, unknown> = {}) => ({
  id, name, primary: style(patch), secondary: style(), createdAt: T, updatedAt: T,
});

async function boot(page: import('@playwright/test').Page, theme: 'light' | 'dark', lang: 'zh' | 'en', initialPresets: any[],
  options: { gateLoad?: boolean; conflictOnce?: boolean } = {}) {
  await prepare(page, theme);
  const entryUrl = lang === 'en' ? `/?ui=en#/projects/${P}/videos/${VIDEO_ID}` : `/#/projects/${P}/videos/${VIDEO_ID}`;
  let presets = [...initialPresets];
  let revision = initialPresets.length ? 1 : 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let failNext = false;
  let conflictOnce = options.conflictOnce ?? false;
  const host = await mockHost(page, {
    'projects.open': () => openPayload(),
    'projects.getStylePresets': async ({ projectId }: any) => {
      if (options.gateLoad) await gate;
      return { projectId, revision, presets };
    },
    'projects.saveStylePresets': (payload: any) => {
      if (failNext) { failNext = false; throw new RpcError('磁盘只读'); }
      if (conflictOnce) {
        conflictOnce = false;
        revision += 1;
        return { status: 'conflict', revision, updatedAt: T, presets };
      }
      revision += 1;
      presets = payload.presets.map((item: any, index: number) => ({
        id: item.id ?? uuid(2700 + index), name: item.name, primary: item.primary, secondary: item.secondary,
        createdAt: T, updatedAt: T,
      }));
      return { status: 'saved', revision, projectRevision: revision, updatedAt: T, presets };
    },
  });
  await page.route(`${MOCK_HOST}/projects/*/media/*`, async route => {
    const request = route.request();
    const headers = { 'Access-Control-Allow-Origin': request.headers().origin ?? '*', 'Access-Control-Allow-Credentials': 'true', 'Content-Type': 'video/mp4' };
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    await route.fulfill({ status: 200, headers, body: readFileSync(mediaFile) });
  });
  await page.goto(entryUrl);
  return { host, release, failNextSave: () => { failNext = true; }, presets: () => presets, revision: () => revision };
}

for (const theme of ['light', 'dark'] as const) {
  for (const lang of ['zh', 'en'] as const) {
    test(`F-0027/AC-1 AC-2 AC-3 AC-5 AC-6 AC-7 AC-8 preset lifecycle (${theme}-${lang})`, async ({ page }) => {
      const zh = lang === 'zh';
      const { release, failNextSave } = await boot(page, theme, lang, [], { gateLoad: true });
      const section = page.getByTestId('custom-presets-section');
      await expect(section).toBeVisible();
      await expect(section.getByTestId('custom-preset-loading')).toBeVisible();
      await shot(page, F, `loading-${theme}-${lang}`);
      release();
      await expect(section.getByTestId('custom-preset-empty')).toBeVisible();
      await shot(page, F, `empty-${theme}-${lang}`);

      await section.getByTestId('custom-preset-save-open').click();
      await section.getByTestId('custom-preset-name').fill('Night');
      await expect(section.getByTestId('custom-preset-form')).toBeVisible();
      await section.getByTestId('custom-preset-save').click();
      await expect(section.getByTestId('custom-preset-notice')).toContainText(zh ? '已完成' : 'Completed');
      await expect(section.getByTestId('custom-preset-item')).toHaveCount(1);
      await shot(page, F, `saved-${theme}-${lang}`);

      await section.getByTestId('custom-preset-save-open').click();
      await section.getByTestId('custom-preset-name').fill('night');
      await section.getByTestId('custom-preset-save').click();
      await expect(section.getByTestId('custom-preset-overwrite')).toBeVisible();
      await section.getByTestId('custom-preset-overwrite-confirm').click();
      await expect(section.getByTestId('custom-preset-item')).toHaveCount(1);
      await shot(page, F, `overwrite-${theme}-${lang}`);

      await section.getByTestId('custom-preset-apply').click();
      await expect(section.getByTestId('custom-preset-notice')).toContainText(zh ? '已应用到当前样式' : 'Applied to the current style');

      await section.getByTestId('custom-preset-delete').click();
      await expect(section.getByTestId('custom-preset-confirm-delete')).toBeVisible();
      await shot(page, F, `delete-confirm-${theme}-${lang}`);
      await section.getByTestId('custom-preset-confirm-delete').click();
      await expect(section.getByTestId('custom-preset-empty')).toBeVisible();
      await expect(section.getByTestId('custom-preset-notice')).toContainText(zh ? '预设已删除' : 'Preset deleted');

      await section.getByTestId('custom-preset-save-open').click();
      await section.getByTestId('custom-preset-name').fill('Retry');
      failNextSave();
      await section.getByTestId('custom-preset-save').click();
      await expect(section.getByTestId('custom-preset-error')).toBeVisible();
      await shot(page, F, `error-${theme}-${lang}`);
      await section.getByTestId('custom-preset-retry').click();
      await expect(section.getByTestId('custom-preset-item')).toHaveCount(1);
    });

    test(`F-0027/AC-4 AC-8 conflict reload and missing font fallback (${theme}-${lang})`, async ({ page }) => {
      const zh = lang === 'zh';
      const { release } = await boot(page, theme, lang, [preset('p1', 'Old', { fontId: 'missing-font' })], { conflictOnce: true });
      release();
      const section = page.getByTestId('custom-presets-section');
      await expect(section.getByTestId('custom-preset-item')).toHaveCount(1);

      await section.getByTestId('custom-preset-save-open').click();
      await section.getByTestId('custom-preset-name').fill('New');
      await section.getByTestId('custom-preset-save').click();
      await expect(section.getByTestId('custom-preset-stale')).toContainText(zh ? '内容已更新，请重新检查' : 'Content changed. Review again.');
      await shot(page, F, `stale-${theme}-${lang}`);
      await section.getByTestId('custom-preset-reload').click();
      await expect(section.getByTestId('custom-preset-item')).toHaveCount(1);

      await section.getByTestId('custom-preset-apply').click();
      await expect(section.getByTestId('custom-preset-notice')).toContainText(zh ? '已保留当前字体' : 'current font was kept');
      await shot(page, F, `font-missing-${theme}-${lang}`);
    });
  }
}

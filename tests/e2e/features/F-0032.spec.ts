/* eslint-disable @typescript-eslint/no-explicit-any -- mock Host payloads */
import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MOCK_HOST, mockHost, prepare, uuid, VIDEO_ID } from '../lib/mockHost';
import { shot } from '../lib/evidence';

const F = 'F-0032';
const P = uuid(320);
const T = '2026-11-16T12:00:00Z';
let mediaDir: string;
let mediaFile: string;

test.beforeAll(() => {
  mediaDir = mkdtempSync(join(tmpdir(), 'flycut-f0032-e2e-'));
  mediaFile = join(mediaDir, 'sample.mp4');
  const run = spawnSync(resolve('src-tauri/binaries/ffmpeg'),
    ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=2', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '2', '-c:v', 'libx264', '-c:a', 'aac', mediaFile],
    { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr);
});
test.afterAll(() => rmSync(mediaDir, { recursive: true, force: true }));

const term = { id: 't1', term: '字幕', asHotword: true, translations: { en: 'Subtitle' }, updatedAt: T };
const chunks = [{ id: 'c1', text: 'FlyCut 的字幕工具支持术语表。', timestamp: [0, 2] }];
const openPayload = () => ({
  status: 'ok',
  project: { formatVersion: 4, id: P, name: '术语测试项目', createdAt: T, updatedAt: T, revision: 1, styleRevision: 0,
    terminology: [term], terminologyRevision: 3,
    videos: [{ id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 2, createdAt: T, updatedAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1000, mimeType: 'video/mp4' }, hasTranscript: true, revision: 0, styleSource: 'project' }] },
  video: { id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 2, createdAt: T, updatedAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1000, mimeType: 'video/mp4' }, hasTranscript: true, revision: 0, styleSource: 'project' },
  transcript: { text: chunks[0].text, language: 'zh', duration: 2, chunks },
  edits: { chunks, deletedWordIds: [] },
  media: { status: 'ok', name: 'sample.mp4', playback: { kind: 'url', path: `/projects/${P}/media/${VIDEO_ID}` } },
  videos: [{ id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 2, createdAt: T, updatedAt: T, hasTranscript: true, mediaMissing: false, hasThumbnail: false, styleSource: 'project', revision: 0 }],
});

for (const theme of ['light', 'dark'] as const) {
  for (const lang of ['zh', 'en'] as const) {
    test(`F-0032/AC-1 AC-3 glossary translations and version display (${theme}-${lang})`, async ({ page }) => {
      await prepare(page, theme);
      let terms = [term];
      let revision = 3;
      await mockHost(page, {
        'projects.open': () => openPayload(),
        'projects.getTerminology': () => ({ projectId: P, revision, terminology: terms }),
        'projects.saveTerminology': (payload: any) => {
          revision += 1;
          terms = payload.terms.map((item: any, index: number) => ({ id: item.id ?? `t${index}`, term: item.term,
            asHotword: item.asHotword, ...(item.translations ? { translations: item.translations } : {}), updatedAt: T }));
          return { status: 'saved', revision, projectRevision: revision, updatedAt: T, terminology: terms };
        },
        'providers.models': () => [{ provider: { id: 'sherpa-onnx', name: 'sherpa-onnx', kind: 'builtin' },
          models: [{ id: 'sensevoice', name: 'SenseVoice', role: 'asr', languages: ['auto'], timestampLevel: 'word', status: 'ready' }] }],
      });
      await page.route(`${MOCK_HOST}/projects/*/media/*`, async route => {
        const request = route.request();
        const headers = { 'Access-Control-Allow-Origin': request.headers().origin ?? '*', 'Access-Control-Allow-Credentials': 'true', 'Content-Type': 'video/mp4' };
        if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
        await route.fulfill({ status: 200, headers, body: readFileSync(mediaFile) });
      });
      const url = lang === 'en' ? `/?ui=en#/projects/${P}/videos/${VIDEO_ID}` : `/#/projects/${P}/videos/${VIDEO_ID}`;
      await page.goto(url);

      await page.getByRole('button', { name: lang === 'zh' ? '选项' : 'Options', exact: true }).click();
      await page.getByRole('button', { name: lang === 'zh' ? '管理热词' : 'Manage hotwords' }).click();
      const dialog = page.getByTestId('hotwords-dialog');
      await expect(dialog.getByTestId('hotword-translation-t1-en')).toContainText('en:Subtitle');
      await shot(page, F, `glossary-chip-${theme}-${lang}`);

      await dialog.getByRole('button', { name: lang === 'zh' ? '编辑 字幕' : 'Edit 字幕' }).click();
      await expect(dialog.getByTestId('hotword-translations-input')).toHaveValue('en=Subtitle');
      await dialog.getByTestId('hotword-translations-input').fill('en=Caption\nja=字幕');
      await dialog.getByRole('button', { name: lang === 'zh' ? '更新' : 'Update' }).click();
      await expect(dialog.getByTestId('hotword-translation-t1-ja')).toContainText('ja:字幕');
      await dialog.getByRole('button', { name: lang === 'zh' ? '保存词表' : 'Save hotwords' }).click();
      await expect(dialog.getByText(lang === 'zh' ? '已完成' : 'Completed')).toBeVisible();
      await shot(page, F, `glossary-saved-${theme}-${lang}`);
      await dialog.getByRole('button', { name: lang === 'zh' ? '关闭' : 'Close', exact: true }).first().click();

      await page.getByTestId('translation-open').click();
      await expect(page.getByTestId('translation-terminology-version')).toContainText(/术语表 v4 · 1 条|Glossary v4 · 1 terms/);
      await shot(page, F, `translation-version-${theme}-${lang}`);
    });
  }
}

import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MOCK_HOST, mockHost, prepare, uuid, VIDEO_ID } from '../lib/mockHost';
import { shot } from '../lib/evidence';

const F = 'F-0037';
const P = uuid(370);
const T = '2026-11-17T00:00:00Z';
let mediaDir: string; let mediaFile: string;
test.beforeAll(() => {
  mediaDir = mkdtempSync(join(tmpdir(), 'flycut-f0037-e2e-'));
  mediaFile = join(mediaDir, 'sample.mp4');
  spawnSync(resolve('src-tauri/binaries/ffmpeg'), ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=4',
    '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '4', '-c:v', 'libx264', '-c:a', 'aac', mediaFile]);
});
test.afterAll(() => rmSync(mediaDir, { recursive: true, force: true }));

const chunks = [{ id: 'c1', text: '第一句', timestamp: [0, 2] }, { id: 'c2', text: '第二句', timestamp: [2, 4] }];
const dubbings = ['c1', 'c2'].map((chunkId, index) => ({ id: uuid(3710 + index), trackId: 'en', chunkId,
  file: `dubbing/${uuid(3710 + index)}.wav`, mimeType: 'audio/wav', format: 'wav', byteLength: 1000,
  durationSeconds: 2, cueDurationSeconds: 2, text: index ? 'Second' : 'First', model: { providerId: 'x', modelId: 'y' },
  language: 'en', createdAt: T }));
const separation = { id: uuid(3720), model: { providerId: 'demucs-local', modelId: 'htdemucs' },
  vocalsFile: `separation/${uuid(3720)}/vocals.wav`, backgroundFile: `separation/${uuid(3720)}/background.wav`,
  durationSeconds: 4, sampleRate: 44100, sourceFingerprint: 'x', createdAt: T };
const openPayload = () => ({
  status: 'ok',
  project: { formatVersion: 4, id: P, name: '混音导出测试', createdAt: T, updatedAt: T, revision: 1, styleRevision: 0,
    videos: [{ id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 4, createdAt: T, updatedAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1000, mimeType: 'video/mp4' }, hasTranscript: true, revision: 1, styleSource: 'project' }] },
  video: { id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 4, createdAt: T, updatedAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1000, mimeType: 'video/mp4' }, hasTranscript: true, revision: 1, styleSource: 'project' },
  transcript: { text: '第一句第二句', language: 'zh', duration: 4, chunks },
  edits: { chunks, deletedWordIds: [], dubbings, separation, languageTracks: [{ id: 'en', name: 'English', languageCode: 'en', origin: 'manual',
    entries: { c1: { text: 'First', sourceText: '第一句', updatedAt: T }, c2: { text: 'Second', sourceText: '第二句', updatedAt: T } } }], activeLanguageTrackId: 'en' },
  media: { status: 'ok', name: 'sample.mp4', playback: { kind: 'url', path: `/projects/${P}/media/${VIDEO_ID}` } },
  videos: [{ id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 4, createdAt: T, updatedAt: T, hasTranscript: true, mediaMissing: false, hasThumbnail: false, styleSource: 'project', revision: 1 }],
});

for (const theme of ['light', 'dark'] as const) {
  for (const lang of ['zh', 'en'] as const) {
    test(`F-0037/AC-1 AC-3 audio modes are offered with dubbing and background (${theme}-${lang})`, async ({ page }) => {
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
      const selector = page.getByTestId('audio-mode-selector');
      await expect(selector).toBeVisible();
      await expect(selector.getByText('配音+背景')).toBeEnabled();
      await selector.getByText('配音+背景').click();
      await expect(selector.getByText(/AI 配音标注/)).toBeVisible();
      await shot(page, F, `audio-modes-${theme}-${lang}`);
    });
  }
}

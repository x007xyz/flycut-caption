/* eslint-disable @typescript-eslint/no-explicit-any -- mock Host payloads */
import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MOCK_HOST, mockHost, prepare, uuid, VIDEO_ID } from '../lib/mockHost';
import { shot } from '../lib/evidence';

const F = 'F-0036';
const P = uuid(360);
const T = '2026-11-17T00:00:00Z';
let mediaDir: string;
let mediaFile: string;

test.beforeAll(() => {
  mediaDir = mkdtempSync(join(tmpdir(), 'flycut-f0036-e2e-'));
  mediaFile = join(mediaDir, 'sample.mp4');
  const run = spawnSync(resolve('src-tauri/binaries/ffmpeg'),
    ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=3', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '3', '-c:v', 'libx264', '-c:a', 'aac', mediaFile],
    { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr);
});
test.afterAll(() => rmSync(mediaDir, { recursive: true, force: true }));

const chunks = [{ id: 'c1', text: '第一句', timestamp: [0, 1] }, { id: 'c2', text: '第二句', timestamp: [1, 2] }];
const tracks = [{ id: 'en', name: 'English', languageCode: 'en', origin: 'manual', entries: {
  c1: { text: 'First cue', sourceText: '第一句', updatedAt: T }, c2: { text: 'Second cue', sourceText: '第二句', updatedAt: T } } }];
const openPayload = () => ({
  status: 'ok',
  project: { formatVersion: 4, id: P, name: '整段配音测试', createdAt: T, updatedAt: T, revision: 1, styleRevision: 0,
    videos: [{ id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 3, createdAt: T, updatedAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1000, mimeType: 'video/mp4' }, hasTranscript: true, revision: 0, styleSource: 'project' }] },
  video: { id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 3, createdAt: T, updatedAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1000, mimeType: 'video/mp4' }, hasTranscript: true, revision: 0, styleSource: 'project' },
  transcript: { text: '第一句第二句', language: 'zh', duration: 3, chunks },
  edits: { chunks, deletedWordIds: [], languageTracks: tracks, activeLanguageTrackId: 'en' },
  media: { status: 'ok', name: 'sample.mp4', playback: { kind: 'url', path: `/projects/${P}/media/${VIDEO_ID}` } },
  videos: [{ id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 3, createdAt: T, updatedAt: T, hasTranscript: true, mediaMissing: false, hasThumbnail: false, styleSource: 'project', revision: 0 }],
});

for (const theme of ['light', 'dark'] as const) {
  for (const lang of ['zh', 'en'] as const) {
    test(`F-0036/AC-1 AC-2 AC-5 AC-6 AC-7 AC-8 track dubbing progress and unresolved result (${theme}-${lang})`, async ({ page }) => {
      await prepare(page, theme);
      let jobCalls = 0;
      let shortened = false;
      await mockHost(page, {
        'providers.models': () => [{ provider: { id: 'flycut:tts', name: 'TTS Reference', kind: 'endpoint' },
          models: [{ id: 'kokoro-demo', name: 'Kokoro Reference', role: 'tts', status: 'ready', languages: ['zh', 'en'],
            tts: { voices: [{ id: 'af_heart', name: 'Heart' }], voiceCloning: false, durationControl: true, outputFormats: ['wav'] } }] }],
        'aiSettings.list': () => ({ hostId: '00000000-0000-4000-8000-0000000000cc', revision: 1, selectedId: uuid(3699),
          configs: [{ id: uuid(3699), name: 'AI Fixture', baseUrl: 'http://127.0.0.1:9999/v1', model: 'fixture', hasApiKey: true }] }),
        'tts.getSettings': () => ({ hostId: '00000000-0000-4000-8000-0000000000cc', revision: 0, selectedModel: null, voiceId: null, language: 'auto', speed: 1, options: {}, lastAudition: null }),
        'projects.open': () => openPayload(),
        'dubbing.alignTrack': () => ({ id: uuid(3600 + jobCalls), status: 'running' }),
        'text.shorten': () => ({ id: 'shorten-job', status: 'running' }),
        'projects.saveVideoEdits': () => ({ status: 'saved', revision: 2, projectRevision: 2, updatedAt: T }),
        'jobs.get': ({ id }: any) => {
          if (id === 'shorten-job') return { id, status: 'complete', result: [{ id: 'c2', text: 'Shorter cue' }] };
          jobCalls += 1;
          if (!shortened && jobCalls < 2) return { id, status: 'running', progress: { status: 'running', progress: 50, data: '整段配音 1/2' } };
          return { id, status: 'complete', result: { status: 'saved',
            artifacts: [{ id: uuid(3601 + jobCalls), trackId: 'en', chunkId: 'c1' }, { id: uuid(3602 + jobCalls), trackId: 'en', chunkId: 'c2' }],
            unresolved: shortened ? [] : [{ chunkId: 'c2', reason: 'too-long', message: '1.60s > 1.00s' }],
            videoRevision: 2, projectRevision: 2, updatedAt: T } };
        },
      });
      await page.route(`${MOCK_HOST}/projects/*/media/*`, async route => {
        const request = route.request();
        const headers = { 'Access-Control-Allow-Origin': request.headers().origin ?? '*', 'Access-Control-Allow-Credentials': 'true', 'Content-Type': 'video/mp4' };
        if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
        await route.fulfill({ status: 200, headers, body: readFileSync(mediaFile) });
      });
      const url = lang === 'en' ? `/?ui=en#/projects/${P}/videos/${VIDEO_ID}` : `/#/projects/${P}/videos/${VIDEO_ID}`;
      await page.goto(url);
      await page.getByTestId('track-dubbing-open').click();
      const panel = page.getByTestId('track-dubbing-panel');
      await expect(panel).toBeVisible();
      await expect(panel.getByText('2 条已确认译文')).toBeVisible();
      await shot(page, F, `ready-${theme}-${lang}`);
      await panel.getByTestId('track-dubbing-start').click();
      await expect(panel.getByTestId('track-dubbing-completed')).toContainText('已完成');
      await expect(panel.getByTestId('track-dubbing-unresolved')).toContainText('1 条未解决');
      await shot(page, F, `completed-${theme}-${lang}`);
      await panel.getByTestId('track-dubbing-shorten-c2').click();
      await expect(panel.getByText('建议：Shorter cue')).toBeVisible();
      shortened = true;
      await panel.getByTestId('track-dubbing-apply-c2').click();
      await expect(panel.getByTestId('track-dubbing-cue-c2')).not.toContainText('未解决');
      await shot(page, F, `shortened-${theme}-${lang}`);
    });
  }
}

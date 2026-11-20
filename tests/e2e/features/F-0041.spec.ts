/* eslint-disable @typescript-eslint/no-explicit-any -- mock Host payloads */
import { expect, test } from '@playwright/test';
import { prepare, mockHost, uuid, VIDEO_ID } from '../lib/mockHost';
import { shot } from '../lib/evidence';

const F = 'F-0041';
const P = uuid(410);
const T = '2026-11-17T00:00:00Z';
const record = { id: uuid(4101), model: { providerId: 'demucs-local', modelId: 'htdemucs' },
  vocalsFile: 'separation/' + uuid(4101) + '/vocals.wav', backgroundFile: 'separation/' + uuid(4101) + '/background.wav',
  durationSeconds: 20, sampleRate: 44100, sourceFingerprint: 'x', createdAt: T };
const openPayload = (separation?: any) => ({
  status: 'ok',
  project: { formatVersion: 4, id: P, name: '人声分离测试', createdAt: T, updatedAt: T, revision: 1, styleRevision: 0,
    videos: [{ id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 20, createdAt: T, updatedAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1000, mimeType: 'video/mp4' }, hasTranscript: true, revision: 1, styleSource: 'project' }] },
  video: { id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 20, createdAt: T, updatedAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1000, mimeType: 'video/mp4' }, hasTranscript: true, revision: 1, styleSource: 'project' },
  transcript: { text: '测试', language: 'zh', duration: 20, chunks: [{ id: 'c1', text: '测试', timestamp: [0, 20] }] },
  edits: { chunks: [{ id: 'c1', text: '测试', timestamp: [0, 20] }], deletedWordIds: [], ...(separation ? { separation } : {}) },
  media: { status: 'ok', name: 'sample.mp4', playback: { kind: 'url', path: `/projects/${P}/media/${VIDEO_ID}` } },
  videos: [{ id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 20, createdAt: T, updatedAt: T, hasTranscript: true, mediaMissing: false, hasThumbnail: false, styleSource: 'project', revision: 1 }],
});

for (const theme of ['light', 'dark'] as const) {
  for (const lang of ['zh', 'en'] as const) {
    test(`F-0041/AC-1 AC-2 AC-3 AC-5 AC-6 AC-7 separation panel and cached result (${theme}-${lang})`, async ({ page }) => {
      await prepare(page, theme);
      let saved = false;
      await mockHost(page, {
        'providers.models': () => [{ provider: { id: 'demucs-local', name: 'Demucs 本地', kind: 'builtin' },
          models: [{ id: 'htdemucs', name: 'HTDemucs', role: 'separation', status: 'ready', offline: true }] }],
        'projects.open': () => openPayload(saved ? record : undefined),
        'separation.analyze': () => ({ id: uuid(4102), status: 'running' }),
        'jobs.get': ({ id }: any) => { saved = true; return { id, status: 'complete', result: { status: 'saved', record, videoRevision: 2, projectRevision: 2, updatedAt: T } }; },
      });
      const url = lang === 'en' ? `/?ui=en#/projects/${P}/videos/${VIDEO_ID}` : `/#/projects/${P}/videos/${VIDEO_ID}`;
      await page.goto(url);
      await page.getByTestId('separation-open').click();
      const panel = page.getByTestId('separation-panel');
      await expect(panel).toBeVisible();
      await shot(page, F, `ready-${theme}-${lang}`);
      await panel.getByTestId('separation-analyze').click();
      await expect(panel.getByTestId('separation-completed')).toContainText('已完成');
      await expect(panel.getByTestId('separation-play-vocals')).toBeVisible();
      await expect(panel.getByTestId('separation-play-background')).toBeVisible();
      await shot(page, F, `completed-${theme}-${lang}`);
    });
  }
}

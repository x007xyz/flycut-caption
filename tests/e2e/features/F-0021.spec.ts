/* eslint-disable @typescript-eslint/no-explicit-any -- mock Host payloads */
import { expect, test } from '@playwright/test';
import { prepare, mockHost, uuid, VIDEO_ID } from '../lib/mockHost';
import { shot } from '../lib/evidence';

const F = 'F-0021';
const P = uuid(210);
const T = '2026-11-17T00:00:00Z';
const SEGMENTS = [{ speaker: 'A', start: 0, end: 2 }, { speaker: 'B', start: 2, end: 4 }];
const chunks = [{ id: 'c1', text: '第一句', timestamp: [0, 2] }, { id: 'c2', text: '第二句', timestamp: [2, 4] }];
const openPayload = () => ({
  status: 'ok',
  project: { formatVersion: 4, id: P, name: '说话人测试', createdAt: T, updatedAt: T, revision: 1, styleRevision: 0,
    videos: [{ id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 4, createdAt: T, updatedAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1000, mimeType: 'video/mp4' }, hasTranscript: true, revision: 0, styleSource: 'project' }] },
  video: { id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 4, createdAt: T, updatedAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1000, mimeType: 'video/mp4' }, hasTranscript: true, revision: 0, styleSource: 'project' },
  transcript: { text: '第一句第二句', language: 'zh', duration: 4, chunks },
  edits: { chunks, deletedWordIds: [], speakerSegments: SEGMENTS, speakerNames: { A: '说话人 1', B: '说话人 2' } },
  media: { status: 'ok', name: 'sample.mp4', playback: { kind: 'url', path: `/projects/${P}/media/${VIDEO_ID}` } },
  videos: [{ id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 4, createdAt: T, updatedAt: T, hasTranscript: true, mediaMissing: false, hasThumbnail: false, styleSource: 'project', revision: 0 }],
});

for (const theme of ['light', 'dark'] as const) {
  for (const lang of ['zh', 'en'] as const) {
    test(`F-0021/AC-1 AC-2 AC-3 speaker panel, rename, filter (${theme}-${lang})`, async ({ page }) => {
      await prepare(page, theme);
      await mockHost(page, {
        'providers.models': () => [{ provider: { id: 'sherpa-diarization', name: 'sherpa-onnx', kind: 'builtin' },
          models: [{ id: 'pyannote-3dspeaker', name: 'Pyannote + 3D-Speaker', role: 'speaker', status: 'ready', languages: ['zh', 'en'] }] }],
        'projects.open': () => openPayload(),
        'speakers.analyze': () => ({ id: uuid(2101), status: 'running' }),
        'jobs.get': ({ id }: any) => ({ id, status: 'complete', result: { status: 'saved', segments: SEGMENTS, speakerCount: 2,
          durationSeconds: 4, videoRevision: 1, projectRevision: 2, updatedAt: T } }),
        'speakers.saveNames': () => ({ status: 'saved', videoRevision: 2, projectRevision: 3, updatedAt: T }),
      });
      const url = lang === 'en' ? `/?ui=en#/projects/${P}/videos/${VIDEO_ID}` : `/#/projects/${P}/videos/${VIDEO_ID}`;
      await page.goto(url);
      await page.getByTestId('speaker-open').click();
      const panel = page.getByTestId('speaker-panel');
      await expect(panel).toBeVisible();
      await expect(panel.getByTestId('speaker-list')).toBeVisible();
      await expect(panel.getByTestId('speaker-A')).toContainText('1 条');
      await expect(panel.getByTestId('speaker-B')).toContainText('1 条');
      await shot(page, F, `panel-${theme}-${lang}`);
      await panel.getByTestId('speaker-name-A').fill('主持人');
      await panel.getByTestId('speaker-save-names').click();
      await panel.getByTestId('speaker-filter-A').click();
      await expect(page.getByTestId('subtitle-main-text')).toHaveCount(1);
      await shot(page, F, `filtered-${theme}-${lang}`);
      await panel.getByTestId('speaker-show-all').click();
      await expect(page.getByTestId('subtitle-main-text')).toHaveCount(2);
    });
  }
}

import { expect, test } from '@playwright/test';
import { prepare, mockHost, uuid, VIDEO_ID } from '../lib/mockHost';
import { shot } from '../lib/evidence';

const F = 'F-0049';
const P = uuid(490);
const T = '2026-11-17T00:00:00Z';
const chunks = [{ id: 'c1', text: '第一句', timestamp: [0, 10] }, { id: 'c2', text: '第二句', timestamp: [10, 20] }];
const clips = [{ id: uuid(4911), name: '短片 A', start: 0, end: 10, score: 80, text: '第一句', reasons: ['t'], createdAt: T },
  { id: uuid(4912), name: '短片 B', start: 10, end: 20, score: 70, text: '第二句', reasons: ['t'], createdAt: T }];
const openPayload = () => ({
  status: 'ok',
  project: { formatVersion: 4, id: P, name: '批量导出测试', createdAt: T, updatedAt: T, revision: 1, styleRevision: 0, clips,
    videos: [{ id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 20, createdAt: T, updatedAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1000, mimeType: 'video/mp4' }, hasTranscript: true, revision: 1, styleSource: 'project' }] },
  video: { id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 20, createdAt: T, updatedAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1000, mimeType: 'video/mp4' }, hasTranscript: true, revision: 1, styleSource: 'project' },
  transcript: { text: '第一句第二句', language: 'zh', duration: 20, chunks },
  edits: { chunks, deletedWordIds: [], clips },
  media: { status: 'ok', name: 'sample.mp4', playback: { kind: 'url', path: `/projects/${P}/media/${VIDEO_ID}` } },
  videos: [{ id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 20, createdAt: T, updatedAt: T, hasTranscript: true, mediaMissing: false, hasThumbnail: false, styleSource: 'project', revision: 1 }],
});

for (const theme of ['light', 'dark'] as const) {
  for (const lang of ['zh', 'en'] as const) {
    test(`F-0049/AC-1 AC-2 batch queue status and completion (${theme}-${lang})`, async ({ page }) => {
      await prepare(page, theme);
      const batch = { requestId: uuid(4901), status: 'completed', jobId: uuid(4902),
        items: [{ clipId: uuid(4911), name: '短片 A', status: 'saved', outputFile: 'clips/a.mp4' },
          { clipId: uuid(4912), name: '短片 B', status: 'saved', outputFile: 'clips/b.mp4' }], createdAt: T, updatedAt: T };
      await mockHost(page, {
        'projects.open': () => openPayload(),
        'clips.batchStart': () => ({ ...batch, status: 'queued', items: batch.items.map(item => ({ ...item, status: 'pending' })) }),
        'clips.batchStatus': () => batch,
      });
      const url = lang === 'en' ? `/?ui=en#/projects/${P}/videos/${VIDEO_ID}` : `/#/projects/${P}/videos/${VIDEO_ID}`;
      await page.goto(url);
      await page.getByTestId('clips-open').click();
      const panel = page.getByTestId('clips-panel');
      await expect(panel.getByTestId('clips-saved')).toBeVisible();
      await panel.getByTestId('clips-batch').click();
      await expect(panel.getByTestId('clips-batch-status')).toContainText('completed', { timeout: 5000 });
      await expect(panel.getByTestId('clips-batch-item-0')).toContainText('saved');
      await expect(panel.getByTestId('clips-batch-item-1')).toContainText('saved');
      await shot(page, F, `batch-${theme}-${lang}`);
    });
  }
}

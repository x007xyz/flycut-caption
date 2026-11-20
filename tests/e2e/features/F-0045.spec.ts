/* eslint-disable @typescript-eslint/no-explicit-any -- mock Host payloads */
import { expect, test } from '@playwright/test';
import { prepare, mockHost, uuid, VIDEO_ID } from '../lib/mockHost';
import { shot } from '../lib/evidence';

const F = 'F-0045';
const P = uuid(450);
const T = '2026-11-17T00:00:00Z';
const chunks = [
  { id: 's1', text: '第一句完整引入', timestamp: [0, 10] },
  { id: 's2', text: '第二句展开说明', timestamp: [10, 25] },
  { id: 's3', text: '第三句给出结论', timestamp: [25, 40] },
];
const candidates = [{ id: 's1-s2', start: 0, end: 25, score: 88, text: '第一句完整引入 第二句展开说明',
  reasons: ['时长 25.0 秒', '起止在句子边界'] }];
const openPayload = (clips: any[] = []) => ({
  status: 'ok',
  project: { formatVersion: 4, id: P, name: '短片推荐测试', createdAt: T, updatedAt: T, revision: 1, styleRevision: 0, clips,
    videos: [{ id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 40, createdAt: T, updatedAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1000, mimeType: 'video/mp4' }, hasTranscript: true, revision: 1, styleSource: 'project' }] },
  video: { id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 40, createdAt: T, updatedAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1000, mimeType: 'video/mp4' }, hasTranscript: true, revision: 1, styleSource: 'project' },
  transcript: { text: '第一句完整引入第二句展开说明第三句给出结论', language: 'zh', duration: 40, chunks },
  edits: { chunks, deletedWordIds: [], clips },
  media: { status: 'ok', name: 'sample.mp4', playback: { kind: 'url', path: `/projects/${P}/media/${VIDEO_ID}` } },
  videos: [{ id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 40, createdAt: T, updatedAt: T, hasTranscript: true, mediaMissing: false, hasThumbnail: false, styleSource: 'project', revision: 1 }],
});

for (const theme of ['light', 'dark'] as const) {
  for (const lang of ['zh', 'en'] as const) {
    test(`F-0045/AC-1 AC-2 AC-3 AC-5 AC-6 AC-7 clip suggestions and confirm (${theme}-${lang})`, async ({ page }) => {
      await prepare(page, theme);
      let clips: any[] = [];
      await mockHost(page, {
        'projects.open': () => openPayload(clips),
        'clips.suggest': () => ({ id: uuid(4501), status: 'running' }),
        'jobs.get': ({ id }: any) => ({ id, status: 'complete', result: { base: JSON.stringify([chunks]), durationSeconds: 40, candidates } }),
        'clips.create': () => {
          clips = [{ id: uuid(4502), name: '第一句完整引入', start: 0, end: 25, score: 88, text: '第一句完整引入 第二句展开说明',
            reasons: ['人工确认'], createdAt: T }];
          return { status: 'saved', clip: clips[0], videoRevision: 2, projectRevision: 2, updatedAt: T };
        },
        'clips.delete': () => { clips = []; return { deleted: true, videoRevision: 3, projectRevision: 3 }; },
      });
      const url = lang === 'en' ? `/?ui=en#/projects/${P}/videos/${VIDEO_ID}` : `/#/projects/${P}/videos/${VIDEO_ID}`;
      await page.goto(url);
      await page.getByTestId('clips-open').click();
      const panel = page.getByTestId('clips-panel');
      await expect(panel).toBeVisible();
      await panel.getByTestId('clips-suggest').click();
      await expect(panel.getByTestId('clips-candidate')).toHaveCount(1);
      await shot(page, F, `candidates-${theme}-${lang}`);
      await panel.getByTestId('clips-select').click();
      await panel.getByTestId('clip-snap').click();
      await panel.getByTestId('clip-create').click();
      await expect(panel.getByTestId('clips-completed')).toContainText('已完成');
      await expect(panel.getByTestId('clips-saved')).toBeVisible();
      await shot(page, F, `completed-${theme}-${lang}`);
      await panel.getByTestId(`clip-delete-${uuid(4502)}`).click();
    });
  }
}

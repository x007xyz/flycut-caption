/* eslint-disable @typescript-eslint/no-explicit-any -- mock Host payloads */
import { expect, test } from '@playwright/test';
import { prepare, mockHost, uuid, VIDEO_ID } from '../lib/mockHost';
import { shot } from '../lib/evidence';

const F = 'F-0038';
const P = uuid(380);
const T = '2026-11-17T00:00:00Z';
const chunks = [{ id: 'c1', text: '第一句', timestamp: [0, 2] }, { id: 'c2', text: '第二句', timestamp: [2, 4] }];
const openPayload = () => ({
  status: 'ok',
  project: { formatVersion: 4, id: P, name: '声音克隆测试', createdAt: T, updatedAt: T, revision: 1, styleRevision: 0, voiceProfiles: [],
    videos: [{ id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 10, createdAt: T, updatedAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1000, mimeType: 'video/mp4' }, hasTranscript: true, revision: 0, styleSource: 'project' }] },
  video: { id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 10, createdAt: T, updatedAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1000, mimeType: 'video/mp4' }, hasTranscript: true, revision: 0, styleSource: 'project' },
  transcript: { text: '第一句第二句', language: 'zh', duration: 10, chunks },
  edits: { chunks, deletedWordIds: [] },
  media: { status: 'ok', name: 'sample.mp4', playback: { kind: 'url', path: `/projects/${P}/media/${VIDEO_ID}` } },
  videos: [{ id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 10, createdAt: T, updatedAt: T, hasTranscript: true, mediaMissing: false, hasThumbnail: false, styleSource: 'project', revision: 0 }],
});

for (const theme of ['light', 'dark'] as const) {
  for (const lang of ['zh', 'en'] as const) {
    test(`F-0038/AC-1 AC-2 AC-4 AC-5 AC-6 AC-7 AC-8 authorized voice profile lifecycle (${theme}-${lang})`, async ({ page }) => {
      await prepare(page, theme);
      let profiles: any[] = [];
      await mockHost(page, {
        'projects.open': () => openPayload(),
        'voices.list': () => profiles,
        'voices.create': () => ({ id: uuid(3801), status: 'running' }),
        'jobs.get': ({ id }: any) => ({ id, status: 'complete', result: { status: 'saved',
          profile: { id: uuid(3802), name: '我的音色', file: 'voices/' + uuid(3803) + '.wav', durationSeconds: 5,
            sourceVideoId: VIDEO_ID, sourceStart: 0, sourceEnd: 5,
            authorization: { confirmed: true, statement: '本人授权', confirmedAt: T }, createdAt: T },
          projectRevision: 2, updatedAt: T } }),
        'voices.delete': ({ id }: any) => {
          profiles = profiles.filter(item => item.id !== id);
          return { deleted: true, remoteRetained: true, note: '302 远端留存' };
        },
      });
      // resolve create result into the list for the next load
      await page.route('**/rpc', async route => {
        const body = route.request().postDataJSON();
        if (body?.method === 'jobs.get') {
          profiles = [{ id: uuid(3802), name: '我的音色', file: 'voices/' + uuid(3803) + '.wav', durationSeconds: 5,
            sourceVideoId: VIDEO_ID, sourceStart: 0, sourceEnd: 5,
            authorization: { confirmed: true, statement: '本人授权', confirmedAt: T }, createdAt: T }];
        }
        await route.fallback();
      });
      const url = lang === 'en' ? `/?ui=en#/projects/${P}/videos/${VIDEO_ID}` : `/#/projects/${P}/videos/${VIDEO_ID}`;
      await page.goto(url);
      await page.getByTestId('voice-clone-open').click();
      const panel = page.getByTestId('voice-clone-panel');
      await expect(panel).toBeVisible();
      await expect(panel.getByTestId('voice-empty')).toBeVisible();
      await shot(page, F, `empty-${theme}-${lang}`);
      await panel.getByTestId('voice-name').fill('我的音色');
      await panel.getByTestId('voice-start').fill('0');
      await panel.getByTestId('voice-end').fill('5');
      await expect(panel.getByTestId('voice-create')).toBeDisabled();
      await panel.getByTestId('voice-authorization').check();
      await panel.getByTestId('voice-create').click();
      await expect(panel.getByTestId('voice-completed')).toBeVisible();
      await expect(panel.getByTestId('voice-item')).toHaveCount(1);
      await shot(page, F, `created-${theme}-${lang}`);
      await panel.getByTestId(`voice-delete-${uuid(3802)}`).click();
      await panel.getByTestId('voice-confirm-delete').click();
      await expect(panel.getByTestId('voice-empty')).toBeVisible();
    });
  }
}

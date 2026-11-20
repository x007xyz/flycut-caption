/* eslint-disable @typescript-eslint/no-explicit-any -- mock Host payloads */
import { expect, test } from '@playwright/test';
import { prepare, mockHost, uuid, VIDEO_ID } from '../lib/mockHost';
import { shot } from '../lib/evidence';

const F = 'F-0050';
const P = uuid(500);
const T = '2026-11-17T00:00:00Z';
const chunk = { id: 'c1', text: '这是一段已确认的短片文本，包含完整语义。', timestamp: [0, 30] };
const clip = { id: uuid(5001), name: '短片 A', start: 0, end: 30, score: 88, text: chunk.text, reasons: ['人工确认'], createdAt: T };
const openPayload = (copy?: any) => ({
  status: 'ok',
  project: { formatVersion: 4, id: P, name: '文案测试', createdAt: T, updatedAt: T, revision: 1, styleRevision: 0,
    clips: [{ ...clip, ...(copy ? { copy } : {}) }],
    videos: [{ id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 30, createdAt: T, updatedAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1000, mimeType: 'video/mp4' }, hasTranscript: true, revision: 1, styleSource: 'project' }] },
  video: { id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 30, createdAt: T, updatedAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1000, mimeType: 'video/mp4' }, hasTranscript: true, revision: 1, styleSource: 'project' },
  transcript: { text: chunk.text, language: 'zh', duration: 30, chunks: [chunk] },
  edits: { chunks: [chunk], deletedWordIds: [], clips: [{ ...clip, ...(copy ? { copy } : {}) }] },
  media: { status: 'ok', name: 'sample.mp4', playback: { kind: 'url', path: `/projects/${P}/media/${VIDEO_ID}` } },
  videos: [{ id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 30, createdAt: T, updatedAt: T, hasTranscript: true, mediaMissing: false, hasThumbnail: false, styleSource: 'project', revision: 1 }],
});

for (const theme of ['light', 'dark'] as const) {
  for (const lang of ['zh', 'en'] as const) {
    test(`F-0050/AC-1 AC-2 AC-3 AC-5 AC-6 AC-7 copy suggestions review and save (${theme}-${lang})`, async ({ page }) => {
      await prepare(page, theme);
      let copy: any;
      await mockHost(page, {
        'aiSettings.list': () => ({ hostId: '00000000-0000-4000-8000-0000000000cc', revision: 1, selectedId: uuid(5099),
          configs: [{ id: uuid(5099), name: 'AI Fixture', baseUrl: 'http://127.0.0.1:9999/v1', model: 'fixture', hasApiKey: true }] }),
        'projects.open': () => openPayload(copy),
        'clips.copy': () => ({ id: uuid(5002), status: 'running' }),
        'jobs.get': ({ id }: any) => ({ id, status: 'complete', result: { title: 'AI 标题', description: 'AI 简介，只基于原文。',
          hashtags: ['字幕', '创作'], generatedAt: T, baseText: chunk.text } }),
        'clips.saveCopy': ({ copy: next }: any) => { copy = next; return { status: 'saved', clip: { ...clip, copy }, videoRevision: 2, projectRevision: 2 }; },
      });
      const url = lang === 'en' ? `/?ui=en#/projects/${P}/videos/${VIDEO_ID}` : `/#/projects/${P}/videos/${VIDEO_ID}`;
      await page.goto(url);
      await page.getByTestId('clips-open').click();
      const panel = page.getByTestId('clips-panel');
      await panel.getByTestId(`clip-copy-${uuid(5001)}`).click();
      const review = page.getByTestId('clip-copy-review');
      await expect(review).toBeVisible();
      await expect(review).toContainText('AI建议，请核对');
      await panel.getByTestId('clip-copy-title').fill('人工确认后的标题');
      await shot(page, F, `review-${theme}-${lang}`);
      await panel.getByTestId('clip-copy-save').click();
      await expect(review).not.toBeVisible();
      await shot(page, F, `saved-${theme}-${lang}`);
    });
  }
}

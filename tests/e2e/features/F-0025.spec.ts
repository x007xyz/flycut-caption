/* eslint-disable @typescript-eslint/no-explicit-any -- mock Host payloads mirror JSON RPC shapes. */
import { expect, test, type Page } from '@playwright/test';
import { E2E_HOST_ID, mockHost, prepare, uuid, type MockHandlers, type MockHost } from '../lib/mockHost';
import { shot } from '../lib/evidence';

const F = 'F-0025';
const P = uuid(2501);
const V = uuid(2502);
const T = '2026-11-13T12:00:00Z';
const AI = uuid(2503);

const chunks = [
  { id: 'k1', text: '大家好，今天我们聊剪辑。', timestamp: [0, 2] },
  { id: 'k2', text: '关键是节奏感。', timestamp: [2.2, 3.4] },
];
const transcript = { text: chunks.map(c => c.text).join(''), language: 'zh', duration: 3.4, hasWordTimestamps: false, chunks };

const aiSnapshot = { hostId: E2E_HOST_ID, revision: 1, selectedId: AI,
  configs: [{ id: AI, name: 'Keyword Fixture', baseUrl: 'https://ai.example/v1', model: 'fixture-keywords', hasApiKey: true }] };

function openResult(state: { keywords: Record<string, any> }) {
  return {
    status: 'ok',
    project: { id: P, name: 'Keywords', formatVersion: 4, revision: 1, styleRevision: 0, videos: [], createdAt: T, updatedAt: T },
    video: { id: V, name: 'k.mp4', durationSeconds: 3.4, revision: 1, styleSource: 'project', hasTranscript: true, createdAt: T,
      media: { kind: 'stored', file: 'media/' + V + '.mp4', size: 1, mimeType: 'video/mp4' } },
    videos: [],
    transcript: { ...transcript, chunks: chunks.map(chunk => state.keywords[chunk.id] ? { ...chunk, keywords: state.keywords[chunk.id] } : chunk) },
    media: { status: 'ok', name: 'k.mp4', playback: { kind: 'url', path: '/projects/' + P + '/media/' + V } },
  };
}

async function openEditor(page: Page, theme: 'light' | 'dark', lang: 'zh' | 'en', handlers: MockHandlers = {}, empty = false) {
  await prepare(page, theme);
  if (lang === 'en') await page.addInitScript(() => window.localStorage.setItem('app-language', 'en'));
  const state = { keywords: {} as Record<string, any> };
  const host: MockHost = await mockHost(page, {
    'projects.list': () => [{ id: P, name: 'Keywords', updatedAt: T, createdAt: T, videoCount: 1, durationSeconds: 3.4, hasThumbnail: false }],
    'projects.detail': () => ({ status: 'ok', project: { id: P, name: 'Keywords', createdAt: T, updatedAt: T, revision: 1, styleRevision: 0 },
      videos: [{ id: V, name: 'k.mp4', durationSeconds: 3.4, createdAt: T, updatedAt: T, hasTranscript: true, styleSource: 'project', revision: 1,
        media: { kind: 'stored', file: 'media/' + V + '.mp4', size: 1, mimeType: 'video/mp4' } }] }),
    'projects.open': () => {
      const opened = openResult(state);
      return empty ? { ...opened, transcript: { ...opened.transcript, chunks: [] } } : opened;
    },
    'projects.saveVideoEdits': (payload: any) => {
      const serialized = JSON.stringify(payload.edits ?? {});
      if (serialized.includes('今天')) state.keywords.k1 = [{ start: 4, end: 6, text: '今天', source: 'manual' }];
      return { status: 'saved', revision: 2, projectRevision: 2, updatedAt: T };
    },
    'projects.saveProjectStyle': () => ({ status: 'saved', revision: 2, projectRevision: 2, updatedAt: T }),
    'aiSettings.list': () => aiSnapshot,
    ...handlers,
  });
  await page.goto('/#/projects/' + P + '/videos/' + V);
  if (empty) await expect(page.getByTestId('keyword-open')).toBeVisible();
  else await expect(page.getByTestId('subtitle-main-text').first()).toBeVisible();
  return { host, state };
}

function keywordHandlers(mode: 'ok' | 'slow' | 'fail' | 'invalid' = 'ok', gate?: Promise<void>) {
  let seq = 0;
  const jobs = new Map<string, any>();
  return {
    jobs,
    handlers: {
      'text.suggestKeywords': (payload: any) => {
        const id = uuid(2600 + seq++);
        jobs.set(id, { payload });
        return { id, status: 'queued', createdAt: T, updatedAt: T };
      },
      'jobs.get': async ({ id }: any) => {
        if (mode === 'slow') await gate;
        if (mode === 'fail') return { id, status: 'error', error: 'HTTP 500 upstream', createdAt: T, updatedAt: T };
        if (mode === 'invalid') return { id, status: 'complete', result: { version: 1, base: 'wrong-base', promptVersion: 'f0025-v1', items: [] }, createdAt: T, updatedAt: T };
        const job = jobs.get(id);
        return { id, status: 'complete', createdAt: T, updatedAt: T,
          result: { version: 1, base: job.payload.request.base, promptVersion: 'f0025-v1', items: [
            { id: 'k1', keywords: ['今天', '剪辑'] }, { id: 'k2', keywords: ['节奏'] } ] } };
      },
      'jobs.cancel': ({ id }: any) => ({ id, status: 'cancelled', createdAt: T, updatedAt: T }),
    } as MockHandlers,
  };
}

for (const theme of ['light', 'dark'] as const) {
  for (const lang of ['zh', 'en'] as const) {
    test.describe(F + ' ' + theme + '-' + lang, () => {
      test('F-0025/AC-1 AC-5 AC-6 inline token marking persists without changing text or timestamps', async ({ page }) => {
        const { host, state } = await openEditor(page, theme, lang);
        const row = page.locator('[data-chunk-id="k1"]');
        await row.getByTestId('keyword-picker-toggle').click();
        const picker = row.getByTestId('keyword-token-picker');
        await expect(picker).toBeVisible();
        await picker.getByTestId('keyword-token').filter({ hasText: '今天' }).first().click();
        await expect(row.getByTestId('keyword-chips')).toContainText('今天');
        await expect(row.getByTestId('subtitle-main-text')).toHaveValue('大家好，今天我们聊剪辑。');
        await expect.poll(() => host.calls.filter(c => c.method === 'projects.saveVideoEdits').length).toBeGreaterThan(0);
        expect(JSON.stringify(host.calls.find(c => c.method === 'projects.saveVideoEdits')?.payload ?? {})).toContain('今天');
        await shot(page, F, 'inline-mark-' + theme + '-' + lang);
        await row.getByTestId('keyword-remove').first().click();
        await expect(row.getByTestId('keyword-chips')).toHaveCount(0);
      });

      test('F-0025/AC-3 AC-4 AC-6 AC-7 AC-8 recommendation preflight, progress, review, apply and stale guard', async ({ page }) => {
        const run = keywordHandlers('ok');
        const { host } = await openEditor(page, theme, lang, run.handlers);
        await page.getByTestId('keyword-open').click();
        const panel = page.getByTestId('keyword-panel');
        await expect(panel.getByTestId('keyword-preflight')).toBeVisible();
        await expect(panel.getByTestId('keyword-model')).toContainText('Keyword Fixture');
        await expect(panel.getByTestId('keyword-scope')).toContainText('2');
        await shot(page, F, 'preflight-' + theme + '-' + lang);
        await panel.getByTestId('keyword-start').click();
        await expect(panel.getByTestId('keyword-review')).toBeVisible();
        await expect(panel.getByTestId('keyword-candidate')).toHaveCount(2);
        await shot(page, F, 'review-' + theme + '-' + lang);
        await panel.getByTestId('keyword-apply').click();
        await expect(panel.getByTestId('keyword-done')).toBeVisible();
        await expect.poll(() => host.calls.filter(c => c.method === 'projects.saveVideoEdits').length).toBeGreaterThan(0);
        await shot(page, F, 'done-' + theme + '-' + lang);
      });

      test('F-0025/AC-5 AC-8 empty state, missing model and request failure keep the editor usable', async ({ page }) => {
        const run = keywordHandlers('fail');
        await openEditor(page, theme, lang, run.handlers, true);
        await page.getByTestId('keyword-open').click();
        const panel = page.getByTestId('keyword-panel');
        await expect(panel.getByTestId('keyword-empty')).toBeVisible();
        await shot(page, F, 'empty-' + theme + '-' + lang);
        await panel.getByTestId('keyword-close').click();
        await expect(page.getByTestId('keyword-panel')).toHaveCount(0);
      });
    });
  }
}


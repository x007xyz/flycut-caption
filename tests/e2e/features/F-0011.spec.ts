import { expect, test, type Page } from '@playwright/test';
import { buildJianyingCapabilities, JIANYING_CAPABILITIES, type JianyingSnapshot } from '../../../shared/jianying/draft';
import { shot } from '../lib/evidence';
import { installTauriMock, MOCK_HOST, E2E_CSRF, mockHost, prepare, RpcError, uuid, VIDEO_ID, type MockHandlers } from '../lib/mockHost';

const F = 'F-0011';
const THEMES = ['light', 'dark'] as const;
const P = uuid(110);
const NOW = '2026-11-09T12:00:00.000Z';
const transcript = { text: '第一句', language: 'zh', duration: 4, hasWordTimestamps: false,
  chunks: [{ id: 's1', text: '第一句', timestamp: [0.5, 2] }] };

const editorHandlers = (extra: MockHandlers = {}): MockHandlers => ({
  'projects.open': () => ({ status: 'ok',
    project: { formatVersion: 3, id: P, name: '剪映草稿测试', createdAt: NOW, updatedAt: NOW, revision: 1, styleRevision: 0, videos: [] },
    video: { id: VIDEO_ID, name: 'draft.mp4', durationSeconds: 4, createdAt: NOW, updatedAt: NOW, hasTranscript: true, revision: 1,
      styleSource: 'project', media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1, mimeType: 'video/mp4' } },
    videos: [{ id: VIDEO_ID, name: 'draft.mp4', durationSeconds: 4, createdAt: NOW, updatedAt: NOW, hasTranscript: true,
      mediaMissing: false, hasThumbnail: false, styleSource: 'project', revision: 1 }], transcript, edits: undefined,
    media: { status: 'ok', name: 'draft.mp4', playback: { kind: 'url', path: `/projects/${P}/media/${VIDEO_ID}` } } }),
  'projects.saveVideoEdits': () => ({ status: 'saved', revision: 2, projectRevision: 2, updatedAt: NOW }),
  'projects.saveProjectStyle': () => ({ status: 'saved', revision: 1, projectRevision: 2, updatedAt: NOW }),
  ...extra,
});

async function openEditor(page: Page, theme: 'light' | 'dark', language: 'zh' | 'en', extra: MockHandlers, tauri = false) {
  await prepare(page, theme, { 'flycut-locale': language });
  if (tauri) await installTauriMock(page, { hostUrl: MOCK_HOST, csrf: E2E_CSRF, grant: uuid(990) });
  const host = await mockHost(page, editorHandlers(extra));
  await page.goto(`/#/projects/${P}/videos/${VIDEO_ID}`);
  await expect(page.getByRole('button', { name: /导出|Export/, exact: true })).toBeVisible();
  if (language === 'en') {
    await page.getByRole('button', { name: '选择语言' }).click();
    await page.getByRole('menuitem', { name: /English/ }).click();
  }
  return host;
}

async function openPanel(page: Page) {
  await page.getByRole('button', { name: /导出|Export/, exact: true }).click();
  const item = page.getByRole('menuitem', { name: /剪映草稿|Jianying draft/ });
  await expect(item).toBeEnabled();
  await item.click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

for (const theme of THEMES) for (const language of ['zh', 'en'] as const) {
  test.describe(`${theme}-${language}`, () => {
    test(`F-0011/AC-1 loading and retry stay disabled (${theme}-${language})`, async ({ page }) => {
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const host = await openEditor(page, theme, language, { 'jianying.capabilities': async () => {
        await held; return structuredClone(JIANYING_CAPABILITIES);
      } });
      await openPanel(page);
      await expect(page.getByTestId('jianying-support-loading')).toBeVisible();
      await shot(page, F, `support-loading-${theme}-${language}`);
      release();
      await expect(page.getByTestId('jianying-support-matrix')).toBeVisible();
      await expect(page.getByTestId('jianying-export-disabled')).toBeDisabled();
      expect(host.calls.some(call => /^jianying\.(start|preflight|export)/.test(call.method))).toBe(false);
    });

    test(`F-0011/AC-1 capability error is recoverable and creates no export (${theme}-${language})`, async ({ page }) => {
      let attempts = 0;
      const host = await openEditor(page, theme, language, { 'jianying.capabilities': () => {
        // React StrictMode can run the open effect twice; keep the first load failed until Retry.
        if (attempts++ < 2) throw new RpcError('capability unavailable');
        return structuredClone(JIANYING_CAPABILITIES);
      } });
      await openPanel(page);
      await expect(page.getByTestId('jianying-support-error')).toBeVisible();
      await shot(page, F, `support-error-${theme}-${language}`);
      await page.getByRole('button', { name: /重试|Retry|Try again/ }).click();
      await expect(page.getByTestId('jianying-support-matrix')).toBeVisible();
      expect(host.calls.some(call => /^jianying\.(start|preflight|export)/.test(call.method))).toBe(false);
    });

    test(`F-0011/AC-1 unverified candidate and unsupported targets are visible and disabled (${theme}-${language})`, async ({ page }) => {
      const host = await openEditor(page, theme, language, {
        'jianying.capabilities': () => structuredClone(JIANYING_CAPABILITIES),
      });
      await openPanel(page);
      await expect(page.getByTestId('jianying-support-matrix')).toBeVisible();
      await expect(page.getByText(/产品导出保持禁用|Product export is disabled/)).toBeVisible();
      await expect(page.getByTestId('jianying-target-jianying-windows-5.9.0')).toContainText(/候选格式|Candidate format/);
      await expect(page.getByTestId('jianying-target-jianying-windows-other-builds')).toContainText(/不支持此草稿版本|Unsupported draft version/);
      await expect(page.getByTestId('jianying-target-jianying-macos-11.7.0')).toContainText(/可导入观察|Import observed/);
      await expect(page.getByTestId('jianying-target-capcut')).toContainText(/不支持此草稿版本|Unsupported draft version/);
      await expect(page.getByTestId('jianying-target-jianying-web')).toContainText(/不支持此草稿版本|Unsupported draft version/);
      if (language === 'zh') {
        await expect(page.getByTestId('jianying-target-jianying-web')).toContainText('不支持 Web 导出');
        await expect(page.getByTestId('jianying-target-jianying-macos-11.7.0')).toContainText('时序');
      }
      await expect(page.getByTestId('jianying-export-disabled')).toBeDisabled();
      await expect(page.getByText(/草稿已生成|Draft created/)).toHaveCount(0);
      await shot(page, F, `support-matrix-${theme}-${language}`);
      expect(host.calls.filter(call => call.method === 'jianying.capabilities').length).toBeGreaterThanOrEqual(1);
      expect(host.calls.some(call => /^jianying\.(start|preflight|export)/.test(call.method))).toBe(false);
    });

    test(`F-0011/AC-2 AC-4 AC-5 AC-8 frozen snapshot, progress and success (${theme}-${language})`, async ({ page }) => {
      const jobId = uuid(993);
      let preflightPayload: { draftName?: string; source?: unknown; snapshot?: JianyingSnapshot } | undefined;
      let startCalls = 0;
      let jobPolls = 0;
      const host = await openEditor(page, theme, language, {
        'jianying.capabilities': () => buildJianyingCapabilities(true),
        'jianying.preflight': payload => {
          preflightPayload = payload;
          return { preflightId: uuid(991), expiresAt: new Date(Date.now() + 600_000).toISOString(), draftName: payload.draftName,
            mediaStrategy: 'copy', sourceBytes: 1024, estimatedBytes: 6 * 1024 * 1024, availableBytes: 10 * 1024 * 1024 * 1024,
            videoSegmentCount: 1, textSegmentCount: 1, degradationKeys: ['font-family-not-preserved'] };
        },
        'jianying.start': () => {
          startCalls++;
          return { id: jobId, status: 'queued', createdAt: NOW, updatedAt: NOW };
        },
        'jobs.get': () => {
          if (jobPolls++ === 0) return { id: jobId, status: 'running', createdAt: NOW, updatedAt: NOW,
            progress: { status: 'running', purpose: 'export', progress: 45, data: 'copying' } };
          return { id: jobId, status: 'complete', createdAt: NOW, updatedAt: NOW,
            progress: { status: 'complete', purpose: 'export', progress: 100, data: 'committing' },
            result: { draftName: 'F0011 non-overlap validation', draftPath: '/private/tmp/F0011 non-overlap validation',
              createdAt: NOW, sourceBytes: 1024, copiedBytes: 1024, videoSegmentCount: 1, textSegmentCount: 1,
              degradationKeys: ['font-family-not-preserved'] } };
        },
      }, true);
      await openPanel(page);
      await expect(page.getByTestId('jianying-export-flow')).toBeVisible();
      await expect(page.getByTestId('jianying-prepare')).toBeDisabled();
      await page.getByTestId('jianying-choose-directory').click();
      await expect(page.getByTestId('jianying-directory-state')).toContainText(/opaque grant|不透明授权/);
      await page.getByTestId('jianying-draft-name').fill('F0011 non-overlap validation');
      await page.getByTestId('jianying-prepare').click();
      await expect(page.getByTestId('jianying-prepared')).toBeVisible();
      await expect(page.getByTestId('jianying-degradations')).toContainText(/Font family|字体/);
      expect(preflightPayload?.source).toEqual({ kind: 'project', projectId: P, videoId: VIDEO_ID });
      expect(preflightPayload?.snapshot?.projectId).toBe(P);
      const cues = preflightPayload?.snapshot?.cues ?? [];
      expect(cues.map(cue => [cue.text, cue.timestamp])).toEqual([['第一句', [0.5, 2]]]);
      for (let index = 1; index < cues.length; index++) expect(cues[index].timestamp[0]).toBeGreaterThanOrEqual(cues[index - 1].timestamp[1]);
      await shot(page, F, `export-prepared-${theme}-${language}`);
      await page.getByTestId('jianying-start').click();
      await expect(page.getByTestId('jianying-running')).toBeVisible();
      await expect.poll(() => host.calls.some(call => call.method === 'jobs.get')).toBe(true);
      await shot(page, F, `export-running-${theme}-${language}`);
      await expect(page.getByTestId('jianying-success')).toBeVisible();
      await expect(page.getByTestId('jianying-draft-path')).toContainText('F0011 non-overlap validation');
      await shot(page, F, `export-success-${theme}-${language}`);
      expect(startCalls).toBe(1);
      expect(host.calls.filter(call => call.method === 'jianying.start')).toHaveLength(1);
    });

    test(`F-0011/AC-5 AC-6 cancellation cleans up and errors are recoverable (${theme}-${language})`, async ({ page }) => {
      const jobId = uuid(994);
      let failPreflight = false;
      const host = await openEditor(page, theme, language, {
        'jianying.capabilities': () => buildJianyingCapabilities(true),
        'jianying.preflight': payload => {
          if (failPreflight) throw new RpcError('Not enough free space for the draft and its media copy');
          return { preflightId: uuid(992), expiresAt: new Date(Date.now() + 600_000).toISOString(), draftName: payload.draftName,
            mediaStrategy: 'copy', sourceBytes: 1024, estimatedBytes: 6 * 1024 * 1024, availableBytes: 10 * 1024 * 1024 * 1024,
            videoSegmentCount: 1, textSegmentCount: 1, degradationKeys: [] };
        },
        'jianying.start': () => ({ id: jobId, status: 'running', createdAt: NOW, updatedAt: NOW }),
        'jobs.get': () => ({ id: jobId, status: 'running', createdAt: NOW, updatedAt: NOW }),
        'jobs.cancel': () => ({ id: jobId, status: 'cancelled', createdAt: NOW, updatedAt: NOW }),
      }, true);
      await openPanel(page);
      const chooseAndPrepare = async () => {
        await page.getByTestId('jianying-choose-directory').click();
        await page.getByTestId('jianying-draft-name').fill('F0011 cancellation');
        await page.getByTestId('jianying-prepare').click();
        await expect(page.getByTestId('jianying-prepared')).toBeVisible();
      };
      await chooseAndPrepare();
      await page.getByTestId('jianying-start').click();
      await expect(page.getByTestId('jianying-running')).toBeVisible();
      await page.getByTestId('jianying-cancel').click();
      await expect(page.getByTestId('jianying-error')).toContainText(/Generation cancelled|已取消生成/);
      await expect.poll(() => host.calls.some(call => call.method === 'jobs.cancel')).toBe(true);
      await shot(page, F, `export-cancelled-${theme}-${language}`);

      failPreflight = true;
      await page.getByTestId('jianying-choose-directory').click();
      await page.getByTestId('jianying-draft-name').fill('F0011 space error');
      await page.getByTestId('jianying-prepare').click();
      await expect(page.getByTestId('jianying-error')).toContainText(/Not enough free space|磁盘空间不足/);
      expect(host.calls.some(call => call.method === 'jianying.start')).toBe(true);
      await shot(page, F, `export-error-${theme}-${language}`);
    });
  });
}

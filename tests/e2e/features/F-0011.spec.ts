import { expect, test, type Page } from '@playwright/test';
import { JIANYING_CAPABILITIES } from '../../../shared/jianying/draft';
import { shot } from '../lib/evidence';
import { mockHost, prepare, RpcError, uuid, VIDEO_ID, type MockHandlers } from '../lib/mockHost';

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

async function openEditor(page: Page, theme: 'light' | 'dark', language: 'zh' | 'en', extra: MockHandlers) {
  await prepare(page, theme, { 'flycut-locale': language });
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
      await page.getByRole('button', { name: /重试|Retry/ }).click();
      await expect(page.getByTestId('jianying-support-matrix')).toBeVisible();
      expect(host.calls.some(call => /^jianying\.(start|preflight|export)/.test(call.method))).toBe(false);
    });

    test(`F-0011/AC-1 unverified candidate and unsupported targets are visible and disabled (${theme}-${language})`, async ({ page }) => {
      const host = await openEditor(page, theme, language, {
        'jianying.capabilities': () => structuredClone(JIANYING_CAPABILITIES),
      });
      await openPanel(page);
      await expect(page.getByTestId('jianying-support-matrix')).toBeVisible();
      await expect(page.getByText(/真实导入验证：未完成|Real import verification: not run/)).toBeVisible();
      await expect(page.getByTestId('jianying-target-jianying-windows-5.9.0')).toContainText(/候选格式|Candidate format/);
      await expect(page.getByTestId('jianying-target-jianying-windows-other-builds')).toContainText(/不支持此草稿版本|Unsupported draft version/);
      await expect(page.getByTestId('jianying-target-jianying-macos-11.7.0')).toContainText(/不支持此草稿版本|Unsupported draft version/);
      await expect(page.getByTestId('jianying-target-capcut')).toContainText(/不支持此草稿版本|Unsupported draft version/);
      await expect(page.getByTestId('jianying-target-jianying-web')).toContainText(/不支持此草稿版本|Unsupported draft version/);
      if (language === 'zh') {
        await expect(page.getByTestId('jianying-target-jianying-web')).toContainText('仅支持桌面 Host');
        await expect(page.getByTestId('jianying-target-jianying-macos-11.7.0')).not.toContainText('Private Timelines');
      }
      await expect(page.getByTestId('jianying-export-disabled')).toBeDisabled();
      await expect(page.getByText(/草稿已生成|Draft created/)).toHaveCount(0);
      await shot(page, F, `support-matrix-${theme}-${language}`);
      expect(host.calls.filter(call => call.method === 'jianying.capabilities').length).toBeGreaterThanOrEqual(1);
      expect(host.calls.some(call => /^jianying\.(start|preflight|export)/.test(call.method))).toBe(false);
    });
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any -- mock Host payloads mirror JSON RPC shapes. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { E2E_CSRF, MOCK_HOST, mockHost, prepare, RpcError, uuid, VIDEO_ID } from '../lib/mockHost';
import { shot } from '../lib/evidence';

const F = 'F-0052';
const P = uuid(5200);
const T = '2026-11-13T12:00:00Z';

const transcript = {
  text: '嗯大家好 今天聊聊 MCP',
  language: 'zh',
  duration: 3,
  hasWordTimestamps: true,
  chunks: [
    { id: 's1', text: '嗯，大家好', timestamp: [0.1, 1.4], wordIds: ['w1', 'w2'] },
    { id: 's2', text: '今天聊聊 MCP', timestamp: [1.5, 2.8], wordIds: ['w3', 'w4'] },
  ],
  wordChunks: [
    { id: 'w1', text: '嗯', timestamp: [0.1, 0.35], sentenceId: 's1' },
    { id: 'w2', text: '大家好', timestamp: [0.45, 1.4], sentenceId: 's1' },
    { id: 'w3', text: '今天聊聊', timestamp: [1.5, 2.2], sentenceId: 's2' },
    { id: 'w4', text: 'MCP', timestamp: [2.25, 2.8], sentenceId: 's2' },
  ],
};

function mcpConfirmation(id: string, kind: 'trash-project' | 'overwrite-export', summary: string, target: Record<string, string>) {
  return {
    id,
    kind,
    source: 'mcp',
    status: 'pending',
    summary,
    target,
    createdAt: T,
    updatedAt: T,
    expiresAt: '2099-01-01T00:00:00Z',
  };
}

let mediaDir: string;
let mediaPath: string;

test.beforeAll(() => {
  mediaDir = mkdtempSync(join(tmpdir(), 'flycut-f0052-ui-'));
  mediaPath = join(mediaDir, 'sample.mp4');
  const gen = spawnSync(process.env.FFMPEG_PATH ?? resolve('src-tauri/binaries/ffmpeg'), [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', mediaPath,
  ], { encoding: 'utf8' });
  if (gen.status !== 0) throw new Error(gen.stderr);
});

test.afterAll(() => {
  rmSync(mediaDir, { recursive: true, force: true });
});

for (const theme of ['light', 'dark'] as const) {
  for (const lang of ['zh', 'en'] as const) {
    test(`F-0052/AC-3 AC-5 AC-8 AC-9 MCP confirmation requests update in real time, retry on error, approve/reject, and show empty state (${theme}-${lang})`, async ({ page }) => {
      await prepare(page, theme);
      let items: Array<ReturnType<typeof mcpConfirmation>> = [];
      let failOnce = true;

      const host = await mockHost(page, {
        'projects.list': () => [],
        'confirmations.list': () => items,
        'confirmations.decide': (payload: any) => {
          if (failOnce && payload.decision === 'approve') {
            failOnce = false;
            throw new RpcError('Host busy, please retry');
          }
          items = items.filter(item => item.id !== payload.id);
          return { status: payload.decision === 'approve' ? 'executed' : 'rejected' };
        },
      });

      await page.goto(`/?ui=${lang}#/projects`);
      await expect(page.getByRole('button', { name: /Connected|已连接/ })).toBeVisible();
      await expect(page.getByTestId('confirmations-open')).toBeVisible();
      await page.getByTestId('confirmations-open').click();
      await expect(page.getByTestId('confirmations-empty')).toBeVisible();
      await expect(page.getByTestId('confirmations-empty')).toHaveText(lang === 'zh' ? '暂无待确认请求' : 'Nothing here yet');

      // Real-time WebSocket push of MCP confirmation requests
      const c1 = mcpConfirmation(uuid(5201), 'trash-project', '将项目「MCP 测试」移入回收站', { projectId: P, projectName: 'MCP 测试' });
      const c2 = mcpConfirmation(uuid(5202), 'overwrite-export', '覆盖导出文件「成片.mp4」', { projectId: P, projectName: 'MCP 测试', outputName: '成片.mp4' });
      items = [c1, c2];
      host.emit('confirmation/updated', { confirmation: c1 });
      host.emit('confirmation/updated', { confirmation: c2 });

      await expect(page.getByTestId('confirmations-count')).toHaveText('2');
      const panel = page.getByTestId('confirmations-panel');
      await expect(panel.getByTestId('confirmation-item')).toHaveCount(2);
      await expect(panel.getByTestId('confirmation-source').first()).toHaveText('MCP');
      await expect(panel).toContainText(lang === 'zh' ? '仅由客户端本人确认' : 'Confirmable only by you in this client');
      await shot(page, F, `mcp-confirmations-list-${theme}-${lang}`);

      // Decide fails once -> error + retry preserves pending item -> retry succeeds
      await panel.getByTestId('confirmations-approve').first().click();
      await expect(panel.getByTestId('confirmations-error')).toBeVisible();
      await expect(panel.getByTestId('confirmations-retry')).toBeVisible();
      await expect(panel.getByTestId('confirmation-item')).toHaveCount(2);

      await panel.getByTestId('confirmations-retry').click();
      await expect(panel.getByTestId('confirmation-item')).toHaveCount(1);
      await expect(page.getByTestId('confirmations-count')).toHaveText('1');
      await shot(page, F, `mcp-confirmations-retried-${theme}-${lang}`);

      // Reject remaining item -> empty state returns
      await panel.getByTestId('confirmations-reject').first().click();
      await expect(panel.getByTestId('confirmations-empty')).toBeVisible();
      await expect(page.getByTestId('confirmations-count')).toHaveCount(0);
    });

    test(`F-0052/AC-3 AC-4 AC-7 AC-9 editor header confirmations and Host pending suggestions preserve formal EDL until confirmed (${theme}-${lang})`, async ({ page }) => {
      await prepare(page, theme);
      let revision = 1;
      let confirmations: Array<ReturnType<typeof mcpConfirmation>> = [];
      let suggestions = [
        {
          id: uuid(5211),
          projectId: P,
          videoId: VIDEO_ID,
          baseRevision: 1,
          createdAt: T,
          status: 'pending',
          batch: {
            kind: 'filler',
            base: 'host-filler-base',
            preview: false,
            origin: 'rule',
            items: [
              {
                id: 'filler-w1',
                start: 0.1,
                end: 0.35,
                reason: 'standalone-filler',
                label: '嗯',
                category: 'standalone',
                confidence: 0.95,
                selected: true,
                source: 'rule',
                sources: ['rule'],
              },
            ],
          },
        },
      ];

      const host = await mockHost(page, {
        'projects.open': () => ({
          status: 'ok',
          project: { id: P, name: 'MCP Editor Review', formatVersion: 4, revision, styleRevision: 0, videos: [], createdAt: T, updatedAt: T },
          video: {
            id: VIDEO_ID,
            name: 'sample.mp4',
            durationSeconds: 3,
            revision,
            styleSource: 'project',
            hasTranscript: true,
            createdAt: T,
            media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1, mimeType: 'video/mp4' },
          },
          videos: [],
          transcript,
          edits: undefined,
          media: { status: 'ok', name: 'sample.mp4', playback: { kind: 'url', path: `/projects/${P}/media/${VIDEO_ID}` } },
        }),
        'projects.saveVideoEdits': () => {
          revision += 1;
          return { status: 'saved', revision, projectRevision: revision, updatedAt: T };
        },
        'projects.saveProjectStyle': () => ({ status: 'saved', revision, projectRevision: revision, updatedAt: T }),
        'confirmations.list': () => confirmations,
        'confirmations.decide': (payload: any) => {
          confirmations = confirmations.filter(item => item.id !== payload.id);
          return { status: 'approved' };
        },
        'projects.suggestions.list': () => suggestions,
        'projects.suggestions.dismiss': (payload: any) => {
          suggestions = suggestions.filter(item => item.id !== payload.suggestionId);
          host.emit('project/suggestions-updated', { projectId: P, videoId: VIDEO_ID });
          return { ok: true };
        },
      });

      await page.route(`${MOCK_HOST}/projects/**/media/**`, route => {
        const bytes = readFileSync(mediaPath);
        const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
        return route.fulfill({
          status: range ? 206 : 200,
          contentType: 'video/mp4',
          body: bytes.subarray(start, end + 1),
          headers: {
            'Accept-Ranges': 'bytes',
            'Content-Length': String(end - start + 1),
            ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}),
          },
        });
      });

      await page.addInitScript(({ url, csrf }) => {
        (window as typeof window & { __FLYCUT_HOST__?: unknown }).__FLYCUT_HOST__ = {
          url, auth: { kind: 'session', csrf },
        };
      }, { url: MOCK_HOST, csrf: E2E_CSRF });

      const url = `/?ui=${lang}#/projects/${P}/videos/${VIDEO_ID}`;
      await page.goto(url);
      try {
        await expect(page.getByTestId('host-suggestions-banner')).toBeVisible({ timeout: 8_000 });
      } catch {
        await page.goto(url);
        await expect(page.getByTestId('host-suggestions-banner')).toBeVisible({ timeout: 15_000 });
      }

      // Header confirmation entry works inside editor route
      const cHeader = mcpConfirmation(uuid(5203), 'overwrite-export', '覆盖导出文件「demo.mp4」', { projectId: P, outputName: 'demo.mp4' });
      confirmations = [cHeader];
      host.emit('confirmation/updated', { confirmation: cHeader });
      await expect(page.getByTestId('confirmations-count')).toHaveText('1');
      await page.getByTestId('confirmations-open').click();
      await expect(page.getByTestId('confirmations-panel')).toBeVisible();
      await expect(page.getByTestId('confirmations-panel').getByTestId('confirmation-source')).toHaveText('MCP');
      await shot(page, F, `mcp-editor-header-confirm-${theme}-${lang}`);
      await page.getByTestId('confirmations-approve').first().click();
      await expect(page.getByTestId('confirmations-count')).toHaveCount(0);
      // Close header popover if open before interacting with editor
      if (await page.getByTestId('confirmations-panel').isVisible()) {
        await page.getByTestId('confirmations-open').click();
      }

      // Host pending-suggestions banner visible, formal edits untouched
      const banner = page.getByTestId('host-suggestions-banner');
      await expect(banner).toContainText(lang === 'zh' ? '未确认前不会修改正式字幕、EDL 或导出。' : 'Formal subtitles, EDL, and exports remain unchanged until you confirm.');
      expect(host.calls.filter(c => c.method === 'projects.saveVideoEdits')).toHaveLength(0);
      await shot(page, F, `mcp-editor-suggestions-banner-${theme}-${lang}`);

      // Load for review -> PendingSuggestionsList opens, STILL no saveVideoEdits
      await page.getByTestId('host-suggestions-load').click();
      await expect(page.getByTestId('cut-suggestions')).toBeVisible();
      await expect(page.getByTestId('pending-suggestion-item')).toHaveCount(1);
      expect(host.calls.filter(c => c.method === 'projects.saveVideoEdits')).toHaveLength(0);
      await shot(page, F, `mcp-editor-suggestions-loaded-${theme}-${lang}`);

      // Apply selected suggestions -> formal save + auto-dismiss Host pending suggestion
      await page.getByRole('button', { name: lang === 'zh' ? '应用选中建议' : 'Apply selected suggestions' }).click();
      await expect.poll(() => host.calls.filter(c => c.method === 'projects.saveVideoEdits').length).toBeGreaterThan(0);
      await expect.poll(() => host.calls.filter(c => c.method === 'projects.suggestions.dismiss').length).toBe(1);
      await expect(page.getByTestId('host-suggestions-banner')).toHaveCount(0);

      // Push stale suggestion (baseRevision=0 vs videoRevision=1) -> stale warning + manual dismiss
      suggestions = [
        {
          id: uuid(5212),
          projectId: P,
          videoId: VIDEO_ID,
          baseRevision: 0,
          createdAt: T,
          status: 'pending',
          batch: {
            kind: 'filler',
            base: 'host-filler-stale',
            preview: false,
            origin: 'rule',
            items: [
              {
                id: 'filler-stale',
                start: 0.1,
                end: 0.35,
                reason: 'standalone-filler',
                label: '嗯',
                category: 'standalone',
                confidence: 0.9,
                selected: true,
                source: 'rule',
                sources: ['rule'],
              },
            ],
          },
        },
      ];
      host.emit('project/suggestions-updated', { projectId: P, videoId: VIDEO_ID });
      await expect(page.getByTestId('host-suggestions-stale')).toBeVisible();
      await page.getByTestId('host-suggestions-dismiss').click();
      await expect.poll(() => host.calls.filter(c => c.method === 'projects.suggestions.dismiss').length).toBe(2);
      await expect(page.getByTestId('host-suggestions-banner')).toHaveCount(0);
    });
  }
}


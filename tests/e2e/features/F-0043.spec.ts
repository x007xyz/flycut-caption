/* eslint-disable @typescript-eslint/no-explicit-any -- mock Host payloads */
import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MOCK_HOST, mockHost, prepare, RpcError, uuid, VIDEO_ID } from '../lib/mockHost';
import { shot } from '../lib/evidence';

const F = 'F-0043';
const P = uuid(430);
const T = '2026-11-13T12:00:00Z';

let mediaDir: string;
let mediaFile: string;

test.beforeAll(() => {
  mediaDir = mkdtempSync(join(tmpdir(), 'flycut-f0043-e2e-'));
  mediaFile = join(mediaDir, 'sample.mp4');
  const run = spawnSync(
    resolve('src-tauri/binaries/ffmpeg'),
    ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=4', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '4', '-c:v', 'libx264', '-c:a', 'aac', mediaFile],
    { encoding: 'utf8' },
  );
  if (run.status !== 0) throw new Error(run.stderr);
});

test.afterAll(() => rmSync(mediaDir, { recursive: true, force: true }));

for (const theme of ['light', 'dark'] as const) {
  for (const lang of ['zh', 'en'] as const) {
    test(`F-0043/AC-1 AC-2 AC-5 AC-6 AC-7 AC-8 Agent/Host suggestions bar lifecycle (${theme}-${lang})`, async ({ page }) => {
      await prepare(page, theme);
      const entryUrl = lang === 'en' ? `/?ui=en#/projects/${P}/videos/${VIDEO_ID}` : `/#/projects/${P}/videos/${VIDEO_ID}`;

      let holdList = false;
      let releaseList!: () => void;
      let pendingSuggestions: any[] = [];
      let videoRevision = 0;
      let suggestAttempt = 0;

      const chunks = [
        { id: 'c1', text: '嗯 今天讲一下口播剪辑', timestamp: [0, 3.5], wordIds: ['w1', 'w2'] },
      ];
      const wordChunks = [
        { id: 'w1', text: '嗯', timestamp: [0.1, 0.5], sentenceId: 'c1' },
        { id: 'w2', text: '今天讲一下口播剪辑', timestamp: [0.6, 3.5], sentenceId: 'c1' },
      ];

      const sampleSuggestion = (rev: number) => ({
        id: uuid(4301),
        projectId: P,
        videoId: VIDEO_ID,
        baseRevision: rev,
        createdAt: T,
        status: 'pending',
        batch: {
          kind: 'filler',
          base: String(rev),
          preview: false,
          origin: 'rule',
          items: [
            {
              id: 'rule-w1',
              start: 0.1,
              end: 0.5,
              text: '嗯',
              reason: 'standalone-filler',
              category: 'filler',
              label: '嗯',
              confidence: 0.95,
              selected: true,
              source: 'rule',
              sources: ['rule'],
            },
          ],
        },
      });

      await mockHost(page, {
        'projects.open': () => ({
          status: 'ok',
          project: {
            formatVersion: 4, id: P, name: 'Agent 剪辑建议测试', createdAt: T, updatedAt: T, revision: 1, styleRevision: 0,
            videos: [{ id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 4, createdAt: T, updatedAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1000, mimeType: 'video/mp4' }, hasTranscript: true, revision: videoRevision, styleSource: 'project' }],
          },
          video: { id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 4, createdAt: T, updatedAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1000, mimeType: 'video/mp4' }, hasTranscript: true, revision: videoRevision, styleSource: 'project' },
          transcript: { text: '嗯 今天讲一下口播剪辑', chunks, wordChunks, hasWordTimestamps: true, language: 'zh', duration: 4 },
          edits: { chunks, deletedWordIds: [] },
          media: { status: 'ok', name: 'sample.mp4', playback: { kind: 'url', path: `/projects/${P}/media/${VIDEO_ID}` } },
          videos: [{ id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 4, createdAt: T, updatedAt: T, hasTranscript: true, mediaMissing: false, hasThumbnail: false, styleSource: 'project', revision: videoRevision }],
        }),
        'projects.suggestions.list': async () => {
          if (holdList) await new Promise<void>((r) => { releaseList = r; });
          return pendingSuggestions;
        },
        'projects.suggestEdits': () => {
          suggestAttempt += 1;
          if (suggestAttempt === 1) {
            throw new RpcError('分析服务暂时不可用');
          }
          if (suggestAttempt === 2) {
            throw new RpcError('内容已更新，请重新检查');
          }
          pendingSuggestions = [sampleSuggestion(videoRevision)];
          return { id: uuid(4350 + suggestAttempt), status: 'complete', createdAt: T, updatedAt: T, result: { suggestionId: uuid(4301) } };
        },
        'jobs.get': ({ id }: any) => ({ id, status: 'complete', createdAt: T, updatedAt: T }),
        'projects.saveVideoEdits': () => {
          videoRevision += 1;
          return { status: 'saved', revision: videoRevision, projectRevision: videoRevision + 1, updatedAt: T };
        },
        'projects.suggestions.dismiss': ({ suggestionId }: any) => {
          pendingSuggestions = pendingSuggestions.filter((s) => s.id !== suggestionId);
          return { ok: true };
        },
      });

      await page.route(`${MOCK_HOST}/projects/*/media/*`, async (route) => {
        const req = route.request();
        const headers = {
          'Access-Control-Allow-Origin': req.headers().origin ?? '*',
          'Access-Control-Allow-Credentials': 'true',
          'Content-Type': 'video/mp4',
        };
        if (req.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
        await route.fulfill({ status: 200, headers, body: readFileSync(mediaFile) });
      });

      await page.goto(entryUrl);
      const bar = page.getByTestId('agent-suggestions-bar');
      await expect(bar).toBeVisible();

      // 1. Open -> empty state
      await page.getByTestId('agent-suggestions-toggle').click();
      await expect(bar.getByText(lang === 'zh' ? '暂无内容' : 'Nothing here yet')).toBeVisible();
      await shot(page, F, `agent-empty-${theme}-${lang}`);

      // 2. Refresh while holding -> loading state
      holdList = true;
      await bar.locator('button').nth(1).click();
      await expect(bar.getByText(lang === 'zh' ? '正在加载…' : 'Loading…')).toBeVisible();
      await shot(page, F, `agent-loading-${theme}-${lang}`);
      holdList = false;
      releaseList();
      await expect(bar.getByText(lang === 'zh' ? '暂无内容' : 'Nothing here yet')).toBeVisible();

      // 3. Error -> Retry -> Stale -> Review again -> Ready
      await bar.getByRole('button', { name: lang === 'zh' ? '生成去口癖建议' : 'Suggest fillers (Host)' }).click();
      await expect(bar.getByText('分析服务暂时不可用')).toBeVisible();
      await shot(page, F, `agent-error-${theme}-${lang}`);

      await bar.getByRole('button', { name: lang === 'zh' ? '重试' : 'Retry' }).click();
      await expect(bar.getByText(lang === 'zh' ? '内容已更新，请重新检查' : 'Content changed. Review again.')).toBeVisible();
      await shot(page, F, `agent-stale-${theme}-${lang}`);

      await bar.getByRole('button', { name: lang === 'zh' ? '重新检查' : 'Review again' }).click();
      await bar.getByRole('button', { name: lang === 'zh' ? '生成去口癖建议' : 'Suggest fillers (Host)' }).click();
      await expect(page.getByTestId('host-suggestion-card')).toBeVisible();
      await shot(page, F, `agent-ready-${theme}-${lang}`);

      // 4. Preview onto timeline -> verify PendingSuggestionsList with quoted text -> Apply -> Completed
      await bar.getByRole('button', { name: lang === 'zh' ? '预览到时间轴' : 'Preview on timeline' }).click();
      await expect(page.getByTestId('cut-suggestions')).toBeVisible();
      await expect(page.getByTestId('cut-suggestions').getByText('“嗯”')).toBeVisible();
      await shot(page, F, `agent-preview-${theme}-${lang}`);

      await bar.getByRole('button', { name: lang === 'zh' ? '应用选中建议' : 'Apply selected suggestions' }).click();
      await expect(bar.getByText(lang === 'zh' ? '已完成' : 'Completed')).toBeVisible();
      await shot(page, F, `agent-completed-${theme}-${lang}`);
    });
  }
}

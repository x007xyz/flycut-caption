/* eslint-disable @typescript-eslint/no-explicit-any -- mock Host payloads */
import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MOCK_HOST, mockHost, prepare, uuid, VIDEO_ID } from '../lib/mockHost';
import { shot } from '../lib/evidence';

const F = 'F-0019';
const P = uuid(190);
const T = '2026-11-13T12:00:00Z';

let mediaDir: string;
let mediaFile: string;

test.beforeAll(() => {
  mediaDir = mkdtempSync(join(tmpdir(), 'flycut-f0019-e2e-'));
  mediaFile = join(mediaDir, 'sample.mp4');
  const run = spawnSync(
    resolve('src-tauri/binaries/ffmpeg'),
    ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=1', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '1', '-c:v', 'libx264', '-c:a', 'aac', mediaFile],
    { encoding: 'utf8' },
  );
  if (run.status !== 0) throw new Error(run.stderr);
});

test.afterAll(() => rmSync(mediaDir, { recursive: true, force: true }));

for (const theme of ['light', 'dark'] as const) {
  for (const lang of ['zh', 'en'] as const) {
    test(`F-0019/AC-1 AC-2 AC-3 AC-5 AC-6 AC-7 AC-8 project hotwords lifecycle and model capability display (${theme}-${lang})`, async ({ page }) => {
      await prepare(page, theme, {
        'flycut-caption-storage': JSON.stringify({
          state: {
            asrModel: { providerId: 'sherpa-onnx', modelId: 'sensevoice-small-int8-zh-en-ja-ko-yue-2024-07-17' },
            language: 'zh',
          },
          version: 0,
        }),
      });
      const entryUrl = lang === 'en' ? `/?ui=en#/projects/${P}/videos/${VIDEO_ID}` : `/#/projects/${P}/videos/${VIDEO_ID}`;

      let holdGet = true;
      let releaseGet!: () => void;
      let terminology: any[] = [];
      let terminologyRevision = 0;
      let saveAttempt = 0;

      await mockHost(page, {
        'providers.models': () => [
          {
            provider: { id: 'sherpa-onnx', name: 'sherpa-onnx（本地）', kind: 'builtin' },
            models: [
              {
                id: 'sensevoice-small-int8-zh-en-ja-ko-yue-2024-07-17',
                name: 'SenseVoice Small INT8',
                role: 'asr',
                languages: ['auto', 'zh'],
                timestampLevel: 'word',
                status: 'ready',
                offline: true,
                hotwords: { supported: false },
              },
            ],
          },
          {
            provider: { id: 'flycut:gpu', name: 'FunASR GPU', kind: 'endpoint' },
            models: [
              {
                id: 'paraformer-hotword',
                name: 'Paraformer Hotword',
                role: 'asr',
                languages: ['auto', 'zh', 'en'],
                timestampLevel: 'word',
                status: 'ready',
                hotwords: { supported: true, weights: true, format: 'weighted-lines' },
              },
            ],
          },
        ],
        'projects.open': () => ({
          status: 'ok',
          project: {
            formatVersion: 4,
            id: P,
            name: '热词测试项目',
            createdAt: T,
            updatedAt: T,
            revision: 1,
            styleRevision: 0,
            terminology,
            terminologyRevision,
            videos: [{ id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 1, createdAt: T, updatedAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1000, mimeType: 'video/mp4' }, hasTranscript: true, revision: 0, styleSource: 'project' }],
          },
          video: { id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 1, createdAt: T, updatedAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1000, mimeType: 'video/mp4' }, hasTranscript: true, revision: 0, styleSource: 'project' },
          transcript: { text: '测试句子', language: 'zh', duration: 1, chunks: [{ id: 'c1', text: '测试句子', timestamp: [0, 1] }] },
          edits: { chunks: [{ id: 'c1', text: '测试句子', timestamp: [0, 1] }], deletedWordIds: [] },
          media: { status: 'ok', name: 'sample.mp4', playback: { kind: 'url', path: `/projects/${P}/media/${VIDEO_ID}` } },
          videos: [{ id: VIDEO_ID, name: 'sample.mp4', durationSeconds: 1, createdAt: T, updatedAt: T, hasTranscript: true, mediaMissing: false, hasThumbnail: false, styleSource: 'project', revision: 0 }],
        }),
        'projects.getTerminology': async () => {
          if (holdGet) {
            await new Promise<void>((resolve) => { releaseGet = resolve; });
          }
          return { projectId: P, revision: terminologyRevision, terminology };
        },
        'projects.saveTerminology': ({ terms }: any) => {
          saveAttempt += 1;
          if (saveAttempt === 1) {
            terminologyRevision = 1;
            return { status: 'conflict', revision: 1, updatedAt: T, terminology };
          }
          if (saveAttempt === 2) {
            throw new Error('网络保存异常');
          }
          terminologyRevision += 1;
          terminology = terms.map((t: any, idx: number) => ({
            id: t.id ?? uuid(1900 + idx),
            term: t.term,
            asHotword: t.asHotword ?? true,
            ...(t.weight !== undefined ? { weight: t.weight } : {}),
            updatedAt: T,
          }));
          return { status: 'saved', revision: terminologyRevision, projectRevision: 2, updatedAt: T, terminology };
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
      // Open ASR Options tab
      const optionsTab = page.getByRole('button', { name: lang === 'zh' ? '选项' : 'Options', exact: true });
      await optionsTab.click();

      const summary = page.getByTestId('asr-hotwords-summary');
      await expect(summary).toBeVisible();
      await expect(summary.getByText(lang === 'zh' ? '此模型不支持热词' : 'This model does not support hotwords')).toBeVisible();
      await shot(page, F, `panel-unsupported-${theme}-${lang}`);

      // Open HotwordsDialog -> loading -> empty
      await summary.getByRole('button', { name: lang === 'zh' ? '管理热词' : 'Manage hotwords' }).click();
      const dialog = page.getByTestId('hotwords-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(lang === 'zh' ? '正在加载…' : 'Loading…')).toBeVisible();
      await shot(page, F, `dialog-loading-${theme}-${lang}`);

      holdGet = false;
      releaseGet();
      await expect(dialog.getByText(lang === 'zh' ? '暂无内容' : 'Nothing here yet')).toBeVisible();
      await shot(page, F, `dialog-empty-${theme}-${lang}`);

      // Inline validation: blank & invalid weight
      await dialog.getByRole('button', { name: lang === 'zh' ? '添加' : 'Add' }).click();
      await expect(dialog.getByRole('alert')).toBeVisible();

      const termInput = dialog.locator('#hotword-term-input');
      const weightInput = dialog.locator('#hotword-weight-input');
      await termInput.fill('FlyCut');
      await weightInput.fill('-2');
      await dialog.getByRole('button', { name: lang === 'zh' ? '添加' : 'Add' }).click();
      await expect(dialog.getByRole('alert')).toBeVisible();

      // Valid add + duplicate check
      await weightInput.fill('2.5');
      await dialog.getByRole('button', { name: lang === 'zh' ? '添加' : 'Add' }).click();
      await expect(dialog.getByText('FlyCut', { exact: true })).toBeVisible();

      await termInput.fill('flycut');
      await dialog.getByRole('button', { name: lang === 'zh' ? '添加' : 'Add' }).click();
      await expect(dialog.getByRole('alert')).toBeVisible();

      // Save -> 1st attempt stale conflict
      await dialog.getByRole('button', { name: lang === 'zh' ? '保存词表' : 'Save hotwords' }).click();
      await expect(dialog.getByText(lang === 'zh' ? '内容已更新，请重新检查' : 'Content changed. Review again.')).toBeVisible();
      await shot(page, F, `dialog-stale-${theme}-${lang}`);

      await dialog.getByRole('button', { name: lang === 'zh' ? '重新检查' : 'Review again' }).click();
      await expect(dialog.getByText(lang === 'zh' ? '暂无内容' : 'Nothing here yet')).toBeVisible();

      // Re-add -> 2nd attempt error -> Retry -> 3rd attempt completed
      await termInput.fill('FlyCut');
      await weightInput.fill('3');
      await dialog.getByRole('button', { name: lang === 'zh' ? '添加' : 'Add' }).click();
      await dialog.getByRole('button', { name: lang === 'zh' ? '保存词表' : 'Save hotwords' }).click();
      await expect(dialog.getByRole('button', { name: lang === 'zh' ? '重试' : 'Retry' })).toBeVisible();
      await dialog.getByRole('button', { name: lang === 'zh' ? '重试' : 'Retry' }).click();
      await expect(dialog.getByText(lang === 'zh' ? '已完成' : 'Completed')).toBeVisible();
      await shot(page, F, `dialog-completed-${theme}-${lang}`);

      await dialog.getByRole('button', { name: lang === 'zh' ? '关闭' : 'Close', exact: true }).first().click();

      // Switch to hotword-supported model and verify before-ASR summary
      const modelSelect = page.locator('[role="combobox"]').first();
      await modelSelect.click();
      await page.getByRole('option', { name: /Paraformer Hotword/ }).click();
      await expect(summary.getByText(/1.*Paraformer Hotword/)).toBeVisible();
      await shot(page, F, `panel-supported-active-${theme}-${lang}`);
    });
  }
}

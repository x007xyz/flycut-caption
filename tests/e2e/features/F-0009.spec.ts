/* eslint-disable @typescript-eslint/no-explicit-any -- mock Host payloads mirror JSON RPC shapes. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  E2E_CSRF, E2E_HOST_ID, MOCK_HOST, mockHost, prepare, RpcError, uuid, VIDEO_ID, type MockHandlers,
} from '../lib/mockHost';
import { shot } from '../lib/evidence';

const P = uuid(109);
const AI = uuid(909);
const T = '2026-11-12T12:00:00Z';
type Scenario = 'success' | 'partial' | 'cancel' | 'invalid' | 'empty';

const transcript = {
  text: '这个这个方案 嗯好的 我们继续 下周再看 最后结束 那个我觉得',
  language: 'zh',
  duration: 7.5,
  hasWordTimestamps: true,
  chunks: [
    { id: 's1', text: '这个这个方案', timestamp: [0, 1.2], wordIds: ['w1', 'w2', 'w3'] },
    { id: 's2', text: '嗯好的', timestamp: [1.5, 2.2], wordIds: ['w4', 'w5'] },
    { id: 's3', text: '我们继续', timestamp: [2.5, 3.1], wordIds: ['w6', 'w7'] },
    { id: 's4', text: '下周再看', timestamp: [3.2, 3.8], wordIds: ['w8', 'w9'] },
    { id: 's5', text: '最后结束', timestamp: [4, 4.6], wordIds: ['w10', 'w11'] },
    { id: 's6', text: '那个我觉得', timestamp: [5, 6.5], wordIds: ['w12', 'w13', 'w14'] },
  ],
  wordChunks: [
    { id: 'w1', text: '这个', timestamp: [0, 0.3], sentenceId: 's1' },
    { id: 'w2', text: '这个', timestamp: [0.3, 0.6], sentenceId: 's1' },
    { id: 'w3', text: '方案', timestamp: [0.6, 1.2], sentenceId: 's1' },
    { id: 'w4', text: '嗯', timestamp: [1.5, 1.7], sentenceId: 's2' },
    { id: 'w5', text: '好的', timestamp: [1.7, 2.2], sentenceId: 's2' },
    { id: 'w6', text: '我们', timestamp: [2.5, 2.8], sentenceId: 's3' },
    { id: 'w7', text: '继续', timestamp: [2.8, 3.1], sentenceId: 's3' },
    { id: 'w8', text: '下周', timestamp: [3.2, 3.5], sentenceId: 's4' },
    { id: 'w9', text: '再看', timestamp: [3.5, 3.8], sentenceId: 's4' },
    { id: 'w10', text: '最后', timestamp: [4, 4.3], sentenceId: 's5' },
    { id: 'w11', text: '结束', timestamp: [4.3, 4.6], sentenceId: 's5' },
    { id: 'w12', text: '那个', timestamp: [5, 5.3], sentenceId: 's6' },
    { id: 'w13', text: '我', timestamp: [5.3, 5.6], sentenceId: 's6' },
    { id: 'w14', text: '觉得', timestamp: [5.6, 6.5], sentenceId: 's6' },
  ],
};
const aiSnapshot = {
  hostId: E2E_HOST_ID, revision: 1, selectedId: AI,
  configs: [{ id: AI, name: 'Semantic Fixture', baseUrl: 'https://ai.example/v1', model: 'fixture-semantic', hasApiKey: true }],
};

let mediaDir: string;
let media: string;

test.beforeAll(() => {
  mediaDir = mkdtempSync(join(tmpdir(), 'flycut-f0009-ui-'));
  media = join(mediaDir, 'marker.mp4');
  const run = spawnSync(process.env.FFMPEG_PATH ?? resolve('src-tauri/binaries/ffmpeg'), [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=8',
    '-c:v', 'libx264', '-preset', 'ultrafast', media,
  ], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr);
});
test.afterAll(() => rmSync(mediaDir, { recursive: true, force: true }));

async function connect(page: Page, options: { withModel?: boolean; scenario?: Scenario } = {}) {
  let scenario = options.scenario ?? 'success';
  let saveFailure = false;
  let saved: Record<string, unknown> | undefined;
  let revision = 1;
  let sequence = 0;
  const jobs = new Map<string, any>();
  const attempts = new Map<string, number>();

  const timedJob = (job: any) => {
    const at = new Date().toISOString();
    return { createdAt: at, updatedAt: at, ...job };
  };
  const candidate = (request: any) => {
    const startWordId = request.target.startWordId;
    if (startWordId === 'w1') return {
      startWordId: 'w1', endWordId: 'w2', scope: 'word', category: 'repetition',
      reason: '重复开头，保留后一次', confidence: 'high', startMs: 0, endMs: 600, text: '这个这个',
    };
    if (startWordId === 'w12') return {
      startWordId: 'w12', endWordId: 'w12', scope: 'word', category: 'contextual-filler',
      reason: '这里的“那个”不承担指代', confidence: 'medium', startMs: 5000, endMs: 5300, text: '那个',
    };
    return null;
  };
  const handlers: MockHandlers = {
    'projects.open': () => ({ status: 'ok',
      project: { id: P, name: 'Semantic fillers', formatVersion: 3, revision, styleRevision: 0, videos: [], createdAt: T, updatedAt: T },
      video: { id: VIDEO_ID, name: 'Semantic.mp4', durationSeconds: 7.5, revision, styleSource: 'project', hasTranscript: true,
        createdAt: T, media: { kind: 'stored', file: 'media/' + VIDEO_ID + '.mp4', size: 1, mimeType: 'video/mp4' } },
      videos: [], transcript, edits: undefined,
      media: { status: 'ok', name: 'Semantic.mp4', playback: { kind: 'url', path: '/projects/' + P + '/media/' + VIDEO_ID } } }),
    'projects.saveVideoEdits': payload => {
      if (saveFailure) throw new RpcError('save failed');
      saved = payload.edits as Record<string, unknown>; revision += 1;
      return { status: 'saved', revision, projectRevision: revision, updatedAt: T };
    },
    'projects.saveProjectStyle': () => ({ status: 'saved', revision, projectRevision: revision, updatedAt: T }),
    'aiSettings.list': () => options.withModel === false
      ? { hostId: E2E_HOST_ID, revision: 0, selectedId: null, configs: [] } : aiSnapshot,
    'text.suggestCuts': payload => {
      sequence += 1;
      const request = payload.request as any;
      const target = request.target.startWordId as string;
      const attempt = (attempts.get(target) ?? 0) + 1;
      attempts.set(target, attempt);
      const id = uuid(4000 + sequence);
      let job: any;
      if (scenario === 'cancel' && target === 'w12') {
        job = { id, status: 'running', progress: { status: 'running', progress: 50 } };
      } else if ((scenario === 'partial' && target === 'w12' && attempt === 1)
        || scenario === 'invalid' && target === 'w12') {
        job = { id, status: 'error', error: 'Invalid analysis result (UNKNOWN_WORD_ID): unknown word' };
      } else {
        const item = candidate(request);
        job = { id, status: 'complete', result: {
          version: 1, base: request.base, promptVersion: 'f0009-v1',
          candidates: scenario === 'empty' || !item ? [] : [item],
        } };
      }
      jobs.set(id, timedJob(job));
      return jobs.get(id);
    },
    'jobs.get': ({ id }) => jobs.get(id),
    'jobs.cancel': ({ id }) => {
      const current = jobs.get(id);
      const cancelled = timedJob({ ...current, status: 'cancelled' });
      jobs.set(id, cancelled);
      return cancelled;
    },
  };
  const host = await mockHost(page, handlers);
  await page.route(MOCK_HOST + '/projects/**/media/**', route => {
    const bytes = readFileSync(media);
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    return route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4', body: bytes.subarray(start, end + 1),
      headers: { 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1),
        ...(range ? { 'Content-Range': 'bytes ' + start + '-' + end + '/' + bytes.length } : {}) } });
  });
  await page.addInitScript(({ url, csrf }) => {
    (window as typeof window & { __FLYCUT_HOST__?: unknown }).__FLYCUT_HOST__ = {
      url, auth: { kind: 'session', csrf },
    };
  }, { url: MOCK_HOST, csrf: E2E_CSRF });
  return { host, saved: () => saved, setScenario: (value: Scenario) => { scenario = value; },
    setSaveFailure: (value: boolean) => { saveFailure = value; } };
}

async function openEditor(page: Page, theme: 'light' | 'dark', lang: 'zh' | 'en', options: { withModel?: boolean; scenario?: Scenario } = {}) {
  await prepare(page, theme, { 'flycut-locale': lang });
  const state = await connect(page, options);
  const url = '/?lang=' + lang + '#/projects/' + P + '/videos/' + VIDEO_ID;
  await page.goto(url);
  try {
    await expect(page.getByTestId('subtitle-main-text').first()).toHaveValue('这个这个方案', { timeout: 7_000 });
  } catch {
    // A cold dev-server navigation can briefly land on the project list before the hash runtime mounts.
    await page.goto(url);
    await expect(page.getByTestId('subtitle-main-text').first()).toHaveValue('这个这个方案', { timeout: 15_000 });
  }
  if (lang === 'en') await switchToEnglish(page);
  await expect(page.getByTestId('semantic-filler-open')).toBeVisible();
  return state;
}

async function openSemantic(page: Page) {
  await page.getByTestId('semantic-filler-open').click();
}

async function switchToEnglish(page: Page) {
  await page.getByRole('button', { name: '选择语言' }).click();
  await page.getByRole('menuitem', { name: /English/ }).click();
  await expect(page.getByRole('button', { name: /^(去口癖|Remove fillers)$/ })).toBeVisible();
}

async function acknowledgeAndStart(page: Page) {
  const acknowledge = page.getByTestId('semantic-filler-panel').getByRole('checkbox');
  if (await acknowledge.count()) await acknowledge.check();
  await page.getByTestId('semantic-start').click();
}

for (const theme of ['light', 'dark'] as const) for (const lang of ['zh', 'en'] as const) {
  test.describe(theme + '-' + lang, () => {
    test('F-0009/AC-1 AC-2 no-model message, working rule layer, scoped preflight and remote consent', async ({ page }) => {
      const state = await openEditor(page, theme, lang, { withModel: false });
      await page.getByRole('button', { name: /^(去口癖|Remove fillers)$/ }).click({ force: true });
      await expect(page.getByTestId('cut-suggestions')).toBeVisible();
      await expect(page.getByText(/规则|Rule/).first()).toBeVisible();
      await openSemantic(page);
      await expect(page.getByText(/配置AI模型以分析语义口癖|Configure an AI model to analyze contextual fillers/)).toBeVisible();
      await expect(page.getByTestId('cut-suggestions')).toBeVisible();
      await shot(page, 'F-0009', 'no-model-' + theme + '-' + lang);

      state.host.set('aiSettings.list', () => aiSnapshot);
      await page.reload();
      await expect(page.getByText('Semantic Fixture').first()).toBeVisible();
      if (lang === 'en') await switchToEnglish(page);
      await openSemantic(page);
      const panel = page.getByTestId('semantic-filler-panel');
      await expect(panel).toContainText(/确认要发送的内容|Review what will be sent/);
      await expect(panel).toContainText(/2 批|2 batches/);
      await expect(panel).toContainText(/不上传媒体|Media is never uploaded/);
      await expect(panel).toContainText(/API Key 只保存在 Host|API key stays in Host storage/);
      await expect(page.getByTestId('semantic-start')).toBeDisabled();
      await panel.getByRole('checkbox').check();
      await expect(page.getByTestId('semantic-start')).toBeEnabled();
      await shot(page, 'F-0009', 'preflight-' + theme + '-' + lang);
    });

    test('F-0009/AC-3 AC-4 AC-8 progress, invalid retry, review and atomic apply', async ({ page }) => {
      const state = await openEditor(page, theme, lang, { scenario: 'partial' });
      await openSemantic(page);
      await acknowledgeAndStart(page);
      await expect(page.getByText(/分析结果无效|Invalid analysis result/)).toBeVisible();
      await expect(page.getByRole('button', { name: /重试失败批次|Retry failed batches/ })).toBeVisible();
      await expect(page.getByTestId('cut-suggestions')).toBeVisible();
      await shot(page, 'F-0009', 'partial-invalid-' + theme + '-' + lang);
      state.setScenario('success');
      await page.getByRole('button', { name: /重试失败批次|Retry failed batches/ }).click();
      const items = page.getByTestId('pending-suggestion-item');
      await expect(items).toHaveCount(3);
      await expect(items.nth(1).getByTestId('suggestion-source')).toContainText(/语义|Semantic/);
      await expect(items.nth(1).getByRole('checkbox')).not.toBeChecked();
      await shot(page, 'F-0009', 'review-' + theme + '-' + lang);
      await items.nth(1).getByRole('checkbox').check();
      await page.getByRole('button', { name: /应用选中建议|Apply selected suggestions/ }).click();
      await expect(page.getByTestId('cut-suggestions')).toBeHidden();
      expect(state.saved()).toBeTruthy();
      await expect(page.getByTestId('subtitle-main-text').first()).toHaveValue('方案');
    });

    test('F-0009/AC-3 AC-5 AC-6 AC-7 AC-8 cancellation, provenance, preview, stale disable, save failure and semantic empty', async ({ page }) => {
      const state = await openEditor(page, theme, lang, { scenario: 'cancel' });
      await openSemantic(page);
      await acknowledgeAndStart(page);
      await expect(page.getByText(/第 2\/2 批|Batch 2 of 2/)).toBeVisible();
      await page.getByTestId('semantic-cancel-running').click();
      await expect(page.getByText(/分析已取消|Analysis cancelled/)).toBeVisible();
      await expect(page.getByTestId('cut-suggestions')).toBeVisible();
      await shot(page, 'F-0009', 'cancelled-' + theme + '-' + lang);
      await page.getByRole('button', { name: /取消|Cancel/, exact: true }).last().click();

      state.setScenario('success');
      await openSemantic(page);
      await acknowledgeAndStart(page);
      const items = page.getByTestId('pending-suggestion-item');
      await expect(items).toHaveCount(3);
      await expect(items.nth(0)).toContainText(/重复开头|重复|Repeated/);
      await expect(items.nth(0).getByTestId('suggestion-source')).toContainText(/规则|Rule/);
      await expect(items.nth(1).getByTestId('suggestion-source')).toContainText(/语义|Semantic/);
      await expect(items.nth(1)).toContainText(/高可信|High confidence/);
      await items.nth(0).getByRole('checkbox').check();
      await page.getByRole('button', { name: /预览剪辑效果|Preview proposed cuts/ }).click();
      await expect(page.getByText(/预览，尚未应用|Preview, not applied/).first()).toBeVisible();
      await shot(page, 'F-0009', 'provenance-preview-' + theme + '-' + lang);

      await page.getByTestId('subtitle-main-text').first().fill('编辑后的字幕');
      await page.getByTestId('subtitle-main-text').first().blur();
      await expect(page.getByText(/建议已过期，请重新分析|Suggestions are outdated/).first()).toBeVisible();
      await expect(page.getByRole('button', { name: /应用选中建议|Apply selected suggestions/ })).toBeDisabled();
      await shot(page, 'F-0009', 'stale-' + theme + '-' + lang);
      await page.getByRole('button', { name: /取消|Cancel/, exact: true }).last().click();
      await page.getByTitle(/撤销删除|Undo Delete/).click();
      await expect(page.getByTestId('subtitle-main-text').first()).toHaveValue('这个这个方案');

      state.setScenario('success');
      state.setSaveFailure(true);
      await openSemantic(page);
      await acknowledgeAndStart(page);
      await expect(page.getByTestId('pending-suggestion-item')).toHaveCount(3);
      await page.getByTestId('pending-suggestion-item').nth(0).getByRole('checkbox').check();
      await page.getByRole('button', { name: /应用选中建议|Apply selected suggestions/ }).click();
      await expect(page.getByText(/应用失败|Cannot apply/)).toBeVisible();
      await expect(page.getByTestId('pending-suggestion-item').first()).toBeVisible();
      await shot(page, 'F-0009', 'save-failed-' + theme + '-' + lang);
      state.setSaveFailure(false);
      await page.getByRole('button', { name: /取消|Cancel/, exact: true }).last().click();

      state.setScenario('empty');
      await openSemantic(page);
      await acknowledgeAndStart(page);
      await expect(page.getByText(/没有发现可剪除的语义口癖|No contextual fillers found/)).toBeVisible();
      await expect(page.getByTestId('cut-suggestions')).not.toContainText(/语境语气词|Contextual filler/);
      await shot(page, 'F-0009', 'empty-' + theme + '-' + lang);
    });
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any -- mock Host payloads mirror JSON RPC shapes. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_HOST_ID, MOCK_HOST, mockHost, pending, prepare, RpcError, uuid, VIDEO_ID, type MockHandlers } from '../lib/mockHost';
import { shot } from '../lib/evidence';

const P = uuid(156);
const AI_A = uuid(956);
const AI_B = uuid(957);
const E2E_HOST_B = uuid(958);
const T = '2026-11-09T12:00:00Z';
const transcript = { text: '', language: 'zh', duration: 3, hasWordTimestamps: false, chunks: [] };
let mediaDir: string; let media: string;

test.beforeAll(() => {
  mediaDir = mkdtempSync(join(tmpdir(), 'flycut-f0056-ui-')); media = join(mediaDir, 'marker.mp4');
  const run = spawnSync(process.env.FFMPEG_PATH ?? resolve('src-tauri/binaries/ffmpeg'), ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', media], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr);
});
test.afterAll(() => rmSync(mediaDir, { recursive: true, force: true }));

async function connect(page: Page, options: { conflict?: boolean; importFailure?: boolean; initial?: any } = {}) {
  let snapshot = options.initial ?? { hostId: E2E_HOST_ID, revision: 0, selectedId: null, configs: [] };
  let failImport = options.importFailure === true;
  let conflict = false;
  let releaseList: ((value: unknown) => void) | null = null;
  const handlers: MockHandlers = {
    'projects.open': () => ({ status: 'ok',
      project: { id: P, name: 'AI settings', formatVersion: 3, revision: 1, styleRevision: 0, videos: [], createdAt: T, updatedAt: T },
      video: { id: VIDEO_ID, name: 'AI settings.mp4', durationSeconds: 3, revision: 1, styleSource: 'project', hasTranscript: true,
        createdAt: T, media: { kind: 'stored', file: `media/${VIDEO_ID}.mp4`, size: 1, mimeType: 'video/mp4' } },
      videos: [], transcript, media: { status: 'ok', name: 'AI settings.mp4', playback: { kind: 'url', path: `/projects/${P}/media/${VIDEO_ID}` } } }),
    'projects.saveVideoEdits': payload => ({ status: 'saved', revision: payload.revision + 1, projectRevision: 2, updatedAt: T }),
    'projects.saveProjectStyle': () => ({ status: 'saved', revision: 1, projectRevision: 2, updatedAt: T }),
    'aiSettings.list': () => releaseList ? new Promise(resolve => { releaseList = resolve as any; }) : snapshot,
    'aiSettings.save': payload => {
      if (payload.expectedRevision !== snapshot.revision) return { status: 'conflict', snapshot };
      const id = payload.configId ?? AI_B; const current = snapshot.configs.find((item: any) => item.id === id);
      if (conflict) {
        conflict = false;
        snapshot = { ...snapshot, revision: snapshot.revision + 1, configs: snapshot.configs.map((item: any) => item.id === id ? { ...item, name: 'Fresh from another client' } : item) };
        return { status: 'conflict', snapshot };
      }
      const next = { id, name: payload.config.name, baseUrl: payload.config.baseUrl, model: payload.config.model,
        temperature: payload.config.temperature,
        hasApiKey: payload.config.clearApiKey ? false : payload.config.apiKey ? true : current?.hasApiKey ?? false };
      snapshot = { ...snapshot, revision: snapshot.revision + 1, selectedId: snapshot.selectedId ?? id,
        configs: current ? snapshot.configs.map((item: any) => item.id === id ? next : item) : [...snapshot.configs, next] };
      return { status: 'saved', configId: id, snapshot };
    },
    'aiSettings.select': payload => {
      if (payload.expectedRevision !== snapshot.revision) return { status: 'conflict', snapshot };
      snapshot = { ...snapshot, revision: snapshot.revision + 1, selectedId: payload.configId }; return { status: 'saved', snapshot };
    },
    'aiSettings.test': () => ({ status: 'ok', message: 'Connection succeeded (HTTP 200)' }),
    'aiSettings.remove': payload => {
      if (payload.expectedRevision !== snapshot.revision) return { status: 'conflict', snapshot };
      snapshot = { ...snapshot, revision: snapshot.revision + 1, configs: snapshot.configs.filter((item: any) => item.id !== payload.configId), selectedId: null };
      return { status: 'removed', removed: payload.configId, snapshot };
    },
    'aiSettings.import': async payload => {
      if (releaseList) { const release = releaseList; releaseList = null; await new Promise(resolve => setTimeout(resolve, 50)); release(snapshot); }
      if (failImport) { failImport = false; throw new RpcError('temporary migration failure'); }
      const imported = payload.configs.map((item: any, index: number) => ({ id: index ? AI_B : AI_A, name: item.name,
        baseUrl: item.baseUrl, model: item.model, hasApiKey: !!item.apiKey }));
      snapshot = { ...snapshot, revision: snapshot.revision + 1, selectedId: AI_A, configs: [...snapshot.configs, ...imported] };
      return { status: 'imported', duplicate: false, configIds: imported.map((item: any) => item.id), snapshot };
    },
  };
  const host = await mockHost(page, handlers);
  await page.route(`${MOCK_HOST}/projects/**/media/**`, route => {
    const bytes = readFileSync(media); const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
    const start = range ? Number(range[1]) : 0; const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    return route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4', body: bytes.subarray(start, end + 1),
      headers: { 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) } });
  });
  return { host, snapshot: () => snapshot, setConflict: () => { conflict = true; },
    releaseList: () => { if (releaseList) { const release = releaseList; releaseList = null; release(snapshot); } } };
}

async function openAITab(page: Page, theme: 'light' | 'dark', lang: 'zh' | 'en', extra: Record<string, string> = {}) {
  await prepare(page, theme, { 'flycut-locale': lang, ...extra });
  await page.goto(`/?lang=${lang}#/projects/${P}/videos/${VIDEO_ID}`);
  if (lang === 'en') {
    await page.getByRole('button', { name: '选择语言' }).click();
    await page.getByRole('menuitem', { name: /English/ }).click();
  }
  await page.getByRole('button', { name: 'API', exact: true }).click();
}

for (const theme of ['light', 'dark'] as const) for (const lang of ['zh', 'en'] as const) {
  test.describe(`${theme}-${lang}`, () => {
    test('F-0056/AC-3 AC-5 AC-6 AC-7 AC-8 CRUD, masking, test connection, loading and version conflict', async ({ page }) => {
      const state = await connect(page);
      await openAITab(page, theme, lang);
      const panel = page.getByTestId('ai-settings-panel');
      await expect(panel.getByTestId('ai-empty')).toBeVisible();
      await shot(page, 'F-0056', `settings-empty-${theme}-${lang}`);

      await panel.getByTestId('ai-config-add').click();
      const dialog = page.getByTestId('ai-config-dialog');
      await dialog.getByPlaceholder('My GPT-4o').fill('Host AI');
      await dialog.getByPlaceholder('https://api.openai.com/v1').fill('https://ai.example/v1');
      await dialog.getByPlaceholder('gpt-4o-mini').fill('fixture-model');
      await dialog.getByTestId('ai-api-key').fill('only-on-host-key');
      await dialog.getByTestId('ai-config-save').click();
      await expect(panel.getByTestId('ai-config-row')).toContainText('Host AI');
      await expect(panel.getByTestId('ai-config-row')).toContainText(theme === 'dark' || lang === 'en' ? /Key configured|Key/ : /Key/);
      const savedCall = state.host.calls.find(call => call.method === 'aiSettings.save');
      expect(savedCall?.payload.config).toMatchObject({ apiKey: 'only-on-host-key' });
      expect(JSON.stringify(state.snapshot())).not.toContain('only-on-host-key');
      await shot(page, 'F-0056', `settings-saved-${theme}-${lang}`);

      await panel.getByTestId('ai-config-test').click();
      await expect(panel.getByTestId('ai-message-success')).toContainText(/Connection succeeded|连接成功/);

      await panel.getByTestId('ai-config-edit').click();
      await expect(dialog.getByTestId('ai-api-key')).toHaveValue('');
      await dialog.getByPlaceholder('My GPT-4o').fill('Edited locally');
      await dialog.getByTestId('ai-config-save').click();
      const editCall = state.host.calls.filter(call => call.method === 'aiSettings.save').at(-1);
      expect(editCall?.payload.config).not.toHaveProperty('apiKey');
      await expect(panel.getByTestId('ai-config-row')).toContainText('Edited locally');

      await panel.getByTestId('ai-config-edit').click();
      await dialog.getByTestId('ai-clear-api-key').click();
      await dialog.getByTestId('ai-config-save').click();
      const clearCall = state.host.calls.filter(call => call.method === 'aiSettings.save').at(-1);
      expect(clearCall?.payload.config).toMatchObject({ clearApiKey: true });
      expect(clearCall?.payload.config).not.toHaveProperty('apiKey');
      await expect(panel.getByTestId('ai-config-row')).toContainText(/No key configured|未配置 Key/);
      await shot(page, 'F-0056', `settings-key-cleared-${theme}-${lang}`);

      await panel.getByTestId('ai-config-edit').click();
      state.setConflict();
      await dialog.getByPlaceholder('My GPT-4o').fill('Pending local edit');
      await dialog.getByTestId('ai-config-save').click();
      await expect(panel.getByTestId('ai-message-warning')).toContainText(/Content changed|内容已更新/);
      await expect(dialog).toBeVisible();
      await dialog.getByPlaceholder('My GPT-4o').fill('After review');
      await dialog.getByTestId('ai-config-save').click();
      await expect(panel.getByTestId('ai-config-row')).toContainText('After review');
      await shot(page, 'F-0056', `settings-conflict-resolved-${theme}-${lang}`);

      await panel.getByTestId('ai-config-delete').click();
      await page.getByTestId('ai-delete-confirm').click();
      await expect(panel.getByTestId('ai-empty')).toBeVisible();

      state.host.set('aiSettings.list', () => ({ hostId: E2E_HOST_B, revision: 7, selectedId: AI_A,
        configs: [{ id: AI_A, name: 'Foreign Host', baseUrl: 'https://foreign.example/v1', model: 'foreign', hasApiKey: true }] }));
      await panel.getByTestId('ai-settings-refresh').click();
      await expect(panel.getByTestId('ai-message-warning')).toContainText(/another Host|另一个 Host/);
      await expect(panel.getByTestId('ai-empty')).toBeVisible();
      await expect(panel).not.toContainText(E2E_HOST_B);
      await shot(page, 'F-0056', `settings-host-mismatch-${theme}-${lang}`);

      state.host.set('projects.identity', () => ({ hostId: E2E_HOST_B, recovery: 1 }));
      state.host.set('aiSettings.list', () => ({ hostId: E2E_HOST_B, revision: 8, selectedId: AI_B,
        configs: [{ id: AI_B, name: 'Second Host', baseUrl: 'https://second.example/v1', model: 'second', hasApiKey: true }] }));
      await state.host.disconnect();
      await expect(page.getByTestId('connection-identity-changed')).toBeVisible();
      await page.evaluate(hash => { window.location.hash = hash; }, `#/projects/${P}/videos/${VIDEO_ID}`);
      await page.getByRole('button', { name: 'API', exact: true }).click();
      await expect(panel.getByTestId('ai-config-row')).toContainText('Second Host');
      await expect(panel).toContainText(E2E_HOST_B);
      await expect(panel).not.toContainText('Foreign Host');
      await shot(page, 'F-0056', `settings-host-switched-${theme}-${lang}`);

      state.host.set('aiSettings.list', () => pending());
      await panel.getByTestId('ai-settings-refresh').click();
      await expect(panel.getByTestId('ai-processing')).toBeVisible();
      await expect(panel.getByTestId('ai-settings-refresh')).toBeDisabled();
      await shot(page, 'F-0056', `settings-loading-${theme}-${lang}`);
    });

    test('F-0056/AC-2 AC-6 AC-8 explicit Host-bound migration keeps source on failure and uses one retry ID', async ({ page }) => {
      const legacy = JSON.stringify({ state: { aiModels: [{ id: 'legacy-browser', name: 'Legacy AI', baseUrl: 'https://legacy.example/v1',
        model: 'legacy-model', apiKey: 'legacy-browser-key' }], selectedAIModelId: 'legacy-browser' }, version: 1 });
      const state = await connect(page, { importFailure: true });
      await openAITab(page, theme, lang, { 'app-settings': legacy });
      const panel = page.getByTestId('ai-settings-panel');
      await expect(panel.getByTestId('ai-migration-card')).toContainText('Legacy AI');
      await expect(panel).toContainText(E2E_HOST_ID);
      await shot(page, 'F-0056', `migration-review-${theme}-${lang}`);

      await panel.getByTestId('ai-migration-review').click();
      const dialog = page.getByTestId('ai-migration-dialog');
      await expect(dialog).toContainText(E2E_HOST_ID);
      await dialog.getByTestId('ai-migration-run').click();
      await expect(panel.getByTestId('ai-message-error')).toContainText(/temporary migration failure/);
      const first = state.host.calls.find(call => call.method === 'aiSettings.import');
      expect(await page.evaluate(() => localStorage.getItem('flycut-ai-settings-migration-source-v1'))).toContain('legacy-browser-key');
      await shot(page, 'F-0056', `migration-failed-${theme}-${lang}`);

      await dialog.getByTestId('ai-migration-run').click();
      const imports = state.host.calls.filter(call => call.method === 'aiSettings.import');
      expect(imports).toHaveLength(2);
      expect(imports[1].payload.migrationId).toBe(first?.payload.migrationId);
      await expect(panel.getByTestId('ai-message-success')).toContainText(/Migration completed|迁移完成/);
      await expect(panel.getByTestId('ai-config-row')).toContainText('Legacy AI');
      expect(await page.evaluate(() => localStorage.getItem('flycut-ai-settings-migration-source-v1'))).toBeNull();
      const persisted = await page.evaluate(() => localStorage.getItem('app-settings'));
      expect(persisted ?? '').not.toContain('legacy-browser-key');
      await shot(page, 'F-0056', `migration-complete-${theme}-${lang}`);
    });
  });
}


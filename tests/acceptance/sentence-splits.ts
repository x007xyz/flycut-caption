import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { createHost } from '../../server/app';
import type { ProjectOpenResult } from '../../shared/projects';

const MEDIA = process.env.FLYCUT_F0020_MEDIA ?? resolve('tests/media/external/coscup-bTc722zFo7o.mp4');
const TRANSCRIPT = process.env.FLYCUT_F0020_TRANSCRIPT ?? resolve('tests/media/external/coscup-bTc722zFo7o.transcript.json');
const SHOTS = resolve('docs/features/F-0020-punctuation-sentence-splitting/screenshots');

if (!existsSync(MEDIA) || !existsSync(TRANSCRIPT)) {
  console.log(`SKIP F-0020 real acceptance: missing ${MEDIA} or ${TRANSCRIPT}`);
  process.exit(0);
}

const transcript = JSON.parse(await readFile(TRANSCRIPT, 'utf8'));
const dir = await mkdtemp(join(tmpdir(), 'flycut-f0020-real-'));
const token = randomUUID();
const ctx = await createHost({ home: dir, appData: dir, bind: '127.0.0.1', port: 0,
  token, resourceRoot: resolve('.'), assetTtlHours: 1 }, { profile: 'desktop', providers: [] });
const auth = { Authorization: `Bearer ${token}` };
const address = ctx.httpServer.address();
if (!address || typeof address === 'string') throw new Error('Host port missing');
const base = `http://127.0.0.1:${address.port}`;
const call = async <T>(method: string, payload: unknown = {}): Promise<T> => {
  const response = await fetch(`${base}/rpc`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }) });
  const envelope = await response.json() as { result: { ok: boolean; value: T; error?: { message: string } } };
  if (!envelope.result.ok) throw new Error(`${method}: ${envelope.result.error?.message}`);
  return envelope.result.value;
};
const openProject = async (projectId: string, videoId: string) =>
  call<ProjectOpenResult>('projects.open', { projectId, videoId });
const projectChunkCount = (result: ProjectOpenResult) =>
  result.status === 'ok' ? (result.edits?.chunks ?? result.transcript?.chunks ?? []).length : 0;

try {
  await mkdir(join(dir, 'media'), { recursive: true });
  const upload = await fetch(`${base}/assets`, { method: 'POST', headers: { ...auth, 'Content-Type': 'video/mp4' },
    body: new Uint8Array(await readFile(MEDIA)) });
  if (!upload.ok) throw new Error(`asset upload failed: HTTP ${upload.status}`);
  const { assetId } = await upload.json() as { assetId: string };
  const ids = await call<{ projectId: string; videoId: string }>('projects.create', {
    name: 'F-0020 真实长口播', videoName: 'coscup.mp4', durationSeconds: transcript.duration,
    media: { assetId, mimeType: 'video/mp4' } });
  await call('projects.saveTranscript', { ...ids, durationSeconds: transcript.duration,
    transcript: { text: transcript.text, language: transcript.language, duration: transcript.duration,
      chunks: transcript.chunks, wordChunks: transcript.wordChunks, hasWordTimestamps: transcript.hasWordTimestamps } });

  await writeFile(join(dir, 'connection.json'), JSON.stringify({ url: base, token }), { mode: 0o600 });
  process.env.FLYCUT_HOST_HOME = dir;
  const vite = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: true }, logLevel: 'error' });
  await vite.listen();
  const app = vite.httpServer?.address();
  if (!app || typeof app === 'string') throw new Error('Web port missing');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    await mkdir(SHOTS, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${app.port}/#/projects/${ids.projectId}/videos/${ids.videoId}`);
    await page.getByTestId('sentence-split-open').waitFor({ state: 'visible', timeout: 120_000 });
    await page.getByTestId('sentence-split-open').click();
    await page.getByTestId('sentence-split-max').fill('20');
    const suggestionCount = await page.getByTestId('sentence-split-suggestion').count();
    if (!suggestionCount) throw new Error('real transcript produced no split suggestions');
    console.log(`real suggestions: ${suggestionCount}`);
    await page.screenshot({ path: join(SHOTS, 'real-ready-zh.png'), fullPage: false });

    const beforeChunks = projectChunkCount(await openProject(ids.projectId, ids.videoId));

    for (const aspect of ['landscape', 'portrait_9_16', 'square_1_1']) {
      const trigger = page.getByRole('button', { name: '位置与大小' });
      if (await trigger.isVisible().catch(() => false)) await trigger.click();
      const button = page.getByTestId(`aspect-preset-${aspect}`);
      await button.click();
      await page.waitForTimeout(200);
      await page.screenshot({ path: join(SHOTS, `real-${aspect}-zh.png`), fullPage: false });
      console.log(`aspect ${aspect}: ok`);
    }

    await page.getByTestId('sentence-split-apply').click();
    await page.getByTestId('sentence-split-completed').waitFor({ state: 'visible', timeout: 120_000 });
    await page.waitForTimeout(2000);
    const afterChunks = projectChunkCount(await openProject(ids.projectId, ids.videoId));
    if (afterChunks <= beforeChunks) throw new Error(`chunks were not split: ${beforeChunks} -> ${afterChunks}`);
    console.log(`chunks: ${beforeChunks} -> ${afterChunks}`);

    await page.locator('body').click({ position: { x: 8, y: 8 } });
    await page.keyboard.press('Meta+z');
    await page.waitForTimeout(3000);
    const undoneChunks = projectChunkCount(await openProject(ids.projectId, ids.videoId));
    if (undoneChunks !== beforeChunks) throw new Error(`undo did not restore chunks: ${undoneChunks} != ${beforeChunks}`);
    console.log(`undo restored chunks: ${undoneChunks}`);

    await page.reload();
    await page.getByTestId('sentence-split-open').waitFor({ state: 'visible', timeout: 120_000 });
    const reopenedChunks = projectChunkCount(await openProject(ids.projectId, ids.videoId));
    if (reopenedChunks !== beforeChunks) throw new Error(`reopen changed chunks: ${reopenedChunks} != ${beforeChunks}`);
    console.log(`reopen chunks: ${reopenedChunks}`);
    if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
    console.log('F-0020 real acceptance passed');
  } finally {
    await browser.close();
    await vite.close();
  }
} finally {
  await ctx.fiber.dispose();
  await rm(dir, { recursive: true, force: true });
}

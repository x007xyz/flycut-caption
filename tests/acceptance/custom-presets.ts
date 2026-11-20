import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { createHost } from '../../server/app';
import type { ProjectOpenResult, ProjectStyle } from '../../shared/projects';
import type { StylePresetsSnapshot } from '../../shared/stylePresets';
import { defaultSubtitleStylePair } from '../../src/subtitle/subtitleStyle';

const SHOTS = resolve('docs/features/F-0027-custom-subtitle-presets/screenshots');
const dir = await mkdtemp(join(tmpdir(), 'flycut-f0027-real-'));
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
const openProject = (projectId: string, videoId: string) => call<ProjectOpenResult>('projects.open', { projectId, videoId });

try {
  const media = join(dir, 'sample.mp4');
  execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30:d=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', media]);
  const upload = async () => {
    const response = await fetch(`${base}/assets`, { method: 'POST', headers: { ...auth, 'Content-Type': 'video/mp4' },
      body: new Uint8Array(await readFile(media)) });
    if (!response.ok) throw new Error(`asset upload failed: HTTP ${response.status}`);
    return (await response.json() as { assetId: string }).assetId;
  };
  const assetA = await upload();
  const ids = await call<{ projectId: string; videoId: string }>('projects.create', {
    name: 'F-0027 真实预设项目', videoName: 'a.mp4', durationSeconds: 2, media: { assetId: assetA, mimeType: 'video/mp4' } });
  const assetB = await upload();
  const videoB = await call<{ videoId: string }>('projects.addVideo', {
    projectId: ids.projectId, videoName: 'b.mp4', durationSeconds: 2, media: { assetId: assetB, mimeType: 'video/mp4' } });
  const transcript = { text: '预设字幕', language: 'zh', duration: 2, chunks: [{ id: 'c1', text: '预设字幕', timestamp: [0, 2] }] };
  await call('projects.saveTranscript', { ...ids, durationSeconds: 2, transcript });
  await call('projects.saveTranscript', { projectId: ids.projectId, videoId: videoB.videoId, durationSeconds: 2, transcript });

  const primary = { ...defaultSubtitleStylePair.primary, color: '#FF0000' };
  const seeded = await call('projects.saveStylePresets', { projectId: ids.projectId, baseRevision: 0,
    presets: [{ name: 'Night', primary, secondary: { ...defaultSubtitleStylePair.secondary } }] });
  if (seeded.status !== 'saved') throw new Error('seed preset failed');

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
    const section = page.getByTestId('custom-presets-section');
    await section.waitFor({ state: 'visible', timeout: 120_000 });
    await section.getByTestId('custom-preset-item').waitFor({ state: 'visible', timeout: 60_000 });
    await page.screenshot({ path: join(SHOTS, 'real-preset-loaded-zh.png') });

    await section.getByTestId('custom-preset-apply').click();
    await section.getByTestId('custom-preset-notice').waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(2500);
    const opened = await openProject(ids.projectId, ids.videoId);
    const style = opened.status === 'ok' ? opened.projectStyle as ProjectStyle | undefined : undefined;
    if ((style?.primary as { color?: string } | undefined)?.color !== '#FF0000') throw new Error('preset was not saved into the project style');
    const aspect = (style?.primary as { aspectPreset?: string } | undefined)?.aspectPreset;
    if (aspect !== 'landscape') throw new Error(`video aspect changed: ${aspect}`);
    console.log('project style applied, aspect kept');

    await page.goto(`http://127.0.0.1:${app.port}/#/projects/${ids.projectId}/videos/${videoB.videoId}`);
    await page.getByTestId('custom-presets-section').getByTestId('custom-preset-item').waitFor({ state: 'visible', timeout: 60_000 });
    console.log('second video sees the preset');
    await page.getByTestId('custom-preset-save-open').click();
    await page.getByTestId('custom-preset-name').fill('FromUI');
    await page.getByTestId('custom-preset-save').click();
    await page.getByTestId('custom-preset-notice').waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(2000);
    const list = await call<StylePresetsSnapshot>('projects.getStylePresets', { projectId: ids.projectId });
    if (list.presets.length !== 2) throw new Error(`UI save did not persist: ${list.presets.length}`);
    console.log(`presets after UI save: ${list.presets.map(item => item.name).join(', ')}`);
    await page.screenshot({ path: join(SHOTS, 'real-preset-saved-zh.png') });

    await page.getByTestId('custom-preset-list').getByTestId('custom-preset-delete').first().click();
    await page.getByTestId('custom-preset-confirm-delete').click();
    await page.waitForTimeout(2000);
    const afterDelete = await call<StylePresetsSnapshot>('projects.getStylePresets', { projectId: ids.projectId });
    if (afterDelete.presets.length !== 1) throw new Error(`delete did not persist: ${afterDelete.presets.length}`);
    const styleAfter = (await openProject(ids.projectId, videoB.videoId));
    const colorAfter = styleAfter.status === 'ok' ? (styleAfter.projectStyle?.primary as { color?: string } | undefined)?.color : undefined;
    if (colorAfter !== '#FF0000') throw new Error(`delete changed the applied style: ${colorAfter}`);
    console.log('delete kept the applied style snapshot');

    await page.reload();
    await page.getByTestId('custom-presets-section').getByTestId('custom-preset-item').waitFor({ state: 'visible', timeout: 60_000 });
    const reopened = await call<StylePresetsSnapshot>('projects.getStylePresets', { projectId: ids.projectId });
    if (reopened.presets.length !== 1) throw new Error('reopen lost presets');
    if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
    console.log('F-0027 real acceptance passed');
  } finally { await browser.close(); await vite.close(); }
} finally {
  await ctx.fiber.dispose();
  await rm(dir, { recursive: true, force: true });
}

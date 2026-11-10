// 真实 Host + 真实浏览器 + 可切断 TCP 代理。普通回归默认跳过；
// 运行：F0015_REAL=1 F0015_REAL_MEDIA=/absolute/path/to/long.mp4 pnpm exec playwright test tests/e2e/features/F-0015.real.spec.ts --workers=1
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createHost } from '../../../server/app';
import { shot } from '../lib/evidence';
import { prepare } from '../lib/mockHost';

const ENABLED = process.env.F0015_REAL === '1';
const APP_ORIGIN = process.env.F0015_APP_ORIGIN ?? 'http://localhost:5173';
const TOKEN = 'f0015-real-browser-token';

function mp4(size: number, seed: number) {
  const bytes = Buffer.allocUnsafe(size);
  for (let offset = 0; offset < size; offset += 1) bytes[offset] = (offset * 31 + seed) & 0xff;
  bytes.writeUInt32BE(24, 0); bytes.write('ftyp', 4, 'ascii'); bytes.write('isom', 8, 'ascii');
  return bytes;
}

async function cuttableProxy(target: string) {
  const destination = new URL(target);
  const sockets = new Set<Socket>();
  let blocked = false; let cutOnce = false; let cutAfter = Number.POSITIVE_INFINITY; let bytes = 0;
  const server = createServer(client => {
    sockets.add(client);
    if (blocked) { client.destroy(); return; }
    const upstream = connect(Number(destination.port), destination.hostname);
    sockets.add(upstream);
    const clean = () => { sockets.delete(client); sockets.delete(upstream); };
    client.on('error', clean); upstream.on('error', clean); client.on('close', clean); upstream.on('close', clean);
    client.on('data', chunk => {
      bytes += chunk.length;
      if (!cutOnce && !blocked && bytes >= cutAfter) {
        cutOnce = true; blocked = true;
        for (const socket of sockets) socket.destroy();
      }
    });
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, resolve); });
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://localhost:${port}`,
    setCutAfter(value: number) { cutAfter = value; cutOnce = false; bytes = 0; },
    restore() { blocked = false; },
    get bytes() { return bytes; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

function cookieHeader(response: Response, name: string) {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')!] : []);
  const value = values.find(item => item.startsWith(`${name}=`))?.split(';')[0];
  return value?.slice(name.length + 1);
}

async function connectBrowser(page: Page, context: BrowserContext, proxyUrl: string, session: { cookie: string; csrf: string }) {
  const browserUrl = new URL(proxyUrl);
  await context.addCookies([{ name: 'flycut_session', value: session.cookie, domain: browserUrl.hostname,
    path: '/', httpOnly: true, sameSite: 'Strict' }]);
  await page.route(`${APP_ORIGIN}/__flycut/connection`, route => route.fulfill({ json: { url: proxyUrl, auth: 'session', csrf: session.csrf } }));
  await page.goto(`${APP_ORIGIN}/#/projects`);
  await expect(page.getByRole('button', { name: /已连接 · localhost:/ })).toBeVisible({ timeout: 15_000 });
}

async function bootstrapHost(hostUrl: string) {
  const response = await fetch(`${hostUrl}/__flycut/connection`, { headers: { Origin: APP_ORIGIN } });
  expect(response.status).toBe(200);
  const cookie = cookieHeader(response, 'flycut_session');
  if (!cookie) throw new Error('Host did not issue a browser session');
  return { cookie, csrf: (await response.json() as { csrf: string }).csrf };
}

async function rpc<T>(hostUrl: string, method: string, payload: unknown) {
  const response = await fetch(`${hostUrl}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }) });
  const body = await response.json() as { result: { ok: boolean; value?: T; error?: { message: string } } };
  if (!body.result.ok) throw new Error(body.result.error?.message);
  return body.result.value as T;
}

async function projectList(hostUrl: string) {
  return rpc<Array<{ id: string; name: string }>>(hostUrl, 'projects.list', {});
}

async function fileIdentity(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { size: (await stat(path)).size, sha256: hash.digest('hex') };
}

async function assertProjectMedia(hostUrl: string, name: string, expected: { size: number; sha256: string }) {
  const project = (await projectList(hostUrl)).find(item => item.name === name);
  if (!project) throw new Error(`Missing project ${name}`);
  const opened = await rpc<{ status: string; media: { playback?: { path?: string } } }>(hostUrl, 'projects.open', { projectId: project.id });
  expect(opened.status).toBe('ok');
  const response = await fetch(`${hostUrl}${opened.media.playback?.path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  expect(response.status).toBe(200);
  const stored = Buffer.from(await response.arrayBuffer());
  expect(stored.length).toBe(expected.size);
  expect(createHash('sha256').update(stored).digest('hex')).toBe(expected.sha256);
}

async function currentSession(page: Page, name: string) {
  return page.evaluate(expectedName => {
    const sessions = Object.keys(localStorage)
      .filter(key => key.startsWith('flycut.upload.sessions.'))
      .flatMap(key => JSON.parse(localStorage.getItem(key) ?? '[]') as Array<Record<string, unknown>>);
    const item = sessions.find(value => value.fileName === expectedName);
    if (!item) throw new Error(`Missing upload locator for ${expectedName}`);
    return String(item.sessionId);
  }, name);
}

async function hostSessionBytes(context: BrowserContext, hostUrl: string, sessionId: string) {
  const cookie = (await context.cookies()).map(item => `${item.name}=${item.value}`).join('; ');
  const response = await fetch(`${hostUrl}/uploads/${sessionId}`, { headers: { Origin: APP_ORIGIN, Cookie: cookie } });
  expect(response.status).toBe(200);
  return (await response.json() as { uploadedBytes: number }).uploadedBytes;
}

test.describe.serial('F-0015 real Host recovery', () => {
  test.skip(!ENABLED, 'set F0015_REAL=1 to run the real Host browser test');

  test('F-0015/AC-5 AC-6 AC-10 real TCP cut and page refresh resume the same session', async ({ page, context }) => {
    test.setTimeout(240_000);
    const home = await mkdtemp(join(tmpdir(), 'flycut-f0015-browser-'));
    const webRoot = join(home, 'web');
    await mkdir(webRoot, { recursive: true });
    await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Host</title>');
    const requestedMedia = process.env.F0015_REAL_MEDIA;
    const mediaPath = requestedMedia ?? join(home, 'generated-long.mp4');
    if (!requestedMedia) await writeFile(mediaPath, mp4(5 * 1024 * 1024 + 31, 7));
    const cutMediaPath = join(home, 'real-cut.mp4');
    const refreshMediaPath = join(home, 'real-refresh.mp4');
    await link(mediaPath, cutMediaPath);
    await link(mediaPath, refreshMediaPath);
    const identity = await fileIdentity(mediaPath);
    expect(identity.size, 'real evidence must use a long media file, not the old 5 MiB fixture').toBeGreaterThan(64 * 1024 * 1024);
    const chunkBytes = 8 * 1024 * 1024;
    const ctx = await createHost({ home, token: TOKEN, port: 0, resourceRoot: resolve('.'), webRoot, allowedOrigins: [APP_ORIGIN],
      uploadChunkBytes: chunkBytes, uploadMaxBytes: identity.size + chunkBytes, uploadSessionTtlHours: 1 }, { providers: [] });
    const hostUrl = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
    const proxy = await cuttableProxy(hostUrl);
    const evidence: Record<string, unknown> = { source: basename(mediaPath), size: identity.size, sha256: identity.sha256, cuts: [], refreshed: {} };
    try {
      await prepare(page, 'light');
      await connectBrowser(page, context, proxy.url, await bootstrapHost(hostUrl));
      proxy.setCutAfter(chunkBytes * 1.5);
      await page.getByTestId('project-file-input').setInputFiles(cutMediaPath);
      const row = page.getByTestId('media-upload-row').last();
      await expect(row).toHaveAttribute('data-upload-phase', 'interrupted', { timeout: 20_000 });
      await expect(row).toContainText('上传已中断，等待重连');
      const cutSession = await currentSession(page, 'real-cut.mp4');
      const afterFirstCut = await hostSessionBytes(context, hostUrl, cutSession);
      expect(afterFirstCut).toBeGreaterThan(0);
      evidence.cuts = [{ attempt: 1, confirmedBytes: afterFirstCut }];
      await shot(page, 'F-0015', 'real-interrupted-light');

      for (const attempt of [2, 3]) {
        proxy.restore();
        await expect(page.getByRole('button', { name: /已连接 · localhost:/ })).toBeVisible({ timeout: 20_000 });
        proxy.setCutAfter(chunkBytes * 1.5);
        const retry = row.getByRole('button', { name: '立即重试' });
        if (await retry.isVisible()) await retry.click();
        await expect(row).toHaveAttribute('data-upload-phase', 'interrupted', { timeout: 20_000 });
        const bytes = await hostSessionBytes(context, hostUrl, cutSession);
        (evidence.cuts as Array<Record<string, number>>).push({ attempt, confirmedBytes: bytes });
      }

      proxy.restore();
      await expect(page.getByRole('button', { name: /已连接 · localhost:/ })).toBeVisible({ timeout: 20_000 });
      const finalRetry = row.getByRole('button', { name: '立即重试' });
      if (await finalRetry.isVisible()) await finalRetry.click();
      await expect(page).toHaveURL(new RegExp(`#/projects/[0-9a-f-]+/videos/[0-9a-f-]+`), { timeout: 30_000 });
      await expect.poll(async () => (await projectList(hostUrl)).map(item => item.name)).toContain('real-cut');
      await assertProjectMedia(hostUrl, 'real-cut', identity);

      await page.getByRole('button', { name: /我的项目/ }).first().click();
      proxy.setCutAfter(chunkBytes * 1.5);
      await page.getByTestId('project-file-input').setInputFiles(refreshMediaPath);
      const secondRow = page.getByTestId('media-upload-row').last();
      await expect(secondRow).toHaveAttribute('data-upload-phase', 'interrupted', { timeout: 20_000 });
      const refreshSession = await currentSession(page, 'real-refresh.mp4');
      const beforeRefresh = await hostSessionBytes(context, hostUrl, refreshSession);
      const locatorCount = await page.evaluate(() => Object.keys(localStorage)
        .filter(key => key.startsWith('flycut.upload.sessions.')).reduce((total, key) => total + JSON.parse(localStorage.getItem(key) ?? '[]').length, 0));
      expect(locatorCount).toBeGreaterThan(0);
      proxy.restore();
      await page.reload();
      await expect(page.getByTestId('media-upload-row').last()).toHaveAttribute('data-upload-phase', 'needs-file', { timeout: 20_000 });
      await expect(page.getByTestId('media-upload-row').last()).toContainText('real-refresh.mp4');
      await shot(page, 'F-0015', 'real-needs-file-light');
      await page.getByTestId('upload-resume-input').setInputFiles(refreshMediaPath);
      await expect(page).toHaveURL(new RegExp(`#/projects/[0-9a-f-]+/videos/[0-9a-f-]+`), { timeout: 30_000 });
      const afterRefresh = await hostSessionBytes(context, hostUrl, refreshSession);
      expect(afterRefresh).toBe(identity.size);
      expect(afterRefresh - beforeRefresh).toBeLessThan(identity.size);
      evidence.refreshed = { confirmedBeforeReload: beforeRefresh, confirmedAfterResume: afterRefresh, resentAfterRefresh: afterRefresh - beforeRefresh };
      await expect.poll(async () => (await projectList(hostUrl)).map(item => item.name)).toContain('real-refresh');
      await assertProjectMedia(hostUrl, 'real-refresh', identity);
      await shot(page, 'F-0015', 'real-recovered-light');
      console.log(`F0015_REAL_EVIDENCE ${JSON.stringify(evidence)}`);
    } finally {
      await proxy.close();
      await ctx.fiber.dispose().catch(() => undefined);
      await rm(home, { recursive: true, force: true });
    }
  });
});

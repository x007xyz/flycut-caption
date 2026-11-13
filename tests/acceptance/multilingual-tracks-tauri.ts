import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remote } from 'webdriverio';
import { media } from './fixture';
import { bundleInfo, launchApp, waitFor } from './mac-app';
import { multilingualTracks } from './multilingual-tracks-flow';

const bundle = process.argv[2];
assert.ok(bundle, 'Usage: pnpm acceptance:f0030:tauri /absolute/path/to/FlyCut Acceptance.app');
assert.equal(bundleInfo(bundle).identifier, 'com.flycut.caption.acceptance');
const dir = await mkdtemp(join(tmpdir(), 'flycut-f0030-tauri-'));
const output = join(dir, 'test-results');
await mkdir(output, { recursive: true });
let failed = false;

try {
  const source = join(dir, 'fixture.mp4');
  media(source);
  const listener = createServer();
  await new Promise<void>((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const app = await launchApp(bundle, dir, join(output, 'app.log'), port);
  try {
    await waitFor('WebDriver owned by the newly launched app', async () => {
      if (app.child.exitCode !== null) throw new Error('test app exited');
      try {
        const owned = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(app.child.pid), `-iTCP:${port}`, '-sTCP:LISTEN'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        if (!owned.includes(`127.0.0.1:${port}`)) return undefined;
        const response = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1000) });
        return response.ok ? true : undefined;
      } catch { return undefined; }
    });
    const browser = await remote({ protocol: 'http', hostname: '127.0.0.1', port, path: '/',
      logLevel: 'error', capabilities: { browserName: 'wry' } });
    try {
      const api = await app.ready();
      await multilingualTracks(browser, api, source);
      console.log('PASS F-0030 desktop: packaged macOS Tauri language tracks');
    } catch (error) {
      await browser.saveScreenshot(join(output, 'failure.png')).catch(() => undefined);
      throw error;
    } finally {
      await browser.deleteSession();
    }
  } finally {
    await app.stop();
  }
} catch (error) {
  failed = true;
  console.error(`F-0030 Tauri acceptance failed; diagnostics: ${dir}`);
  throw error;
} finally {
  if (!failed) await rm(dir, { recursive: true, force: true });
}

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { remote } from 'webdriverio';
import { createHost } from '../../server/app';
import { host, media } from './fixture';
import { multilingualTracks } from './multilingual-tracks-flow';

const dir = await mkdtemp(join(tmpdir(), 'flycut-f0030-web-'));
const source = join(dir, 'fixture.mp4');
try {
  await mkdir(join(dir, 'media'), { recursive: true });
  media(source);
  const token = randomUUID();
  const ctx = await createHost({ home: dir, appData: dir, bind: '127.0.0.1', port: 0,
    token, resourceRoot: resolve('.'), assetTtlHours: 1 }, { profile: 'desktop', providers: [] });
  try {
    const address = ctx.httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Host port missing');
    const connection = { url: `http://127.0.0.1:${address.port}`, token };
    await writeFile(join(dir, 'connection.json'), JSON.stringify(connection), { mode: 0o600 });
    process.env.FLYCUT_HOST_HOME = dir;
    const vite = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: true } });
    try {
      await vite.listen();
      const app = vite.httpServer?.address();
      if (!app || typeof app === 'string') throw new Error('Web port missing');
      const chrome = process.env.FLYCUT_ACCEPTANCE_CHROME;
      const browser = await remote({ logLevel: 'error', capabilities: {
        browserName: 'chrome', 'goog:chromeOptions': { args: ['--headless=new', '--window-size=1440,900'],
          ...(chrome ? { binary: chrome } : {}) },
      } });
      try {
        await browser.url(`http://127.0.0.1:${app.port}/#/projects`);
        await multilingualTracks(browser, host(connection), source);
      } finally {
        await browser.deleteSession();
      }
    } finally {
      await vite.close();
    }
  } finally {
    await ctx.fiber.dispose();
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

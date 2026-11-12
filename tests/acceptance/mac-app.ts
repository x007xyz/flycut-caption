import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { once } from 'node:events';
import { basename, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { host, type Connection } from './fixture';

export async function waitFor<T>(label: string, fn: () => Promise<T | undefined>, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== undefined) return result;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export function bundleInfo(bundle: string) {
  assert.ok(isAbsolute(bundle) && bundle.endsWith('.app'), 'Supply an absolute path to the tested .app');
  const read = (key: string) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(bundle, 'Contents/Info.plist')],
    { encoding: 'utf8' }).trim();
  const identifier = read('CFBundleIdentifier');
  const binary = read('CFBundleExecutable');
  assert.match(identifier, /^com\.flycut\.caption(?:\.[a-z0-9-]+)?$/);
  assert.equal(binary, basename(binary));
  return { identifier, binary: join(bundle, 'Contents/MacOS', binary) };
}

export async function launchApp(bundle: string, runDir: string, logPath: string, driverPort?: number) {
  const info = bundleInfo(bundle);
  const home = join(runDir, 'home');
  await mkdir(home, { recursive: true });
  const env = { ...process.env, HOME: home };
  // Prevent the caller's dev Host configuration from making a broken bundle pass.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('FLYCUT_') || key === 'TAURI_WEBDRIVER_PORT') delete (env as NodeJS.ProcessEnv)[key];
  }
  if (driverPort) (env as NodeJS.ProcessEnv).TAURI_WEBDRIVER_PORT = String(driverPort);
  const output = createWriteStream(logPath, { mode: 0o600 });
  const child = spawn(await realpath(info.binary), [], { env, cwd: runDir, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  child.on('close', () => output.end());
  const exited = once(child, 'close');
  await once(child, 'spawn');
  const hostDir = join(home, 'Library/Application Support', info.identifier, 'host');
  let connection: Connection | undefined;
  async function ready() {
    return waitFor('the packaged Host in the isolated data directory', async () => {
      assert.equal(child.exitCode, null, 'desktop app exited before Host readiness');
      const raw = await readFile(join(hostDir, 'connection.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!raw) return undefined;
      const candidate = JSON.parse(raw) as Connection;
      await host(candidate).call('projects.identity');
      connection = candidate;
      return host(candidate);
    });
  }
  async function stop() {
    if (connection) await host(connection).call('host.shutdown').catch(() => undefined);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  }
  return { child, hostDir, ready, stop };
}

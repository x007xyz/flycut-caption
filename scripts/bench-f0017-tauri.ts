#!/usr/bin/env node
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { access, chmod, copyFile, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { cpus, loadavg, platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHost } from '../server/app';
import {
  F0017_REAL_SOURCES,
  F0017_REAL_WORD_COUNT,
  makeF0017RealTranscript,
  type F0017Transcript,
} from '../tests/e2e/lib/longTranscript';

const root = resolve('.');
const theme = process.env.F0017_THEME === 'dark' ? 'dark' : 'light';
const ffmpeg = process.env.FFMPEG_PATH ?? join(root, 'src-tauri/binaries/ffmpeg');
const outputDir = join(root, 'test-results/f0017-bench');

interface State { phase: 'waiting' | 'ready' | 'error'; projectName?: string; firstText?: string; error?: string }
interface Sample { elapsedMs: number; maxLongTaskMs: number; renderedRows: number; textareas: number }
interface Result { ok: boolean; runs?: Sample[]; environment?: Record<string, unknown>; error?: string }

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
}

function appDataRoot(home: string): string {
  if (platform() === 'darwin') return join(home, 'Library', 'Application Support', 'com.flycut.caption');
  if (platform() === 'win32') return join(home, 'AppData', 'Roaming', 'com.flycut.caption');
  return join(home, '.local', 'share', 'com.flycut.caption');
}

async function rpc<T>(url: string, token: string, method: string, payload: unknown = {}): Promise<T> {
  const response = await fetch(`${url}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }) });
  const envelope = await response.json() as { result: { ok: boolean; value?: T; error?: { message?: string } } };
  if (!envelope.result.ok) throw new Error(envelope.result.error?.message ?? `${method} failed`);
  return envelope.result.value as T;
}

async function seedProject(home: string, media: string, transcript: F0017Transcript) {
  const appData = appDataRoot(home);
  await mkdir(join(appData, 'host'), { recursive: true });
  const token = 'f0017-tauri-seed';
  const shellToken = 'f0017-tauri-shell';
  const host = await createHost({ home: join(appData, 'host'), appData, token, shellToken, port: 0, resourceRoot: root, bind: '127.0.0.1' },
    { profile: 'desktop', providers: [] });
  const address = host.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('seed Host did not expose a TCP port');
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const linked = await fetch(`${url}/shell/projects/media`, { method: 'POST',
      headers: { Authorization: `Bearer ${shellToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: media }) });
    if (!linked.ok) throw new Error(`media link failed: ${linked.status} ${await linked.text()}`);
    const { mediaRef } = await linked.json() as { mediaRef: string };
    const projectName = 'Tauri 六十分钟口播';
    const created = await rpc<{ projectId: string; videoId: string }>(url, token, 'projects.create', {
      name: projectName, videoName: 'coscup-60min.mp4', durationSeconds: transcript.duration, media: { mediaRef },
    });
    await rpc(url, token, 'projects.saveTranscript', { projectId: created.projectId, videoId: created.videoId,
      transcript, durationSeconds: transcript.duration });
    return { projectName, firstText: transcript.chunks[0]!.text };
  } finally {
    await host.fiber.dispose();
  }
}

function mediaDuration(path: string): number {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-i', path], { cwd: root, encoding: 'utf8' });
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(`${result.stdout}\n${result.stderr}`);
  if (!match) throw new Error(`ffmpeg did not report a media duration for ${path}`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

async function stageNodeRuntimeLibrary(): Promise<void> {
  if (platform() !== 'darwin') return;
  const nodeLib = join(dirname(process.execPath), '..', 'lib');
  const filename = (await readdir(nodeLib).catch(() => []))
    .find(name => /^libnode\.\d+\.dylib$/.test(name));
  if (!filename) throw new Error(`current Node runtime library not found in ${nodeLib}`);
  for (const directory of [join(root, 'src-tauri/binaries'), join(root, 'src-tauri/target/debug/binaries')]) {
    await mkdir(directory, { recursive: true });
    const destination = join(directory, filename);
    await chmod(destination, 0o644).catch(() => undefined);
    await copyFile(join(nodeLib, filename), destination);
    await chmod(destination, 0o644);
  }
}

async function makeMedia(temp: string, expectedDuration: number): Promise<{ path: string; source: string }> {
  for (const source of F0017_REAL_SOURCES) {
    const path = join(root, `${source}.mp4`);
    await access(path).catch(() => { throw new Error(`real F-0017 media is missing: ${path}`); });
  }
  const path = join(temp, 'coscup-60min.mp4');
  const list = join(temp, 'concat.txt');
  await writeFile(list, F0017_REAL_SOURCES.map((source, index) => {
    const media = join(root, `${source}.mp4`).replaceAll("'", "'\\''");
    return `file '${media}'${index === F0017_REAL_SOURCES.length - 1 ? '' : '\n'}`;
  }).join(''));
  run(ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy',
    '-movflags', '+faststart', path]);
  const actualDuration = mediaDuration(path);
  if (Math.abs(actualDuration - expectedDuration) > 1) {
    throw new Error(`real COSCUP media duration ${actualDuration.toFixed(3)}s does not match transcript ${expectedDuration.toFixed(3)}s`);
  }
  return { path, source: F0017_REAL_SOURCES.map(source => `${source}.mp4`).join(' + ') };
}

async function waitForFrontend(): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try { const response = await fetch('http://127.0.0.1:5173/'); if (response.ok) return; } catch { /* Vite is starting. */ }
    await new Promise(done => setTimeout(done, 250));
  }
  throw new Error('Vite did not start on 5173 within 120 seconds');
}

function collector() {
  let state: State = { phase: 'waiting' };
  let settle!: (result: Result) => void;
  const completed = new Promise<Result>(resolve => { settle = resolve; });
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    try {
      if (request.method === 'GET' && request.url === '/state') {
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(state)); return;
      }
      if (request.method === 'POST' && request.url === '/result') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Result;
        response.writeHead(204); response.end(); settle(result); return;
      }
      response.writeHead(404); response.end();
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  return { server, completed, ready(value: Omit<State, 'phase'>) { state = { phase: 'ready', ...value }; },
    fail(error: string) { state = { phase: 'error', error }; settle({ ok: false, error }); } };
}

function stop(child: ChildProcess | undefined): void {
  if (!child || child.killed) return;
  try { if (child.pid && platform() !== 'win32') process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch { /* already gone */ }
}

async function main(): Promise<void> {
  const inheritedHome = process.env.HOME;
  const temp = await mkdtemp(join(tmpdir(), 'flycut-f0017-tauri-'));
  const home = join(temp, 'home');
  await mkdir(home, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  const signals = collector();
  await new Promise<void>((resolveListen, rejectListen) => {
    signals.server.once('error', rejectListen);
    signals.server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = signals.server.address();
  if (!address || typeof address === 'string') throw new Error('collector did not expose a TCP port');
  let vite: ChildProcess | undefined;
  let tauri: ChildProcess | undefined;
  try {
    const transcript = await makeF0017RealTranscript(root);
    if (transcript.chunks.length !== 1173 || (transcript.wordChunks?.length ?? 0) !== F0017_REAL_WORD_COUNT) {
      throw new Error(`real COSCUP dataset mismatch: ${transcript.chunks.length} chunks / ${transcript.wordChunks?.length ?? 0} words`);
    }
    const media = await makeMedia(temp, transcript.duration);
    run('pnpm', ['package:host']);
    await stageNodeRuntimeLibrary();
    const seeded = await seedProject(home, media.path, transcript);
    const env = { ...process.env, HOME: home, CFFIXED_USER_HOME: home,
      CARGO_HOME: process.env.CARGO_HOME ?? (inheritedHome ? join(inheritedHome, '.cargo') : undefined),
      RUSTUP_HOME: process.env.RUSTUP_HOME ?? (inheritedHome ? join(inheritedHome, '.rustup') : undefined) };
    vite = spawn('pnpm', ['dev:web', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'],
      detached: platform() !== 'win32' });
    await waitForFrontend();
    signals.ready(seeded);
    const config = JSON.stringify({ build: { beforeDevCommand: 'node -e "process.exit(0)"',
      devUrl: `http://127.0.0.1:5173/?f0017Tauri=${address.port}&f0017Theme=${theme}` } });
    tauri = spawn('pnpm', ['exec', 'tauri', 'dev', '--config', config], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'],
      detached: platform() !== 'win32' });
    tauri.stdout?.on('data', chunk => process.stdout.write(chunk));
    const timeout = new Promise<Result>((_, reject) => setTimeout(() => reject(new Error('Tauri benchmark timed out after 180 seconds')), 180_000));
    const result = await Promise.race([signals.completed, timeout]);
    if (!result.ok || !result.runs) throw new Error(result.error ?? 'Tauri benchmark returned no samples');
    const report = {
      measuredAt: new Date().toISOString(),
      environment: { platform: platform(), arch: process.arch, cpuCount: cpus().length, loadAverage: loadavg(),
        port: 5173, theme, media: media.source, ...result.environment },
      data: { chunks: transcript.chunks.length, words: transcript.wordChunks?.length ?? 0, durationSeconds: transcript.duration },
      runs: result.runs,
    };
    await writeFile(join(outputDir, 'tauri-after.json'), `${JSON.stringify(report, null, 2)}\n`);
    const table = [
      `# F-0017 Tauri benchmark (${report.measuredAt})`, '',
      `- 前台 Tauri WebView；${platform()}/${process.arch}；${cpus().length} 核；load ${loadavg().map(value => value.toFixed(2)).join(' / ')}`,
      `- 数据：${transcript.chunks.length} 句 / ${transcript.wordChunks?.length ?? 0} 字词 / ${transcript.duration.toFixed(3)} 秒`,
      `- 端口 5173；主题 ${theme}；素材 ${media.source}`, '',
      '| 次数 | 到可编辑 ms | 可编辑后 1 秒最大 long task ms | 挂载行 | textarea |', '|---:|---:|---:|---:|---:|',
      ...result.runs.map((sample, index) => `| ${index + 1} | ${sample.elapsedMs} | ${sample.maxLongTaskMs} | ${sample.renderedRows} | ${sample.textareas} |`), '',
    ].join('\n');
    await writeFile(join(outputDir, 'tauri-after.md'), table);
    process.stdout.write(table);
    const failures = result.runs.flatMap((sample, index) => [
      ...(sample.elapsedMs > 3000 ? [`run ${index + 1} elapsed ${sample.elapsedMs}ms`] : []),
      ...(sample.maxLongTaskMs > 200 ? [`run ${index + 1} long task ${sample.maxLongTaskMs}ms`] : []),
    ]);
    if (failures.length) throw new Error(`F-0017 Tauri thresholds failed: ${failures.join(', ')}`);
  } finally {
    signals.server.close();
    stop(tauri);
    stop(vite);
    await rm(temp, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

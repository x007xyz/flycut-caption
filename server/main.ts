import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, unlink, readFile } from 'node:fs/promises';
import { createHost, resolveHostProfile } from './app';

const home = resolve(process.env.FLYCUT_HOST_HOME ?? join(homedir(), '.flycut-caption/host'));
await mkdir(home, { recursive: true });
const tokenFile = join(home, 'auth.token');
let token = process.env.FLYCUT_HOST_TOKEN;
if (!token) {
  try { token = (await readFile(tokenFile, 'utf8')).trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    token = randomBytes(32).toString('hex'); await writeFile(tokenFile, token, { mode: 0o600, flag: 'wx' });
  }
}
const argValue = (flag: string) => { const index = process.argv.indexOf(flag); return index > 0 ? process.argv[index + 1] : undefined; };
const profile = argValue('--profile');
const webRootArg = argValue('--web-root') ?? process.env.FLYCUT_WEB_ROOT;
const webRoot = webRootArg ? resolve(webRootArg) : undefined;
const bind = process.env.FLYCUT_HOST_BIND ?? '127.0.0.1';
const allowedOrigins = (process.env.FLYCUT_ALLOWED_ORIGINS ?? '').split(',').map(origin => origin.trim().replace(/\/$/, '')).filter(Boolean);
for (const origin of allowedOrigins) if (new URL(origin).origin !== origin) throw new Error(`FLYCUT_ALLOWED_ORIGINS 只能包含 origin（协议+主机+端口）：${origin}`);
if (process.argv.includes('--dump-config')) {
  // Prints the composed plugin tree this Host would boot, then exits without taking the lock.
  const resolved = await resolveHostProfile({ home, token: '', port: 0, resourceRoot: resolve(process.env.FLYCUT_RESOURCE_ROOT ?? '.') }, { profile });
  console.log(JSON.stringify({ profile: resolved.name, layers: resolved.layers,
    plugins: resolved.rows.map(({ id, source, module, provides, config }) => ({ id, source, module, provides, config })) }, null, 2));
  process.exit(0);
}
const lockFile = join(home, 'host.lock');
try { await writeFile(lockFile, String(process.pid), { flag: 'wx', mode: 0o600 }); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  const pid = Number(await readFile(lockFile, 'utf8'));
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Host home is being initialized by another process');
  try { process.kill(pid, 0); throw new Error('A Host already owns this home directory'); }
  catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ESRCH') throw failure; }
  await unlink(lockFile);
  await writeFile(lockFile, String(process.pid), { flag: 'wx', mode: 0o600 });
}
const appData = resolve(process.env.FLYCUT_APP_DATA ?? (process.platform === 'darwin'
  ? join(homedir(), 'Library/Application Support/com.flycut.caption')
  : process.platform === 'win32' ? join(process.env.APPDATA ?? homedir(), 'com.flycut.caption')
  : join(homedir(), '.local/share/com.flycut.caption')));
const ctx = await createHost({ home, token, appData, port: Number(process.env.FLYCUT_HOST_PORT ?? 8766),
  resourceRoot: resolve(process.env.FLYCUT_RESOURCE_ROOT ?? '.'), pythonUrl: process.env.FLYCUT_PYTHON_URL, bind, allowedOrigins, webRoot,
  assetTtlHours: process.env.FLYCUT_ASSET_TTL_HOURS ? Number(process.env.FLYCUT_ASSET_TTL_HOURS) : undefined }, { profile })
  .catch(async error => { await unlink(lockFile).catch(() => undefined); throw error; });
const address = ctx.httpServer.address() as { port: number };
const info = { url: `http://127.0.0.1:${address.port}`, token, pid: process.pid };
const discovery = join(home, 'connection.json');
await writeFile(discovery, JSON.stringify(info), { mode: 0o600 });
// Desktop reads readiness from the process pipe; never log the credential.
if (process.env.FLYCUT_HOST_STDIO === '1') process.stdout.write(JSON.stringify({ type: 'host-ready', ...info }) + '\n');
else console.log(`FlyCut Host ready at ${info.url}${bind === '127.0.0.1' ? '' : ` (listening on ${bind}:${address.port})`}`);
if (webRoot) console.log(`Serving frontend from ${webRoot}`);
if (webRoot && !['127.0.0.1', 'localhost', '::1'].includes(bind)) {
  // The served page hands its token to whoever can load it; access control must sit in front of the Host.
  console.warn('[security] 前端与连接凭证对所有能访问此端口的客户端开放。请只通过带鉴权的反向代理对外提供服务。');
}
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await ctx.fiber.dispose(); await unlink(discovery).catch(() => undefined); await unlink(lockFile).catch(() => undefined); }
process.once('SIGINT', () => { void stop().then(() => process.exit()); });
process.once('SIGTERM', () => { void stop().then(() => process.exit()); });

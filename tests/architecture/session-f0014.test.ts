// F-0014 AC-8：浏览器 HttpOnly 会话、CSRF、WebSocket Cookie 和撤销。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { createHost } from '../../server/app';

function cookieOf(response: Response): string {
  const header = response.headers.get('set-cookie') ?? '';
  assert.match(header, /flycut_session=/);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  return header.split(';')[0];
}

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'flycut-session-test-'));
  const web = join(home, 'dist');
  await mkdir(join(web, 'assets'), { recursive: true });
  await writeFile(join(web, 'index.html'), '<!doctype html><title>FlyCut</title>');
  const ctx = await createHost({ home, token: 'session-credential', port: 0, resourceRoot: resolve('.'), webRoot: web,
    sessionTtlMs: 60_000 }, { providers: [] });
  const port = (ctx.httpServer.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const origin = base;
  const rpc = (cookie?: string, csrf?: string) => fetch(`${base}/rpc`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-Flycut-CSRF': csrf } : {}) },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'host.info', payload: {} }) });
  return { home, ctx, base, origin, rpc, async close() { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }); } };
}

test('F-0014/AC-8 same-origin bootstrap mints an HttpOnly session; CSRF is required for writes', async () => {
  const host = await setup();
  try {
    const bootstrap = await fetch(`${host.base}/__flycut/connection`, { headers: { Origin: host.origin } });
    assert.equal(bootstrap.status, 200);
    const body = await bootstrap.json() as { auth: string; csrf: string; token?: string };
    assert.equal(body.auth, 'session'); assert.equal(body.token, undefined); assert.ok(body.csrf.length > 20);
    const cookie = cookieOf(bootstrap);

    assert.equal((await host.rpc()).status, 401, 'no cookie and no bearer');
    assert.equal((await host.rpc(cookie)).status, 401, 'cookie write without CSRF');
    assert.equal((await host.rpc(cookie, 'wrong-csrf')).status, 401, 'cookie write with wrong CSRF');
    const allowed = await host.rpc(cookie, body.csrf);
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json() as any).result.ok, true);

    const removed = await fetch(`${host.base}/session`, { method: 'DELETE', headers: { Origin: host.origin, Cookie: cookie, 'X-Flycut-CSRF': body.csrf } });
    assert.equal(removed.status, 204);
    assert.match(removed.headers.get('set-cookie') ?? '', /Max-Age=0/);
    assert.equal((await host.rpc(cookie, body.csrf)).status, 401, 'revoked cookie cannot write');
  } finally { await host.close(); }
});

test('F-0014/AC-8 bearer exchanges for a cookie session; generic query tokens do not authenticate', async () => {
  const host = await setup();
  try {
    const rpcWithQueryToken = await fetch(`${host.base}/rpc?token=session-credential`, { method: 'POST', headers: { Origin: host.origin },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'host.info', payload: {} }) });
    assert.equal(rpcWithQueryToken.status, 401, 'query tokens never authenticate writes');
    const exchanged = await fetch(`${host.base}/session`, { method: 'POST', headers: { Origin: host.origin, Authorization: 'Bearer session-credential' } });
    assert.equal(exchanged.status, 201);
    const body = await exchanged.json() as { auth: string; csrf: string; token?: string };
    assert.equal(body.auth, 'session'); assert.equal(body.token, undefined);
    const cookie = cookieOf(exchanged);
    assert.equal((await host.rpc(cookie, body.csrf)).status, 200);
    // Media GET is the desktop/dev local-bearer exception; generic assets still reject query tokens.
    assert.equal((await fetch(`${host.base}/assets/${crypto.randomUUID()}?token=session-credential`, { headers: { Origin: host.origin } })).status, 401);
  } finally { await host.close(); }
});

test('F-0014/AC-8 WebSocket accepts the session cookie and rejects a token in the query string', async () => {
  const host = await setup();
  try {
    const bootstrap = await fetch(`${host.base}/__flycut/connection`, { headers: { Origin: host.origin } });
    const cookie = cookieOf(bootstrap);
    const frames: any[] = [];
    const ws = new WebSocket(`${host.base.replace('http', 'ws')}/events`, { headers: { Cookie: cookie }, origin: host.origin });
    ws.on('message', data => frames.push(JSON.parse(String(data))));
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    // host/ready and jobs/snapshot are two back-to-back frames; wait for both before terminating the socket.
    await new Promise(resolve => setTimeout(resolve, 50));
    ws.terminate();
    assert.ok(frames.some(frame => frame.type === 'host/ready'));
    assert.ok(frames.some(frame => frame.type === 'jobs/snapshot'));

    const rejected = new WebSocket(`${host.base.replace('http', 'ws')}/events?token=session-credential`);
    await new Promise<void>(resolve => { rejected.once('unexpected-response', () => { resolve(); }); rejected.once('error', () => resolve()); });
    rejected.terminate();
  } finally { await host.close(); }
});

test('F-0014/AC-8 TLS proxy marks the session cookie Secure', async () => {
  const host = await setup();
  try {
    const bootstrap = await fetch(`${host.base}/__flycut/connection`, { headers: { Origin: host.origin, 'X-Forwarded-Proto': 'https' } });
    assert.equal(bootstrap.status, 200);
    assert.match(bootstrap.headers.get('set-cookie') ?? '', /; Secure/);
  } finally { await host.close(); }
});

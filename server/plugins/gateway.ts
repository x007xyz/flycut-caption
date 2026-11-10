import type { Context } from '@deepseek-ai/cordis';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { rpcRequestSchema, PROTOCOL_VERSION, type HostFrame, type RpcResponse } from '../../shared/protocol';
import { readHostIdentity } from './projects';

async function body(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > limit) throw new Error('Request body exceeds limit'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm' };
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const ASSET_PATH = /^\/assets\/([0-9a-f-]{36})$/i;
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1)(:\d+)?$/;
const SESSION_COOKIE = 'flycut_session';
const UPLOAD_OWNER_COOKIE = 'flycut_upload_owner';
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const UPLOAD_OWNER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface BrowserSession { id: string; csrf: string; createdAt: number; expiresAt: number }
interface AuthResult { ok: boolean; session?: BrowserSession; kind?: 'session' | 'bearer'; principal?: string }

function bearerPrincipal(token: string): string {
  return `bearer:${createHash('sha256').update(token).digest('hex')}`;
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function protocolBearer(req: IncomingMessage): string | undefined {
  const raw = headerValue(req.headers['sec-websocket-protocol']);
  if (!raw) return undefined;
  const entry = raw.split(',').map(item => item.trim()).find(item => item.startsWith('flycut.token.'));
  if (!entry) return undefined;
  try {
    const encoded = entry.slice('flycut.token.'.length).replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(encoded, 'base64').toString('utf8');
  } catch { return undefined; }
}

function isHttps(req: IncomingMessage): boolean {
  return headerValue(req.headers['x-forwarded-proto'])?.split(',')[0]?.trim() === 'https';
}

function sessionCookie(req: IncomingMessage, id: string, ttlMs: number): string {
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(ttlMs / 1000))}${isHttps(req) ? '; Secure' : ''}`;
}

function clearSessionCookie(req: IncomingMessage): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isHttps(req) ? '; Secure' : ''}`;
}

function uploadOwnerCookie(req: IncomingMessage, value: string, expiresAt: number): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  return `${UPLOAD_OWNER_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}

function clearUploadOwnerCookie(req: IncomingMessage): string {
  return `${UPLOAD_OWNER_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isHttps(req) ? '; Secure' : ''}`;
}

function appendCookie(res: ServerResponse, cookie: string) {
  const current = res.getHeader('Set-Cookie');
  const values = current === undefined ? [] : Array.isArray(current) ? current : [String(current)];
  res.setHeader('Set-Cookie', [...values, cookie]);
}

export interface GatewayConfig {
  /** Registers `host.shutdown`; the `server` profile turns it off so remote clients cannot stop the Host. */
  shutdown?: boolean;
}

/**
 * Harness-inspired transport: unary RPC + generation-scoped WebSocket events.
 * The Gateway owns no business methods; it dispatches to `ctx.rpc`, where each plugin registers its own.
 */
export const gatewayPlugin = { name: 'flycut-api-gateway', inject: ['hostConfig', 'rpc', 'jobs', 'assets'], async apply(ctx: Context, config: GatewayConfig = {}) {
  const origins = new Set(ctx.hostConfig.allowedOrigins ?? []);
  const originHosts = new Set([...origins].map(origin => new URL(origin).host));
  const webRoot = ctx.hostConfig.webRoot ? resolve(ctx.hostConfig.webRoot) : undefined;
  const sessionTtlMs = Math.max(60_000, ctx.hostConfig.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS);
  const sessions = new Map<string, BrowserSession>();
  const ownerKey = createHash('sha256').update(await readHostIdentity(ctx.hostConfig.home)).update(ctx.hostConfig.token).digest();
  const allowedOrigin = (origin?: string) => !origin || origin === 'tauri://localhost' || origin === 'http://tauri.localhost'
    || LOOPBACK_ORIGIN.test(origin) || origins.has(origin);
  const pruneSessions = () => { const now = Date.now(); for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id); };
  const issueSession = (req: IncomingMessage, res: ServerResponse) => {
    pruneSessions();
    const now = Date.now();
    const session: BrowserSession = { id: randomBytes(32).toString('base64url'), csrf: randomBytes(32).toString('base64url'), createdAt: now, expiresAt: now + sessionTtlMs };
    sessions.set(session.id, session);
    res.setHeader('Set-Cookie', sessionCookie(req, session.id, sessionTtlMs));
    return session;
  };
  const signUploadOwner = (id: string, expiresAt: number) => {
    const signed = `v1.${id}.${expiresAt}`;
    const signature = createHmac('sha256', ownerKey).update(signed).digest('base64url');
    return `${signed}.${signature}`;
  };
  const verifyUploadOwner = (value?: string): string | undefined => {
    if (!value) return undefined;
    const parts = value.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1' || !/^[A-Za-z0-9_-]{32,128}$/.test(parts[1])) return undefined;
    const expiresAt = Number(parts[2]);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return undefined;
    const signed = `v1.${parts[1]}.${parts[2]}`;
    const expected = createHmac('sha256', ownerKey).update(signed).digest();
    let actual: Buffer;
    try { actual = Buffer.from(parts[3], 'base64url'); } catch { return undefined; }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
    return parts[1];
  };
  /**
   * A stable per-browser upload owner. The cookie is signed with the Host home identity and token,
   * carries its own server-verified expiry, and is only an ownership tag after session/bearer auth.
   * An invalid or forged value is replaced rather than trusted. Logout clears it.
   */
  const ensureUploadOwner = (req: IncomingMessage, res: ServerResponse) => {
    const existing = verifyUploadOwner(cookieValue(req, UPLOAD_OWNER_COOKIE));
    if (existing) return existing;
    const id = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + UPLOAD_OWNER_TTL_MS;
    appendCookie(res, uploadOwnerCookie(req, signUploadOwner(id, expiresAt), expiresAt));
    return id;
  };
  const sessionFor = (req: IncomingMessage): BrowserSession | undefined => {
    const id = cookieValue(req, SESSION_COOKIE);
    if (!id) return undefined;
    const session = sessions.get(id);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) { sessions.delete(id); return undefined; }
    return session;
  };
  /**
   * Cookie auth is for the browser; bearer remains for CLI/tests/desktop local Host.
   * Unsafe cookie requests must carry the session CSRF token. Bearer requests never need CSRF because
   * browsers do not attach them automatically.
   */
  const authorize = (req: IncomingMessage, url: URL, options: { csrf?: boolean; queryToken?: boolean } = {}): AuthResult => {
    if (!allowedOrigin(req.headers.origin)) return { ok: false };
    const bearer = req.headers.authorization === `Bearer ${ctx.hostConfig.token}` || protocolBearer(req) === ctx.hostConfig.token;
    if (bearer) return { ok: true, kind: 'bearer', principal: bearerPrincipal(ctx.hostConfig.token) };
    // 本地 bearer 媒体例外：<video src> 不能带 Authorization，只允许只读路由从查询参数取 token。
    if (options.queryToken && (req.method === 'GET' || req.method === 'HEAD')) {
      const queryToken = url.searchParams.get('token');
      if (queryToken && safeEqual(queryToken, ctx.hostConfig.token)) return { ok: true, kind: 'bearer', principal: bearerPrincipal(ctx.hostConfig.token) };
    }
    const session = sessionFor(req);
    if (!session) return { ok: false };
    if (options.csrf !== false && req.method !== 'GET' && req.method !== 'HEAD') {
      const csrf = headerValue(req.headers['x-flycut-csrf']);
      if (!csrf || !safeEqual(csrf, session.csrf)) return { ok: false };
    }
    return { ok: true, session, kind: 'session', principal: `session:${session.id}` };
  };
  if (config.shutdown !== false) {
    ctx.effect(() => ctx.rpc.register('host.shutdown', undefined, () => { setTimeout(() => process.emit('SIGTERM'), 25); return { stopping: true } as const; }));
  }
  ctx.effect(() => ctx.rpc.capability('browserSession', true));
  ctx.effect(() => ctx.rpc.capability('cookieMedia', true));
  /** Serves the built frontend with SPA fallback; returns false for paths it does not own. */
  const serveStatic = async (pathname: string, res: ServerResponse) => {
    let decoded: string; try { decoded = decodeURIComponent(pathname); } catch { return false; }
    let file = resolve(webRoot!, `.${decoded}`);
    if (file !== webRoot && !file.startsWith(webRoot! + sep)) return false;
    let info = await stat(file).catch(() => undefined);
    if (info?.isDirectory()) { file = resolve(file, 'index.html'); info = await stat(file).catch(() => undefined); }
    if (!info?.isFile()) {
      // Client-side routes fall back to the app shell; missing files with an extension stay 404.
      if (extname(pathname)) return false;
      file = resolve(webRoot!, 'index.html'); info = await stat(file).catch(() => undefined);
      if (!info?.isFile()) return false;
    }
    const hashed = pathname.startsWith('/assets/');
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': info.size,
      'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache' });
    await pipeline(createReadStream(file), res).catch(() => res.destroy());
    return true;
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.headers.origin && allowedOrigin(req.headers.origin)) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin); res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Flycut-CSRF, X-Flycut-Offset, X-Chunk-SHA256');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    }
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (url.pathname === '/health' && req.method === 'GET') { json(200, { ok: true, protocolVersion: PROTOCOL_VERSION }); return; }
    if (url.pathname === '/session' && req.method === 'POST') {
      if (!allowedOrigin(req.headers.origin) || req.headers.authorization !== `Bearer ${ctx.hostConfig.token}`) { json(401, { error: 'Unauthorized' }); return; }
      const session = issueSession(req, res);
      json(201, { auth: 'session', csrf: session.csrf, expiresAt: new Date(session.expiresAt).toISOString() }); return;
    }
    if (url.pathname === '/session' && req.method === 'DELETE') {
      const auth = authorize(req, url);
      if (!auth.ok) { json(auth.session ? 403 : 401, { error: auth.session ? 'Invalid CSRF token' : 'Unauthorized' }); return; }
      if (auth.session) sessions.delete(auth.session.id);
      res.writeHead(204, { 'Set-Cookie': [clearSessionCookie(req), clearUploadOwnerCookie(req)], 'Cache-Control': 'no-store' }); res.end(); return;
    }
    if (webRoot && url.pathname === '/__flycut/connection' && req.method === 'GET') {
      // Same-origin bootstrap for the served frontend. The Host header check blocks DNS-rebinding pages.
      const host = req.headers.host ?? '';
      if (!allowedOrigin(req.headers.origin) || !(LOOPBACK_HOST.test(host) || originHosts.has(host))) { json(403, { error: 'Forbidden' }); return; }
      // A normal refresh keeps the authenticated browser identity. Logout still deletes the
      // session and expiry still mints a new one; the response contract is unchanged.
      const session = sessionFor(req) ?? issueSession(req, res);
      json(200, { auth: 'session', csrf: session.csrf, expiresAt: new Date(session.expiresAt).toISOString() }); return;
    }
    // Plugin-owned routes (media streaming, shell-only endpoints). Shell routes come from the desktop shell process,
    // which sends no Origin; a browser page cannot use them even if it learned the frontend token.
    const routed = ctx.rpc.match(req.method ?? '', url.pathname);
    if (routed) {
      const shellToken = ctx.hostConfig.shellToken;
      const auth = routed.route.auth === 'shell'
        ? (!!shellToken && !req.headers.origin && req.headers.authorization === `Bearer ${shellToken}`
            ? { ok: true, kind: 'bearer' as const, principal: bearerPrincipal(shellToken) }
            : { ok: false })
        : authorize(req, url, { csrf: true, queryToken: routed.route.queryToken });
      if (!auth.ok || !auth.kind || !auth.principal) { json(401, { error: 'Unauthorized' }); return; }
      const owner = auth.kind === 'session' && url.pathname.startsWith('/uploads') ? ensureUploadOwner(req, res) : undefined;
      const subject = owner
        ? `upload:${createHash('sha256').update(owner).digest('hex')}`
        : auth.principal;
      try { await routed.route.handle(req, res, routed.match, { kind: auth.kind, principal: auth.principal, subject }); }
      catch (error) {
        if (res.headersSent) { res.destroy(); return; }
        json(400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    // Vite emits bundles under `/assets/<name>`; Host assets are `/assets/<uuid>`, so only UUIDs reach the API.
    if (webRoot && req.method === 'GET' && !['/rpc', '/events'].includes(url.pathname) && !ASSET_PATH.test(url.pathname)) {
      if (await serveStatic(url.pathname, res)) return;
      json(404, { error: 'Not found' }); return;
    }
    if (!authorize(req, url).ok) { json(401, { error: 'Unauthorized' }); return; }
    try {
      if (url.pathname === '/assets' && req.method === 'POST') {
        const assetId = await ctx.assets.putStream(req, 4 * 1024 * 1024 * 1024); json(201, { assetId }); return;
      }
      const assetMatch = url.pathname.match(ASSET_PATH);
      if (assetMatch && req.method === 'GET') {
        const file = ctx.assets.path(assetMatch[1]); const size = await ctx.assets.size(assetMatch[1]).catch(() => undefined);
        if (size === undefined) { json(404, { error: 'Asset not found' }); return; }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size, 'Cache-Control': 'no-store' });
        // A client may close right after the last byte; that is not a server error once headers are out.
        await pipeline(createReadStream(file), res).catch(error => { if (!res.headersSent) throw error; res.destroy(); });
        return;
      }
      if (url.pathname !== '/rpc' || req.method !== 'POST') { json(404, { error: 'Not found' }); return; }
      // An hour of word timestamps is a few MB of JSON (projects.saveTranscript); media goes through /assets.
      const input = rpcRequestSchema.parse(JSON.parse((await body(req, 32 * 1024 * 1024)).toString('utf8')));
      let response: RpcResponse;
      try { response = { type: 'server-response', rpcId: input.rpcId, result: { ok: true, value: await ctx.rpc.invoke(input.method, input.payload) } }; }
      catch (error) { response = { type: 'server-response', rpcId: input.rpcId, result: { ok: false, error: { code: 'RPC_ERROR', message: error instanceof Error ? error.message : String(error), details: {} } } }; }
      json(200, response);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      json(400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  const sockets = new WebSocketServer({ noServer: true, handleProtocols(protocols) { return protocols.has('flycut') ? 'flycut' : false; } });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/events' || !authorize(req, url, { csrf: false }).ok) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    sockets.handleUpgrade(req, socket, head, client => {
      const send = (frame: HostFrame) => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(frame)); };
      send({ type: 'host/ready', protocolVersion: PROTOCOL_VERSION, generation: ctx.rpc.generation, cursor: ctx.rpc.cursor(), events: ctx.rpc.events() });
      // Subscribe before snapshot: duplicates are identified by job.updatedAt; no update is lost between them.
      const off = ctx.rpc.subscribe(send);
      send({ type: 'jobs/snapshot', jobs: ctx.jobs.list() });
      client.once('close', off);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(ctx.hostConfig.port, ctx.hostConfig.bind ?? '127.0.0.1', resolve); });
  ctx.provide('httpServer', server);
  ctx.effect(() => async () => {
    sockets.clients.forEach(client => client.terminate());
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  });
} };

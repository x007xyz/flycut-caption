import type { Context } from '@deepseek-ai/cordis';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { rpcRequestSchema, PROTOCOL_VERSION, type HostFrame, type RpcResponse } from '../../shared/protocol';

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
  const allowedOrigin = (origin?: string) => !origin || origin === 'tauri://localhost' || origin === 'http://tauri.localhost'
    || LOOPBACK_ORIGIN.test(origin) || origins.has(origin);
  const authorized = (req: IncomingMessage, url: URL) => allowedOrigin(req.headers.origin)
    && (req.headers.authorization === `Bearer ${ctx.hostConfig.token}` || url.searchParams.get('token') === ctx.hostConfig.token);
  if (config.shutdown !== false) {
    ctx.effect(() => ctx.rpc.register('host.shutdown', undefined, () => { setTimeout(() => process.emit('SIGTERM'), 25); return { stopping: true } as const; }));
  }
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
    if (allowedOrigin(req.headers.origin) && req.headers.origin) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin); res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    }
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (url.pathname === '/health' && req.method === 'GET') { json(200, { ok: true, protocolVersion: PROTOCOL_VERSION }); return; }
    if (webRoot && url.pathname === '/__flycut/connection' && req.method === 'GET') {
      // Same-origin bootstrap for the served frontend. The Host header check blocks DNS-rebinding pages.
      const host = req.headers.host ?? '';
      if (!allowedOrigin(req.headers.origin) || !(LOOPBACK_HOST.test(host) || originHosts.has(host))) { json(403, { error: 'Forbidden' }); return; }
      json(200, { token: ctx.hostConfig.token }); return;
    }
    // Plugin-owned routes (media streaming, shell-only endpoints). Shell routes come from the desktop shell process,
    // which sends no Origin; a browser page cannot use them even if it learned the frontend token.
    const routed = ctx.rpc.match(req.method ?? '', url.pathname);
    if (routed) {
      const shellToken = ctx.hostConfig.shellToken;
      const allowed = routed.route.auth === 'shell'
        ? !!shellToken && !req.headers.origin && req.headers.authorization === `Bearer ${shellToken}`
        : authorized(req, url);
      if (!allowed) { json(401, { error: 'Unauthorized' }); return; }
      try { await routed.route.handle(req, res, routed.match); }
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
    if (!authorized(req, url)) { json(401, { error: 'Unauthorized' }); return; }
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
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/events' || !authorized(req, url)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
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

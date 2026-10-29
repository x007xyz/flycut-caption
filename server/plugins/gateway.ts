import type { Context } from '@deepseek-ai/cordis';
import { createServer, type IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { rpcRequestSchema, PROTOCOL_VERSION, type HostFrame, type RpcResponse } from '../../shared/protocol';

async function body(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > limit) throw new Error('Request body exceeds limit'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

/**
 * Harness-inspired transport: unary RPC + generation-scoped WebSocket events.
 * The Gateway owns no business methods; it dispatches to `ctx.rpc`, where each plugin registers its own.
 */
export const gatewayPlugin = { name: 'flycut-api-gateway', inject: ['hostConfig', 'rpc', 'jobs', 'assets'], async apply(ctx: Context) {
  const allowedOrigin = (origin?: string) => !origin || origin === 'tauri://localhost' || origin === 'http://tauri.localhost'
    || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const authorized = (req: IncomingMessage, url: URL) => allowedOrigin(req.headers.origin)
    && (req.headers.authorization === `Bearer ${ctx.hostConfig.token}` || url.searchParams.get('token') === ctx.hostConfig.token);
  ctx.effect(() => ctx.rpc.register('host.shutdown', undefined, () => { setTimeout(() => process.emit('SIGTERM'), 25); return { stopping: true } as const; }));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (allowedOrigin(req.headers.origin) && req.headers.origin) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin); res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    }
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (url.pathname === '/health' && req.method === 'GET') { json(200, { ok: true, protocolVersion: PROTOCOL_VERSION }); return; }
    if (!authorized(req, url)) { json(401, { error: 'Unauthorized' }); return; }
    try {
      if (url.pathname === '/assets' && req.method === 'POST') {
        const assetId = await ctx.assets.putStream(req, 4 * 1024 * 1024 * 1024); json(201, { assetId }); return;
      }
      const assetMatch = url.pathname.match(/^\/assets\/([0-9a-f-]{36})$/i);
      if (assetMatch && req.method === 'GET') {
        const file = ctx.assets.path(assetMatch[1]); const size = await ctx.assets.size(assetMatch[1]).catch(() => undefined);
        if (size === undefined) { json(404, { error: 'Asset not found' }); return; }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size, 'Cache-Control': 'no-store' });
        // A client may close right after the last byte; that is not a server error once headers are out.
        await pipeline(createReadStream(file), res).catch(error => { if (!res.headersSent) throw error; res.destroy(); });
        return;
      }
      if (url.pathname !== '/rpc' || req.method !== 'POST') { json(404, { error: 'Not found' }); return; }
      const input = rpcRequestSchema.parse(JSON.parse((await body(req, 2 * 1024 * 1024)).toString('utf8')));
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
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(ctx.hostConfig.port, '127.0.0.1', resolve); });
  ctx.provide('httpServer', server);
  ctx.effect(() => async () => {
    sockets.clients.forEach(client => client.terminate());
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  });
} };

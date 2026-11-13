// 端到端测试用的假 Host：拦截连接引导、RPC 和事件流，按方法名返回测试给的结果。
// 只用来构造界面状态（加载中、出错、冲突……）；Host 自身的行为由 tests/architecture 覆盖。
import type { Page, Route, WebSocketRoute } from '@playwright/test';

export const MOCK_HOST = 'http://127.0.0.1:8799';
export const MOCK_HOST_2 = 'http://127.0.0.1:8798';
export const E2E_CSRF = 'e2e-csrf';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试里按方法直接解构参数
type Handler = (payload: any) => unknown | Promise<unknown>;
export type MockHandlers = Record<string, Handler>;

export interface MockHost {
  /** 每个方法被调用时收到的参数，按调用顺序 */
  calls: { method: string; payload: Record<string, unknown> }[];
  set(method: string, handler: Handler): void;
  /** 模拟 Host 重启 / 网络断开：关闭当前事件流，客户端应进入重连。 */
  disconnect(): Promise<void>;
}

/** 模拟一个永不返回的请求（加载中状态）。 */
export const pending = () => new Promise<never>(() => undefined);

/** 让 RPC 返回错误（Host 已收到但处理失败）。 */
export class RpcError extends Error {}

const defaults: MockHandlers = {
  'host.info': () => ({ protocolVersion: 2, generation: 'e2e', methods: [], events: [], providers: [],
    capabilities: { projects: true, browserSession: true, cookieMedia: true, resumableUpload: true } }),
  'uploads.capabilities': () => ({ protocolVersion: 1, chunkSize: 2 * 1024 * 1024, maxBytes: 4 * 1024 * 1024 * 1024,
    maxChunks: 2048, sessionTtlHours: 24, allowedMimeTypes: ['video/mp4', 'video/webm', 'video/quicktime', 'video/ogg',
      'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4'] }),
  'providers.models': () => [],
  'cloud.status': () => ({ available: false }),
  'endpoints.list': () => [],
  'projects.list': () => [],
  'projects.identity': () => ({ hostId: E2E_HOST_ID, recovery: 1 }),
  'aiSettings.list': () => ({ hostId: E2E_HOST_ID, revision: 0, selectedId: null, configs: [] }),
  'tts.getSettings': () => ({ hostId: E2E_HOST_ID, revision: 0, selectedModel: null, voiceId: null, language: 'auto', speed: 1, options: {}, lastAudition: null }),
};

export interface MockHostOptions {
  /** 覆盖同源 /__flycut/connection 的响应；'none' 模拟没有可发现的 Host。 */
  connection?: unknown | 'none';
  csrf?: string;
}

export async function mockHost(page: Page, handlers: MockHandlers = {}, options: MockHostOptions = {}): Promise<MockHost> {
  const table: MockHandlers = { ...defaults, ...handlers };
  const sockets = new Set<WebSocketRoute>();
  const uploads = new Map<string, Record<string, unknown>>();
  const host: MockHost = { calls: [], set: (method, handler) => { table[method] = handler; },
    disconnect: async () => { await Promise.all([...sockets].map(socket => socket.close({ code: 1011, reason: 'test disconnect' }).catch(() => undefined))); } };
  const csrf = options.csrf ?? E2E_CSRF;
  const sessionConnection = { url: MOCK_HOST, auth: 'session', csrf };

  await page.route('**/__flycut/connection', route => {
    if (options.connection === 'none') { void route.fulfill({ status: 503, json: { error: 'no host' } }); return; }
    void route.fulfill({ json: options.connection ?? sessionConnection });
  });
  await page.routeWebSocket(`${MOCK_HOST.replace('http', 'ws')}/events**`, ws => {
    sockets.add(ws);
    // The F-0014 connection waits for host/ready before any RPC. Snapshot frames keep job recovery quiet.
    ws.send(JSON.stringify({ type: 'host/ready', generation: 'e2e', protocolVersion: 2, cursor: 0, events: [] }));
    ws.send(JSON.stringify({ type: 'jobs/snapshot', jobs: [] }));
    ws.onClose(() => sockets.delete(ws));
  });
  await page.route(`${MOCK_HOST}/**`, async (route: Route) => {
    const request = route.request();
    const origin = request.headers().origin;
    const headers = { 'Access-Control-Allow-Origin': origin ?? '*', 'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    const url = new URL(request.url());
    if (url.pathname === '/session' && request.method() === 'DELETE') { await route.fulfill({ status: 204, headers }); return; }
    if (url.pathname === '/__flycut/connection') { await route.fulfill({ headers, json: options.connection === 'none' ? { error: 'no host' } : options.connection ?? sessionConnection }); return; }
    // 上传媒体（Web 端新建项目）
    if (url.pathname === '/assets' && request.method() === 'POST') { await route.fulfill({ headers, json: { assetId: UPLOADED_ASSET } }); return; }
    // F-0015 resumable upload fixture. Tests can override individual semantics by replacing the relevant RPC.
    if (url.pathname === '/uploads' && request.method() === 'POST') {
      if (request.headers()['x-flycut-csrf'] !== csrf) { await route.fulfill({ status: 401, headers }); return; }
      const input = request.postDataJSON() as { fileName: string; size: number; mimeType: string; sha256: string };
      const id = uuid(800 + uploads.size); const now = new Date().toISOString();
      const session = { id, ...input, chunkSize: 2 * 1024 * 1024, chunkCount: Math.max(1, Math.ceil(input.size / (2 * 1024 * 1024))),
        chunks: [], uploadedBytes: 0, state: 'active', createdAt: now, updatedAt: now, expiresAt: '2099-01-01T00:00:00.000Z' };
      uploads.set(id, session); await route.fulfill({ status: 201, headers, json: session }); return;
    }
    const uploadMatch = /^\/uploads\/([^/]+)(?:\/chunks\/(\d+)|\/(complete))?$/.exec(url.pathname);
    if (uploadMatch) {
      if (request.headers()['x-flycut-csrf'] !== csrf) { await route.fulfill({ status: 401, headers }); return; }
      const session = uploads.get(uploadMatch[1]);
      if (!session) { await route.fulfill({ status: 404, headers, json: { error: { code: 'invalid-session' } } }); return; }
      const now = new Date().toISOString();
      if (request.method() === 'GET') { await route.fulfill({ headers, json: session }); return; }
      if (request.method() === 'DELETE') { session.state = 'cancelled'; session.updatedAt = now; await route.fulfill({ headers, json: session }); return; }
      if (uploadMatch[3]) {
        session.state = 'complete'; session.assetId = UPLOADED_ASSET; session.updatedAt = now;
        await route.fulfill({ headers, json: session }); return;
      }
      if (uploadMatch[2] && request.method() === 'PUT') {
        const index = Number(uploadMatch[2]); const bytes = request.postDataBuffer()?.length ?? 0;
        const chunks = session.chunks as Array<Record<string, unknown>>;
        if (!chunks.some(chunk => chunk.index === index)) chunks.push({ index, offset: index * Number(session.chunkSize), size: bytes,
          sha256: request.headers()['x-chunk-sha256'] });
        session.chunks = chunks.sort((a, b) => Number(a.index) - Number(b.index));
        session.uploadedBytes = chunks.reduce((total, chunk) => total + Number(chunk.size), 0); session.updatedAt = now;
        await route.fulfill({ headers, json: session }); return;
      }
    }
    if (url.pathname !== '/rpc') { await route.fulfill({ status: 404, headers }); return; }
    if (request.headers()['x-flycut-csrf'] !== csrf) { await route.fulfill({ status: 401, headers, json: { error: 'Unauthorized' } }); return; }
    const body = request.postDataJSON() as { rpcId: string; method: string; payload: Record<string, unknown> };
    host.calls.push({ method: body.method, payload: body.payload });
    const handler = table[body.method];
    let result: unknown;
    try {
      if (!handler) throw new RpcError(`Unknown RPC method: ${body.method}`);
      result = { ok: true, value: await handler(body.payload) };
    } catch (error) {
      // 网络层失败（Host 未响应）：直接断开
      if (!(error instanceof RpcError)) { await route.abort('connectionrefused').catch(() => undefined); return; }
      result = { ok: false, error: { code: 'RPC_ERROR', message: error.message, details: {} } };
    }
    await route.fulfill({ headers, json: { type: 'server-response', rpcId: body.rpcId, result } }).catch(() => undefined);
  });
  return host;
}

/** 首页列表里的一个项目。 */
export function projectItem(id: string, name: string, patch: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return { id, name, durationSeconds: 754, createdAt: now, updatedAt: now, revision: 3, videoCount: 1, videoId: VIDEO_ID,
    hasThumbnail: false, mediaMissing: false, ...patch };
}

/** 假 Host 的身份（F-0004：恢复副本按它隔离） */
export const E2E_HOST_ID = '00000000-0000-4000-8000-0000000000cc';

/** 假 Host 给每次上传返回的资产编号 */
export const UPLOADED_ASSET = '00000000-0000-4000-8000-0000000000bb';
export const VIDEO_ID = '00000000-0000-4000-8000-0000000000aa';
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** 设置主题和界面偏好；在 page.goto 之前调用。 */
export async function prepare(page: Page, theme: 'light' | 'dark', extra: Record<string, string> = {}) {
  await page.addInitScript(({ theme, extra }) => {
    if (sessionStorage.getItem('e2e-prepared')) return;
    sessionStorage.setItem('e2e-prepared', '1');
    localStorage.setItem('theme-storage', JSON.stringify({ state: { theme, resolvedTheme: theme }, version: 0 }));
    for (const [key, value] of Object.entries(extra)) localStorage.setItem(key, value);
  }, { theme, extra });
}

/** Minimal Tauri IPC double for desktop-only UI tests. Directory selection returns an opaque grant. */
export async function installTauriMock(page: Page, options: { hostUrl: string; csrf: string; grant: string }): Promise<void> {
  await page.addInitScript(({ hostUrl, csrf, grant }) => {
    let callbackId = 0;
    const callbacks = new Map<number, (value: unknown) => unknown>();
    const internals = {
      metadata: { currentWindow: { label: 'main' } },
      transformCallback(callback: (value: unknown) => unknown, once = false) {
        const id = ++callbackId;
        callbacks.set(id, value => { if (once) callbacks.delete(id); return callback(value); });
        return id;
      },
      unregisterCallback(id: number) { callbacks.delete(id); },
      convertFileSrc(path: string) { return path; },
      async invoke(command: string) {
        if (command === 'ensure_host') return { url: hostUrl, auth: { kind: 'session', csrf } };
        if (command === 'pick_jianying_output_directory') return { grant, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
        if (command === 'plugin:event|listen') return ++callbackId;
        if (command === 'plugin:event|unlisten') return null;
        return null;
      },
    };
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = internals;
    (window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  }, options);
}

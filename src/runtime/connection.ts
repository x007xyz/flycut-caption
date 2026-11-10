import type { Context } from '@deepseek-ai/cordis';
import type { HostFrame, JobSnapshot, RemoteEventName, RemoteEvents, RpcInput, RpcMethod, RpcOutput, RpcResponse } from '../../shared/protocol';
import { PROTOCOL_VERSION } from '../../shared/protocol';
import {
  classifyHttpStatus, isReadOnlyRpc, type HostAuth, type HostConnectionOptions, type HostSessionService,
} from './connectionModel';

/** Methods whose input is `void` may be called without a payload. */
type CallArgs<M extends RpcMethod> = RpcInput<M> extends void ? [payload?: undefined] : [payload: RpcInput<M>];

export interface RemoteConnection {
  call<M extends RpcMethod>(method: M, ...args: CallArgs<M>): Promise<RpcOutput<M>>;
  /** Subscribes to a Host event the Host chose to expose. Wrap in `ctx.effect` inside client plugins. */
  on<E extends RemoteEventName>(name: E, listener: (payload: RemoteEvents[E]) => void): () => void;
  upload(audio: Blob): Promise<string>;
  download(assetId: string): Promise<Blob>;
  /** Absolute URL of a Host HTTP route for elements that cannot send headers (`<video src>`). */
  resourceUrl(path: string): string;
  waitJob<T>(id: string, progress?: (job: JobSnapshot) => void, signal?: AbortSignal): Promise<T>;
  subscribe(listener: () => void): () => void;
  snapshot(): 'connecting' | 'connected' | 'disconnected';
  isReady(): boolean;
  /** Opens the socket and resolves after `host/ready`; callers run `host.info` + `projects.identity` next. */
  open(): Promise<HostFrame & { type: 'host/ready' }>;
  waitForJobsSnapshot(timeoutMs?: number): Promise<void>;
  setRefreshHandler(handler: (() => Promise<HostAuth | null>) | null): void;
  setErrorHandler(handler: ((error: HostRequestError) => void) | null): void;
  setSessionExpiry(expiresAt?: string): void;
  close(): void;
}
declare module '@deepseek-ai/cordis' {
  interface Context { connection: RemoteConnection; hostSession: HostSessionService }
}

/** HTTP-level failure. Messages never include URLs, cookies or tokens. */
export class HostRequestError extends Error {
  readonly code: 'auth-expired' | 'access-denied' | 'rate-limited' | 'server-error' | 'request';
  readonly status: number;
  readonly retryAfterMs?: number;
  constructor(status: number, retryAfterMsValue?: number) {
    const code = classifyHttpStatus(status);
    super(code === 'auth-expired' ? 'Host session expired' : code === 'access-denied' ? 'Host access denied'
      : code === 'rate-limited' ? 'Host is rate limiting requests' : code === 'server-error' ? 'Host failed to handle the request'
        : `Host request failed (HTTP ${status})`);
    this.name = 'HostRequestError'; this.code = code; this.status = status; this.retryAfterMs = retryAfterMsValue;
  }
}

export class SessionClosedError extends Error {
  constructor() { super('Host session closed'); this.name = 'SessionClosedError'; }
}

export class ConnectionUnavailableError extends Error {
  constructor() { super('连接已断开，连接恢复后可继续'); this.name = 'ConnectionUnavailableError'; }
}

function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function base64url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Separate transport instance per client Context; no backend implementation is imported. */
export class HostConnection implements RemoteConnection {
  private socket?: WebSocket;
  private status: 'connecting' | 'connected' | 'disconnected' = 'disconnected';
  private listeners = new Set<() => void>();
  private jobs = new Map<string, JobSnapshot>();
  private observers = new Set<(job: JobSnapshot) => void>();
  private remoteListeners = new Map<string, Set<(payload: never) => void>>();
  private waiters = new Set<() => void>();
  private snapshotWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private stopped = false;
  private generation?: string;
  private sequence = 0;
  private socketEpoch = 0;
  private jobsSnapshotReceived = false;
  private refreshHandler: (() => Promise<HostAuth | null>) | null = null;
  private errorHandler: ((error: HostRequestError) => void) | null = null;
  private refreshing: Promise<HostAuth | null> | null = null;
  private sessionExpiresAt?: string;
  private options: HostConnectionOptions;

  constructor(options: HostConnectionOptions) { this.options = options; }
  snapshot = () => this.status;
  isReady = () => this.status === 'connected' && !this.stopped;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  setRefreshHandler(handler: (() => Promise<HostAuth | null>) | null) { this.refreshHandler = handler; }
  setErrorHandler(handler: ((error: HostRequestError) => void) | null) { this.errorHandler = handler; }
  setSessionExpiry(expiresAt?: string) { this.sessionExpiresAt = expiresAt; }
  getSessionExpiry() { return this.sessionExpiresAt; }

  private setStatus(status: typeof this.status) {
    if (this.status === status) return;
    this.status = status; this.listeners.forEach(listener => listener());
  }

  private notifyError(error: HostRequestError) {
    if (error.code === 'auth-expired' || error.code === 'access-denied') this.errorHandler?.(error);
  }

  on<E extends RemoteEventName>(name: E, listener: (payload: RemoteEvents[E]) => void) {
    const set = this.remoteListeners.get(name) ?? new Set(); this.remoteListeners.set(name, set);
    set.add(listener as (payload: never) => void);
    return () => { set.delete(listener as (payload: never) => void); };
  }

  private authHeaders(): Record<string, string> {
    if (this.options.auth.kind === 'bearer') return { Authorization: `Bearer ${this.options.auth.token}` };
    return this.options.auth.csrf ? { 'X-Flycut-CSRF': this.options.auth.csrf } : {};
  }

  private credentials(): RequestCredentials { return this.options.auth.kind === 'session' ? 'include' : 'omit'; }

  private async refreshOnce(): Promise<HostAuth | null> {
    if (!this.refreshHandler) return null;
    if (!this.refreshing) this.refreshing = this.refreshHandler().finally(() => { this.refreshing = null; });
    const auth = await this.refreshing;
    if (auth) this.options = { ...this.options, auth };
    return auth;
  }

  private async httpFailure(response: Response): Promise<HostRequestError> {
    const error = new HostRequestError(response.status, parseRetryAfter(response.headers.get('retry-after')));
    this.notifyError(error);
    return error;
  }

  async call<M extends RpcMethod>(method: M, ...[payload]: CallArgs<M>): Promise<RpcOutput<M>> {
    if (this.stopped) throw new SessionClosedError();
    if (this.status !== 'connected') throw new ConnectionUnavailableError();
    const rpcId = crypto.randomUUID();
    const request = () => fetch(`${this.options.url}/rpc`, { method: 'POST', credentials: this.credentials(),
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: payload ?? {} }), signal: AbortSignal.timeout(30000) });
    let response = await request();
    if (response.status === 401 && this.options.auth.kind === 'session' && isReadOnlyRpc(method)) {
      // 刷新只允许重试只读请求一次；写请求的 401 直接进入 auth-expired。
      const auth = await this.refreshOnce().catch(() => null);
      if (auth) response = await request();
    }
    if (!response.ok) throw await this.httpFailure(response);
    const envelope = await response.json() as RpcResponse;
    if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId) throw new Error('Invalid Host RPC response');
    if (envelope.result.ok === false) throw new Error(envelope.result.error.message);
    return envelope.result.value as RpcOutput<M>;
  }

  async upload(audio: Blob) {
    if (this.stopped) throw new SessionClosedError();
    if (this.status !== 'connected') throw new ConnectionUnavailableError();
    const response = await fetch(`${this.options.url}/assets`, { method: 'POST', body: audio, credentials: this.credentials(),
      headers: this.authHeaders() });
    if (!response.ok) throw await this.httpFailure(response);
    return (await response.json() as { assetId: string }).assetId;
  }

  async download(assetId: string) {
    if (this.stopped) throw new SessionClosedError();
    if (this.status !== 'connected') throw new ConnectionUnavailableError();
    const response = await fetch(`${this.options.url}/assets/${assetId}`, { credentials: this.credentials(), headers: this.authHeaders() });
    if (!response.ok) throw await this.httpFailure(response);
    return response.blob();
  }

  /**
   * 浏览器会话不带凭证；桌面本机 bearer 例外仍把 token 放在 URL 里，
   * 因为 `<video src>` 无法设置 Authorization。Web/Cloud 会话永远走 Cookie。
   */
  resourceUrl(path: string) {
    const url = new URL(path, this.options.url);
    if (this.options.auth.kind === 'bearer') url.searchParams.set('token', this.options.auth.token);
    return url.toString();
  }

  private settleSnapshots(error?: Error) {
    for (const waiter of this.snapshotWaiters) {
      clearTimeout(waiter.timer);
      if (error) waiter.reject(error); else waiter.resolve();
    }
    this.snapshotWaiters.clear();
  }

  private accept(job: JobSnapshot) {
    const previous = this.jobs.get(job.id);
    if (previous && previous.updatedAt > job.updatedAt) return;
    this.jobs.set(job.id, job); this.observers.forEach(observer => observer(job));
  }

  async waitForJobsSnapshot(timeoutMs = 10_000) {
    if (this.jobsSnapshotReceived) return;
    await new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject, timer: setTimeout(() => { this.snapshotWaiters.delete(waiter); reject(new Error('Host did not send jobs/snapshot')); }, timeoutMs) };
      this.snapshotWaiters.add(waiter);
    });
  }

  open(): Promise<HostFrame & { type: 'host/ready' }> {
    if (this.stopped) return Promise.reject(new SessionClosedError());
    const epoch = ++this.socketEpoch;
    this.jobsSnapshotReceived = false;
    this.setStatus('connecting');
    const url = new URL('/events', this.options.url);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const protocols = this.options.auth.kind === 'bearer'
      ? ['flycut', `flycut.token.${base64url(this.options.auth.token)}`]
      : ['flycut'];
    let settled = false;
    return new Promise((resolve, reject) => {
      let socket: WebSocket;
      try { socket = new WebSocket(url, protocols); } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); return; }
      this.socket = socket;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timeout);
        try { socket.close(); } catch { /* already closed */ }
        reject(error);
      };
      const timeout = setTimeout(() => fail(new Error('Host connection timed out')), 10_000);
      socket.onmessage = event => {
        try {
          const message = JSON.parse(String(event.data)) as HostFrame;
          if (message.type === 'host/ready') {
            if (message.protocolVersion !== PROTOCOL_VERSION) { fail(new Error(`Host protocol version mismatch (${message.protocolVersion})`)); return; }
            if (this.generation !== message.generation) { this.jobs.clear(); this.generation = message.generation; }
            this.sequence = message.cursor;
            if (!settled) { settled = true; clearTimeout(timeout); this.setStatus('connected'); resolve(message); }
          } else if (message.type === 'jobs/snapshot') {
            this.jobsSnapshotReceived = true;
            message.jobs.forEach(job => this.accept(job));
            this.settleSnapshots();
          } else if (message.type === 'event' && message.generation === this.generation && message.seq > this.sequence) {
            this.sequence = message.seq;
            if (message.name === 'job/updated') this.accept((message.payload as RemoteEvents['job/updated']).job);
            this.remoteListeners.get(message.name)?.forEach(listener => {
              try { listener(message.payload as never); } catch (error) { console.error('Remote event listener failed', error); }
            });
          }
        } catch (error) {
          console.error('Host stream error', error); fail(error instanceof Error ? error : new Error(String(error)));
        }
      };
      socket.onerror = () => { if (!settled) fail(new Error('Host connection failed')); };
      socket.onclose = () => {
        if (this.socket !== socket || epoch !== this.socketEpoch) return;
        this.setStatus('disconnected');
        this.settleSnapshots(new Error('Host connection closed'));
        // 临时断线只暂停 waitJob（它订阅状态，重连后用 jobs.get 恢复）；只有 close()（登出/切换）才结束等待。
        if (!settled) fail(new Error('Host connection closed'));
      };
    });
  }

  async waitJob<T>(id: string, progress?: (job: JobSnapshot) => void, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      const cleanup = () => {
        finished = true; clearInterval(timer); this.observers.delete(observe); this.waiters.delete(closed);
        offStatus(); signal?.removeEventListener('abort', abort);
      };
      const closed = () => { cleanup(); reject(new SessionClosedError()); };
      const observe = (job: JobSnapshot) => {
        if (finished || job.id !== id) return;
        progress?.(job);
        if (job.status === 'complete') { cleanup(); resolve(job.result as T); }
        else if (job.status === 'error' || job.status === 'cancelled') { cleanup(); reject(new Error(job.error || job.status)); }
      };
      const abort = () => {
        cleanup();
        // 用户明确取消：只在连接可用时发送；断线时不排队，也不在登出后补发。
        if (this.isReady()) void this.call('jobs.cancel', { id }).catch(() => undefined);
        reject(signal?.reason ?? new Error('Cancelled'));
      };
      // 断线时暂停轮询；重连后立即查一次。任务快照和 jobs.get 都是只读恢复。
      const refresh = () => {
        if (finished || !this.isReady()) return;
        void this.call('jobs.get', { id }).then(observe, error => {
          if (finished) return;
          if (error instanceof SessionClosedError) closed();
        });
      };
      const schedule = () => {
        clearInterval(timer); timer = undefined;
        if (finished || !this.isReady()) return;
        refresh(); timer = setInterval(refresh, 2000);
      };
      const offStatus = this.subscribe(schedule);
      this.waiters.add(closed); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      const cached = this.jobs.get(id); if (cached) observe(cached);
      schedule();
    });
  }

  close() {
    if (this.stopped) return;
    this.stopped = true; this.socketEpoch += 1;
    this.remoteListeners.clear(); this.settleSnapshots(new SessionClosedError());
    try { this.socket?.close(); } catch { /* already closed */ }
    this.waiters.forEach(close => close()); this.waiters.clear();
    this.setStatus('disconnected'); this.listeners.clear();
  }
}

export interface ConnectionPluginOptions { session?: HostSessionService }

export function connectionPlugin(input: HostConnectionOptions | RemoteConnection, options: ConnectionPluginOptions = {}) {
  return { name: 'flycut-client-connection', apply(ctx: Context) {
    const legacyOptions = 'auth' in input && 'url' in input;
    const connection = (legacyOptions ? new HostConnection(input as HostConnectionOptions) : input) as RemoteConnection;
    ctx.provide('connection', connection);
    if (options.session) ctx.provide('hostSession', options.session);
    if (legacyOptions) void connection.open().catch(error => console.warn('Host 连接失败', error instanceof Error ? error.message : String(error)));
    ctx.effect(() => () => connection.close());
  } };
}

/** Legacy direct-window discovery kept for embedders that import it; new UI uses HostSessionController. */
export async function discoverHost(): Promise<HostConnectionOptions> {
  if ('__TAURI_INTERNALS__' in window) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<HostConnectionOptions>('ensure_host');
  }
  const explicit = (globalThis as typeof globalThis & { __FLYCUT_HOST__?: HostConnectionOptions }).__FLYCUT_HOST__;
  if (explicit) return explicit;
  const response = await fetch('/__flycut/connection', { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('无法连接 FlyCut Host。请运行 pnpm dev，或设置 window.__FLYCUT_HOST__。');
  const options = await response.json() as Partial<HostConnectionOptions> & { token?: string; auth?: HostAuth; csrf?: string };
  if (options.token) return { url: options.url || location.origin, auth: { kind: 'bearer', token: options.token } };
  if (options.auth) return { url: options.url || location.origin, auth: options.auth };
  throw new Error('Host 版本不兼容');
}

import type { Context } from '@deepseek-ai/cordis';
import type { HostFrame, JobSnapshot, RemoteEventName, RemoteEvents, RpcInput, RpcMethod, RpcOutput, RpcResponse } from '../../shared/protocol';
import { PROTOCOL_VERSION } from '../../shared/protocol';

/** Methods whose input is `void` may be called without a payload. */
type CallArgs<M extends RpcMethod> = RpcInput<M> extends void ? [payload?: undefined] : [payload: RpcInput<M>];

export interface HostConnectionOptions { url: string; token: string }
export interface RemoteConnection {
  call<M extends RpcMethod>(method: M, ...args: CallArgs<M>): Promise<RpcOutput<M>>;
  /** Subscribes to a Host event the Host chose to expose. Wrap in `ctx.effect` inside client plugins. */
  on<E extends RemoteEventName>(name: E, listener: (payload: RemoteEvents[E]) => void): () => void;
  upload(audio: Blob): Promise<string>;
  download(assetId: string): Promise<Blob>;
  waitJob<T>(id: string, progress?: (job: JobSnapshot) => void, signal?: AbortSignal): Promise<T>;
  subscribe(listener: () => void): () => void;
  snapshot(): 'connecting' | 'connected' | 'disconnected';
  close(): void;
}
declare module '@deepseek-ai/cordis' { interface Context { connection: RemoteConnection } }

/** Separate transport instance per client Context; no backend implementation is imported. */
export class HostConnection implements RemoteConnection {
  private socket?: WebSocket;
  private status: 'connecting' | 'connected' | 'disconnected' = 'connecting';
  private listeners = new Set<() => void>();
  private jobs = new Map<string, JobSnapshot>();
  private observers = new Set<(job: JobSnapshot) => void>();
  private remoteListeners = new Map<string, Set<(payload: never) => void>>();
  private waiters = new Set<() => void>();
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private generation?: string;
  private sequence = 0;
  private options: HostConnectionOptions;
  constructor(options: HostConnectionOptions) { this.options = options; this.connect(); }
  snapshot = () => this.status;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private setStatus(status: typeof this.status) { this.status = status; this.listeners.forEach(listener => listener()); }
  on<E extends RemoteEventName>(name: E, listener: (payload: RemoteEvents[E]) => void) {
    const set = this.remoteListeners.get(name) ?? new Set(); this.remoteListeners.set(name, set);
    set.add(listener as (payload: never) => void);
    return () => { set.delete(listener as (payload: never) => void); };
  }
  async call<M extends RpcMethod>(method: M, ...[payload]: CallArgs<M>): Promise<RpcOutput<M>> {
    const rpcId = crypto.randomUUID();
    const response = await fetch(`${this.options.url}/rpc`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.options.token}` },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: payload ?? {} }), signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Host RPC HTTP ${response.status}`);
    const envelope = await response.json() as RpcResponse;
    if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId) throw new Error('Invalid Host RPC response');
    if (envelope.result.ok === false) throw new Error(envelope.result.error.message);
    return envelope.result.value as RpcOutput<M>;
  }
  async upload(audio: Blob) {
    const response = await fetch(`${this.options.url}/assets`, { method: 'POST', body: audio,
      headers: { Authorization: `Bearer ${this.options.token}` } });
    if (!response.ok) throw new Error(`Host upload HTTP ${response.status}`);
    return (await response.json() as { assetId: string }).assetId;
  }
  async download(assetId: string) {
    const response = await fetch(`${this.options.url}/assets/${assetId}`, { headers: { Authorization: `Bearer ${this.options.token}` } });
    if (!response.ok) throw new Error(`Host download HTTP ${response.status}`);
    return response.blob();
  }
  private accept(job: JobSnapshot) {
    const previous = this.jobs.get(job.id);
    if (previous && previous.updatedAt > job.updatedAt) return;
    this.jobs.set(job.id, job); this.observers.forEach(observer => observer(job));
  }
  private connect() {
    if (this.stopped) return;
    this.setStatus('connecting');
    const url = new URL('/events', this.options.url); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('token', this.options.token);
    const socket = new WebSocket(url); this.socket = socket;
    socket.onmessage = event => {
      try {
        const message = JSON.parse(String(event.data)) as HostFrame;
        if (message.type === 'host/ready') {
          if (message.protocolVersion !== PROTOCOL_VERSION) throw new Error('Host protocol version mismatch');
          if (this.generation !== message.generation) { this.jobs.clear(); this.generation = message.generation; }
          this.sequence = message.cursor; this.attempt = 0; this.setStatus('connected');
        } else if (message.type === 'jobs/snapshot') message.jobs.forEach(job => this.accept(job));
        else if (message.type === 'event' && message.generation === this.generation && message.seq > this.sequence) {
          this.sequence = message.seq;
          if (message.name === 'job/updated') this.accept((message.payload as RemoteEvents['job/updated']).job);
          this.remoteListeners.get(message.name)?.forEach(listener => {
            try { listener(message.payload as never); } catch (error) { console.error('Remote event listener failed', error); }
          });
        }
      } catch (error) { console.error('Host stream error', error); socket.close(); }
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (this.stopped || this.socket !== socket) return;
      this.setStatus('disconnected');
      this.timer = setTimeout(() => this.connect(), Math.min(10000, 250 * 2 ** this.attempt++));
    };
  }
  async waitJob<T>(id: string, progress?: (job: JobSnapshot) => void, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const cleanup = () => { finished = true; this.observers.delete(observe); this.waiters.delete(closed); signal?.removeEventListener('abort', abort); clearInterval(poll); };
      const closed = () => { cleanup(); reject(new Error('Host connection closed')); };
      const observe = (job: JobSnapshot) => {
        if (finished || job.id !== id) return;
        progress?.(job);
        if (job.status === 'complete') { cleanup(); resolve(job.result as T); }
        else if (job.status === 'error' || job.status === 'cancelled') { cleanup(); reject(new Error(job.error || job.status)); }
      };
      const abort = () => { cleanup(); void this.call('jobs.cancel', { id }).catch(() => undefined); reject(signal?.reason ?? new Error('Cancelled')); };
      // Snapshot/query recovery covers updates before subscription and stream disconnects.
      const refresh = () => { void this.call('jobs.get', { id }).then(observe, error => { if (!finished && this.stopped) { cleanup(); reject(error); } }); };
      const poll = setInterval(refresh, 2000);
      this.waiters.add(closed);
      this.observers.add(observe); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      const cached = this.jobs.get(id); if (cached) observe(cached);
      if (!finished) refresh();
    });
  }
  close() { this.stopped = true; this.remoteListeners.clear(); clearTimeout(this.timer); this.socket?.close(); this.waiters.forEach(close => close()); this.setStatus('disconnected'); }
}

export function connectionPlugin(options: HostConnectionOptions) {
  return { name: 'flycut-client-connection', apply(ctx: Context) {
    const connection = new HostConnection(options); ctx.provide('connection', connection);
    ctx.effect(() => () => connection.close());
  } };
}

export async function discoverHost(): Promise<HostConnectionOptions> {
  if ('__TAURI_INTERNALS__' in window) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<HostConnectionOptions>('ensure_host');
  }
  const explicit = (globalThis as typeof globalThis & { __FLYCUT_HOST__?: HostConnectionOptions }).__FLYCUT_HOST__;
  if (explicit) return explicit;
  const response = await fetch('/__flycut/connection', { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('无法连接 FlyCut Host。请运行 pnpm dev，或设置 window.__FLYCUT_HOST__。');
  return response.json() as Promise<HostConnectionOptions>;
}

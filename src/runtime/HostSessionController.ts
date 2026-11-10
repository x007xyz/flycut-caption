// F-0014：连接状态机。拥有目标发现、候选连接、重连计时器、身份缓存、切换和登出；
// React 只订阅快照并渲染，不在组件里保存连接状态。
import type { HostInfo } from '../../shared/protocol';
import { PROTOCOL_VERSION } from '../../shared/protocol';
import { HostConnection, HostRequestError, type RemoteConnection } from './connection';
import {
  RECONNECT_MAX_ATTEMPTS, SELF_HOSTING_DOC_URL, reconnectDelay, targetLabel, validateHostUrl,
  type CloudBootstrap, type CloudSessionAdapter, type ConnectionError, type ConnectionIdentity, type ConnectionSnapshot,
  type ConnectionSource, type DiscoveredHost, type HostAuth, type HostConnectionOptions, type HostSessionService,
} from './connectionModel';

export class IncompatibleHostError extends Error {
  constructor(message: string) { super(message); this.name = 'IncompatibleHostError'; }
}

export interface SessionTransport {
  open(): Promise<unknown>;
  call(method: string, payload?: unknown): Promise<unknown>;
  waitForJobsSnapshot(timeoutMs?: number): Promise<void>;
  subscribe(listener: () => void): () => void;
  snapshot(): 'connecting' | 'connected' | 'disconnected';
  isReady(): boolean;
  setRefreshHandler(handler: (() => Promise<HostAuth | null>) | null): void;
  setErrorHandler(handler: ((error: HostRequestError) => void) | null): void;
  setSessionExpiry(expiresAt?: string): void;
  close(): void;
}

export interface RuntimeSessionHooks {
  /** 切换前保存/丢弃并 endSession(false)；返回 false 表示用户取消。 */
  beforeSwitch?: () => Promise<boolean>;
  /** 登出前保存/保留副本；返回 false 表示用户取消。 */
  beforeLogout?: () => Promise<boolean>;
  /** 鉴权失败、登出或切换后清空旧身份的项目视图。 */
  onSessionEnded?: () => void;
  /** 同一地址重连后 hostId 变化。 */
  onIdentityChanged?: (previousHostId: string, hostId: string) => void;
  /** 重连成功且身份一致。 */
  onReconnected?: (hostId: string) => void;
}

export interface HostSessionControllerOptions {
  cloudAdapter?: CloudSessionAdapter;
  transportFactory?: (options: HostConnectionOptions) => SessionTransport;
  /** 测试替换目标发现；默认按桌面 → 嵌入方 → 同源 → Cloud 顺序。 */
  discover?: () => Promise<DiscoveredHost | null>;
  now?: () => number;
  random?: () => number;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  location?: { hash: string; assign(hash: string): void };
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  /** 页面重新可见 / 网络恢复时立即重试；测试不传。 */
  onlineSignals?: boolean;
}

const TARGET_KEY = 'flycut.connection.target';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function browserLocation(): HostSessionControllerOptions['location'] {
  if (typeof window === 'undefined') return undefined;
  return { get hash() { return window.location.hash; }, assign(hash: string) { window.location.hash = hash; } };
}

function browserStorage(): HostSessionControllerOptions['storage'] {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; }
}

function sourceFor(url: string): ConnectionSource {
  if (typeof window === 'undefined') return 'self-hosted';
  return url === window.location.origin ? 'same-origin' : 'self-hosted';
}

function asTransport(connection: HostConnection): SessionTransport {
  return connection as unknown as SessionTransport;
}

function parseBootstrap(data: unknown, fallbackUrl: string, source: ConnectionSource): DiscoveredHost | null {
  if (!data || typeof data !== 'object') return null;
  const body = data as { url?: unknown; auth?: unknown; csrf?: unknown; expiresAt?: unknown; token?: unknown };
  const url = typeof body.url === 'string' && body.url ? body.url : fallbackUrl;
  const checked = validateHostUrl(url);
  if (!checked.ok || !checked.url) return null;
  if (body.auth === 'session' || body.auth === 'cookie') {
    return { target: { url: checked.url, label: targetLabel(checked.url, source), source },
      auth: { kind: 'session', csrf: typeof body.csrf === 'string' ? body.csrf : undefined },
      expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : undefined };
  }
  // 显式地址/Tauri/开发替身仍可使用内存 bearer；同源旧 Host 的 token 响应不接受为浏览器会话。
  if (typeof body.token === 'string' && body.token) {
    return { target: { url: checked.url, label: targetLabel(checked.url, source), source }, auth: { kind: 'bearer', token: body.token } };
  }
  const auth = body.auth as HostAuth | undefined;
  if (auth && (auth.kind === 'session' || auth.kind === 'bearer')) {
    return { target: { url: checked.url, label: targetLabel(checked.url, source), source }, auth,
      csrf: auth.kind === 'session' ? (typeof body.csrf === 'string' ? body.csrf : auth.csrf) : undefined,
      expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : undefined };
  }
  return null;
}

async function fetchBootstrap(url: string, source: ConnectionSource): Promise<DiscoveredHost> {
  const response = await fetch(`${url}/__flycut/connection`, { credentials: 'include', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new HostRequestError(response.status);
  const parsed = parseBootstrap(await response.json(), url, source);
  if (!parsed) throw new IncompatibleHostError('Host connection bootstrap is incompatible');
  return parsed;
}

function cloudDiscovered(bootstrap: CloudBootstrap): DiscoveredHost {
  const checked = validateHostUrl(bootstrap.hostUrl);
  if (!checked.ok || !checked.url) throw new Error('Cloud returned an invalid Host address');
  const auth: HostAuth = bootstrap.auth.kind === 'cookie' ? { kind: 'session', csrf: bootstrap.csrf } : bootstrap.auth;
  return { target: { url: checked.url, label: targetLabel(checked.url, 'cloud'), source: 'cloud' }, auth,
    csrf: bootstrap.csrf, expiresAt: bootstrap.subject.expiresAt, subject: bootstrap.subject };
}

export class HostSessionController implements HostSessionService {
  readonly selfHostingUrl = SELF_HOSTING_DOC_URL;
  private options: HostSessionControllerOptions;
  private state: ConnectionSnapshot = { phase: 'boot', attempt: 0 };
  private listeners = new Set<() => void>();
  private active?: SessionTransport;
  private activeInfo?: { discovered: DiscoveredHost; identity: ConnectionIdentity; info: HostInfo };
  private pending?: { transport: SessionTransport; discovered: DiscoveredHost; identity: ConnectionIdentity; info: HostInfo };
  private hooks?: RuntimeSessionHooks;
  private generation = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;
  private refreshPromise: Promise<HostAuth | null> | null = null;
  private pendingRemoteLogout?: () => Promise<void>;
  private started = false;
  private stopped = false;
  private disposers: Array<() => void> = [];
  private runtimeKey?: string;

  constructor(options: HostSessionControllerOptions = {}) {
    this.options = { location: browserLocation(), storage: browserStorage(), now: () => Date.now(), random: () => Math.random(), onlineSignals: true, ...options };
  }

  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  cloudAvailable = () => !!this.options.cloudAdapter?.available();
  lastTargetUrl = () => this.readTarget();

  currentConnection(): RemoteConnection | undefined {
    return this.active as unknown as RemoteConnection | undefined;
  }

  private set(patch: Partial<ConnectionSnapshot>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }

  private now() { return this.options.now?.() ?? Date.now(); }
  private random() { return this.options.random?.() ?? Math.random(); }
  private setTimer(callback: () => void, ms: number) { return this.options.setTimer ? this.options.setTimer(callback, ms) : setTimeout(callback, ms); }
  private clearTimer(timer?: ReturnType<typeof setTimeout>) { if (timer === undefined) return; if (this.options.clearTimer) this.options.clearTimer(timer); else clearTimeout(timer); }

  private readTarget(): string | undefined {
    try { return this.options.storage?.getItem(TARGET_KEY) ?? undefined; } catch { return undefined; }
  }

  private rememberTarget(url: string) {
    try { this.options.storage?.setItem(TARGET_KEY, url); } catch { /* UI 偏好，不是功能前提 */ }
  }

  attachRuntime(hooks: RuntimeSessionHooks) { this.hooks = hooks; }
  detachRuntime(hooks?: RuntimeSessionHooks) { if (!hooks || this.hooks === hooks) this.hooks = undefined; }

  private syncTransport(transport: SessionTransport) {
    transport.setRefreshHandler(() => this.refreshSession());
    transport.setErrorHandler(error => { void this.handleSessionError(error); });
  }

  private async handleSessionError(error: HostRequestError) {
    if (error.code !== 'auth-expired' && error.code !== 'access-denied') return;
    this.clearReconnectTimer();
    this.hooks?.onSessionEnded?.();
    this.set({ phase: error.code === 'auth-expired' ? 'auth-expired' : 'access-denied', attempt: 0, nextRetryAt: undefined,
      error: { code: error.code, message: error.message, status: error.status } });
  }

  start() {
    if (this.started && !this.stopped) return;
    this.stopped = false; this.started = true;
    this.set({ phase: 'boot', attempt: 0, error: undefined, identityChanged: undefined });
    this.installOnlineSignals();
    void this.bootstrap();
  }

  stop() {
    this.stopped = true;
    this.clearReconnectTimer();
    this.disposers.forEach(dispose => dispose()); this.disposers = [];
    this.pending?.transport.close(); this.pending = undefined;
    this.active?.close(); this.active = undefined;
  }

  private installOnlineSignals() {
    if (!this.options.onlineSignals || typeof window === 'undefined') return;
    const retry = () => { if (this.state.phase === 'reconnecting' || this.state.phase === 'unreachable') void this.retry(); };
    const onVisibility = () => { if (document.visibilityState === 'visible') retry(); };
    window.addEventListener('online', retry);
    document.addEventListener('visibilitychange', onVisibility);
    this.disposers.push(() => window.removeEventListener('online', retry), () => document.removeEventListener('visibilitychange', onVisibility));
  }

  private async discover(): Promise<DiscoveredHost | null> {
    if (this.options.discover) return this.options.discover();
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core');
      const connection = await invoke<HostConnectionOptions & { token?: string }>('ensure_host');
      const checked = validateHostUrl(connection.url);
      if (!checked.ok || !checked.url) throw new Error('桌面端 Host 地址无效');
      const auth: HostAuth = connection.auth ?? (connection.token ? { kind: 'bearer', token: connection.token } : { kind: 'session' });
      return { target: { url: checked.url, label: targetLabel(checked.url, 'desktop'), source: 'desktop' }, auth };
    }
    const explicit = (globalThis as typeof globalThis & { __FLYCUT_HOST__?: HostConnectionOptions & { token?: string } }).__FLYCUT_HOST__;
    if (explicit) {
      const checked = validateHostUrl(explicit.url);
      if (!checked.ok || !checked.url) throw new Error('window.__FLYCUT_HOST__ 地址无效');
      const source: ConnectionSource = checked.url === window.location.origin ? 'same-origin' : 'self-hosted';
      const auth: HostAuth = explicit.auth ?? (explicit.token ? { kind: 'bearer', token: explicit.token } : { kind: 'session' });
      return { target: { url: checked.url, label: targetLabel(checked.url, source), source }, auth };
    }
    if (this.options.cloudAdapter?.available()) {
      const restored = await this.options.cloudAdapter.restore().catch(() => null);
      if (restored) return cloudDiscovered(restored);
    }
    try { return await fetchBootstrap(window.location.origin, 'same-origin'); }
    catch (error) {
      if (error instanceof HostRequestError || error instanceof IncompatibleHostError) return null;
      return null;
    }
  }

  private async bootstrap() {
    const generation = ++this.generation;
    try {
      const discovered = await this.discover();
      if (generation !== this.generation || this.stopped) return;
      if (!discovered) { this.set({ phase: 'config', attempt: 0 }); return; }
      await this.connectDiscovered(discovered, 'initial', generation);
    } catch (error) {
      if (generation !== this.generation || this.stopped) return;
      this.set({ phase: 'config', attempt: 0, error: this.connectionError(error) });
    }
  }

  private connectionError(error: unknown): ConnectionError {
    if (error instanceof HostRequestError) {
      return { code: error.code === 'rate-limited' ? 'rate-limited' : error.code === 'server-error' ? 'server-error' : error.code,
        message: error.message, status: error.status, retryAfterMs: error.retryAfterMs };
    }
    if (error instanceof IncompatibleHostError) return { code: 'protocol', message: error.message };
    return { code: 'unreachable', message: error instanceof Error ? error.message : String(error) };
  }

  private createTransport(discovered: DiscoveredHost): SessionTransport {
    const options: HostConnectionOptions = { url: discovered.target.url, auth: discovered.auth };
    return this.options.transportFactory ? this.options.transportFactory(options) : asTransport(new HostConnection(options));
  }

  private async handshake(transport: SessionTransport, discovered: DiscoveredHost) {
    const info = await transport.call('host.info') as HostInfo;
    if (!info || typeof info.protocolVersion !== 'number') throw new IncompatibleHostError('Host did not return host.info');
    if (info.protocolVersion !== PROTOCOL_VERSION) throw new IncompatibleHostError(`Host protocol version ${info.protocolVersion} is not supported`);
    if (info.capabilities?.projects !== true) throw new IncompatibleHostError('Host does not provide projects');
    if (discovered.auth.kind === 'session' && info.capabilities?.browserSession !== true) {
      throw new IncompatibleHostError('Host does not support browser sessions');
    }
    if (discovered.auth.kind === 'session' && info.capabilities?.cookieMedia !== true) {
      throw new IncompatibleHostError('Host does not support cookie media');
    }
    // Recovery copies still read projects.identity through ProjectService. A slow identity read
    // must not block the editor from opening: fall back to the generation for display/change
    // detection and let the project service surface recovery-unavailable if identity fails.
    const identityResult = await Promise.race([
      transport.call('projects.identity'),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 500)),
    ]) as { hostId?: unknown } | null;
    const identityVerified = !!identityResult && typeof identityResult.hostId === 'string' && !!identityResult.hostId;
    const hostId = identityVerified ? identityResult!.hostId as string : info.generation;
    await transport.waitForJobsSnapshot(10_000);
    const identity: ConnectionIdentity = {
      hostId,
      identityVerified,
      protocolVersion: info.protocolVersion,
      generation: info.generation,
      clientGeneration: crypto.randomUUID(),
      subjectId: discovered.subject?.id,
      subjectLabel: discovered.subject?.label,
    };
    return { info, identity };
  }

  private attach(transport: SessionTransport) {
    this.syncTransport(transport);
    const off = transport.subscribe(() => {
      if (this.active !== transport) return;
      if (transport.snapshot() === 'disconnected' && this.state.phase === 'connected') this.beginReconnect();
    });
    this.disposers.push(off);
  }

  private async connectDiscovered(discovered: DiscoveredHost, mode: 'initial' | 'switch', generation: number) {
    const transport = this.createTransport(discovered);
    this.pending = undefined;
    if (mode === 'initial') this.set({ phase: 'connecting', target: discovered.target, attempt: 0, error: undefined, sessionExpiresAt: discovered.expiresAt });
    try {
      await transport.open();
      const { info, identity } = await this.handshake(transport, discovered);
      if (generation !== this.generation || this.stopped) { transport.close(); return false; }
      if (mode === 'switch') {
        const before = await this.hooks?.beforeSwitch?.();
        if (before === false) { transport.close(); this.restoreActiveSnapshot(); return false; }
        const previous = this.activeInfo?.identity.hostId;
        if (previous && previous !== identity.hostId) this.options.location?.assign('#/projects');
      }
      this.commit(transport, discovered, identity, info);
      this.rememberTarget(discovered.target.url);
      return true;
    } catch (error) {
      transport.close();
      if (generation === this.generation && !this.stopped) {
        const snapshotError = this.connectionError(error);
        if (snapshotError.code === 'protocol') this.set({ phase: 'incompatible', target: discovered.target, error: snapshotError, attempt: 0 });
        else if (snapshotError.code === 'auth-expired') this.set({ phase: 'auth-expired', target: discovered.target, error: snapshotError, attempt: 0 });
        else if (snapshotError.code === 'access-denied') this.set({ phase: 'access-denied', target: discovered.target, error: snapshotError, attempt: 0 });
        else this.set({ phase: 'unreachable', target: discovered.target, error: snapshotError, attempt: 0 });
      }
      return false;
    }
  }

  private commit(transport: SessionTransport, discovered: DiscoveredHost, identity: ConnectionIdentity, info: HostInfo) {
    this.clearReconnectTimer();
    this.active = transport;
    this.activeInfo = { discovered, identity, info };
    this.pending = undefined;
    this.attach(transport);
    transport.setSessionExpiry(discovered.expiresAt);
    this.runtimeKey = crypto.randomUUID();
    this.set({ phase: 'connected', target: discovered.target, identity, capabilities: info.capabilities ?? {}, attempt: 0,
      nextRetryAt: undefined, error: undefined, sessionExpiresAt: discovered.expiresAt, runtimeKey: this.runtimeKey });
  }

  private restoreActiveSnapshot() {
    const active = this.activeInfo;
    if (!active) { this.set({ phase: 'connected', attempt: 0, nextRetryAt: undefined }); return; }
    this.set({ phase: 'connected', target: active.discovered.target, identity: active.identity, capabilities: active.info.capabilities ?? {},
      attempt: 0, nextRetryAt: undefined, error: undefined, sessionExpiresAt: active.discovered.expiresAt });
  }

  async connectTo(input: string): Promise<boolean> {
    const checked = validateHostUrl(input);
    if (!checked.ok || !checked.url) {
      this.set({ phase: 'config', attempt: 0, error: { code: 'invalid-address', message: checked.error ?? 'Invalid connection address' } });
      return false;
    }
    const generation = ++this.generation;
    this.set({ phase: 'connecting', attempt: 0, error: undefined });
    try {
      const discovered = await fetchBootstrap(checked.url, sourceFor(checked.url));
      if (generation !== this.generation) return false;
      this.set({ target: discovered.target });
      return await this.connectDiscovered(discovered, 'initial', generation);
    } catch (error) {
      if (generation === this.generation) {
        const snapshotError = this.connectionError(error);
        this.set({ phase: snapshotError.code === 'protocol' ? 'incompatible' : 'unreachable', attempt: 0, error: snapshotError,
          target: { url: checked.url, label: targetLabel(checked.url, sourceFor(checked.url)), source: sourceFor(checked.url) } });
      }
      return false;
    }
  }

  async switchHost(input: string): Promise<boolean> {
    const checked = validateHostUrl(input);
    if (!checked.ok || !checked.url) {
      this.set({ phase: 'config', attempt: 0, error: { code: 'invalid-address', message: checked.error ?? 'Invalid connection address' } });
      return false;
    }
    if (!this.active) return this.connectTo(checked.url);
    const generation = ++this.generation;
    const previous = this.activeInfo;
    this.set({ phase: 'switching', attempt: 0, nextRetryAt: undefined, error: undefined });
    try {
      const discovered = await fetchBootstrap(checked.url, sourceFor(checked.url));
      if (generation !== this.generation) return false;
      const candidate = this.createTransport(discovered);
      this.pending = { transport: candidate, discovered, identity: previous!.identity, info: previous!.info };
      await candidate.open();
      const { info, identity } = await this.handshake(candidate, discovered);
      if (generation !== this.generation || this.stopped) { candidate.close(); return false; }
      const before = await this.hooks?.beforeSwitch?.();
      if (before === false) { candidate.close(); this.pending = undefined; this.restoreActiveSnapshot(); return false; }
      if (identity.hostId !== previous!.identity.hostId) this.options.location?.assign('#/projects');
      this.active?.close();
      this.commit(candidate, discovered, identity, info);
      this.rememberTarget(discovered.target.url);
      return true;
    } catch (error) {
      this.pending?.transport.close(); this.pending = undefined;
      if (generation === this.generation) {
        const snapshotError = this.connectionError(error);
        this.restoreActiveSnapshot();
        this.set({ error: { ...snapshotError, code: 'switch-failed', message: snapshotError.message } });
      }
      return false;
    }
  }

  cancel() {
    this.generation += 1;
    this.clearReconnectTimer();
    this.pending?.transport.close(); this.pending = undefined;
    if (this.active && this.activeInfo) {
      this.restoreActiveSnapshot();
      return;
    }
    this.set({ phase: 'config', attempt: 0, nextRetryAt: undefined, error: { code: 'cancelled', message: 'Connection cancelled' } });
  }

  private clearReconnectTimer() { this.clearTimer(this.reconnectTimer); this.reconnectTimer = undefined; }

  private beginReconnect() {
    if (!this.activeInfo) return;
    this.reconnectAttempt = 0;
    this.set({ phase: 'reconnecting', attempt: 0, nextRetryAt: undefined, error: undefined });
    this.scheduleReconnect(0);
  }

  private scheduleReconnect(delay?: number) {
    this.clearReconnectTimer();
    if (this.stopped) return;
    if (this.reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
      this.set({ phase: 'unreachable', attempt: this.reconnectAttempt, nextRetryAt: undefined,
        error: this.state.error ?? { code: 'unreachable', message: 'Cannot connect to Host' } });
      return;
    }
    const wait = delay ?? reconnectDelay(this.reconnectAttempt, () => this.random());
    const nextRetryAt = this.now() + wait;
    this.set({ phase: 'reconnecting', nextRetryAt });
    this.reconnectTimer = this.setTimer(() => { this.reconnectTimer = undefined; void this.attemptReconnect(); }, wait);
  }

  private async attemptReconnect() {
    const active = this.active;
    if (!active || !this.activeInfo || this.state.phase !== 'reconnecting') return;
    const generation = ++this.generation;
    this.reconnectAttempt += 1;
    this.set({ attempt: this.reconnectAttempt, nextRetryAt: undefined, error: undefined });
    try {
      await active.open();
      const handshake = await this.handshake(active, this.activeInfo.discovered);
      const { info } = handshake;
      if (generation !== this.generation || this.stopped) return;
      const previous = this.activeInfo.identity;
      const previousHostId = previous.hostId;
      // A generation fallback is not an identity: only two verified hostIds can prove a different Host.
      // Otherwise keep the previous id and let ProjectService.resumeAfterReconnect re-read projects.identity.
      const comparable = previous.identityVerified !== false && handshake.identity.identityVerified !== false;
      const identity = handshake.identity.identityVerified !== false ? handshake.identity
        : { ...handshake.identity, hostId: previousHostId, identityVerified: previous.identityVerified };
      const changed = comparable && identity.hostId !== previousHostId;
      this.activeInfo = { ...this.activeInfo, info, identity };
      active.setSessionExpiry(this.activeInfo.discovered.expiresAt);
      this.reconnectAttempt = 0;
      if (changed) {
        this.hooks?.onIdentityChanged?.(previousHostId, identity.hostId);
        this.set({ phase: 'connected', identity, capabilities: info.capabilities ?? {}, attempt: 0, nextRetryAt: undefined, error: undefined,
          identityChanged: { previousHostId, hostId: identity.hostId } });
      } else {
        this.hooks?.onReconnected?.(identity.hostId);
        this.set({ phase: 'connected', identity, capabilities: info.capabilities ?? {}, attempt: 0, nextRetryAt: undefined, error: undefined });
      }
    } catch (error) {
      if (generation !== this.generation || this.stopped) return;
      const snapshotError = this.connectionError(error);
      if (snapshotError.code === 'auth-expired' || snapshotError.code === 'access-denied' || snapshotError.code === 'protocol') {
        this.hooks?.onSessionEnded?.();
        this.set({ phase: snapshotError.code === 'protocol' ? 'incompatible' : snapshotError.code, attempt: this.reconnectAttempt, error: snapshotError });
        return;
      }
      this.set({ error: snapshotError });
      if (this.reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
        this.set({ phase: 'unreachable', nextRetryAt: undefined });
        return;
      }
      const retry = snapshotError.retryAfterMs;
      this.scheduleReconnect(retry !== undefined ? Math.max(retry, reconnectDelay(this.reconnectAttempt, () => this.random())) : undefined);
    }
  }

  async retry(): Promise<void> {
    if (this.state.phase === 'auth-expired') {
      const auth = await this.refreshSession();
      if (!auth) return;
    }
    if (this.active && this.activeInfo) {
      this.clearReconnectTimer();
      this.reconnectAttempt = 0;
      this.set({ phase: 'reconnecting', attempt: 0, nextRetryAt: undefined, error: undefined });
      this.scheduleReconnect(0);
      return;
    }
    const target = this.state.target?.url ?? this.readTarget();
    if (target) await this.connectTo(target);
    else this.set({ phase: 'config', attempt: 0 });
  }

  /** 单飞刷新。Cloud 适配器优先；自部署会话重新走同源 bootstrap。 */
  private refreshSession(): Promise<HostAuth | null> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const discovered = this.activeInfo?.discovered;
      if (!discovered) return null;
      try {
        if (this.options.cloudAdapter?.available()) {
          const result = await this.options.cloudAdapter.refresh();
          if (result === 'expired') { void this.handleSessionError(new HostRequestError(401)); return null; }
          if (result === 'denied') { void this.handleSessionError(new HostRequestError(403)); return null; }
          const next = cloudDiscovered(result);
          this.activeInfo = { ...this.activeInfo!, discovered: next };
          return next.auth;
        }
        if (discovered.auth.kind === 'session') {
          const next = await fetchBootstrap(discovered.target.url, discovered.target.source);
          this.activeInfo = { ...this.activeInfo!, discovered: next };
          this.set({ sessionExpiresAt: next.expiresAt, error: undefined });
          return next.auth;
        }
        return null;
      } catch { return null; }
    })().finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  async logout(): Promise<void> {
    if (this.state.phase === 'signed-out' && this.pendingRemoteLogout) return this.retryLogout();
    if (this.state.phase === 'signed-out') return;
    if (this.state.phase === 'signing-out') return;
    const before = await this.hooks?.beforeLogout?.();
    if (before === false) return;
    this.set({ phase: 'signing-out', nextRetryAt: undefined, error: undefined, logoutError: undefined });
    this.clearReconnectTimer();
    const remote = this.buildRemoteLogout();
    let failure: string | undefined;
    if (remote) {
      try { await remote(); } catch (error) { failure = error instanceof Error ? error.message : String(error); }
    }
    this.pendingRemoteLogout = failure ? remote : undefined;
    this.hooks?.onSessionEnded?.();
    this.active?.close(); this.active = undefined; this.activeInfo = undefined; this.pending = undefined;
    this.runtimeKey = undefined;
    this.set({ phase: 'signed-out', attempt: 0, identity: undefined, capabilities: undefined, target: undefined, sessionExpiresAt: undefined,
      logoutError: failure });
  }

  async retryLogout(): Promise<void> {
    const remote = this.pendingRemoteLogout;
    if (!remote) return;
    this.set({ logoutError: undefined });
    try { await remote(); this.pendingRemoteLogout = undefined; this.set({ logoutError: undefined }); }
    catch (error) { this.set({ logoutError: error instanceof Error ? error.message : String(error) }); }
  }

  private buildRemoteLogout(): (() => Promise<void>) | undefined {
    const discovered = this.activeInfo?.discovered;
    if (!discovered) return undefined;
    if (this.options.cloudAdapter?.available()) return () => this.options.cloudAdapter!.logout();
    if (discovered.auth.kind !== 'session') return undefined;
    return async () => {
      const response = await fetch(`${discovered.target.url}/session`, { method: 'DELETE', credentials: 'include',
        headers: discovered.auth.kind === 'session' && discovered.auth.csrf ? { 'X-Flycut-CSRF': discovered.auth.csrf } : {},
        signal: AbortSignal.timeout(10_000) });
      if (!response.ok && response.status !== 401) throw new HostRequestError(response.status);
    };
  }

  dismissIdentityChange() { this.set({ identityChanged: undefined }); }
}

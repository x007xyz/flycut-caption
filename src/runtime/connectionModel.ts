// F-0014：连接层的数据契约和纯逻辑。这里不依赖 React、DOM 或 Host，方便单元测试；
// 网络和状态机分别在 connection.ts / HostSessionController.ts。

export type ConnectionSource = 'cloud' | 'self-hosted' | 'desktop' | 'same-origin';

export type ConnectionPhase =
  | 'boot'
  | 'config'
  | 'validating'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'auth-expired'
  | 'access-denied'
  | 'unreachable'
  | 'switching'
  | 'signing-out'
  | 'signed-out'
  | 'incompatible';

export type ConnectionErrorCode =
  | 'invalid-address'
  | 'auth-expired'
  | 'access-denied'
  | 'unreachable'
  | 'rate-limited'
  | 'server-error'
  | 'request'
  | 'protocol'
  | 'cancelled'
  | 'switch-failed'
  | 'logout-failed';

export interface ConnectionTarget {
  /** 已规范化的 origin，不带末尾斜杠 */
  url: string;
  label: string;
  source: ConnectionSource;
}

export interface ConnectionIdentity {
  hostId: string;
  /** false: projects.identity did not answer in time and hostId is the generation fallback, not a real identity. */
  identityVerified?: boolean;
  protocolVersion: number;
  generation: string;
  subjectId?: string;
  subjectLabel?: string;
  /** 同一次连接生命周期内递增，用于丢弃迟到的异步结果 */
  clientGeneration: string;
}

export interface ConnectionError {
  code: ConnectionErrorCode;
  message: string;
  /** HTTP 状态码（有的话） */
  status?: number;
  /** 429 / Retry-After 提示 */
  retryAfterMs?: number;
}

export interface ConnectionSnapshot {
  phase: ConnectionPhase;
  target?: ConnectionTarget;
  identity?: ConnectionIdentity;
  capabilities?: Record<string, boolean>;
  attempt: number;
  nextRetryAt?: number;
  error?: ConnectionError;
  /** 会话到期时间（Cloud 或自部署会话提供时） */
  sessionExpiresAt?: string;
  /** 每次提交新运行时递增；ConnectionGate 用它重挂载 ClientRuntime */
  runtimeKey?: string;
  /** 同一地址重连后 hostId 变化时显示一次提示 */
  identityChanged?: { previousHostId: string; hostId: string };
  /** 最近一次切换/登出的远端失败提示 */
  logoutError?: string;
}

export type HostAuth =
  | { kind: 'bearer'; token: string }
  | { kind: 'session'; csrf?: string };

export interface HostConnectionOptions {
  url: string;
  auth: HostAuth;
}

export interface CloudSubject {
  id: string;
  label?: string;
  expiresAt?: string;
}

export interface CloudBootstrap {
  hostUrl: string;
  /** 由 Cloud 契约决定：同源 HttpOnly Cookie，或短期 JWT。 */
  auth: { kind: 'cookie' } | { kind: 'bearer'; token: string };
  /** Host 需要 CSRF 时由 Cloud 适配器带回；只在内存中使用。 */
  csrf?: string;
  subject: CloudSubject;
}

/**
 * 唯一需要真实 Cloud 契约的接缝。本需求不提供具体实现；
 * 没有适配器时 UI 不显示可点击的 Cloud 登录入口，也不把测试替身当作 Cloud 验收。
 */
export interface CloudSessionAdapter {
  readonly kind: 'cloud';
  /** 仅供 UI 判断是否显示入口；不是 Host 可达证明。 */
  available(): boolean;
  beginSignIn(): Promise<CloudBootstrap | null>;
  restore(): Promise<CloudBootstrap | null>;
  refresh(): Promise<CloudBootstrap | 'expired' | 'denied'>;
  logout(): Promise<void>;
  describe(): CloudSubject | null;
}

export interface DiscoveredHost {
  target: ConnectionTarget;
  auth: HostAuth;
  csrf?: string;
  expiresAt?: string;
  subject?: CloudSubject;
  /** 自部署会话刷新时用；Cloud 适配器优先 */
  adapter?: CloudSessionAdapter;
}

/** ConnectionGate 提供给 Kit 内部的会话服务；实现是 HostSessionController。 */
export interface HostSessionService {
  snapshot(): ConnectionSnapshot;
  subscribe(listener: () => void): () => void;
  switchHost(url: string): Promise<boolean>;
  logout(): Promise<void>;
  retryLogout(): Promise<void>;
  retry(): Promise<void>;
  cancel(): void;
  dismissIdentityChange(): void;
  cloudAvailable(): boolean;
  lastTargetUrl(): string | undefined;
  readonly selfHostingUrl: string;
}

/** 只读方法白名单：重连恢复只允许重放这些请求，副作用请求永不自动重发。 */
export const READ_ONLY_RPC_METHODS = new Set<string>([
  'host.info',
  'uploads.capabilities',
  'jobs.get',
  'jobs.list',
  'projects.list',
  'projects.open',
  'projects.identity',
  'projects.detail',
  'projects.trashList',
  'projects.thumbnail',
  'projects.backupPreview',
  'projects.getTerminology',
  'projects.getStylePresets',
  'voices.list',
  'speakers.analyze',
  'separation.analyze',
  'reframe.analyze',
  'dubbing.mix',
  'clips.suggest',
  'clips.copy',
  'clips.batchStatus',
  'projects.suggestions.list',
  'providers.list',
  'providers.models',
  'tts.getSettings',
  'endpoints.list',
  'cloud.status',
  'editing.list',
  'agent.tools',
  'plugins.list',
]);

export const isReadOnlyRpc = (method: string) => READ_ONLY_RPC_METHODS.has(method);

/** 500ms → 1s → 2s → 4s → 8s → 15s → 30s，每档 ±20% 抖动。 */
export const RECONNECT_BASE_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;
export const RECONNECT_MAX_ATTEMPTS = RECONNECT_BASE_DELAYS_MS.length;

export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const base = RECONNECT_BASE_DELAYS_MS[Math.min(Math.max(attempt, 0), RECONNECT_BASE_DELAYS_MS.length - 1)];
  const jitter = 1 + (random() * 2 - 1) * 0.2;
  return Math.max(0, Math.round(base * jitter));
}

export type HttpErrorClass = 'auth-expired' | 'access-denied' | 'rate-limited' | 'server-error' | 'request';

export function classifyHttpStatus(status: number): HttpErrorClass {
  if (status === 401) return 'auth-expired';
  if (status === 403) return 'access-denied';
  if (status === 429) return 'rate-limited';
  if (status >= 500 && status <= 599) return 'server-error';
  return 'request';
}

export interface HostUrlResult {
  ok: boolean;
  /** 成功时是规范化 origin */
  url?: string;
  error?: string;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * 只接受 https origin；http 只允许本机回环。拒绝账号密码、查询参数、片段和路径，
 * 避免把凭证或路由参数带进日志。非法地址在本地失败，调用方不得发起任何请求。
 */
export function validateHostUrl(input: string): HostUrlResult {
  const value = input.trim();
  if (!value) return { ok: false, error: 'empty' };
  let parsed: URL;
  try { parsed = new URL(value); } catch { return { ok: false, error: 'syntax' }; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { ok: false, error: 'protocol' };
  if (parsed.protocol === 'http:' && !LOOPBACK_HOSTS.has(parsed.hostname)) return { ok: false, error: 'insecure' };
  if (parsed.username || parsed.password) return { ok: false, error: 'credentials' };
  if (parsed.search || parsed.hash) return { ok: false, error: 'query' };
  if (parsed.pathname !== '/' && parsed.pathname !== '') return { ok: false, error: 'path' };
  return { ok: true, url: parsed.origin };
}

export function targetLabel(url: string, source: ConnectionSource): string {
  if (source === 'desktop') return 'This computer';
  if (source === 'same-origin') return 'This page';
  try { return new URL(url).host; } catch { return url; }
}

/** 兼容旧版 Host 的 Bootstrap 响应：只给 token 时转成 bearer；不把它当作新 Host 的浏览器会话。 */
export function legacyBootstrap(value: unknown): { auth: HostAuth } | null {
  if (!value || typeof value !== 'object') return null;
  const token = (value as { token?: unknown }).token;
  return typeof token === 'string' && token ? { auth: { kind: 'bearer', token } } : null;
}

/** 把 `Authorization` / `Cookie` / CSRF / URL 查询参数等敏感内容从日志文本里去掉。 */
export function redactSecrets(text: string): string {
  return text
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[redacted]')
    .replace(/((?:set-)?cookie\s*[:=]\s*)[^\n]+/gi, '$1[redacted]')
    .replace(/(x-flycut-csrf\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/([?&](?:token|bootstrap)=)[^&\s]+/gi, '$1[redacted]');
}

export const SELF_HOSTING_DOC_URL = 'https://github.com/x007xyz/flycut-caption/blob/main/docs/remote-host-self-hosting.md';

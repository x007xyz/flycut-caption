import type { CloudBootstrap, CloudSessionAdapter, CloudSubject } from './connectionModel';

interface CloudBootstrapBody {
  url?: string;
  token?: string;
  auth?: 'session' | 'cookie' | { kind: 'session' | 'bearer'; token?: string; csrf?: string };
  csrf?: string;
  expiresAt?: string;
}

export interface CurrentBackendCloudAdapterOptions {
  /** Defaults to window.__FLYCUT_CLOUD_URL__, then the page origin. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

declare global {
  interface Window { __FLYCUT_CLOUD_URL__?: string }
}

function originOf(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return undefined;
    return url.origin;
  } catch { return undefined; }
}

/**
 * F-0014: the current Host backend is the Cloud contract. It exposes the same
 * /__flycut/connection bootstrap and /session cookie lifecycle that a future
 * FlyCut Cloud deployment will expose. No invented endpoints, no mock fallback.
 */
export function createCurrentBackendCloudAdapter(options: CurrentBackendCloudAdapterOptions = {}): CloudSessionAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  let subject: CloudSubject | null = null;
  let csrf: string | undefined;
  const endpoint = () => {
    const configured = options.baseUrl
      ?? (typeof window !== 'undefined' ? window.__FLYCUT_CLOUD_URL__ : undefined)
      ?? (typeof window !== 'undefined' ? window.location.origin : undefined);
    return configured ? originOf(configured) : undefined;
  };

  const bootstrap = async (): Promise<CloudBootstrap | null> => {
    const base = endpoint();
    if (!base) return null;
    const response = await fetchImpl(`${base}/__flycut/connection`, { credentials: 'include', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const body = await response.json() as CloudBootstrapBody;
    const nextCsrf = typeof body.csrf === 'string' ? body.csrf : undefined;
    const hostUrl = body.url ? originOf(body.url) : base;
    if (!hostUrl) return null;
    csrf = nextCsrf;
    subject = { id: `current-backend:${hostUrl}`, label: 'FlyCut Cloud', expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : undefined };
    if (body.token) return { hostUrl, auth: { kind: 'bearer', token: body.token }, subject };
    if (body.auth && typeof body.auth === 'object' && body.auth.kind === 'bearer' && body.auth.token) {
      return { hostUrl, auth: { kind: 'bearer', token: body.auth.token }, csrf: nextCsrf, subject };
    }
    return { hostUrl, auth: { kind: 'cookie' }, csrf: nextCsrf, subject };
  };

  return {
    kind: 'cloud',
    available: () => !!endpoint(),
    beginSignIn: bootstrap,
    restore: bootstrap,
    async refresh() {
      try {
        const result = await bootstrap();
        return result ?? ('expired' as const);
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 401) return 'expired';
        if (status === 403) return 'denied';
        throw error;
      }
    },
    async logout() {
      const base = endpoint();
      if (!base) return;
      const response = await fetchImpl(`${base}/session`, { method: 'DELETE', credentials: 'include',
        headers: csrf ? { 'X-Flycut-CSRF': csrf } : {} });
      if (!response.ok) throw new Error(`Cloud logout failed: HTTP ${response.status}`);
      subject = null; csrf = undefined;
    },
    describe: () => subject,
  };
}

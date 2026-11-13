export type HostErrorCode =
  | 'RPC_ERROR'
  | 'AUTH_FAILED'
  | 'NO_HOST_CONNECTION'
  | 'CONFIRMATION_REQUIRED'
  | 'CONFIRMATION_REJECTED'
  | 'CONFIRMATION_NOT_APPROVED'
  | 'CONFIRMATION_ALREADY_CONSUMED'
  | 'CONFIRMATION_EXPIRED'
  | 'INVALID_ARGUMENT'
  | 'INVALID_ID'
  | 'NOT_FOUND'
  | 'PROJECT_TRASHED'
  | 'MEDIA_MISSING'
  | 'MODEL_REQUIRED'
  | 'MODEL_NOT_READY'
  | 'AI_CONFIG_NOT_READY'
  | 'VERSION_CONFLICT'
  | 'JOB_FAILED'
  | 'JOB_CANCELLED'
  | 'INTERRUPTED'
  | 'CONTENT_CHANGED'
  | 'BACKUP_INVALID'
  | 'INSUFFICIENT_SPACE'
  | 'MISSING_MEDIA';

export class HostRpcError extends Error {
  readonly code: HostErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: HostErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'HostRpcError';
    this.code = code;
    this.details = details;
  }
}

/** Scrubs Bearer tokens, sk-* keys, and explicit known secret strings before printing or returning errors. */
export function redactSecrets(input: string, secrets: Iterable<string> = []): string {
  let text = input
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]')
    .replace(/([?&]token=)[^&\s]+/gi, '$1[REDACTED]');
  for (const secret of secrets) {
    if (secret && secret.length >= 4) {
      text = text.split(secret).join('[REDACTED]');
    }
  }
  return text;
}

export function asRpcErrorPayload(error: unknown): { code: string; message: string; details: Record<string, unknown> } {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = redactSecrets(rawMessage);
  if (error instanceof HostRpcError) {
    return { code: error.code, message, details: error.details };
  }
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; details?: unknown };
    if (typeof candidate.code === 'string' && candidate.code.length > 0 && candidate.code.length <= 64) {
      const details = candidate.details && typeof candidate.details === 'object' && !Array.isArray(candidate.details)
        ? candidate.details as Record<string, unknown>
        : {};
      return { code: candidate.code, message, details };
    }
  }
  return { code: 'RPC_ERROR', message, details: {} };
}

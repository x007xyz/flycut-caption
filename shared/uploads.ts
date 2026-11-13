import { z } from 'zod';

/** F-0015: one upload session protocol shared by the browser client and the Host. */
export const UPLOAD_PROTOCOL_VERSION = 1;
export const DEFAULT_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
export const DEFAULT_UPLOAD_MAX_BYTES = 4 * 1024 * 1024 * 1024;
export const DEFAULT_UPLOAD_SESSION_TTL_HOURS = 24;
export const DEFAULT_UPLOAD_DISK_RESERVE_BYTES = 256 * 1024 * 1024;

export const UPLOAD_MIME_TYPES = [
  'video/mp4', 'video/webm', 'video/quicktime', 'video/ogg',
  'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/mp4', 'audio/x-m4a',
] as const;

const MIME_BY_EXTENSION: Record<string, string> = {
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg', ogg: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
};

/** Returns the canonical media MIME, accepting a known extension when the browser leaves MIME empty. */
export function canonicalUploadMime(mimeType: string, fileName: string): string | undefined {
  const mime = mimeType.trim().toLowerCase();
  if ((UPLOAD_MIME_TYPES as readonly string[]).includes(mime)) {
    return mime === 'audio/mp3' ? 'audio/mpeg' : mime === 'audio/x-wav' ? 'audio/wav' : mime === 'audio/x-m4a' ? 'audio/mp4' : mime;
  }
  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXTENSION[extension];
}

export interface UploadCapabilities {
  protocolVersion: number;
  chunkSize: number;
  maxBytes: number;
  maxChunks: number;
  sessionTtlHours: number;
  allowedMimeTypes: string[];
}

export type UploadSessionState = 'active' | 'finalizing' | 'complete' | 'cancelled' | 'expired';

export interface UploadChunkConfirmation {
  index: number;
  offset: number;
  size: number;
  sha256: string;
}

export interface UploadSession {
  id: string;
  fileName: string;
  size: number;
  mimeType: string;
  sha256: string;
  chunkSize: number;
  chunkCount: number;
  chunks: UploadChunkConfirmation[];
  uploadedBytes: number;
  state: UploadSessionState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  assetId?: string;
}

export interface UploadCreateInput {
  fileName: string;
  size: number;
  mimeType: string;
  sha256: string;
  idempotencyKey: string;
}

export interface UploadCompleteInput { sha256: string }

export type UploadErrorCode =
  | 'unsupported-media-type'
  | 'too-large'
  | 'insufficient-storage'
  | 'invalid-session'
  | 'chunk-conflict'
  | 'operation-conflict'
  | 'invalid-offset'
  | 'integrity-mismatch'
  | 'incomplete'
  | 'expired'
  | 'cancelled'
  | 'already-complete'
  | 'finalizing'
  | 'forbidden';

export interface UploadErrorBody { error: { code: UploadErrorCode; message: string } }

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/i, 'Expected a SHA-256 hex digest');

export const uploadCreateInputSchema = z.strictObject({
  fileName: z.string().trim().min(1).max(260),
  size: z.number().int().positive(),
  mimeType: z.string().max(200),
  sha256: sha256Schema,
  idempotencyKey: z.uuid(),
});
export const uploadCompleteInputSchema = z.strictObject({ sha256: sha256Schema });
export const uploadSessionIdSchema = z.uuid();
export const uploadChunkConfirmationSchema = z.object({ index: z.number().int().min(0), offset: z.number().int().min(0),
  size: z.number().int().positive(), sha256: sha256Schema });
export const uploadSessionSchema = z.object({
  id: z.uuid(), fileName: z.string().min(1).max(260), size: z.number().int().positive(), mimeType: z.string(), sha256: sha256Schema,
  chunkSize: z.number().int().positive(), chunkCount: z.number().int().positive(), chunks: z.array(uploadChunkConfirmationSchema),
  uploadedBytes: z.number().int().min(0), state: z.enum(['active', 'finalizing', 'complete', 'cancelled', 'expired']),
  createdAt: z.string(), updatedAt: z.string(), expiresAt: z.string(), assetId: z.uuid().optional(),
});

export function uploadChunkCount(size: number, chunkSize: number): number {
  if (!Number.isSafeInteger(size) || size <= 0 || !Number.isSafeInteger(chunkSize) || chunkSize <= 0) return 0;
  return Math.ceil(size / chunkSize);
}

export function uploadChunkRange(index: number, size: number, chunkSize: number): { start: number; end: number; length: number } | null {
  const count = uploadChunkCount(size, chunkSize);
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) return null;
  const start = index * chunkSize;
  const end = Math.min(size, start + chunkSize);
  return { start, end, length: end - start };
}

export function uploadProgress(session: Pick<UploadSession, 'uploadedBytes' | 'size' | 'state'>): number {
  if (session.state === 'complete') return 1;
  if (!Number.isFinite(session.size) || session.size <= 0) return 0;
  return Math.max(0, Math.min(1, session.uploadedBytes / session.size));
}

export function uploadSessionExpired(session: Pick<UploadSession, 'expiresAt'>, now = Date.now()): boolean {
  const expiry = Date.parse(session.expiresAt);
  return !Number.isFinite(expiry) || expiry <= now;
}

/** A media header check performed after all chunks are assembled; this is not a MIME trust boundary. */
export function looksLikeSupportedMedia(head: Uint8Array): boolean {
  const ascii = (start: number, length: number) => String.fromCharCode(...head.slice(start, start + length));
  if (head.length >= 12 && ascii(4, 4) === 'ftyp') return true;
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return true;
  if (head.length >= 4 && ascii(0, 4) === 'OggS') return true;
  if (head.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return true;
  if (head.length >= 3 && ascii(0, 3) === 'ID3') return true;
  return head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0;
}

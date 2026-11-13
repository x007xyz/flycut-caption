import type { RemoteConnection } from '@/runtime/connection';
import { canonicalUploadMime, uploadChunkRange, type UploadCapabilities, type UploadSession } from '../../shared/uploads';
import { hashBytes } from './sha256';

export class UploadPausedError extends Error {
  constructor() { super('Upload paused'); this.name = 'UploadPausedError'; }
}

export function validateUploadSelection(file: Blob & { name?: string; type?: string }, capabilities: UploadCapabilities): { mimeType: string } | { error: string } {
  const mimeType = canonicalUploadMime(file.type ?? '', file.name ?? '');
  if (!mimeType || !capabilities.allowedMimeTypes.includes(mimeType)) return { error: 'unsupported-media-type' };
  if (file.size <= 0) return { error: 'too-large' };
  if (file.size > capabilities.maxBytes) return { error: 'too-large' };
  return { mimeType };
}

export interface UploadTransferCallbacks {
  signal: AbortSignal;
  onSession?: (session: UploadSession) => void;
}

/** Uploads only chunks the Host has not confirmed. Every retry starts from a fresh GET by the caller. */
export async function transferMissingChunks(connection: RemoteConnection, file: Blob, initial: UploadSession,
  callbacks: UploadTransferCallbacks): Promise<UploadSession> {
  let session = initial;
  if (session.state === 'complete') return session;
  const missing = () => {
    const confirmed = new Set(session.chunks.map(chunk => chunk.index));
    return Array.from({ length: session.chunkCount }, (_, index) => index).filter(index => !confirmed.has(index));
  };
  for (const index of missing()) {
    callbacks.signal.throwIfAborted();
    const range = uploadChunkRange(index, session.size, session.chunkSize);
    if (!range) throw new Error('Invalid upload chunk range');
    const chunk = file.slice(range.start, range.end);
    const digest = await hashBytes(new Uint8Array(await chunk.arrayBuffer()));
    callbacks.signal.throwIfAborted();
    session = await connection.putUploadChunk(session.id, index, chunk, range.start, digest, callbacks.signal);
    callbacks.onSession?.(session);
  }
  if (missing().length) throw new Error('Upload session still has missing chunks');
  return session;
}

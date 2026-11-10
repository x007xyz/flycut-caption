import type { Context } from '@deepseek-ai/cordis';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { mkdir, open, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HttpRouteAuth } from './rpc';
import {
  DEFAULT_UPLOAD_CHUNK_BYTES, DEFAULT_UPLOAD_DISK_RESERVE_BYTES, DEFAULT_UPLOAD_MAX_BYTES,
  DEFAULT_UPLOAD_SESSION_TTL_HOURS, UPLOAD_MIME_TYPES, UPLOAD_PROTOCOL_VERSION, canonicalUploadMime,
  looksLikeSupportedMedia, uploadChunkCount, uploadChunkRange, uploadCompleteInputSchema, uploadCreateInputSchema,
  uploadSessionExpired, uploadSessionSchema, type UploadCapabilities, type UploadChunkConfirmation,
  type UploadErrorCode, type UploadSession,
} from '../../shared/uploads';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const HOUR = 3_600_000;
const BODY_LIMIT = 64 * 1024;

const storedSessionSchema = uploadSessionSchema.extend({ owner: z.string().min(1), idempotencyKey: z.uuid() });

type UploadStoreSession = z.infer<typeof storedSessionSchema>;

function sameText(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function fail(res: ServerResponse, status: number, code: UploadErrorCode, message: string, extra: Record<string, unknown> = {}) {
  send(res, status, { error: { code, message, ...extra } });
}

async function readJson(req: IncomingMessage, limit = BODY_LIMIT): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error('Request body exceeds limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function drain(req: IncomingMessage): Promise<void> {
  await new Promise<void>((resolve, reject) => { req.once('end', resolve); req.once('error', reject); req.resume(); });
}

async function hashFile(file: string): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256'); let size = 0;
  for await (const chunk of createReadStream(file)) { const bytes = chunk as Buffer; size += bytes.length; hash.update(bytes); }
  return { size, sha256: hash.digest('hex') };
}

function publicSession(session: UploadStoreSession): UploadSession {
  const { owner, idempotencyKey, ...visible } = session;
  void owner; void idempotencyKey;
  return visible;
}

function sortedChunks(chunks: UploadChunkConfirmation[]): UploadChunkConfirmation[] {
  return [...chunks].sort((left, right) => left.index - right.index);
}

/** Persistent, idempotent Host-side upload sessions (F-0015). */
export const uploadsPlugin = { name: 'flycut-uploads', inject: ['hostConfig', 'rpc', 'assets'], async apply(ctx: Context) {
  const root = join(ctx.hostConfig.home, 'uploads');
  await mkdir(root, { recursive: true });
  const chunkSize = ctx.hostConfig.uploadChunkBytes ?? DEFAULT_UPLOAD_CHUNK_BYTES;
  const maxBytes = ctx.hostConfig.uploadMaxBytes ?? DEFAULT_UPLOAD_MAX_BYTES;
  const ttlHours = ctx.hostConfig.uploadSessionTtlHours ?? DEFAULT_UPLOAD_SESSION_TTL_HOURS;
  const diskReserve = ctx.hostConfig.uploadDiskReserveBytes ?? DEFAULT_UPLOAD_DISK_RESERVE_BYTES;
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0
    || !Number.isFinite(ttlHours) || ttlHours <= 0 || !Number.isSafeInteger(diskReserve) || diskReserve < 0) {
    throw new Error('Invalid resumable upload configuration');
  }
  const ttlMs = Math.max(1_000, ttlHours * HOUR);
  const maxChunks = uploadChunkCount(maxBytes, chunkSize);
  const capabilities: UploadCapabilities = { protocolVersion: UPLOAD_PROTOCOL_VERSION, chunkSize, maxBytes, maxChunks,
    sessionTtlHours: ttlHours, allowedMimeTypes: [...UPLOAD_MIME_TYPES] };
  const sessions = new Map<string, UploadStoreSession>();
  const byOperation = new Map<string, string>();
  const locks = new Map<string, Promise<void>>();

  const paths = (id: string) => {
    const dir = join(root, id);
    return { dir, meta: join(dir, 'session.json'), chunks: join(dir, 'chunks'), assembled: join(dir, 'assembled') };
  };
  const metaPath = (id: string) => paths(id).meta;
  const operationKey = (owner: string, idempotencyKey: string) => `${owner}:${idempotencyKey}`;

  const writeSession = async (session: UploadStoreSession) => {
    await mkdir(paths(session.id).dir, { recursive: true });
    await writeFile(`${metaPath(session.id)}.tmp`, JSON.stringify(session));
    await rename(`${metaPath(session.id)}.tmp`, metaPath(session.id));
  };

  const readSessionFile = async (id: string): Promise<UploadStoreSession | undefined> => {
    if (!SESSION_ID.test(id)) return undefined;
    try { return storedSessionSchema.parse(JSON.parse(await readFile(metaPath(id), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  };

  const cleanupData = async (id: string) => {
    await rm(paths(id).chunks, { recursive: true, force: true });
    await rm(paths(id).assembled, { force: true });
  };

  const freeBytes = async (): Promise<number | undefined> => {
    try { const info = await statfs(root); return Number(info.bavail) * Number(info.bsize); }
    catch { return undefined; }
  };

  const activeRemaining = () => [...sessions.values()]
    .filter(session => session.state === 'active' || session.state === 'finalizing')
    .reduce((total, session) => total + Math.max(0, session.size - session.uploadedBytes), 0);

  const ensureSpace = async (extraBytes: number, reservedBytes = 0): Promise<boolean> => {
    const free = await freeBytes();
    return free === undefined || free - diskReserve - reservedBytes >= extraBytes;
  };

  const withLock = async <T>(id: string, task: () => Promise<T>): Promise<T> => {
    const previous = locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const current = previous.then(() => gate);
    locks.set(id, current);
    await previous;
    try { return await task(); }
    finally {
      release();
      if (locks.get(id) === current) locks.delete(id);
    }
  };

  const assetSize = async (id?: string): Promise<number | undefined> => {
    if (!id) return undefined;
    return ctx.assets.size(id).catch(() => undefined);
  };

  const markExpired = async (session: UploadStoreSession, now = Date.now()) => {
    if (session.state === 'complete') return session;
    session.state = 'expired'; session.updatedAt = new Date(now).toISOString();
    await cleanupData(session.id); await writeSession(session);
    return session;
  };

  const markComplete = async (session: UploadStoreSession) => {
    session.state = 'complete'; session.updatedAt = new Date().toISOString();
    await cleanupData(session.id); await writeSession(session);
  };

  const recoverSession = async (session: UploadStoreSession) => {
    const info = paths(session.id);
    await rm(`${info.meta}.tmp`, { force: true });
    if (session.state === 'active') {
      const parts = await readdir(info.chunks).catch(() => [] as string[]);
      await Promise.all(parts.filter(name => name.includes('.part-')).map(name => rm(join(info.chunks, name), { force: true })));
      const confirmed: UploadChunkConfirmation[] = [];
      for (const chunk of session.chunks) {
        const range = uploadChunkRange(chunk.index, session.size, session.chunkSize);
        if (!range) continue;
        const file = join(info.chunks, String(chunk.index));
        const found = await stat(file).catch(() => undefined);
        if (!found?.isFile() || found.size !== range.length) continue;
        // A process can die after the atomic rename but before session.json records the chunk, or after
        // external corruption. Reconfirm the persisted bytes so a stale index can never count as uploaded.
        const digest = await hashFile(file).catch(() => undefined);
        if (digest?.sha256 === chunk.sha256) confirmed.push(chunk);
      }
      session.chunks = sortedChunks(confirmed);
      session.uploadedBytes = session.chunks.reduce((total, chunk) => total + chunk.size, 0);
      await writeSession(session);
      return;
    }
    if (session.state === 'finalizing') {
      const existing = await assetSize(session.assetId);
      if (existing === session.size) { await markComplete(session); return; }
      const assembled = await stat(info.assembled).catch(() => undefined);
      if (assembled?.isFile() && session.assetId && assembled.size === session.size) {
        const digest = await hashFile(info.assembled).catch(() => undefined);
        if (digest?.sha256 === session.sha256) {
          await ctx.assets.adopt(info.assembled, session.assetId);
          await markComplete(session); return;
        }
      }
      await rm(info.assembled, { force: true });
      session.state = 'active'; session.assetId = undefined; session.updatedAt = new Date().toISOString();
      await writeSession(session);
      return;
    }
    await cleanupData(session.id);
  };

  const loadAll = async () => {
    sessions.clear(); byOperation.clear();
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue;
      const session = await readSessionFile(entry.name).catch(error => {
        console.warn(`Ignoring corrupted upload session ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      });
      if (!session) continue;
      sessions.set(session.id, session);
      byOperation.set(operationKey(session.owner, session.idempotencyKey), session.id);
      await recoverSession(session);
    }
  };

  const sweep = async () => {
    const now = Date.now();
    for (const candidate of [...sessions.values()]) {
      await withLock(candidate.id, async () => {
        const session = sessions.get(candidate.id);
        if (!session) return;
        if (uploadSessionExpired(session, now) && session.state !== 'complete' && session.state !== 'expired') await markExpired(session, now);
        const old = Date.parse(session.updatedAt) < now - ttlMs - 24 * HOUR;
        if (old && (session.state === 'expired' || session.state === 'cancelled' || session.state === 'complete')) {
          await rm(paths(session.id).dir, { recursive: true, force: true });
          sessions.delete(session.id); byOperation.delete(operationKey(session.owner, session.idempotencyKey));
        }
      });
    }
  };

  await loadAll(); await sweep();
  ctx.effect(() => {
    const timer = setInterval(() => { void sweep().catch(error => console.warn('Upload cleanup failed', error)); }, HOUR);
    timer.unref?.();
    return () => clearInterval(timer);
  });

  ctx.effect(() => ctx.rpc.register('uploads.capabilities', undefined, () => capabilities));
  ctx.effect(() => ctx.rpc.capability('resumableUpload', true));

  const owned = async (id: string, auth: HttpRouteAuth): Promise<UploadStoreSession | undefined> => {
    const session = sessions.get(id) ?? await readSessionFile(id).catch(() => undefined);
    if (!session || session.owner !== auth.subject) return undefined;
    sessions.set(id, session);
    return session;
  };

  const expiredResponse = async (res: ServerResponse, session: UploadStoreSession) => {
    if (session.state !== 'expired' && uploadSessionExpired(session)) await markExpired(session);
    fail(res, 410, 'expired', 'Upload session expired');
  };

  const route = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', pattern: RegExp,
    handle: (req: IncomingMessage, res: ServerResponse, match: RegExpMatchArray, auth: HttpRouteAuth) => Promise<void>) => {
    ctx.effect(() => ctx.rpc.route({ method, pattern, auth: 'client', handle: async (req, res, match, auth) => {
      try { await handle(req, res, match, auth); }
      catch (error) {
        if (res.headersSent) { res.destroy(); return; }
        const message = error instanceof Error ? error.message : String(error);
        fail(res, /exceeds limit/i.test(message) ? 413 : 400, /exceeds limit/i.test(message) ? 'too-large' : 'invalid-session', message);
      }
    } }));
  };

  route('POST', /^\/uploads$/, async (req, res, _match, auth) => {
    const input = uploadCreateInputSchema.parse(await readJson(req));
    const mimeType = canonicalUploadMime(input.mimeType, input.fileName);
    if (!mimeType) { fail(res, 415, 'unsupported-media-type', 'Unsupported media type'); return; }
    if (input.size > maxBytes) { fail(res, 413, 'too-large', `File exceeds the ${maxBytes}-byte limit`); return; }
    const count = uploadChunkCount(input.size, chunkSize);
    if (!count || count > maxChunks) { fail(res, 413, 'too-large', 'File has too many chunks'); return; }
    // Creation shares one reservation lock: two retries for the same operation must not both pass
    // the space check and create a session, and concurrent files must reserve disk serially.
    await withLock('__create__', async () => {
      const operation = operationKey(auth.subject, input.idempotencyKey);
      const existing = sessions.get(byOperation.get(operation) ?? '');
      if (existing && (existing.state === 'active' || existing.state === 'finalizing' || existing.state === 'complete')) {
        if (existing.size !== input.size || !sameText(existing.sha256, input.sha256) || existing.mimeType !== mimeType) {
          fail(res, 409, 'operation-conflict', 'Idempotency key was already used for another file'); return;
        }
        send(res, 201, publicSession(existing)); return;
      }
      if (!(await ensureSpace(input.size, activeRemaining()))) { fail(res, 507, 'insufficient-storage', 'Not enough Host disk space for this upload'); return; }
      const now = new Date();
      const id = randomUUID();
      const session: UploadStoreSession = { id, fileName: input.fileName, size: input.size, mimeType, sha256: input.sha256.toLowerCase(),
        chunkSize, chunkCount: count, chunks: [], uploadedBytes: 0, state: 'active', createdAt: now.toISOString(),
        updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttlMs).toISOString(), owner: auth.subject,
        idempotencyKey: input.idempotencyKey };
      await mkdir(paths(id).chunks, { recursive: true });
      await writeSession(session);
      sessions.set(id, session); byOperation.set(operation, id);
      send(res, 201, publicSession(session));
    });
  });

  route('GET', /^\/uploads\/([0-9a-f-]{36})$/, async (_req, res, match, auth) => {
    await withLock(match[1], async () => {
      const session = await owned(match[1], auth);
      if (!session) { fail(res, 404, 'invalid-session', 'Upload session not found'); return; }
      if (session.state === 'expired' || uploadSessionExpired(session)) { await expiredResponse(res, session); return; }
      send(res, 200, publicSession(session));
    });
  });

  route('PUT', /^\/uploads\/([0-9a-f-]{36})\/chunks\/(\d+)$/, async (req, res, match, auth) => {
    const id = match[1]; const index = Number(match[2]);
    const declaredHash = String(req.headers['x-chunk-sha256'] ?? '').toLowerCase();
    const declaredOffset = Number(req.headers['x-flycut-offset']);
    if (!SHA256.test(declaredHash) || !Number.isSafeInteger(declaredOffset) || declaredOffset < 0) {
      fail(res, 400, 'invalid-offset', 'Missing or invalid chunk offset/hash headers'); await drain(req).catch(() => undefined); return;
    }
    await withLock(id, async () => {
      const session = await owned(id, auth);
      if (!session) { fail(res, 404, 'invalid-session', 'Upload session not found'); await drain(req).catch(() => undefined); return; }
      if (session.state === 'expired' || uploadSessionExpired(session)) { await expiredResponse(res, session); await drain(req).catch(() => undefined); return; }
      if (session.state === 'complete') { fail(res, 409, 'already-complete', 'Upload is already complete'); await drain(req).catch(() => undefined); return; }
      if (session.state === 'cancelled') { fail(res, 409, 'cancelled', 'Upload was cancelled'); await drain(req).catch(() => undefined); return; }
      if (session.state === 'finalizing') { fail(res, 409, 'finalizing', 'Upload is being finalized'); await drain(req).catch(() => undefined); return; }
      const range = uploadChunkRange(index, session.size, session.chunkSize);
      if (!range || range.start !== declaredOffset) { fail(res, 409, 'invalid-offset', 'Chunk offset does not match its index'); await drain(req).catch(() => undefined); return; }
      const confirmed = session.chunks.find(chunk => chunk.index === index);
      if (confirmed) {
        await drain(req).catch(() => undefined);
        if (confirmed.size !== range.length || !sameText(confirmed.sha256, declaredHash)) {
          fail(res, 409, 'chunk-conflict', 'Chunk already exists with different content'); return;
        }
        send(res, 200, publicSession(session)); return;
      }
      if (!(await ensureSpace(range.length))) { fail(res, 507, 'insufficient-storage', 'Not enough Host disk space'); await drain(req).catch(() => undefined); return; }
      await mkdir(paths(id).chunks, { recursive: true });
      const final = join(paths(id).chunks, String(index));
      const existingFile = await stat(final).catch(() => undefined);
      if (existingFile?.isFile() && existingFile.size === range.length) {
        const digest = await hashFile(final).catch(() => undefined);
        if (digest?.sha256 === declaredHash) {
          await drain(req).catch(() => undefined);
          session.chunks = sortedChunks([...session.chunks, { index, offset: range.start, size: range.length, sha256: declaredHash }]);
          session.uploadedBytes = session.chunks.reduce((total, chunk) => total + chunk.size, 0);
          session.updatedAt = new Date().toISOString(); await writeSession(session); send(res, 200, publicSession(session)); return;
        }
        await rm(final, { force: true });
      }
      const temp = join(paths(id).chunks, `${index}.part-${randomUUID()}`);
      const hash = createHash('sha256'); let bytes = 0;
      const guard = new Transform({ transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        if (bytes > range.length) { done(new Error('Chunk exceeds expected length')); return; }
        hash.update(chunk); done(null, chunk);
      } });
      try { await pipeline(req, guard, createWriteStream(temp, { flags: 'wx' })); }
      catch (error) { await rm(temp, { force: true }); throw error; }
      if (bytes !== range.length || hash.digest('hex') !== declaredHash) {
        await rm(temp, { force: true });
        fail(res, 422, 'integrity-mismatch', 'Chunk length or digest does not match'); return;
      }
      await rename(temp, final);
      session.chunks = sortedChunks([...session.chunks, { index, offset: range.start, size: range.length, sha256: declaredHash }]);
      session.uploadedBytes = session.chunks.reduce((total, chunk) => total + chunk.size, 0);
      session.updatedAt = new Date().toISOString(); await writeSession(session);
      send(res, 200, publicSession(session));
    });
  });

  route('POST', /^\/uploads\/([0-9a-f-]{36})\/complete$/, async (req, res, match, auth) => {
    const input = uploadCompleteInputSchema.parse(await readJson(req));
    const id = match[1];
    await withLock(id, async () => {
      const session = await owned(id, auth);
      if (!session) { fail(res, 404, 'invalid-session', 'Upload session not found'); return; }
      if (session.state === 'expired' || uploadSessionExpired(session)) { await expiredResponse(res, session); return; }
      if (session.state === 'cancelled') { fail(res, 409, 'cancelled', 'Upload was cancelled'); return; }
      if (session.state === 'complete') { send(res, 200, publicSession(session)); return; }
      if (!sameText(input.sha256, session.sha256)) { fail(res, 422, 'integrity-mismatch', 'Completion digest does not match the session'); return; }
      const missing: number[] = []; let total = 0;
      for (let index = 0; index < session.chunkCount; index += 1) {
        const confirmation = session.chunks.find(chunk => chunk.index === index);
        const range = uploadChunkRange(index, session.size, session.chunkSize);
        const info = confirmation && range ? await stat(join(paths(id).chunks, String(index))).catch(() => undefined) : undefined;
        if (!confirmation || !range || info?.size !== range.length) { missing.push(index); continue; }
        total += confirmation.size;
      }
      if (missing.length || total !== session.size) { fail(res, 409, 'incomplete', 'Upload has missing or changed chunks', { missing }); return; }
      session.state = 'finalizing'; session.assetId = session.assetId ?? randomUUID();
      session.updatedAt = new Date().toISOString(); await writeSession(session);
      const assetId = session.assetId;
      const info = paths(id);
      const existingAsset = await assetSize(assetId);
      if (existingAsset === undefined) {
        await rm(info.assembled, { force: true });
        const out = createWriteStream(info.assembled, { flags: 'wx' });
        try {
          for (let index = 0; index < session.chunkCount; index += 1) {
            for await (const chunk of createReadStream(join(info.chunks, String(index)))) {
              if (!out.write(chunk)) await once(out, 'drain');
            }
          }
          const finished = new Promise<void>((resolve, reject) => { out.once('finish', resolve); out.once('error', reject); });
          out.end();
          await finished;
        } catch (error) { out.destroy(); await rm(info.assembled, { force: true }); throw error; }
        const digest = await hashFile(info.assembled);
        const handle = await open(info.assembled, 'r');
        const head = Buffer.alloc(64); let headLength = 0;
        try { headLength = (await handle.read(head, 0, head.length, 0)).bytesRead; }
        finally { await handle.close(); }
        if (digest.size !== session.size || digest.sha256 !== session.sha256) {
          await rm(info.assembled, { force: true }); session.state = 'active'; session.assetId = undefined;
          session.updatedAt = new Date().toISOString(); await writeSession(session);
          fail(res, 422, 'integrity-mismatch', 'Final file size or digest does not match'); return;
        }
        if (!looksLikeSupportedMedia(head.subarray(0, headLength))) {
          await rm(info.assembled, { force: true }); session.state = 'active'; session.assetId = undefined;
          session.updatedAt = new Date().toISOString(); await writeSession(session);
          fail(res, 415, 'unsupported-media-type', 'The assembled file is not supported media'); return;
        }
        await ctx.assets.adopt(info.assembled, assetId);
      } else if (existingAsset !== session.size) {
        fail(res, 409, 'integrity-mismatch', 'Existing asset size does not match the session'); return;
      }
      await markComplete(session);
      send(res, 200, publicSession(session));
    });
  });

  route('DELETE', /^\/uploads\/([0-9a-f-]{36})$/, async (_req, res, match, auth) => {
    const id = match[1];
    await withLock(id, async () => {
      const session = await owned(id, auth);
      if (!session) { fail(res, 404, 'invalid-session', 'Upload session not found'); return; }
      if (session.state === 'expired' || uploadSessionExpired(session)) { await expiredResponse(res, session); return; }
      if (session.state === 'complete') { send(res, 200, publicSession(session)); return; }
      if (session.state !== 'cancelled') {
        session.state = 'cancelled'; session.updatedAt = new Date().toISOString(); await writeSession(session); await cleanupData(id);
      }
      send(res, 200, publicSession(session));
    });
  });

  ctx.effect(() => async () => {
    for (const session of sessions.values()) {
      if (session.state === 'finalizing') await writeSession(session).catch(() => undefined);
    }
  });
} };

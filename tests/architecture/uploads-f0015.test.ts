import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer as createTcpServer, connect, type Socket } from 'node:net';
import { createHost } from '../../server/app';
import type { HostConfig } from '../../server/services';
import type { UploadCapabilities, UploadSession } from '../../shared/uploads';
import type { JobSnapshot } from '../../shared/protocol';
import type { Context, Plugin } from '@deepseek-ai/cordis';

const TOKEN = 'f0015-test-credential';
const ORIGIN = 'http://127.0.0.1:5177';
const SHA256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

function media(size: number, options: { header?: boolean } = {}): Buffer {
  const body = Buffer.alloc(size, 0x2a);
  if (options.header !== false) {
    body.writeUInt32BE(24, 0);
    body.write('ftyp', 4, 'ascii');
    body.write('isom', 8, 'ascii');
  }
  return body;
}

type CookieJar = { session?: string; owner?: string; csrf?: string };

function cookiesOf(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (headers.getSetCookie) return headers.getSetCookie();
  const value = response.headers.get('set-cookie');
  return value ? [value] : [];
}

function cookieValue(response: Response, name: string): string | undefined {
  const header = cookiesOf(response).find(value => value.startsWith(`${name}=`));
  return header?.slice(0, header.indexOf(';') > -1 ? header.indexOf(';') : undefined);
}

function cookieHeader(jar: CookieJar): string {
  return [jar.session, jar.owner].filter(Boolean).join('; ');
}

async function cuttableProxy(target: string) {
  const destination = new URL(target);
  const sockets = new Set<Socket>();
  let blocked = false;
  const server = createTcpServer(client => {
    sockets.add(client);
    if (blocked) { client.destroy(); return; }
    const upstream = connect(Number(destination.port), destination.hostname);
    sockets.add(upstream);
    const clean = () => { sockets.delete(client); sockets.delete(upstream); };
    client.on('error', clean); upstream.on('error', clean); client.on('close', clean); upstream.on('close', clean);
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    cut() { blocked = true; for (const socket of sockets) socket.destroy(); },
    restore() { blocked = false; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

async function setup(extra: Partial<HostConfig> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0015-upload-'));
  const webRoot = join(home, 'dist');
  await mkdir(join(webRoot, 'assets'), { recursive: true });
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>FlyCut</title>');
  const boot = async (config: Partial<HostConfig> = {}) => createHost({
    home, token: TOKEN, port: 0, resourceRoot: resolve('.'), webRoot,
    allowedOrigins: [ORIGIN], uploadChunkBytes: 1024, uploadMaxBytes: 64 * 1024,
    uploadSessionTtlHours: 1, ...extra, ...config,
  }, { providers: [] });
  let ctx = await boot();
  const url = (context = ctx) => `http://127.0.0.1:${(context.httpServer.address() as { port: number }).port}`;
  const bearerHeaders = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
  const call = async <T>(method: string, payload: unknown = {}, context = ctx): Promise<T> => {
    const rpcId = crypto.randomUUID();
    const response = await fetch(`${url(context)}/rpc`, { method: 'POST', headers: bearerHeaders,
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }) });
    const envelope = await response.json() as any;
    assert.equal(envelope.rpcId, rpcId);
    if (!envelope.result.ok) throw new Error(envelope.result.error.message);
    return envelope.result.value as T;
  };
  const bootstrap = async (jar: CookieJar = {}, context = ctx) => {
    const response = await fetch(`${url(context)}/__flycut/connection`, { headers: { Origin: ORIGIN, ...(cookieHeader(jar) ? { Cookie: cookieHeader(jar) } : {}) } });
    assert.equal(response.status, 200);
    const body = await response.json() as { csrf: string; expiresAt: string; auth: string };
    const next: CookieJar = { ...jar, csrf: body.csrf, session: cookieValue(response, 'flycut_session') ?? jar.session };
    return { response, body, jar: next };
  };
  const create = async (file: Buffer, jar?: CookieJar, idempotencyKey = crypto.randomUUID()) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Origin: ORIGIN };
    if (jar) { headers.Cookie = cookieHeader(jar); headers['X-Flycut-CSRF'] = jar.csrf ?? ''; } else headers.Authorization = `Bearer ${TOKEN}`;
    const response = await fetch(`${url()}/uploads`, { method: 'POST', headers,
      body: JSON.stringify({ fileName: 'fixture.mp4', size: file.length, mimeType: 'video/mp4', sha256: SHA256(file), idempotencyKey }) });
    const session = response.ok ? await response.json() as UploadSession : undefined;
    const owner = cookieValue(response, 'flycut_upload_owner');
    return { response, session, nextJar: owner ? { ...jar, owner } : jar };
  };
  const chunk = async (id: string, index: number, body: Buffer, offset: number, digest = SHA256(body), jar?: CookieJar) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream', Origin: ORIGIN,
      'X-Flycut-Offset': String(offset), 'X-Chunk-SHA256': digest };
    if (jar) { headers.Cookie = cookieHeader(jar); headers['X-Flycut-CSRF'] = jar.csrf ?? ''; } else headers.Authorization = `Bearer ${TOKEN}`;
    const response = await fetch(`${url()}/uploads/${id}/chunks/${index}`, { method: 'PUT', headers, body });
    return { response, value: response.ok ? await response.json() as UploadSession : await response.json() as any, owner: cookieValue(response, 'flycut_upload_owner') };
  };
  const get = async (id: string, jar?: CookieJar, context = ctx, base = url(context)) => {
    const headers: Record<string, string> = { Origin: ORIGIN };
    if (jar) headers.Cookie = cookieHeader(jar); else headers.Authorization = `Bearer ${TOKEN}`;
    return fetch(`${base}/uploads/${id}`, { headers });
  };
  const complete = async (id: string, digest: string, jar?: CookieJar) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Origin: ORIGIN };
    if (jar) { headers.Cookie = cookieHeader(jar); headers['X-Flycut-CSRF'] = jar.csrf ?? ''; } else headers.Authorization = `Bearer ${TOKEN}`;
    return fetch(`${url()}/uploads/${id}/complete`, { method: 'POST', headers, body: JSON.stringify({ sha256: digest }) });
  };
  const cancel = async (id: string, jar?: CookieJar) => {
    const headers: Record<string, string> = { Origin: ORIGIN };
    if (jar) { headers.Cookie = cookieHeader(jar); headers['X-Flycut-CSRF'] = jar.csrf ?? ''; } else headers.Authorization = `Bearer ${TOKEN}`;
    return fetch(`${url()}/uploads/${id}`, { method: 'DELETE', headers });
  };
  const uploadAsset = async (body: Buffer, context = ctx) => {
    const response = await fetch(`${url(context)}/assets`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body });
    assert.equal(response.status, 201);
    return (await response.json() as { assetId: string }).assetId;
  };
  const waitJob = async (id: string, context = ctx) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const job = await call<JobSnapshot>('jobs.get', { id }, context);
      if (job.status === 'complete' || job.status === 'error' || job.status === 'cancelled') return job;
      await sleep(10);
    }
    throw new Error(`Job ${id} did not settle`);
  };
  return {
    home, webRoot, get ctx() { return ctx; }, url, call, bearerHeaders, bootstrap, create, chunk, get, complete, cancel, uploadAsset, waitJob,
    async restart(config: Partial<HostConfig> = {}) { await ctx.fiber.dispose(); ctx = await boot(config); return ctx; },
    async close() { await ctx.fiber.dispose().catch(() => undefined); await rm(home, { recursive: true, force: true }); },
  };
}

test('F-0015/AC-1 Host advertises the real resumable protocol and persists an atomic asset', async () => {
  const host = await setup();
  try {
    const capabilities = await host.call<UploadCapabilities>('uploads.capabilities');
    assert.equal(capabilities.protocolVersion, 1);
    assert.equal(capabilities.chunkSize, 1024);
    assert.equal(capabilities.maxChunks, 64);
    assert.ok(capabilities.allowedMimeTypes.includes('video/mp4'));
    assert.equal((await host.call<any>('host.info')).capabilities.resumableUpload, true);

    const file = media(2500);
    const created = await host.create(file);
    assert.equal(created.response.status, 201);
    assert.ok(created.session); assert.equal(created.session.chunkCount, 3); assert.equal(created.session.uploadedBytes, 0);
    for (let index = 0; index < created.session.chunkCount; index += 1) {
      const part = file.subarray(index * 1024, Math.min(file.length, (index + 1) * 1024));
      const uploaded = await host.chunk(created.session.id, index, part, index * 1024);
      assert.equal(uploaded.response.status, 200, JSON.stringify(uploaded.value));
    }
    const completed = await host.complete(created.session.id, SHA256(file));
    assert.equal(completed.status, 200);
    const completeBody = await completed.json() as UploadSession;
    assert.equal(completeBody.state, 'complete'); assert.equal(completeBody.uploadedBytes, file.length); assert.ok(completeBody.assetId);
    const download = await fetch(`${host.url()}/assets/${completeBody.assetId}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(download.status, 200);
    const bytes = Buffer.from(await download.arrayBuffer());
    assert.equal(bytes.length, file.length); assert.equal(SHA256(bytes), SHA256(file));

    const repeated = await host.complete(created.session.id, SHA256(file));
    assert.equal(repeated.status, 200); assert.equal((await repeated.json() as UploadSession).assetId, completeBody.assetId);
  } finally { await host.close(); }
});

test('F-0015/AC-3 chunk offsets and digests are idempotent, conflicts are rejected, incomplete files cannot complete', async () => {
  const host = await setup();
  try {
    const file = media(2100);
    const created = await host.create(file); assert.ok(created.session);
    const first = file.subarray(0, 1024); const second = file.subarray(1024, 2048);
    const accepted = await host.chunk(created.session.id, 0, first, 0); assert.equal(accepted.response.status, 200);
    assert.equal(accepted.value.uploadedBytes, first.length);
    const same = await host.chunk(created.session.id, 0, first, 0); assert.equal(same.response.status, 200);
    assert.equal(same.value.uploadedBytes, first.length);
    const changed = Buffer.from(first); changed[100] ^= 0xff;
    const conflict = await host.chunk(created.session.id, 0, changed, 0, SHA256(changed));
    assert.equal(conflict.response.status, 409); assert.equal(conflict.value.error.code, 'chunk-conflict');
    const wrongOffset = await host.chunk(created.session.id, 1, second, 0);
    assert.equal(wrongOffset.response.status, 409); assert.equal(wrongOffset.value.error.code, 'invalid-offset');
    const incomplete = await host.complete(created.session.id, SHA256(file));
    assert.equal(incomplete.status, 409); assert.deepEqual((await incomplete.json() as any).error.missing, [1, 2]);
    const badDigest = await host.chunk(created.session.id, 1, second, 1024, '0'.repeat(64));
    assert.equal(badDigest.response.status, 422); assert.equal((await host.get(created.session.id)).status, 200);
    assert.equal((await (await host.get(created.session.id)).json() as UploadSession).uploadedBytes, first.length);
  } finally { await host.close(); }
});

test('F-0015/AC-3/AC-7 final size/digest/header verification and cancel-after-complete preserve the asset', async () => {
  const host = await setup();
  try {
    const file = media(1500);
    const created = await host.create(file); assert.ok(created.session);
    for (let index = 0; index < created.session.chunkCount; index += 1) {
      const part = file.subarray(index * 1024, Math.min(file.length, (index + 1) * 1024));
      assert.equal((await host.chunk(created.session.id, index, part, index * 1024)).response.status, 200);
    }
    const wrongDigest = await host.complete(created.session.id, 'f'.repeat(64));
    assert.equal(wrongDigest.status, 422);
    const active = await (await host.get(created.session.id)).json() as UploadSession; assert.equal(active.state, 'active');

    // Chunk-level hashes can all be valid while the assembled file differs from the declared source.
    const contaminated = media(1500); contaminated[800] ^= 0xff;
    const mismatch = await host.create(file); assert.ok(mismatch.session);
    for (let index = 0; index < mismatch.session.chunkCount; index += 1) {
      const part = contaminated.subarray(index * 1024, Math.min(contaminated.length, (index + 1) * 1024));
      assert.equal((await host.chunk(mismatch.session.id, index, part, index * 1024)).response.status, 200);
    }
    const assembledMismatch = await host.complete(mismatch.session.id, SHA256(file));
    assert.equal(assembledMismatch.status, 422);
    assert.equal((await (await host.get(mismatch.session.id)).json() as UploadSession).state, 'active');

    const completed = await host.complete(created.session.id, SHA256(file)); assert.equal(completed.status, 200);
    const session = await completed.json() as UploadSession;
    const cancelled = await host.cancel(created.session.id); assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json() as UploadSession).state, 'complete');
    assert.equal((await fetch(`${host.url()}/assets/${session.assetId}`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200);

    const unsupported = media(1200, { header: false });
    const bad = await host.create(unsupported); assert.ok(bad.session);
    for (let index = 0; index < bad.session.chunkCount; index += 1) {
      const part = unsupported.subarray(index * 1024, Math.min(unsupported.length, (index + 1) * 1024));
      assert.equal((await host.chunk(bad.session.id, index, part, index * 1024)).response.status, 200);
    }
    const rejected = await host.complete(bad.session.id, SHA256(unsupported));
    assert.equal(rejected.status, 415); assert.equal((await rejected.json() as any).error.code, 'unsupported-media-type');
  } finally { await host.close(); }
});

test('F-0015/AC-4/AC-7/AC-8 cancel is repeatable and expiry stops all writes', async () => {
  const host = await setup({ uploadSessionTtlHours: 1 / 3600 });
  try {
    const file = media(1200);
    const created = await host.create(file); assert.ok(created.session);
    const first = file.subarray(0, 1024); assert.equal((await host.chunk(created.session.id, 0, first, 0)).response.status, 200);
    const cancelled = await host.cancel(created.session.id); assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json() as UploadSession).state, 'cancelled');
    const repeated = await host.cancel(created.session.id); assert.equal(repeated.status, 200);
    assert.equal((await (await host.get(created.session.id)).json() as UploadSession).state, 'cancelled');

    const expired = await host.create(media(1200)); assert.ok(expired.session);
    await sleep(1_100);
    const status = await host.get(expired.session.id); assert.equal(status.status, 410);
    const write = await host.chunk(expired.session.id, 0, file.subarray(0, 1024), 0); assert.equal(write.response.status, 410);
    assert.equal((await host.complete(expired.session.id, SHA256(file))).status, 410);
  } finally { await host.close(); }
});

test('F-0015/AC-2/AC-6/AC-8 cross-origin Cookie+CSRF ownership is signed, isolated and recovers after Host restart', async () => {
  const host = await setup();
  try {
    const ownerA = await host.bootstrap();
    const fileA = media(1600);
    const created = await host.create(fileA, ownerA.jar); assert.equal(created.response.status, 201); assert.ok(created.session);
    assert.ok(created.nextJar.owner, 'first upload issues a signed owner cookie');
    assert.match(created.nextJar.owner, /^flycut_upload_owner=v1\.[A-Za-z0-9_-]+\.[0-9]+\.[A-Za-z0-9_-]+$/);
    const chunkA = await host.chunk(created.session.id, 0, fileA.subarray(0, 1024), 0, SHA256(fileA.subarray(0, 1024)), created.nextJar);
    assert.equal(chunkA.response.status, 200);

    const noCsrf = await fetch(`${host.url()}/uploads`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN,
      Cookie: cookieHeader(created.nextJar) }, body: JSON.stringify({ fileName: 'x.mp4', size: 1, mimeType: 'video/mp4', sha256: '0'.repeat(64),
        idempotencyKey: crypto.randomUUID() }) });
    assert.equal(noCsrf.status, 401);

    const ownerB = await host.bootstrap();
    const foreign = await host.get(created.session.id, ownerB.jar);
    assert.equal(foreign.status, 404);

    const forgedJar = { ...created.nextJar, owner: 'flycut_upload_owner=v1.attacker.9999999999999.bad-signature' };
    const forged = await host.get(created.session.id, forgedJar);
    assert.equal(forged.status, 404);
    assert.ok(cookieValue(forged, 'flycut_upload_owner'), 'invalid owner is rejected and a new signed cookie is returned');

    const refreshed = await host.bootstrap(created.nextJar);
    assert.equal(refreshed.jar.csrf, ownerA.jar.csrf, 'normal refresh reuses the existing session');
    const sameIdentity = await host.get(created.session.id, { ...refreshed.jar, owner: created.nextJar.owner });
    assert.equal(sameIdentity.status, 200);

    await host.restart();
    const reauthorized = await host.bootstrap(created.nextJar);
    const recovered = await host.get(created.session.id, { ...reauthorized.jar, owner: created.nextJar.owner });
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json() as UploadSession).uploadedBytes, 1024);
    const next = await host.chunk(created.session.id, 1, fileA.subarray(1024), 1024, SHA256(fileA.subarray(1024)),
      { ...reauthorized.jar, owner: created.nextJar.owner });
    assert.equal(next.response.status, 200);
  } finally { await host.close(); }
});

test('F-0015/AC-3/AC-8 create is idempotent per operation and rejects reuse for another file', async () => {
  const host = await setup();
  try {
    const file = media(1200); const operation = crypto.randomUUID();
    const first = await host.create(file, undefined, operation); assert.ok(first.session);
    const second = await host.create(file, undefined, operation); assert.ok(second.session);
    assert.equal(second.session.id, first.session.id);
    const other = media(1300);
    const conflict = await host.create(other, undefined, operation);
    assert.equal(conflict.response.status, 409);
    assert.equal((await conflict.response.json() as any).error.code, 'operation-conflict');
  } finally { await host.close(); }
});

test('F-0015/AC-3 concurrent create retries reserve one session and space is checked under the create lock', async () => {
  const host = await setup();
  try {
    const file = media(2400); const operation = crypto.randomUUID();
    const attempts = await Promise.all(Array.from({ length: 12 }, () => host.create(file, undefined, operation)));
    assert.ok(attempts.every(item => item.response.status === 201));
    assert.equal(new Set(attempts.map(item => item.session?.id)).size, 1);
    assert.equal(attempts[0].session?.uploadedBytes, 0);
  } finally { await host.close(); }

  const full = await setup({ uploadDiskReserveBytes: Number.MAX_SAFE_INTEGER });
  try {
    const refused = await full.create(media(1200));
    assert.equal(refused.response.status, 507);
    assert.equal((await refused.response.json() as any).error.code, 'insufficient-storage');
  } finally { await full.close(); }
});

test('F-0015/AC-3/AC-7 concurrent complete and complete/cancel settle through one serialized state machine', async () => {
  const host = await setup();
  try {
    const file = media(1200);
    const created = await host.create(file); assert.ok(created.session);
    assert.equal((await host.chunk(created.session.id, 0, file.subarray(0, 1024), 0)).response.status, 200);
    assert.equal((await host.chunk(created.session.id, 1, file.subarray(1024), 1024)).response.status, 200);
    const completions = await Promise.all(Array.from({ length: 8 }, () => host.complete(created.session.id, SHA256(file))));
    assert.ok(completions.every(response => response.status === 200));
    const bodies = await Promise.all(completions.map(response => response.json() as Promise<UploadSession>));
    assert.equal(new Set(bodies.map(session => session.assetId)).size, 1);

    const racedFile = media(1500);
    const raced = await host.create(racedFile); assert.ok(raced.session);
    for (let index = 0; index < raced.session.chunkCount; index += 1) {
      const part = racedFile.subarray(index * 1024, Math.min(racedFile.length, (index + 1) * 1024));
      assert.equal((await host.chunk(raced.session.id, index, part, index * 1024)).response.status, 200);
    }
    const [completion, cancellation] = await Promise.all([
      host.complete(raced.session.id, SHA256(racedFile)),
      host.cancel(raced.session.id),
    ]);
    assert.equal(cancellation.status, 200);
    assert.ok(completion.status === 200 || completion.status === 409);
    const settled = await (await host.get(raced.session.id)).json() as UploadSession;
    assert.ok(settled.state === 'complete' || settled.state === 'cancelled');
    if (settled.state === 'complete') {
      assert.equal((await cancellation.json() as UploadSession).state, 'complete');
      assert.equal((await fetch(`${host.url()}/assets/${settled.assetId}`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200);
    } else {
      assert.equal(completion.status, 409);
    }
  } finally { await host.close(); }
});

test('F-0015/AC-3/AC-10 restart re-hashes confirmed chunks and only trusts intact bytes', async () => {
  const host = await setup();
  try {
    const file = media(1200);
    const created = await host.create(file); assert.ok(created.session);
    assert.equal((await host.chunk(created.session.id, 0, file.subarray(0, 1024), 0)).response.status, 200);
    assert.equal((await host.chunk(created.session.id, 1, file.subarray(1024), 1024)).response.status, 200);
    const corrupted = Buffer.alloc(1024, 0x2a);
    corrupted.writeUInt32BE(24, 0); corrupted.write('ftyp', 4, 'ascii'); corrupted[100] ^= 0xff;
    await writeFile(join(host.home, 'uploads', created.session.id, 'chunks', '0'), corrupted);
    await host.restart();
    const recovered = await (await host.get(created.session.id)).json() as UploadSession;
    assert.deepEqual(recovered.chunks.map(chunk => chunk.index), [1]);
    assert.equal(recovered.uploadedBytes, 176);
    assert.equal((await host.chunk(created.session.id, 0, file.subarray(0, 1024), 0)).response.status, 200);
    assert.equal((await host.complete(created.session.id, SHA256(file))).status, 200);
  } finally { await host.close(); }
});

test('F-0015/AC-4/AC-7 expiry waits for a chunk already in flight and never deletes during its write', async () => {
  const host = await setup({ uploadSessionTtlHours: 1 / 3600 });
  try {
    const file = media(1200);
    const created = await host.create(file); assert.ok(created.session);
    const part = file.subarray(0, 1024);
    const delayed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(part.subarray(0, 512));
        setTimeout(() => { controller.enqueue(part.subarray(512)); controller.close(); }, 1_250);
      },
    });
    const putPromise = fetch(`${host.url()}/uploads/${created.session.id}/chunks/0`, { method: 'PUT', duplex: 'half',
      headers: { Origin: ORIGIN, Authorization: `Bearer ${TOKEN}`, 'X-Flycut-Offset': '0', 'X-Chunk-SHA256': SHA256(part) },
      body: delayed } as RequestInit);
    await sleep(1_100);
    const getPromise = host.get(created.session.id);
    const put = await putPromise;
    assert.equal(put.status, 200, 'the in-flight write completes instead of having its chunk deleted');
    const status = await getPromise;
    assert.equal(status.status, 410, 'the queued GET observes expiry only after the write lock is released');
  } finally { await host.close(); }
});

test('F-0015/AC-9 project create and add-video retries return the same entities after the asset was consumed', async () => {
  const host = await setup();
  try {
    const assetId = await host.uploadAsset(media(1200));
    const createOperation = crypto.randomUUID();
    const createInput = { name: 'Idempotent project', videoName: 'one.mp4', durationSeconds: 1, media: { assetId, mimeType: 'video/mp4' }, operationId: createOperation };
    const attempts = await Promise.all(Array.from({ length: 8 }, () => host.call<any>('projects.create', createInput)));
    assert.equal(new Set(attempts.map(item => item.projectId)).size, 1);
    assert.equal(new Set(attempts.map(item => item.videoId)).size, 1);
    const first = attempts[0];
    const second = await host.call<any>('projects.create', createInput);
    assert.equal(second.projectId, first.projectId); assert.equal(second.videoId, first.videoId);

    const nextAsset = await host.uploadAsset(media(1300));
    const addOperation = crypto.randomUUID();
    const addInput = { projectId: first.projectId, videoName: 'two.mp4', durationSeconds: 1,
      media: { assetId: nextAsset, mimeType: 'video/mp4' }, operationId: addOperation };
    const added = await host.call<any>('projects.addVideo', addInput);
    const repeated = await host.call<any>('projects.addVideo', addInput);
    assert.equal(repeated.videoId, added.videoId);
    const detail = await host.call<any>('projects.detail', { projectId: first.projectId });
    assert.equal(detail.videos.length, 2);
  } finally { await host.close(); }
});

test('F-0015/AC-9 workflow operationId deduplicates concurrent starts and survives Host restart', async () => {
  const host = await setup();
  let providerCalls = 0;
  const provider: Plugin = { name: 'f0015-fixture-provider', inject: ['providers'], apply(ctx: Context) {
    ctx.effect(() => ctx.providers.register({ id: 'f0015-fixture', name: 'F-0015 fixture', kind: 'builtin',
      models: async () => [{ id: 'fixture', name: 'Fixture', role: 'asr', status: 'ready' }],
      async transcribe() {
        providerCalls += 1;
        return { text: 'hello', chunks: [{ id: 's1', text: 'hello', timestamp: [0, 1] }], language: 'en', duration: 1,
          hasWordTimestamps: false } as any;
      } }));
  } };
  try {
    const fiber = host.ctx.plugin(provider); await fiber.await();
    const assetId = await host.uploadAsset(Buffer.from('fixture-audio'));
    const operationId = crypto.randomUUID();
    const starts = await Promise.all(Array.from({ length: 8 }, () => host.call<JobSnapshot>('workflow.start',
      { operationId, asr: { providerId: 'f0015-fixture', modelId: 'fixture', assetId } })));
    assert.equal(new Set(starts.map(job => job.id)).size, 1);
    assert.equal(starts[0].operationId, operationId);
    const settled = await host.waitJob(starts[0].id);
    assert.equal(settled.status, 'complete'); assert.equal(providerCalls, 1);

    await host.restart();
    const afterRestartFiber = host.ctx.plugin(provider); await afterRestartFiber.await();
    const afterRestart = await host.call<JobSnapshot>('workflow.start',
      { operationId, asr: { providerId: 'f0015-fixture', modelId: 'fixture', assetId } });
    assert.equal(afterRestart.id, starts[0].id); assert.equal(afterRestart.status, 'complete');
  } finally { await host.close(); }
});

test('F-0015/AC-5/AC-10 a real TCP cut resumes the same Host session without retransmitting confirmed chunks', async () => {
  const host = await setup();
  const proxy = await cuttableProxy(host.url());
  const common = { Authorization: `Bearer ${TOKEN}`, Connection: 'close' };
  try {
    const file = media(4200);
    const createdResponse = await fetch(`${proxy.url}/uploads`, { method: 'POST',
      headers: { ...common, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: 'network.mp4', size: file.length, mimeType: 'video/mp4', sha256: SHA256(file), idempotencyKey: crypto.randomUUID() }) });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as UploadSession;
    const first = file.subarray(0, 1024);
    const firstResponse = await fetch(`${proxy.url}/uploads/${created.id}/chunks/0`, { method: 'PUT',
      headers: { ...common, 'X-Flycut-Offset': '0', 'X-Chunk-SHA256': SHA256(first) }, body: first });
    assert.equal(firstResponse.status, 200);

    proxy.cut();
    await assert.rejects(fetch(`${proxy.url}/uploads/${created.id}`, { headers: common, signal: AbortSignal.timeout(1_500) }));
    proxy.restore();

    const resumedResponse = await fetch(`${proxy.url}/uploads/${created.id}`, { headers: common });
    assert.equal(resumedResponse.status, 200);
    const resumed = await resumedResponse.json() as UploadSession;
    assert.equal(resumed.uploadedBytes, 1024);
    assert.deepEqual(resumed.chunks.map(chunk => chunk.index), [0]);

    let bytesAfterReconnect = 0;
    for (let index = 1; index < resumed.chunkCount; index += 1) {
      const part = file.subarray(index * 1024, Math.min(file.length, (index + 1) * 1024));
      bytesAfterReconnect += part.length;
      const response = await fetch(`${proxy.url}/uploads/${created.id}/chunks/${index}`, { method: 'PUT',
        headers: { ...common, 'X-Flycut-Offset': String(index * 1024), 'X-Chunk-SHA256': SHA256(part) }, body: part });
      assert.equal(response.status, 200);
    }
    assert.ok(bytesAfterReconnect < file.length, 'recovery sends only missing bytes');
    const completed = await fetch(`${proxy.url}/uploads/${created.id}/complete`, { method: 'POST',
      headers: { ...common, 'Content-Type': 'application/json' }, body: JSON.stringify({ sha256: SHA256(file) }) });
    assert.equal(completed.status, 200);
    const session = await completed.json() as UploadSession;
    const download = await fetch(`${host.url()}/assets/${session.assetId}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const bytes = Buffer.from(await download.arrayBuffer());
    assert.equal(bytes.length, file.length); assert.equal(SHA256(bytes), SHA256(file));
  } finally { await proxy.close(); await host.close(); }
});

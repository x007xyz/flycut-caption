import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { redactSecrets, type HostErrorCode } from '../shared/errors';
import { PROTOCOL_VERSION, type HostFrame, type JobSnapshot, type RemoteEvents, type RpcInput, type RpcMethod, type RpcOutput, type RpcResponse } from '../shared/protocol';
import type { UploadCapabilities, UploadSession } from '../shared/uploads';

export const EXIT_CODES = {
  OK: 0,
  INTERNAL: 1,
  AUTH: 2,
  CONNECTION: 3,
  CONFIRMATION: 4,
  INVALID_INPUT: 5,
  NOT_FOUND: 6,
  NOT_READY: 7,
  CONFLICT: 8,
  JOB_FAILED: 9,
  INTERRUPTED: 130,
} as const;

export function exitCodeForError(code: HostErrorCode): number {
  switch (code) {
    case 'AUTH_FAILED': return EXIT_CODES.AUTH;
    case 'NO_HOST_CONNECTION': return EXIT_CODES.CONNECTION;
    case 'CONFIRMATION_REQUIRED':
    case 'CONFIRMATION_REJECTED':
    case 'CONFIRMATION_NOT_APPROVED':
    case 'CONFIRMATION_ALREADY_CONSUMED':
    case 'CONFIRMATION_EXPIRED': return EXIT_CODES.CONFIRMATION;
    case 'INVALID_ARGUMENT':
    case 'INVALID_ID': return EXIT_CODES.INVALID_INPUT;
    case 'NOT_FOUND':
    case 'PROJECT_TRASHED':
    case 'MEDIA_MISSING': return EXIT_CODES.NOT_FOUND;
    case 'MODEL_REQUIRED':
    case 'MODEL_NOT_READY':
    case 'AI_CONFIG_NOT_READY': return EXIT_CODES.NOT_READY;
    case 'VERSION_CONFLICT': return EXIT_CODES.CONFLICT;
    case 'JOB_FAILED':
    case 'JOB_CANCELLED': return EXIT_CODES.JOB_FAILED;
    case 'INTERRUPTED': return EXIT_CODES.INTERRUPTED;
    default: return EXIT_CODES.INTERNAL;
  }
}

export class CliHostError extends Error {
  readonly code: HostErrorCode;
  readonly exitCode: number;
  readonly next?: string;
  readonly details: Record<string, unknown>;

  constructor(code: HostErrorCode, message: string, options: { next?: string; details?: Record<string, unknown>; exitCode?: number } = {}) {
    super(message);
    this.name = 'CliHostError';
    this.code = code;
    this.exitCode = options.exitCode ?? exitCodeForError(code);
    this.next = options.next;
    this.details = options.details ?? {};
  }
}

export interface ConnectionConfig {
  url: string;
  token: string;
  home: string;
}

const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
};

export function inferMediaMimeType(filePath: string): string {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function discoverHostConnection(opts: { host?: string; token?: string; tokenFile?: string; home?: string }): Promise<ConnectionConfig> {
  const home = resolve(opts.home ?? process.env.FLYCUT_HOST_HOME ?? join(homedir(), '.flycut-caption/host'));
  let url = (opts.host ?? process.env.FLYCUT_HOST_URL ?? '').trim().replace(/\/+$/, '');
  let token = (opts.token ?? process.env.FLYCUT_HOST_TOKEN ?? '').trim();
  if (!token && opts.tokenFile) {
    try {
      token = (await readFile(resolve(opts.tokenFile), 'utf8')).trim();
    } catch (error) {
      throw new CliHostError('AUTH_FAILED', `无法读取 token 文件：${error instanceof Error ? error.message : String(error)}`, {
        next: '检查 --token-file 路径或改用 FLYCUT_HOST_TOKEN 环境变量。',
      });
    }
  }
  if (!url || !token) {
    const discoveryPath = join(home, 'connection.json');
    try {
      const parsed = JSON.parse(await readFile(discoveryPath, 'utf8')) as { url?: string; token?: string };
      if (!url && typeof parsed.url === 'string') url = parsed.url.trim().replace(/\/+$/, '');
      if (!token && typeof parsed.token === 'string') token = parsed.token.trim();
    } catch {
      // Fall back to auth.token only when url was explicitly supplied.
    }
  }
  if (!token && url) {
    try { token = (await readFile(join(home, 'auth.token'), 'utf8')).trim(); } catch { /* ignore */ }
  }
  if (!url) {
    throw new CliHostError('NO_HOST_CONNECTION', `未找到运行中的 FlyCut Host（已检查 ${join(home, 'connection.json')}）`, {
      next: '请先启动 FlyCut 桌面端或运行 pnpm host:dev，或显式传入 --host <url> 与 --token <token>。',
    });
  }
  if (!token) {
    throw new CliHostError('AUTH_FAILED', '缺少 Host Bearer 凭证', {
      next: '请传入 --token / --token-file、设置 FLYCUT_HOST_TOKEN，或确保 Host home 下存在 connection.json。',
    });
  }
  let parsedUrl: URL;
  try { parsedUrl = new URL(url); } catch {
    throw new CliHostError('INVALID_ARGUMENT', `Host URL 无效：${url}`, { next: '请提供合法的 http:// 或 https:// 地址。' });
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new CliHostError('INVALID_ARGUMENT', `不支持的 Host 协议：${parsedUrl.protocol}`, { next: '仅支持 http:// 或 https://。' });
  }
  return { url, token, home };
}

async function sha256File(filePath: string): Promise<{ size: number; sha256: string }> {
  const info = await stat(filePath);
  if (!info.isFile()) throw new CliHostError('INVALID_ARGUMENT', `不是普通文件：${filePath}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return { size: info.size, sha256: hash.digest('hex') };
}

function nextHintForError(code: string, message: string): string | undefined {
  if (code === 'AUTH_FAILED') return '请检查 --token、FLYCUT_HOST_TOKEN 或 Host home 中的 connection.json 凭证。';
  if (code === 'NO_HOST_CONNECTION') return '请确认 FlyCut Host 正在运行且地址可达。';
  if (code === 'MODEL_NOT_READY') return '请运行 flycut providers models 查看状态，或运行 flycut providers prepare 下载模型。';
  if (code === 'MODEL_REQUIRED') return '请运行 flycut providers models，并在命令中传入 --provider 与 --model。';
  if (code === 'AI_CONFIG_NOT_READY') return '请先在 FlyCut UI「设置 → API」中添加并选中 Host AI 模型，或使用 flycut ai list 查看可用 configId。';
  if (code === 'VERSION_CONFLICT') return '请先重新读取最新状态（projects get / confirmations get），再重试操作。';
  if (message.includes('未找到') || code === 'NOT_FOUND') return '请检查项目/视频/任务 ID 是否正确，或先运行 flycut projects list。';
  return undefined;
}

export class HostCliClient {
  readonly url: string;
  private readonly token: string;
  private readonly log: (msg: string) => void;

  constructor(config: ConnectionConfig, log: (msg: string) => void) {
    this.url = config.url;
    this.token = config.token;
    this.log = log;
  }

  redact(text: string): string {
    return redactSecrets(text, [this.token]);
  }

  private async fetchHost(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${this.token}`);
      return await fetch(`${this.url}${path}`, { ...init, headers });
    } catch (error) {
      const reason = this.redact(error instanceof Error ? error.message : String(error));
      throw new CliHostError('NO_HOST_CONNECTION', `无法连接 Host（${this.url}）：${reason}`, {
        next: '请确认 Host 仍在运行后重试；若已有任务在进行，可用 flycut jobs get <jobId> 查询进度。',
      });
    }
  }

  async call<M extends RpcMethod>(method: M, ...args: RpcInput<M> extends void ? [] : [RpcInput<M>]): Promise<RpcOutput<M>> {
    const payload = args.length ? args[0] : {};
    const rpcId = randomUUID();
    const response = await this.fetchHost('/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: payload ?? {} }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401 || response.status === 403) {
      throw new CliHostError('AUTH_FAILED', `Host 鉴权失败（HTTP ${response.status}）`, {
        next: '请检查 --token、FLYCUT_HOST_TOKEN 或 connection.json 是否与当前 Host 匹配。',
      });
    }
    if (!response.ok) {
      const bodyText = this.redact(await response.text().catch(() => ''));
      throw new CliHostError('RPC_ERROR', `Host HTTP ${response.status}: ${bodyText.slice(0, 300)}`);
    }
    const envelope = await response.json() as RpcResponse;
    if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId) {
      throw new CliHostError('RPC_ERROR', 'Host 返回了无效的 RPC 信封');
    }
    if (!envelope.result.ok) {
      const err = envelope.result.error;
      const code = (err.code || 'RPC_ERROR') as HostErrorCode;
      const message = this.redact(err.message);
      throw new CliHostError(code, message, {
        next: nextHintForError(code, message),
        details: err.details ?? {},
      });
    }
    return envelope.result.value as RpcOutput<M>;
  }

  async uploadMediaFile(filePath: string, operationId = randomUUID()): Promise<{ assetId: string; size: number; sha256: string; mimeType: string; fileName: string }> {
    const abs = resolve(filePath);
    const { size, sha256 } = await sha256File(abs).catch(error => {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new CliHostError('NOT_FOUND', `本地媒体文件不存在：${abs}`);
      }
      throw error;
    });
    const fileName = basename(abs);
    const mimeType = inferMediaMimeType(abs);
    const caps = await this.call('uploads.capabilities').catch(() => undefined as UploadCapabilities | undefined);

    if (caps && caps.protocolVersion >= 1 && size > 0 && size <= caps.maxBytes && caps.allowedMimeTypes.includes(mimeType)) {
      this.log(`正在分片上传 ${fileName} (${size} bytes)...`);
      const createRes = await this.fetchHost('/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName, size, mimeType, sha256, idempotencyKey: operationId }),
      });
      if (createRes.status === 401 || createRes.status === 403) throw new CliHostError('AUTH_FAILED', `上传鉴权失败（HTTP ${createRes.status}）`);
      if (!createRes.ok) {
        const msg = this.redact(await createRes.text().catch(() => ''));
        throw new CliHostError('RPC_ERROR', `创建上传会话失败（HTTP ${createRes.status}）：${msg.slice(0, 300)}`);
      }
      let session = await createRes.json() as UploadSession;
      if (session.state === 'complete' && session.assetId) {
        return { assetId: session.assetId, size, sha256, mimeType, fileName };
      }
      const confirmed = new Set(session.chunks.map(c => c.index));
      const handle = await open(abs, 'r');
      try {
        for (let index = 0; index < session.chunkCount; index += 1) {
          if (confirmed.has(index)) continue;
          const offset = index * session.chunkSize;
          const length = Math.min(session.chunkSize, size - offset);
          const buf = Buffer.allocUnsafe(length);
          let readTotal = 0;
          while (readTotal < length) {
            const { bytesRead } = await handle.read(buf, readTotal, length - readTotal, offset + readTotal);
            if (bytesRead === 0) break;
            readTotal += bytesRead;
          }
          const slice = readTotal === length ? buf : buf.subarray(0, readTotal);
          const chunkSha = createHash('sha256').update(slice).digest('hex');
          const putRes = await this.fetchHost(`/uploads/${session.id}/chunks/${index}`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-Flycut-Offset': String(offset),
              'X-Chunk-SHA256': chunkSha,
            },
            body: new Uint8Array(slice),
          });
          if (!putRes.ok) {
            const msg = this.redact(await putRes.text().catch(() => ''));
            throw new CliHostError('RPC_ERROR', `上传分片 ${index + 1}/${session.chunkCount} 失败（HTTP ${putRes.status}）：${msg.slice(0, 300)}`);
          }
          session = await putRes.json() as UploadSession;
          this.log(`上传分片 ${index + 1}/${session.chunkCount} (${Math.round(session.uploadedBytes / size * 100)}%)`);
        }
      } finally {
        await handle.close();
      }
      const completeRes = await this.fetchHost(`/uploads/${session.id}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha256 }),
      });
      if (!completeRes.ok) {
        const msg = this.redact(await completeRes.text().catch(() => ''));
        throw new CliHostError('RPC_ERROR', `完成上传校验失败（HTTP ${completeRes.status}）：${msg.slice(0, 300)}`);
      }
      const completed = await completeRes.json() as UploadSession;
      if (!completed.assetId) throw new CliHostError('RPC_ERROR', 'Host 上传完成但未返回 assetId');
      return { assetId: completed.assetId, size, sha256, mimeType, fileName };
    }

    // Fallback to streaming /assets for unsupported MIME or custom Host profiles.
    this.log(`正在流式上传 ${fileName} (${size} bytes)...`);
    const streamRes = await this.fetchHost('/assets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: createReadStream(abs) as unknown as BodyInit,
      // @ts-expect-error Node fetch requires duplex for stream bodies
      duplex: 'half',
    });
    if (streamRes.status === 401 || streamRes.status === 403) throw new CliHostError('AUTH_FAILED', `上传鉴权失败（HTTP ${streamRes.status}）`);
    if (!streamRes.ok) {
      const msg = this.redact(await streamRes.text().catch(() => ''));
      throw new CliHostError('RPC_ERROR', `上传媒体失败（HTTP ${streamRes.status}）：${msg.slice(0, 300)}`);
    }
    const { assetId } = await streamRes.json() as { assetId: string };
    return { assetId, size, sha256, mimeType, fileName };
  }

  async downloadAssetToFile(assetId: string, outPath: string, allowOverwrite: boolean): Promise<{ outPath: string; sizeBytes: number }> {
    const abs = resolve(outPath);
    const existing = await stat(abs).catch(() => undefined);
    if (existing && !allowOverwrite) {
      throw new CliHostError('CONFIRMATION_REQUIRED', `目标文件已存在，未经客户端确认禁止覆盖：${abs}`);
    }
    const response = await this.fetchHost(`/assets/${assetId}`, { method: 'GET' });
    if (response.status === 401 || response.status === 403) throw new CliHostError('AUTH_FAILED', `下载导出资产鉴权失败（HTTP ${response.status}）`);
    if (!response.ok || !response.body) {
      throw new CliHostError('NOT_FOUND', `无法下载导出资产 ${assetId}（HTTP ${response.status}）`);
    }
    const tmp = `${abs}.${randomUUID()}.part`;
    const handle = await open(tmp, 'w');
    let sizeBytes = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        await handle.write(chunk);
        sizeBytes += chunk.length;
      }
      await handle.close();
      const raced = await stat(abs).catch(() => undefined);
      if (raced && !allowOverwrite) {
        throw new CliHostError('CONFIRMATION_REQUIRED', `写入前检测到目标文件已存在，拒绝未确认覆盖：${abs}`);
      }
      await rename(tmp, abs);
      return { outPath: abs, sizeBytes };
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async waitForJob(jobId: string): Promise<JobSnapshot> {
    const wsUrl = new URL('/events', this.url);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: WebSocket | undefined;
    let interrupted = false;
    let lastProgress = '';

    const onSigint = () => { interrupted = true; socket?.terminate(); };
    process.once('SIGINT', onSigint);

    const logProgress = (job: JobSnapshot) => {
      const p = job.progress;
      if (!p) return;
      const pct = typeof p.progress === 'number' ? ` ${Math.round(p.progress)}%` : '';
      const msg = p.data ? ` ${p.data}` : '';
      const line = `[job ${job.id.slice(0, 8)}] ${job.status}${pct}${msg}`;
      if (line !== lastProgress) {
        lastProgress = line;
        this.log(this.redact(line));
      }
    };

    try {
      const initial = await this.call('jobs.get', { id: jobId });
      logProgress(initial);
      if (['complete', 'error', 'cancelled'].includes(initial.status)) return initial;

      return await new Promise<JobSnapshot>((resolveWait, rejectWait) => {
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearInterval(pollTimer);
          clearInterval(sigintTimer);
          try { socket?.terminate(); } catch { /* ignore */ }
          fn();
        };
        const handleJob = (job: JobSnapshot) => {
          if (job.id !== jobId) return;
          logProgress(job);
          if (job.status === 'complete') finish(() => resolveWait(job));
          else if (job.status === 'error') {
            finish(() => rejectWait(new CliHostError('JOB_FAILED', this.redact(job.error || 'Host 任务执行失败'), {
              details: { jobId: job.id, status: job.status, ...(job.operationId ? { operationId: job.operationId } : {}) },
            })));
          } else if (job.status === 'cancelled') {
            finish(() => rejectWait(new CliHostError('JOB_CANCELLED', this.redact(job.error || 'Host 任务已取消'), {
              details: { jobId: job.id, status: job.status },
            })));
          }
        };
        const poll = async () => {
          if (interrupted) {
            const latest = await this.call('jobs.get', { id: jobId }).catch(() => undefined);
            const stillRunning = latest ? (latest.status === 'queued' || latest.status === 'running') : true;
            finish(() => rejectWait(new CliHostError('INTERRUPTED', stillRunning
              ? `已停止本地等待；Host 任务 ${jobId} 仍在运行（状态：${latest?.status ?? 'unknown'}）`
              : `已停止本地等待；Host 任务 ${jobId} 当前状态：${latest?.status ?? 'unknown'}`, {
              next: `使用 flycut jobs get ${jobId} 查询进度，或 flycut jobs cancel ${jobId} 取消任务。`,
              details: { jobId, hostStatus: latest?.status ?? 'unknown', hostStillRunning: stillRunning },
            })));
            return;
          }
          try {
            handleJob(await this.call('jobs.get', { id: jobId }));
          } catch (error) {
            finish(() => rejectWait(error instanceof CliHostError ? error : new CliHostError('NO_HOST_CONNECTION', String(error), {
              next: `重新连接后使用 flycut jobs get ${jobId} 查询任务。`,
              details: { jobId },
            })));
          }
        };

        try {
          socket = new WebSocket(wsUrl, ['flycut', `flycut.token.${base64url(this.token)}`]);
          socket.on('message', raw => {
            try {
              const frame = JSON.parse(String(raw)) as HostFrame;
              if (frame.type === 'host/ready' && frame.protocolVersion !== PROTOCOL_VERSION) {
                finish(() => rejectWait(new CliHostError('RPC_ERROR', `Host 协议版本不兼容：${frame.protocolVersion}`)));
              } else if (frame.type === 'jobs/snapshot') {
                for (const item of frame.jobs) handleJob(item);
              } else if (frame.type === 'event' && frame.name === 'job/updated') {
                handleJob((frame.payload as RemoteEvents['job/updated']).job);
              }
            } catch { /* ignore malformed frame */ }
          });
          socket.on('close', () => {
            if (interrupted) void poll();
          });
          socket.on('error', () => { /* rely on polling / SIGINT */ });
        } catch { /* fallback to polling */ }

        const pollTimer = setInterval(() => { void poll(); }, 1000);
        const sigintTimer = setInterval(() => {
          if (interrupted) {
            clearInterval(sigintTimer);
            void poll();
          }
        }, 50);
        sigintTimer.unref?.();
      });
    } finally {
      process.removeListener('SIGINT', onSigint);
    }
  }
}

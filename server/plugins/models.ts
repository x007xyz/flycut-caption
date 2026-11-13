import type { Context } from '@deepseek-ai/cordis';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, open, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import type { AvailableModel } from '../../src/types/model';
import type { ProgressReporter } from '../services';

/** A downloadable model entry (`models.json` row shape). Each Provider owns its own entries. */
export type ManifestModel = Omit<AvailableModel, 'custom' | 'local_path'>;

export interface ModelService {
  /** Directory holding all verified model files, or undefined when incomplete/unverified. */
  locate(model: ManifestModel): Promise<string | undefined>;
  /** Downloads into the app data directory (mirrors first, archives last), verifies integrity, and returns the directory. */
  download(model: ManifestModel, signal: AbortSignal, report: ProgressReporter): Promise<string>;
}
declare module '@deepseek-ai/cordis' { interface Context { models: ModelService } }

const DEFAULT_DISK_RESERVE_BYTES = 64 * 1024 * 1024;
const VERIFIED_FILE = '.verified.json';
const PROGRESS_INTERVAL_MS = 100;

const exists = (path: string) => access(path).then(() => true, () => false);
const fileStats = (path: string) => stat(path).then(item => (item.isFile() ? item : undefined), () => undefined);
const isNonEmptyFile = async (path: string) => {
  const info = await fileStats(path);
  return !!info && info.size > 0;
};

interface VerifiedRecord {
  version: 1;
  files: Array<{ path: string; size: number; mtimeMs: number; sha256: string | null }>;
}

async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    signal?.throwIfAborted();
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function formatMb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function isFastFailNetworkError(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } })?.code
    ?? (error as { cause?: { code?: string } })?.cause?.code;
  return code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENETUNREACH' || code === 'ECONNREFUSED';
}

function formatErrorMessage(error: unknown): string {
  const err = error as { code?: string; cause?: { code?: string; message?: string }; message?: string };
  const code = err?.code ?? err?.cause?.code;
  if (code === 'ENOSPC') return '磁盘空间不足，无法写入模型文件 (ENOSPC)';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENETUNREACH' || code === 'ECONNREFUSED') {
    return `网络连接失败 (${code})，请检查网络或改选已有模型`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Download sources: per-file mirrors → direct file links → archives; `cn` first within a tier. */
function sortedSources(sources: ManifestModel['download_sources']) {
  const fileMode = (source: ManifestModel['download_sources'][number]) => source.download_mode === 'files' || source.url.endsWith('/');
  const tier = (source: ManifestModel['download_sources'][number]) => fileMode(source) ? 0 : source.url.endsWith('.onnx') ? 1 : source.url.endsWith('.tar.bz2') ? 2 : 3;
  return [...sources].sort((a, b) => tier(a) - tier(b) || Number(a.region !== 'cn') - Number(b.region !== 'cn'))
    .map(source => ({ ...source, fileMode: fileMode(source) }));
}

async function fetchToFile(url: string, target: string, signal: AbortSignal, onBytes: (bytes: number, total: number) => void) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(600_000)]),
        headers: { 'User-Agent': 'FlyCut-Caption/1.0' }, redirect: 'follow' });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      if ((response.headers.get('content-type') ?? '').includes('text/html')) throw new Error(`源返回 HTML 页面而非模型文件：${url}`);
      const total = Number(response.headers.get('content-length') ?? 0);
      const file = await open(target, 'w');
      let received = 0;
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          signal.throwIfAborted();
          await file.write(chunk);
          received += chunk.length;
          onBytes(received, total);
        }
      } finally { await file.close(); }
      if (received === 0) throw new Error(`下载文件为空：${url}`);
      if (total > 0 && received !== total) {
        throw new Error(`下载中断或不完整：已接收 ${received}/${total} 字节`);
      }
      return received;
    } catch (error) {
      await rm(target, { force: true }).catch(() => undefined);
      if (signal.aborted) throw error;
      lastError = error;
      if (isFastFailNetworkError(error) || (error as { code?: string })?.code === 'ENOSPC') throw error;
      if (attempt < 2) await setTimeout(500 * (attempt + 1), undefined, { signal });
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function extractTarBz2(archive: string, destination: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xjf', archive, '-C', destination], { stdio: ['ignore', 'ignore', 'pipe'], signal });
    let stderr = '';
    child.stderr.on('data', data => { stderr += String(data); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`解压失败：${stderr.trim() || `tar 退出码 ${code}`}`)));
  });
}

/**
 * Model file storage shared by built-in Providers: locating verified model directories and downloading
 * them with byte progress, disk space checks, cancellation cleanup, and SHA-256 verification.
 */
export const modelsPlugin = { name: 'flycut-models', inject: ['hostConfig'], apply(ctx: Context) {
  const appData = ctx.hostConfig.appData ?? join(ctx.hostConfig.home, 'app-data');
  const reserveEnv = process.env.FLYCUT_MODEL_DISK_RESERVE_BYTES;
  const parsedReserve = reserveEnv !== undefined ? Number(reserveEnv) : undefined;
  const diskReserve = ctx.hostConfig.modelDiskReserveBytes
    ?? (parsedReserve !== undefined && Number.isFinite(parsedReserve) && parsedReserve >= 0 ? parsedReserve : DEFAULT_DISK_RESERVE_BYTES);

  const candidates = (model: ManifestModel) => [join(appData, 'models', model.id), join(ctx.hostConfig.resourceRoot, 'models', model.id),
    join(ctx.hostConfig.resourceRoot, 'src-tauri/models', model.id)];

  async function readVerifiedCache(dir: string): Promise<VerifiedRecord | undefined> {
    try {
      const raw = JSON.parse(await readFile(join(dir, VERIFIED_FILE), 'utf8')) as VerifiedRecord;
      if (raw?.version === 1 && Array.isArray(raw.files)) return raw;
    } catch { /* missing or corrupt cache */ }
    return undefined;
  }

  async function writeVerifiedCache(dir: string, files: VerifiedRecord['files']) {
    const target = join(dir, VERIFIED_FILE);
    const temp = `${target}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ version: 1, files } satisfies VerifiedRecord, null, 2));
      await rename(temp, target);
    } catch {
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  async function verifyDir(
    dir: string,
    files: ManifestModel['files'],
    options: { signal?: AbortSignal; writeCache?: boolean } = {},
  ): Promise<{ ok: boolean; reason?: string; totalBytes: number; corruptPaths: string[] }> {
    const cache = await readVerifiedCache(dir);
    const verifiedEntries: VerifiedRecord['files'] = [];
    let totalBytes = 0;
    let cacheStale = !cache;
    const corruptPaths: string[] = [];

    for (const file of files) {
      options.signal?.throwIfAborted();
      const fullPath = join(dir, file.path);
      const info = await fileStats(fullPath);
      if (!info || info.size <= 0) {
        return { ok: false, reason: `模型文件缺失或为空：${file.path}`, totalBytes: 0, corruptPaths: info ? [fullPath] : [] };
      }
      totalBytes += info.size;
      const expectedSha = file.sha256 ? file.sha256.toLowerCase() : null;
      const cached = cache?.files.find(entry => entry.path === file.path);
      const cacheHit = cached && cached.size === info.size && Math.abs(cached.mtimeMs - info.mtimeMs) < 1 && cached.sha256 === expectedSha;
      if (expectedSha) {
        if (!cacheHit) {
          cacheStale = true;
          const actualSha = await sha256File(fullPath, options.signal);
          if (actualSha !== expectedSha) {
            corruptPaths.push(fullPath);
            return { ok: false, reason: `模型文件校验失败：${file.path} SHA-256 不匹配`, totalBytes: 0, corruptPaths };
          }
        }
      } else if (!cacheHit) {
        cacheStale = true;
      }
      verifiedEntries.push({ path: file.path, size: info.size, mtimeMs: info.mtimeMs, sha256: expectedSha });
    }

    if (options.writeCache && cacheStale) {
      await writeVerifiedCache(dir, verifiedEntries);
    }
    return { ok: true, totalBytes, corruptPaths: [] };
  }

  async function freeDiskBytes(dir: string): Promise<number | undefined> {
    try {
      const info = await statfs(dir);
      return Number(info.bavail) * Number(info.bsize);
    } catch {
      return undefined;
    }
  }

  async function ensureDiskSpace(dir: string, model: ManifestModel, hasFileSource: boolean) {
    const estimateBytes = Math.max(0, Math.round((model.artifact.size_mb_estimate ?? 0) * 1_000_000));
    const required = hasFileSource ? estimateBytes : Math.round(estimateBytes * 2);
    const available = await freeDiskBytes(dir);
    if (available === undefined) return;
    if (available < required + diskReserve) {
      throw new Error(`磁盘空间不足：需要约 ${formatMb(required + diskReserve)}，当前可用 ${formatMb(available)}`);
    }
  }

  async function locate(model: ManifestModel) {
    for (const dir of candidates(model)) {
      const result = await verifyDir(dir, model.files, { writeCache: true });
      if (result.ok) return dir;
    }
    return undefined;
  }

  async function download(model: ManifestModel, signal: AbortSignal, report: ProgressReporter) {
    const ready = await locate(model);
    if (ready) {
      const size = (await Promise.all(model.files.map(file => fileStats(join(ready, file.path)))))
        .reduce((sum, item) => sum + (item?.size ?? 0), 0);
      report({ status: 'progress', purpose: 'download', phase: 'complete', progress: 100, downloadedBytes: size, totalBytes: size, data: '模型已存在并校验通过' });
      return ready;
    }

    const dir = join(appData, 'models', model.id);
    await mkdir(dir, { recursive: true });
    const sources = sortedSources(model.download_sources);
    await ensureDiskSpace(dir, model, sources.some(s => s.fileMode));

    const errors: string[] = [];
    const estimateBytes = Math.max(0, Math.round((model.artifact.size_mb_estimate ?? 0) * 1_000_000));

    for (const source of sources) {
      signal.throwIfAborted();
      try {
        if (source.fileMode) {
          const base = source.url.endsWith('/') ? source.url : `${source.url}/`;
          let completedBytes = 0;
          for (const file of model.files) {
            const existing = await fileStats(join(dir, file.path));
            if (existing && existing.size > 0 && !file.sha256) completedBytes += existing.size;
          }
          let lastReportAt = 0;
          for (const [index, file] of model.files.entries()) {
            const target = join(dir, file.path);
            const existing = await fileStats(target);
            if (existing && existing.size > 0) {
              if (!file.sha256) continue;
              const hash = await sha256File(target, signal).catch(() => '');
              if (hash === file.sha256.toLowerCase()) {
                completedBytes += existing.size;
                continue;
              }
              await rm(target, { force: true });
            }
            await mkdir(dirname(target), { recursive: true });
            const part = `${target}.part`;
            const fileReceived = await fetchToFile(`${base}${file.path}`, part, signal, (bytes, total) => {
              const now = Date.now();
              if (now - lastReportAt < PROGRESS_INTERVAL_MS && bytes < total) return;
              lastReportAt = now;
              const downloadedBytes = completedBytes + bytes;
              const totalBytes = total > 0 ? completedBytes + total : (estimateBytes > 0 ? estimateBytes : undefined);
              const pct = totalBytes && totalBytes > 0
                ? Math.min(95, Math.round((downloadedBytes / totalBytes) * 95))
                : Math.round((index + (total ? bytes / total : 0)) / model.files.length * 95);
              report({
                status: 'progress', purpose: 'download', phase: 'downloading',
                progress: pct, downloadedBytes, totalBytes, data: `下载 ${file.path}`, file: file.path,
              });
            });
            await rename(part, target);
            completedBytes += fileReceived;
          }
        } else if (source.url.endsWith('.tar.bz2')) {
          const archive = `${dir}.tar.bz2.tmp`;
          let lastReportAt = 0;
          await fetchToFile(source.url, archive, signal, (bytes, total) => {
            const now = Date.now();
            if (now - lastReportAt < PROGRESS_INTERVAL_MS && bytes < total) return;
            lastReportAt = now;
            const totalBytes = total > 0 ? total : (estimateBytes > 0 ? estimateBytes : undefined);
            report({
              status: 'progress', purpose: 'download', phase: 'downloading',
              progress: Math.min(92, Math.round(bytes / (totalBytes || bytes * 2) * 92)),
              downloadedBytes: bytes, totalBytes, data: `下载 ${model.artifact.archive_name}`,
            });
          });
          report({ status: 'progress', purpose: 'download', phase: 'extracting', progress: 94, data: '正在解压归档...' });
          const staging = `${dir}.extract`;
          await rm(staging, { recursive: true, force: true });
          await mkdir(staging, { recursive: true });
          try {
            await extractTarBz2(archive, staging, signal);
            const extracted = join(staging, model.artifact.extract_dir);
            const from = await exists(extracted) ? extracted : staging;
            for (const entry of await readdir(from)) {
              await rename(join(from, entry), join(dir, entry)).catch(async () => {
                await rm(join(dir, entry), { recursive: true, force: true });
                await rename(join(from, entry), join(dir, entry));
              });
            }
          } finally {
            await rm(staging, { recursive: true, force: true });
            await rm(archive, { force: true });
          }
        } else {
          continue;
        }

        report({ status: 'progress', purpose: 'download', phase: 'verifying', progress: 98, data: '正在校验模型文件完整性…' });
        const verified = await verifyDir(dir, model.files, { signal, writeCache: true });
        if (verified.ok) {
          report({
            status: 'progress', purpose: 'download', phase: 'complete', progress: 100,
            downloadedBytes: verified.totalBytes, totalBytes: verified.totalBytes, data: '下载并校验完成',
          });
          return dir;
        }
        for (const bad of verified.corruptPaths) await rm(bad, { force: true }).catch(() => undefined);
        await rm(join(dir, VERIFIED_FILE), { force: true }).catch(() => undefined);
        errors.push(`${source.provider}: ${verified.reason ?? '下载后文件校验失败'}`);
      } catch (error) {
        if (signal.aborted) throw error;
        errors.push(`${source.provider}: ${formatErrorMessage(error)}`);
        if ((error as { code?: string })?.code === 'ENOSPC') break;
      }
    }
    throw new Error(`下载失败：${errors.join('；')}`);
  }

  ctx.provide('models', { locate: async model => (await locate(model)), download } satisfies ModelService);
  void isNonEmptyFile;
} };

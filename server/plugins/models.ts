import type { Context } from '@deepseek-ai/cordis';
import { access, mkdir, readdir, rename, rm, stat, open } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import type { AvailableModel } from '../../src/types/model';
import type { ProgressReporter } from '../services';

/** A downloadable model entry (`models.json` row shape). Each Provider owns its own entries. */
export type ManifestModel = Omit<AvailableModel, 'custom' | 'local_path'>;

export interface ModelService {
  /** Directory holding all of the model's files, or undefined when incomplete. */
  locate(model: ManifestModel): Promise<string | undefined>;
  /** Downloads into the app data directory (mirrors first, archives last) and returns the directory. */
  download(model: ManifestModel, signal: AbortSignal, report: ProgressReporter): Promise<string>;
}
declare module '@deepseek-ai/cordis' { interface Context { models: ModelService } }

const exists = (path: string) => access(path).then(() => true, () => false);
const isFile = (path: string) => stat(path).then(item => item.isFile(), () => false);

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
          await file.write(chunk); received += chunk.length; onBytes(received, total);
        }
      } finally { await file.close(); }
      return;
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error; await setTimeout(1000 * (attempt + 1), undefined, { signal });
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
 * Model file storage shared by built-in Providers: locating complete model directories and downloading
 * them. Which models exist is decided by each Provider, not here (docs/subsystems/providers.md).
 */
export const modelsPlugin = { name: 'flycut-models', inject: ['hostConfig'], apply(ctx: Context) {
  const appData = ctx.hostConfig.appData ?? join(ctx.hostConfig.home, 'app-data');
  const candidates = (model: ManifestModel) => [join(appData, 'models', model.id), join(ctx.hostConfig.resourceRoot, 'models', model.id),
    join(ctx.hostConfig.resourceRoot, 'src-tauri/models', model.id)];
  const complete = async (dir: string, files: ManifestModel['files']) => {
    for (const file of files) if (!await isFile(join(dir, file.path))) return false;
    return true;
  };
  async function locate(model: ManifestModel) {
    for (const dir of candidates(model)) if (await complete(dir, model.files)) return dir;
  }

  async function download(model: ManifestModel, signal: AbortSignal, report: ProgressReporter) {
    const ready = await locate(model);
    if (ready) { report({ status: 'progress', purpose: 'download', progress: 100, data: '模型已存在' }); return ready; }
    const dir = join(appData, 'models', model.id); await mkdir(dir, { recursive: true });
    const errors: string[] = [];
    for (const source of sortedSources(model.download_sources)) {
      signal.throwIfAborted();
      try {
        if (source.fileMode) {
          const base = source.url.endsWith('/') ? source.url : `${source.url}/`;
          for (const [index, file] of model.files.entries()) {
            const target = join(dir, file.path);
            if (await isFile(target)) continue;
            await mkdir(dirname(target), { recursive: true });
            await fetchToFile(`${base}${file.path}`, `${target}.part`, signal, (bytes, total) => report({ status: 'progress', purpose: 'download',
              progress: Math.round((index + (total ? bytes / total : 0)) / model.files.length * 100), data: `下载 ${file.path}`, file: file.path }));
            await rename(`${target}.part`, target);
          }
        } else if (source.url.endsWith('.tar.bz2')) {
          const archive = `${dir}.tar.bz2.tmp`;
          const estimate = (model.artifact.size_mb_estimate ?? 0) * 1_000_000;
          await fetchToFile(source.url, archive, signal, (bytes, total) => report({ status: 'progress', purpose: 'download',
            progress: Math.min(95, Math.round(bytes / (total || estimate || bytes * 2) * 95)), data: `下载 ${model.artifact.archive_name}` }));
          report({ status: 'progress', purpose: 'download', progress: 96, data: '正在解压归档...' });
          const staging = `${dir}.extract`; await rm(staging, { recursive: true, force: true }); await mkdir(staging, { recursive: true });
          try {
            await extractTarBz2(archive, staging, signal);
            const extracted = join(staging, model.artifact.extract_dir);
            const from = await exists(extracted) ? extracted : staging;
            for (const entry of await readdir(from)) await rename(join(from, entry), join(dir, entry)).catch(async () => {
              await rm(join(dir, entry), { recursive: true, force: true }); await rename(join(from, entry), join(dir, entry));
            });
          } finally { await rm(staging, { recursive: true, force: true }); await rm(archive, { force: true }); }
        } else continue;
        if (await complete(dir, model.files)) { report({ status: 'progress', purpose: 'download', progress: 100, data: '下载完成' }); return dir; }
        errors.push(`${source.provider}: 下载后文件不完整`);
      } catch (error) {
        if (signal.aborted) throw error;
        errors.push(`${source.provider}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`没有可用的下载源。${errors.join('；')}`);
  }

  ctx.provide('models', { locate, download } satisfies ModelService);
} };

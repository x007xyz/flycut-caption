import type { Context } from '@deepseek-ai/cordis';
import { access, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile, open } from 'node:fs/promises';
import { isAbsolute, join, basename, dirname, normalize, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import type { AllModelsStatus, AvailableModel } from '../../src/types/model';
import type { ModelScanEntry, ModelScanResult, ModelEnvironment } from '../../shared/protocol';
import type { ProgressReporter } from '../services';

/** Shape of models.json rows (`ManifestModel` in the former Rust implementation). */
export type ManifestModel = Omit<AvailableModel, 'custom'>;
interface SharedAsset { id: string; files: Array<{ path: string }> }
interface Manifest { models: ManifestModel[]; shared_assets?: SharedAsset[] }

export interface ModelService {
  /** Built-in manifest plus the user's custom catalog. */
  catalog(): Promise<ManifestModel[]>;
  list(): Promise<AvailableModel[]>;
  /** Directory holding a model's files, or undefined when files are incomplete. */
  resolve(modelId: string): Promise<{ model: ManifestModel; path: string } | undefined>;
  download(modelId: string, signal: AbortSignal, report: ProgressReporter): Promise<string>;
}
declare module '@deepseek-ai/cordis' { interface Context { models: ModelService } }

const exists = (path: string) => access(path).then(() => true, () => false);
const isFile = (path: string) => stat(path).then(item => item.isFile(), () => false);
const SHERPA_FAMILIES = ['sense_voice', 'paraformer', 'whisper', 'moonshine', 'telespeech_ctc', 'zipformer_ctc', 'nemo_transducer', 'fire_red_asr'];

function safeRelative(value: string) {
  return !!value && !/[\\:?#%]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..') && !isAbsolute(value);
}

/** User model definitions are data, never executable commands or remote Python code. */
export function validateCustomModel(model: ManifestModel) {
  if (!/^custom-[A-Za-z0-9_-]+$/.test(model.id) || model.id.length > 100) throw new Error('自定义模型 ID 必须以 custom- 开头，且只包含英文字母、数字、-、_');
  if (!model.name?.trim() || !model.files?.length) throw new Error('模型名称和文件列表不能为空');
  const paths = new Set<string>();
  for (const file of model.files) {
    if (!safeRelative(file.path) || paths.has(file.path)) throw new Error(`无效或重复的模型文件路径：${file.path}`);
    paths.add(file.path);
    if (file.sha256) throw new Error('当前自定义下载不支持 SHA256 校验，请将 sha256 设为 null');
  }
  if (!model.local_path && !model.download_sources?.length) throw new Error('请选择本地模型目录或提供下载源');
  if (model.local_path && !isAbsolute(model.local_path)) throw new Error('本地模型目录必须使用绝对路径');
  for (const source of model.download_sources ?? []) {
    const url = new URL(source.url);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.search || url.hash || source.download_mode !== 'files') {
      throw new Error('自定义下载源必须为 HTTP(S) 文件目录前缀，download_mode 必须为 files');
    }
  }
  const config = model.recognizer_config as Record<string, unknown> | null;
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('recognizer_config 必须为对象');
  if ((model.provider ?? 'sherpa-onnx') === 'sherpa-onnx') {
    if (!SHERPA_FAMILIES.includes(model.family)) throw new Error('sherpa-onnx 不支持该模型 family；Qwen 模型请选择 qwen-asr Provider');
    if (config.model_type !== model.family) throw new Error('model_type 必须与 family 一致');
    for (const [key, value] of Object.entries(config)) {
      if (key === 'tokens' || key.endsWith('_model') || /encoder|decoder|preprocessor/.test(key) || key === 'joiner') {
        if (typeof value !== 'string') throw new Error('模型文件配置必须为字符串');
        if (!paths.has(value)) throw new Error(`recognizer_config.${key} 必须引用 files 中的文件`);
      }
    }
  } else {
    if (model.family !== 'qwen_asr') throw new Error('qwen-asr 的 family 必须为 qwen_asr');
    if (!paths.has('config.json') || !model.files.some(file => file.path.endsWith('.safetensors'))) throw new Error('Qwen 模型必须包含 config.json 和 safetensors 权重');
    if (config.device !== undefined && !['auto', 'cpu', 'mps', 'cuda:0'].includes(String(config.device))) throw new Error('不支持的 Qwen device');
    if (config.python_path !== undefined && (typeof config.python_path !== 'string' || !isAbsolute(config.python_path))) throw new Error('python_path 必须为 Python 可执行文件的绝对路径');
    if (config.forced_aligner !== undefined && (typeof config.forced_aligner !== 'string' || !isAbsolute(config.forced_aligner))) throw new Error('forced_aligner 必须指向已下载的本地对齐模型目录');
  }
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

function stableId(path: string) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(path)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return `custom-folder-${hash.toString(16).padStart(16, '0')}`;
}

/**
 * Model catalog, custom catalog, library scanning and downloads. Formerly Tauri commands; the Host is
 * now the single control plane so Web and desktop share it. Native folder pickers stay in the shell.
 */
export const modelsPlugin = { name: 'flycut-models', inject: ['hostConfig', 'jobs', 'rpc'], apply(ctx: Context) {
  const appData = ctx.hostConfig.appData ?? join(ctx.hostConfig.home, 'app-data');
  const customFile = join(appData, 'custom-models.json');
  const libraryFile = join(appData, 'model-library.json');
  let manifestCache: Promise<Manifest> | undefined;
  const manifest = () => manifestCache ??= (async () => {
    for (const candidate of [join(ctx.hostConfig.resourceRoot, 'models.json'), join(ctx.hostConfig.resourceRoot, 'src-tauri/models.json')]) {
      if (await exists(candidate)) return JSON.parse(await readFile(candidate, 'utf8')) as Manifest;
    }
    throw new Error('找不到 models.json 模型清单');
  })().catch(error => { manifestCache = undefined; throw error; });
  async function readCustom(): Promise<ManifestModel[]> {
    try {
      const models = JSON.parse(await readFile(customFile, 'utf8')) as ManifestModel[];
      models.forEach(validateCustomModel); return models;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(`自定义模型清单损坏：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let writes = Promise.resolve();
  const mutateCustom = (change: (models: ManifestModel[]) => Promise<ManifestModel[]> | ManifestModel[]) => {
    const run = writes.then(async () => {
      const next = await change(await readCustom());
      await mkdir(appData, { recursive: true });
      await writeFile(`${customFile}.tmp`, JSON.stringify(next, null, 2)); await rename(`${customFile}.tmp`, customFile);
    });
    writes = run.catch(() => undefined); return run;
  };
  const catalog = async () => [...(await manifest()).models, ...await readCustom()];
  const candidates = (model: ManifestModel) => model.local_path ? [model.local_path] : [
    join(appData, 'models', model.id), join(ctx.hostConfig.resourceRoot, 'models', model.id),
    join(ctx.hostConfig.resourceRoot, 'src-tauri/models', model.id)];
  const complete = async (dir: string, files: ManifestModel['files']) => {
    for (const file of files) if (!await isFile(join(dir, file.path))) return false;
    return true;
  };
  async function locate(model: ManifestModel) {
    for (const dir of candidates(model)) if (await complete(dir, model.files)) return dir;
  }
  const find = async (modelId: string) => {
    const model = (await catalog()).find(item => item.id === modelId);
    if (!model) throw new Error(`Unknown model: ${modelId}`);
    return model;
  };

  async function download(modelId: string, signal: AbortSignal, report: ProgressReporter) {
    const model = await find(modelId);
    const ready = await locate(model);
    if (ready) { report({ status: 'progress', purpose: 'download', progress: 100, data: '模型已存在' }); return ready; }
    if (model.local_path) throw new Error('本地模型文件不完整，请补齐文件或重新导入目录');
    const dir = join(appData, 'models', modelId); await mkdir(dir, { recursive: true });
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

  async function status(): Promise<AllModelsStatus> {
    const models = (await catalog()).filter(model => model.enabled);
    const ids: string[] = []; let total = 0; let downloaded = 0;
    for (const model of models) {
      const size = Math.round((model.artifact.size_mb_estimate ?? 0) * 1_000_000); total += size;
      if (await locate(model)) { ids.push(model.id); downloaded += size; }
    }
    return { all_downloaded: ids.length === models.length, downloaded_model_ids: ids, total_models: models.length,
      downloaded_count: ids.length, total_size_bytes: total, downloaded_size_bytes: downloaded };
  }

  async function inspect(path: string, builtIn: ManifestModel[]): Promise<ModelScanEntry | undefined> {
    const name = basename(path);
    const entry: ModelScanEntry = { path, name, kind: 'unsupported', model: null, warnings: [], registered: false };
    const readJson = async (file: string) => {
      if ((await stat(file)).size > 4_000_000) throw new Error('模型配置文件大于 4 MB，已跳过');
      return JSON.parse(await readFile(file, 'utf8'));
    };
    const localize = (model: ManifestModel): ManifestModel => ({ ...structuredClone(model), id: stableId(path), local_path: path, download_sources: [],
      recommended: false, enabled: true, timestamp: { ...model.timestamp, level: 'segment', token_timestamp_verified: false } });
    let model: ManifestModel | undefined;
    try {
      if (await isFile(join(path, 'flycut-model.json'))) model = localize(await readJson(join(path, 'flycut-model.json')));
      else {
        if (await isFile(join(path, 'config.json'))) {
          const config = await readJson(join(path, 'config.json'));
          const type = String(config.model_type ?? ''); const arch = JSON.stringify(config.architectures ?? '').toLowerCase();
          if (type.includes('forced_aligner') || arch.includes('forcedalign') || name.toLowerCase().includes('forcedaligner')) {
            entry.kind = 'aligner'; entry.warnings.push('对齐模型是 ASR 的配套资源，不能单独进行语音识别。可在 Qwen 配置中选择此目录。'); return entry;
          }
          if (type === 'qwen3_asr' && config.thinker_config !== undefined) {
            const files = new Set(['config.json', 'preprocessor_config.json', 'tokenizer_config.json', 'vocab.json', 'merges.txt', 'chat_template.json']);
            if (await isFile(join(path, 'model.safetensors.index.json'))) {
              const weights = (await readJson(join(path, 'model.safetensors.index.json'))).weight_map as Record<string, string> | undefined;
              if (!weights || !Object.keys(weights).length) throw new Error('权重索引为空');
              files.add('model.safetensors.index.json'); Object.values(weights).forEach(file => files.add(file));
            } else files.add('model.safetensors');
            const base = builtIn[0]; if (!base) throw new Error('内置模型清单为空');
            model = localize({ ...base, name, provider: 'qwen-asr', family: 'qwen_asr', languages: ['multi'],
              description: '本地 Qwen3-ASR；未配置 ForcedAligner 时仅提供粗粒度分段时间戳', quantization: undefined,
              artifact: { ...base.artifact, size_mb_estimate: null }, files: [...files].sort().map(file => ({ path: file, sha256: null })),
              recognizer_config: { model_type: 'qwen_asr', tokens: '', device: 'auto', language: 'auto' } });
            entry.warnings.push('需要安装 qwen-asr 的 Python 环境；精细剪辑需配置 ForcedAligner。');
          }
        }
        // Match official sherpa directory names: model.onnx + tokens.txt alone are shared by incompatible architectures.
        if (!model) {
          for (const source of builtIn.filter(item => item.enabled && (item.artifact.extract_dir === name || item.id === name)).sort((a, b) => Number(b.recommended) - Number(a.recommended))) {
            const files = Object.values(source.recognizer_config).filter((value): value is string => typeof value === 'string' && /\.(onnx|txt)$/.test(value)).map(file => ({ path: file, sha256: null }));
            if (files.length && await complete(path, files)) { model = { ...localize(source), files }; break; }
          }
        }
        if (!model) {
          if (await isFile(join(path, 'silero_vad.onnx')) || await isFile(join(path, 'vad.onnx')) || await isFile(join(path, 'vad.mvn'))) {
            entry.kind = 'vad'; entry.warnings.push('VAD 是语音分段资源。当前 sherpa Provider 使用应用内置 VAD；此目录不会作为 ASR 加载。'); return entry;
          }
          const children = await readdir(path).catch(() => [] as string[]);
          if (await isFile(join(path, 'config.json')) || await isFile(join(path, 'tokens.txt')) || children.some(file => /\.(onnx|safetensors|gguf|pt)$/.test(file))) {
            throw new Error('未识别或文件不完整。请保留官方 sherpa 解压目录名；其他已适配格式可添加 flycut-model.json。原始 PyTorch、GGUF、*-hf 检查点不能直接用于 sherpa。');
          }
          return undefined;
        }
      }
      validateCustomModel(model);
      const missing = [];
      for (const file of model.files) if (!await isFile(join(path, file.path))) missing.push(file.path);
      if (missing.length) entry.warnings.push(`缺少文件：${missing.join(', ')}`);
      else { entry.kind = 'asr'; entry.name = model.name; entry.model = { ...model, custom: true }; }
    } catch (error) { entry.warnings.push(error instanceof Error ? error.message : String(error)); }
    return entry;
  }

  async function scan(rootInput: string): Promise<ModelScanResult> {
    const root = await realpath(rootInput).catch(error => { throw new Error(`模型根目录不可用：${error.message}`); });
    if (!(await stat(root)).isDirectory()) throw new Error('请选择文件夹');
    const builtIn = (await manifest()).models; const custom = await readCustom();
    const result: ModelScanResult = { root, entries: [], warnings: [] };
    const queue: Array<[string, number]> = [[root, 0]]; const visited = new Set<string>();
    while (queue.length) {
      const [path, depth] = queue.pop()!;
      if (visited.size >= 2000) { result.warnings.push('目录超过 2000 个，已停止扫描；请选择更具体的模型目录。'); break; }
      if (visited.has(path)) continue; visited.add(path);
      const entry = await inspect(path, builtIn);
      if (entry) {
        entry.registered = custom.some(model => model.local_path === entry.path);
        result.entries.push(entry); if (entry.kind !== 'unsupported') continue;
      }
      if (depth >= 6) { result.warnings.push(`已达到 6 层扫描深度：${path}`); continue; }
      try {
        const dirs = (await readdir(path, { withFileTypes: true })).filter(item => item.isDirectory() && !item.isSymbolicLink() && !item.name.startsWith('.'))
          .map(item => join(path, item.name)).sort().reverse();
        queue.push(...dirs.map(dir => [dir, depth + 1] as [string, number]));
      } catch (error) { result.warnings.push(`无法读取 ${path}：${error instanceof Error ? error.message : String(error)}`); }
    }
    await mkdir(appData, { recursive: true }); await writeFile(libraryFile, JSON.stringify({ root: result.root }));
    return result;
  }

  async function environment(modelId: string): Promise<ModelEnvironment> {
    const model = (await catalog()).find(item => item.id === modelId);
    if (!model) return { modelId, modelReady: false, sidecarReady: false, missingModelFiles: [], modelError: `模型 ${modelId} 不在 manifest 中` };
    const dir = candidates(model)[0]; const missing: string[] = [];
    const located = await locate(model);
    if (!located) for (const file of model.files) if (!await isFile(join(dir, file.path))) missing.push(file.path);
    let sidecarError: string | undefined;
    if (model.provider === 'qwen-asr') {
      const python = (model.recognizer_config as { python_path?: string }).python_path;
      if (python && !await exists(python)) sidecarError = `找不到 Python：${python}`;
    } else {
      const binary = process.env.FLYCUT_FUNASR_SIDECAR ?? join(ctx.hostConfig.resourceRoot, 'src-tauri/binaries', process.platform === 'win32' ? 'funasr-asr.exe' : 'funasr-asr');
      if (!await exists(binary)) sidecarError = `找不到 funasr-asr 识别程序：${binary}。请运行 pnpm build:funasr-sidecar`;
    }
    return { modelId, modelDir: located ?? dir, modelReady: !!located, sidecarReady: !sidecarError, missingModelFiles: missing, sidecarError };
  }

  const service: ModelService = {
    catalog, download,
    list: async () => (await catalog()).filter(model => model.enabled).map(model => ({ ...model, custom: model.id.startsWith('custom-') })),
    resolve: async modelId => { const model = await find(modelId); const path = await locate(model); return path ? { model, path } : undefined; },
  };
  ctx.provide('models', service);
  const customModelSchema = z.custom<ManifestModel>(value => typeof value === 'object' && value !== null);
  ctx.effect(() => ctx.rpc.register('models.list', undefined, () => service.list()));
  ctx.effect(() => ctx.rpc.register('models.status', undefined, status));
  ctx.effect(() => ctx.rpc.register('models.environment', z.object({ modelId: z.string().min(1) }), ({ modelId }) => environment(modelId)));
  ctx.effect(() => ctx.rpc.register('models.download', z.object({ modelId: z.string().min(1) }), ({ modelId }) =>
    ctx.jobs.create(async (signal, report) => ({ path: await download(modelId, signal, report) }))));
  ctx.effect(() => ctx.rpc.register('models.registerCustom', z.object({ model: customModelSchema }), async ({ model: input }) => {
    const model: ManifestModel = structuredClone(input); delete (model as Partial<AvailableModel>).custom;
    validateCustomModel(model);
    if ((await manifest()).models.some(item => item.id === model.id)) throw new Error('不能覆盖内置模型');
    if (model.local_path) {
      const path = normalize(await realpath(model.local_path).catch(error => { throw new Error(`模型目录不可用：${error.message}`); }));
      for (const file of model.files) if (!await isFile(join(path, file.path))) throw new Error(`模型目录缺少 ${file.path}`);
      model.local_path = path.endsWith(sep) ? path.slice(0, -1) : path;
    }
    // A user-supplied capability claim must not enable destructive word-level editing.
    model.timestamp = { ...model.timestamp, level: 'segment', token_timestamp_verified: false }; model.enabled = true;
    await mutateCustom(models => {
      if (models.some(item => item.id === model.id)) throw new Error('该 ID 已存在，请先移除旧配置或使用新 ID');
      return [...models, model];
    });
    return { id: model.id };
  }));
  // Removing a configuration keeps both external and downloaded model files.
  ctx.effect(() => ctx.rpc.register('models.removeCustom', z.object({ modelId: z.string() }), async ({ modelId }) => {
    await mutateCustom(models => models.filter(model => model.id !== modelId)); return { removed: modelId };
  }));
  ctx.effect(() => ctx.rpc.register('models.libraryRoot', undefined, async () => {
    try { return (JSON.parse(await readFile(libraryFile, 'utf8')) as { root?: string }).root ?? null; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }));
  ctx.effect(() => ctx.rpc.register('models.scan', z.object({ root: z.string().min(1) }), ({ root }) => scan(root)));
} };

import type { Context } from '@deepseek-ai/cordis';
import { access, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ModelInfo, OptionField } from '../../shared/providers';
import { normalizeASRApiResponse } from '../../shared/asr/apiProtocol';
import { getWebAsrModel, WEB_ASR_MODELS } from '../../shared/asr/webModels';
import { WHISPER_LANGUAGES } from '../../src/constants/languages';
import type { ManifestModel } from './models';
import type { Provider } from '../services';
import { runJson } from '../providers/process';

const exists = (path: string) => access(path).then(() => true, () => false);
const sizeText = (mb: number | null | undefined) => mb ? (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`) : undefined;
/** Manifest languages use `multi` for "many, detected automatically". */
const languages = (model: ManifestModel) => {
  const list = model.languages.filter(code => code !== 'multi');
  return model.languages.includes('multi') || model.recognizer_config.language === 'auto' ? ['auto', ...list] : list;
};

export function wavSamples(bytes: Buffer) {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Expected PCM WAV audio');
  let offset = 12, sampleRate = 0, channels = 0, bits = 0, format = 0;
  while (offset + 8 <= bytes.length) {
    const name = bytes.toString('ascii', offset, offset + 4); const size = bytes.readUInt32LE(offset + 4); offset += 8;
    if (offset + size > bytes.length) throw new Error('Truncated WAV');
    if (name === 'fmt ') { format = bytes.readUInt16LE(offset); channels = bytes.readUInt16LE(offset + 2); sampleRate = bytes.readUInt32LE(offset + 4); bits = bytes.readUInt16LE(offset + 14); }
    if (name === 'data') {
      if (format !== 1 || channels !== 1 || sampleRate !== 16000 || bits !== 16) throw new Error('Expected 16 kHz mono PCM16 WAV');
      const samples = new Float32Array(Math.floor(size / 2));
      for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(offset + i * 2) / 32768;
      return samples;
    }
    offset += size + size % 2;
  }
  throw new Error('Missing WAV data');
}

/** sherpa-onnx ONNX models from `models.json`, run by the native `funasr-asr` sidecar. */
export const sherpaAsrPlugin = { name: 'flycut-asr-sherpa', inject: ['providers', 'models', 'hostConfig'], apply(ctx: Context) {
  const root = ctx.hostConfig.resourceRoot;
  const sidecar = process.env.FLYCUT_FUNASR_SIDECAR ?? join(root, 'src-tauri/binaries', process.platform === 'win32' ? 'funasr-asr.exe' : 'funasr-asr');
  let manifest: Promise<ManifestModel[]> | undefined;
  const entries = () => manifest ??= (async () => {
    for (const file of [join(root, 'models.json'), join(root, 'src-tauri/models.json')]) {
      if (await exists(file)) {
        const models = (JSON.parse(await readFile(file, 'utf8')) as { models: ManifestModel[] }).models;
        return models.filter(model => model.enabled && (model.provider ?? 'sherpa-onnx') === 'sherpa-onnx');
      }
    }
    throw new Error('找不到 models.json 模型清单');
  })().catch(error => { manifest = undefined; throw error; });
  /** Bundled FSMN VAD (`pnpm fetch:shared-assets`): packaged next to `binaries/`, in development under `src-tauri/`. */
  async function vadDir() {
    for (const dir of [join(dirname(sidecar), '../shared_assets/funasr-fsmn-vad'), join(root, 'src-tauri/shared_assets/funasr-fsmn-vad')]) {
      if (await exists(join(dir, 'model.onnx'))) return dir;
    }
  }
  const find = async (modelId: string) => {
    const model = (await entries()).find(item => item.id === modelId);
    if (!model) throw new Error(`Unknown sherpa-onnx model: ${modelId}`);
    return model;
  };
  const provider: Provider = { id: 'sherpa-onnx', name: 'sherpa-onnx（本地）', kind: 'builtin',
    async models() {
      const binary = await exists(sidecar); const vad = !!await vadDir();
      return Promise.all((await entries()).map(async (model): Promise<ModelInfo> => {
        const options: Record<string, OptionField> = {};
        if (vad) options.vad = { type: 'select', label: 'VAD 分段', default: 'fsmn',
          description: '长音频建议开启：先按语音活动切分再识别', options: [{ value: 'fsmn', label: 'FSMN-VAD' }, { value: 'none', label: '不使用' }] };
        if (model.timestamp.token_timestamp_verified) options.timestamps = { type: 'select', label: '时间戳', default: 'auto',
          options: [{ value: 'auto', label: '自动（字级优先）' }, { value: 'segment', label: '只要句段' }] };
        return { id: model.id, name: model.name, role: 'asr', description: model.description, languages: languages(model),
          timestampLevel: model.timestamp.token_timestamp_verified ? 'word' : 'segment', size: sizeText(model.artifact.size_mb_estimate),
          recommended: model.recommended, options,
          ...!binary ? { status: 'unavailable', reason: `找不到 funasr-asr 识别程序，请运行 pnpm build:funasr-sidecar（${sidecar}）` }
            : { status: await ctx.models.locate(model) ? 'ready' : 'download' } };
      }));
    },
    async prepare(modelId, signal, report) { await ctx.models.download(await find(modelId), signal, report); },
    async transcribe(request, audioPath, signal, report) {
      const model = await find(request.modelId);
      const dir = await ctx.models.locate(model); if (!dir) throw new Error(`模型未下载：${model.name}`);
      const vad = request.options?.vad !== 'none' ? await vadDir() : undefined;
      report({ status: 'running', data: `sherpa-onnx 识别中：${model.name}` });
      return await runJson(sidecar, ['--input', audioPath, '--model', dir, '--model-type', model.family,
        '--recognizer-config', JSON.stringify(model.recognizer_config), ...vad ? ['--vad-type', 'fsmn', '--vad-dir', vad] : ['--vad-type', 'none'],
        '--language', request.language, '--timestamp-mode', request.options?.timestamps === 'segment' ? 'segment' : 'auto', '--output-json'], signal) as never;
    } };
  ctx.effect(() => ctx.providers.register(provider));
} };

const QWEN_FILES = ['chat_template.json', 'config.json', 'generation_config.json', 'merges.txt', 'preprocessor_config.json', 'tokenizer_config.json', 'vocab.json'];
const qwenEntry = (id: string, repo: string, name: string, sizeMb: number, weights: string[]): ManifestModel => ({
  id, name, provider: 'qwen-asr', family: 'qwen_asr', enabled: true, recommended: false, languages: ['multi'], description: '', mode: 'offline',
  supports_subtitle: true, timestamp: { level: 'segment', token_timestamp_verified: false },
  artifact: { archive_name: '', extract_dir: '', size_mb_estimate: sizeMb }, recognizer_config: { model_type: 'qwen_asr', tokens: '' },
  files: [...QWEN_FILES, ...weights].map(path => ({ path, sha256: null })),
  download_sources: [
    { region: 'cn', provider: 'modelscope', download_mode: 'files', url: `https://www.modelscope.cn/models/Qwen/${repo}/resolve/master/` },
    { region: 'global', provider: 'huggingface', download_mode: 'files', url: `https://huggingface.co/Qwen/${repo}/resolve/main/` }],
});
export const QWEN_MODELS = [
  { entry: qwenEntry('qwen3-asr-0.6b', 'Qwen3-ASR-0.6B', 'Qwen3-ASR 0.6B', 1890, ['model.safetensors']), role: 'asr' as const },
  { entry: qwenEntry('qwen3-asr-1.7b', 'Qwen3-ASR-1.7B', 'Qwen3-ASR 1.7B', 4700,
    ['model-00001-of-00002.safetensors', 'model-00002-of-00002.safetensors', 'model.safetensors.index.json']), role: 'asr' as const },
  { entry: qwenEntry('qwen3-forced-aligner-0.6b', 'Qwen3-ForcedAligner-0.6B', 'Qwen3 ForcedAligner 0.6B', 1840, ['model.safetensors']), role: 'align' as const },
];

/** Qwen3-ASR through the official `qwen-asr` package (`python/qwen_asr_runner.py`, one process per job). */
export const qwenAsrPlugin = { name: 'flycut-asr-qwen', inject: ['providers', 'models', 'hostConfig'], apply(ctx: Context) {
  const runner = join(ctx.hostConfig.resourceRoot, 'python/qwen_asr_runner.py');
  const python = process.env.FLYCUT_QWEN_PYTHON ?? process.env.FLYCUT_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  const find = (modelId: string) => {
    const model = QWEN_MODELS.find(item => item.entry.id === modelId);
    if (!model) throw new Error(`Unknown Qwen model: ${modelId}`);
    return model.entry;
  };
  const options: Record<string, OptionField> = {
    aligner: { type: 'select', label: '字词对齐', default: 'none', description: '需要先下载 ForcedAligner；开启后才有字级时间戳',
      options: [{ value: 'none', label: '不使用（每 25 秒一段）' }, { value: 'qwen3-forced-aligner-0.6b', label: 'Qwen3 ForcedAligner 0.6B' }] },
    device: { type: 'select', label: '设备', default: 'auto',
      options: ['auto', 'cpu', 'mps', 'cuda:0'].map(value => ({ value, label: value })) },
  };
  const provider: Provider = { id: 'qwen-asr', name: 'Qwen ASR（本地 Python）', kind: 'builtin',
    models: () => Promise.all(QWEN_MODELS.map(async ({ entry, role }): Promise<ModelInfo> => ({
      id: entry.id, name: entry.name, role, size: sizeText(entry.artifact.size_mb_estimate), status: await ctx.models.locate(entry) ? 'ready' : 'download',
      ...role === 'asr' ? { languages: ['auto', 'zh', 'en', 'yue', 'ja', 'ko'], timestampLevel: 'segment' as const, options,
        description: `需要安装 qwen-asr 的 Python 环境（${python}，可用 FLYCUT_QWEN_PYTHON 指定）` }
        : { description: '为 Qwen3-ASR 提供字词级时间戳' } }))),
    async prepare(modelId, signal, report) { await ctx.models.download(find(modelId), signal, report); },
    async transcribe(request, audioPath, signal, report) {
      const model = find(request.modelId);
      const dir = await ctx.models.locate(model); if (!dir) throw new Error(`模型未下载：${model.name}`);
      const config: Record<string, unknown> = { device: request.options?.device ?? 'auto' };
      if (request.options?.aligner && request.options.aligner !== 'none') {
        const aligner = await ctx.models.locate(find(String(request.options.aligner)));
        if (!aligner) throw new Error('请先下载 Qwen3 ForcedAligner，或把字词对齐设为不使用');
        config.forced_aligner = aligner;
      }
      report({ status: 'running', data: `Qwen 识别中：${model.name}` });
      return await runJson(python, [runner, '--model', dir, '--input', audioPath, '--language', request.language, '--config', JSON.stringify(config)], signal) as never;
    } };
  ctx.effect(() => ctx.providers.register(provider));
} };

type WebModel = NonNullable<ReturnType<typeof getWebAsrModel>>;
/**
 * Loads a Transformers.js recognizer, preferring the OSS mirror. `modelBaseUrl` already ends with the repo id,
 * so the mirror host is the prefix before it. The mirror hosts fp32 encoders only (decoder q8); if it is
 * unavailable the load falls back to HuggingFace with uniform q8 weights.
 */
async function loadRecognizer(model: WebModel) {
  const { pipeline, env } = await import('@huggingface/transformers');
  const defaults = { remoteHost: env.remoteHost, remotePathTemplate: env.remotePathTemplate };
  const load = (dtype: 'q8' | Record<string, 'fp32' | 'q8'>) => pipeline('automatic-speech-recognition', model.modelId, { device: 'cpu', dtype });
  const mirror = model.modelBaseUrl?.endsWith(`/${model.modelId}`) ? model.modelBaseUrl.slice(0, -model.modelId.length) : undefined;
  if (mirror && model.family === 'whisper') {
    try {
      env.remoteHost = mirror; env.remotePathTemplate = '{model}/';
      return await load({ encoder_model: 'fp32', decoder_model_merged: 'q8' });
    } catch (error) {
      console.warn(`[transformers] mirror unavailable for ${model.modelId}, falling back to HuggingFace`, error);
    } finally { Object.assign(env, defaults); }
  }
  return load('q8');
}

export const transformersAsrPlugin = { name: 'flycut-asr-transformers', inject: ['providers', 'hostConfig'], apply(ctx: Context) {
  const downloadedFile = join(ctx.hostConfig.home, 'downloaded-models.json');
  async function downloaded(): Promise<string[]> {
    try { return JSON.parse(await readFile(downloadedFile, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  const find = (modelId: string) => { const model = getWebAsrModel(modelId); if (!model) throw new Error('Unknown Transformers model'); return model; };
  ctx.effect(() => ctx.providers.register({ id: 'transformers', name: 'Transformers.js（Host CPU）', kind: 'builtin',
    async models() {
      const ready = new Set(await downloaded());
      return WEB_ASR_MODELS.map(model => ({ id: model.id, name: model.name, role: 'asr', description: model.description,
        languages: model.languages.includes('multi') ? ['auto', ...Object.keys(WHISPER_LANGUAGES)] : model.languages, timestampLevel: 'segment', size: model.sizeHint,
        recommended: model.recommended, status: ready.has(model.id) ? 'ready' : 'download' }));
    },
    async prepare(modelId, signal, report) {
      const model = find(modelId);
      signal.throwIfAborted();
      report({ status: 'loading', purpose: 'download', data: '后端正在下载 Transformers 模型...' });
      const recognizer = await loadRecognizer(model);
      await recognizer.dispose(); signal.throwIfAborted();
      await writeFile(downloadedFile, JSON.stringify([...new Set([...await downloaded(), modelId])]));
    },
    async transcribe(request, audioPath, signal, report) {
      const model = find(request.modelId);
      const samples = wavSamples(await readFile(audioPath)); signal.throwIfAborted();
      report({ status: 'loading', data: '后端加载 Transformers 模型（CPU）...' });
      const recognizer = await loadRecognizer(model);
      try {
        signal.throwIfAborted();
        const raw = await recognizer(samples, { return_timestamps: true,
          ...(model.family === 'whisper' ? { chunk_length_s: 30, ...(request.language !== 'auto' ? { language: request.language } : {}) } : {}) });
        signal.throwIfAborted();
        const output = Array.isArray(raw) ? raw[0] : raw;
        return normalizeASRApiResponse({ text: output.text, segments: output.chunks?.map(chunk => ({ text: chunk.text,
          start: chunk.timestamp[0] ?? 0, end: chunk.timestamp[1] ?? samples.length / 16000 })) }, samples.length / 16000);
      } finally { await recognizer.dispose(); }
    } }));
} };

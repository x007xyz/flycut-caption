import type { Context } from '@deepseek-ai/cordis';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ModelInfo, OptionField } from '../../shared/providers';
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
  async function sileroVadPath() {
    for (const file of [join(dirname(sidecar), '../shared_assets/silero-vad/silero_vad.onnx'), join(root, 'src-tauri/shared_assets/silero-vad/silero_vad.onnx')]) {
      if (await exists(file)) return file;
    }
  }
  const find = async (modelId: string) => {
    const model = (await entries()).find(item => item.id === modelId);
    if (!model) throw new Error(`Unknown sherpa-onnx model: ${modelId}`);
    return model;
  };
  const provider: Provider = { id: 'sherpa-onnx', name: 'sherpa-onnx（本地）', kind: 'builtin',
    async models() {
      const binary = await exists(sidecar); const vad = !!await vadDir(); const silero = !!await sileroVadPath();
      const models = await Promise.all((await entries()).map(async (model): Promise<ModelInfo> => {
        const options: Record<string, OptionField> = {};
        if (vad) options.vad = { type: 'select', label: 'VAD 分段', default: 'fsmn',
          description: '长音频建议开启：先按语音活动切分再识别', options: [{ value: 'fsmn', label: 'FSMN-VAD' }, { value: 'none', label: '不使用' }] };
        if (model.timestamp.token_timestamp_verified) options.timestamps = { type: 'select', label: '时间戳', default: 'auto',
          options: [{ value: 'auto', label: '自动（字级优先）' }, { value: 'segment', label: '只要句段' }] };
        return { id: model.id, name: model.name, role: 'asr', description: model.description, languages: languages(model),
          timestampLevel: model.timestamp.token_timestamp_verified ? 'word' : 'segment', size: sizeText(model.artifact.size_mb_estimate),
          recommended: model.recommended, offline: true, ...(model.recommendation ? { recommendation: model.recommendation } : {}), options,
          hotwords: { supported: false },
          ...!binary ? { status: 'unavailable', reason: `找不到 funasr-asr 识别程序，请运行 pnpm build:funasr-sidecar（${sidecar}）` }
            : { status: await ctx.models.locate(model) ? 'ready' : 'download' } };
      }));
      return [...models,
        { id: 'fsmn-vad', name: 'FSMN-VAD', role: 'vad', description: '中文口播优先的离线人声检测', languages: ['zh'], recommended: true, offline: true,
          status: binary && vad ? 'ready' : 'unavailable', ...!binary ? { reason: '找不到 funasr-asr 识别程序，请运行 pnpm build:funasr-sidecar' }
            : !vad ? { reason: '找不到 FSMN VAD 资源，请运行 pnpm fetch:shared-assets' } : {} },
        { id: 'silero-vad', name: 'Silero VAD', role: 'vad', description: '多语言离线人声检测', languages: ['auto'], offline: true,
          status: binary && silero ? 'ready' : 'unavailable', ...!binary ? { reason: '找不到 funasr-asr 识别程序，请运行 pnpm build:funasr-sidecar' }
            : !silero ? { reason: '找不到 Silero VAD 资源，请运行 pnpm fetch:shared-assets' } : {} },
      ];
    },
    async prepare(modelId, signal, report) { await ctx.models.download(await find(modelId), signal, report); },
    async detectVoice(modelId, audioPath, signal, report) {
      if (modelId !== 'fsmn-vad' && modelId !== 'silero-vad') throw new Error('Unknown VAD model: ' + modelId);
      report({ status: 'running', data: '人声检测中：' + modelId });
      const args = ['--input', audioPath, '--vad-type', modelId === 'fsmn-vad' ? 'fsmn' : 'silero', '--vad-dump-json'];
      if (modelId === 'fsmn-vad') {
        const dir = await vadDir(); if (!dir) throw new Error('找不到 FSMN VAD 资源');
        args.push('--vad-dir', dir);
      } else {
        const file = await sileroVadPath(); if (!file) throw new Error('找不到 Silero VAD 资源');
        args.push('--vad-model', file);
      }
      const dump = await runJson(sidecar, args, signal) as { vadType: string; duration: number; segments: Array<[number, number]> };
      return { vadType: modelId === 'fsmn-vad' ? 'fsmn' : 'silero', duration: dump.duration,
        segments: dump.segments.map(([start, end]) => [start / 1000, end / 1000]) };
    },
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

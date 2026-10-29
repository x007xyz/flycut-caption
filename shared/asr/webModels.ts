import type { ModelTimestampDto } from '../../src/types/model';

// Web 端（浏览器 Transformers.js）ASR 模型清单
// 与 Tauri 客户端的 models.json 完全独立，仅服务于浏览器引擎。
// 每个 model 的 `id` 是前端引用用的短 id，`modelId` 是 HuggingFace / OSS 的实际仓库 id。
// `modelBaseUrl` 可选：设置后会拦截 huggingface.co 请求并重定向到自建 OSS 镜像
// （Host Transformers Provider 设置 env.remoteHost），加速国内下载。未设置时直接从 HuggingFace 拉取。

export interface WebAsrModelFamily {
  /** 前端分组用的人类可读名称 */
  label: string;
}

export const WEB_MODEL_FAMILY_LABELS: Record<string, string> = {
  whisper: 'Whisper 多语种',
  moonshine: 'Moonshine 英文轻量',
};

export interface WebAsrModel {
  /** 前端引用的短 id */
  id: string;
  /** 下拉显示名称 */
  name: string;
  /** 模型族，用于分组与 worker 内部适配 */
  family: 'whisper' | 'moonshine';
  /** HuggingFace / OSS 仓库 id（传给 transformers.js pipeline） */
  modelId: string;
  /** 自建 OSS 镜像前缀，未设置时直接从 HuggingFace 下载 */
  modelBaseUrl?: string;
  /** 支持的语言列表，['multi'] 表示多语种，['en'] 表示仅英文 */
  languages: string[];
  /** 是否推荐 */
  recommended: boolean;
  /** 是否已通过 smoke test 验证 token/word 级时间戳（用于按字词删除能力提示） */
  tokenTimestampVerified: boolean;
  /** 体积提示文案 */
  sizeHint: string;
  /** 简介 */
  description: string;
}

// OSS 镜像现状（需与 Host Transformers Provider 的 dtype 策略保持一致）：
// - whisper-small：已上传 config/tokenizer + encoder_model.onnx(fp32)
//   + decoder_model_merged_{quantized,q4}.onnx；缺 encoder_model_quantized.onnx
// - whisper-tiny / whisper-base：尚未上传完整权重，暂不配置 modelBaseUrl，
//   直接从 HuggingFace 拉取（worker 仍会对已配置镜像做 404→HF 回退）
// - Moonshine：暂未上传 OSS 镜像
export const WEB_ASR_MODELS: WebAsrModel[] = [
  {
    id: 'whisper-tiny',
    name: 'Whisper Tiny',
    family: 'whisper',
    modelId: 'onnx-community/whisper-tiny',
    languages: ['multi'],
    recommended: false,
    tokenTimestampVerified: true,
    sizeHint: '~75MB (q8)',
    description: '最轻量的 Whisper，速度最快，精度较低，适合实时预览。',
  },
  {
    id: 'whisper-base',
    name: 'Whisper Base',
    family: 'whisper',
    modelId: 'onnx-community/whisper-base',
    languages: ['multi'],
    recommended: false,
    tokenTimestampVerified: true,
    sizeHint: '~145MB (q8)',
    description: 'Whisper Base，速度与精度的折中。',
  },
  {
    id: 'whisper-small',
    name: 'Whisper Small',
    family: 'whisper',
    modelId: 'onnx-community/whisper-small',
    modelBaseUrl:
      'https://fly-cut.oss-cn-hangzhou.aliyuncs.com/models/onnx-community/whisper-small',
    languages: ['multi'],
    recommended: true,
    tokenTimestampVerified: true,
    // encoder 走 fp32、decoder 走 q8/q4（对齐 OSS 实际文件）
    sizeHint: '~500MB (encoder fp32 + decoder q8/q4)',
    description: '推荐：多语种支持好，浏览器本地可用，WASM/WebGPU 均可。',
  },
  {
    id: 'whisper-large-v3-turbo',
    name: 'Whisper Large v3 Turbo',
    family: 'whisper',
    modelId: 'onnx-community/whisper-large-v3-turbo',
    languages: ['multi'],
    recommended: false,
    tokenTimestampVerified: true,
    sizeHint: '~1.5GB (q8)',
    description:
      'Whisper Large v3 Turbo，Large v3 的推理加速版（解码层更少）。权重直连 HuggingFace（公开仓库），建议 WebGPU + 充足内存。',
  },
  {
    id: 'moonshine-tiny',
    name: 'Moonshine Tiny',
    family: 'moonshine',
    modelId: 'onnx-community/moonshine-tiny-int8',
    languages: ['en'],
    recommended: false,
    tokenTimestampVerified: false,
    sizeHint: '~27MB (int8)',
    description: 'Useful Sense 出品的英文轻量模型，体积小速度快，仅英文。',
  },
  {
    id: 'moonshine-base',
    name: 'Moonshine Base',
    family: 'moonshine',
    modelId: 'onnx-community/moonshine-base-int8',
    languages: ['en'],
    recommended: false,
    tokenTimestampVerified: false,
    sizeHint: '~64MB (int8)',
    description: 'Moonshine Base，英文识别精度更好，体积仍很小。',
  },
];

export function getWebModelTimestamp(modelId: string): ModelTimestampDto | undefined {
  const model = WEB_ASR_MODELS.find((entry) => entry.id === modelId);
  if (!model) return undefined;
  return {
    level: model.tokenTimestampVerified ? 'token' : 'segment',
    source: model.tokenTimestampVerified ? 'model' : 'vad',
    token_timestamp_verified: model.tokenTimestampVerified,
  };
}

// 默认 Web 模型 id
export const DEFAULT_WEB_MODEL_ID = 'whisper-small';

/** 按 id 查找 Web 模型定义 */
export function getWebAsrModel(id: string): WebAsrModel | undefined {
  return WEB_ASR_MODELS.find((m) => m.id === id);
}

/** 按 HuggingFace modelId 反查（用于从 engine config 反推 family 等信息） */
export function findWebAsrModelByHFModelId(
  hfModelId: string,
): WebAsrModel | undefined {
  return WEB_ASR_MODELS.find((m) => m.modelId === hfModelId);
}
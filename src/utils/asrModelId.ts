import { WEB_ASR_MODELS } from '../../shared/asr/webModels';
import { DEFAULT_MODEL_ID } from '@/types/model';

const WEB_MODEL_IDS = new Set(WEB_ASR_MODELS.map((model) => model.id));

/** 是否为浏览器 Transformers 专用短 id（与 Tauri manifest 无关） */
export function isWebAsrModelId(modelId: string): boolean {
  return WEB_MODEL_IDS.has(modelId);
}

/**
 * Tauri FunASR 只能使用 models.json manifest 中的 id。
 * 若 store 误存了 Web 短 id（如 whisper-small），回退到默认桌面模型。
 */
export function resolveFunasrModelId(modelId?: string): string {
  const id = modelId?.trim() || DEFAULT_MODEL_ID;
  if (isWebAsrModelId(id)) {
    console.warn(
      `[ASR] 模型 id "${id}" 属于浏览器引擎，Tauri FunASR 回退到 ${DEFAULT_MODEL_ID}`,
    );
    return DEFAULT_MODEL_ID;
  }
  return id;
}
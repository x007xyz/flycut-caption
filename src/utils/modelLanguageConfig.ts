import type { WebAsrModel } from '../../shared/asr/webModels';
import type { AvailableModel } from '@/types/model';
import { getLanguageName, isValidLanguageCode } from '@/constants/languages';

export type ModelLanguageMode = 'selectable' | 'fixed' | 'auto';

export interface ModelLanguageSelectorConfig {
  mode: ModelLanguageMode;
  /** 写入 store / 传给识别引擎的语言值 */
  language: string;
}

const MANIFEST_LANGUAGE_LABELS: Record<string, string> = {
  auto: '自动检测',
  multi: '多语种',
  yue: '粤语',
  multi_european: '欧洲多语种',
};

/** ASR 语言选择器展示名（含 auto 与 manifest 专用语种码） */
export function getAsrLanguageDisplayName(code: string): string {
  if (code === 'auto') {
    return MANIFEST_LANGUAGE_LABELS.auto;
  }
  if (code in MANIFEST_LANGUAGE_LABELS) {
    return MANIFEST_LANGUAGE_LABELS[code];
  }
  const name = getLanguageName(code);
  return name !== 'Unknown' ? name : code;
}

/** 浏览器 Web 模型：Whisper 多语种可选，Moonshine 等固定英文 */
export function getWebModelLanguageConfig(model: WebAsrModel): ModelLanguageSelectorConfig {
  if (model.languages.includes('multi')) {
    return { mode: 'selectable', language: 'en' };
  }

  const fixed = model.languages.find((lang) => lang !== 'multi') ?? 'en';
  return { mode: 'fixed', language: fixed };
}

/** 桌面端 manifest 模型：recognizer_config.language 优先，否则按 languages 推断 */
export function getDesktopModelLanguageConfig(model: AvailableModel): ModelLanguageSelectorConfig {
  const configLang = model.recognizer_config.language;

  if (configLang === 'auto') {
    return { mode: 'auto', language: 'auto' };
  }

  if (configLang) {
    return { mode: 'fixed', language: configLang };
  }

  const normalized = model.languages.filter(
    (lang) => lang !== 'multi' && lang !== 'multi_european',
  );

  if (model.languages.includes('multi') || normalized.length > 1) {
    return { mode: 'auto', language: 'auto' };
  }

  if (normalized.length === 1) {
    return { mode: 'fixed', language: normalized[0] };
  }

  return { mode: 'auto', language: 'auto' };
}

/** 根据模型语言策略，解析应写入 store 的语言值 */
export function resolveLanguageForModel(
  config: ModelLanguageSelectorConfig,
  currentLanguage: string,
): string {
  if (config.mode === 'fixed' || config.mode === 'auto') {
    return config.language;
  }

  if (isValidLanguageCode(currentLanguage)) {
    return currentLanguage;
  }

  return 'en';
}
import type { ModelInfo } from '../../shared/providers';
import { getLanguageName } from '@/constants/languages';

export type ModelLanguageMode = 'selectable' | 'fixed' | 'auto';

export interface ModelLanguageSelectorConfig {
  mode: ModelLanguageMode;
  /** 可选的语言代码；`auto` 表示自动检测 */
  options: string[];
}

const MANIFEST_LANGUAGE_LABELS: Record<string, string> = {
  auto: '自动检测',
  multi: '多语种',
  yue: '粤语',
  multi_european: '欧洲多语种',
};

/** ASR 语言选择器展示名（含 auto 与 manifest 专用语种码） */
export function getAsrLanguageDisplayName(code: string): string {
  if (code in MANIFEST_LANGUAGE_LABELS) {
    return MANIFEST_LANGUAGE_LABELS[code];
  }
  const name = getLanguageName(code);
  return name !== 'Unknown' ? name : code;
}

/** 语言选择完全由模型声明的 `languages` 决定：多个可选，一个就锁定 */
export function getModelLanguageConfig(model?: ModelInfo): ModelLanguageSelectorConfig {
  const options = model?.languages?.length ? model.languages : ['auto'];
  if (options.length > 1) return { mode: 'selectable', options };
  return { mode: options[0] === 'auto' ? 'auto' : 'fixed', options };
}

/** 切换模型后保留仍受支持的语言，否则用模型的第一个语言 */
export function resolveLanguageForModel(config: ModelLanguageSelectorConfig, currentLanguage: string): string {
  return config.options.includes(currentLanguage) ? currentLanguage : config.options[0];
}

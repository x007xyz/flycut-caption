import { useEffect, useMemo, useState } from 'react';
import { getWebAsrModel } from '../../shared/asr/webModels';
import type { AvailableModel } from '@/types/model';
import { useAppStore } from '@/stores/appStore';
import { isTauriRuntime } from '@/utils/runtime';
import {
  getDesktopModelLanguageConfig,
  getWebModelLanguageConfig,
  resolveLanguageForModel,
  type ModelLanguageSelectorConfig,
} from '@/utils/modelLanguageConfig';
import { useClientRuntime } from '@/runtime/context';

const DEFAULT_SELECTABLE_CONFIG: ModelLanguageSelectorConfig = {
  mode: 'selectable',
  language: 'en',
};

/** 当前选中 ASR 模型的语言选择器配置，并在切换模型时同步 store.language */
export function useActiveModelLanguageConfig(): ModelLanguageSelectorConfig {
  const { connection } = useClientRuntime();
  const asrEngineType = useAppStore((s) => s.asrEngineType);
  const asrModelId = useAppStore((s) => s.asrModelId);
  const webModelId = useAppStore((s) => s.webModelId);
  const language = useAppStore((s) => s.language);
  const setLanguage = useAppStore((s) => s.setLanguage);

  const [desktopModel, setDesktopModel] = useState<AvailableModel | undefined>();

  useEffect(() => {
    if (!isTauriRuntime() || asrEngineType !== 'funasr-tauri') {
      setDesktopModel(undefined);
      return;
    }

    let cancelled = false;
    connection.call('models.list')
      .then((models) => {
        if (cancelled) return;
        setDesktopModel(models.find((model) => model.id === asrModelId));
      })
      .catch(() => {
        if (!cancelled) setDesktopModel(undefined);
      });

    return () => {
      cancelled = true;
    };
  }, [asrEngineType, asrModelId, connection]);

  const config = useMemo(() => {
    if (asrEngineType === 'api') return { mode: 'selectable' as const, language: 'en' };
    if (isTauriRuntime() && asrEngineType === 'funasr-tauri' && desktopModel) {
      return getDesktopModelLanguageConfig(desktopModel);
    }

    const webModel = getWebAsrModel(webModelId);
    if (webModel) {
      return getWebModelLanguageConfig(webModel);
    }

    return DEFAULT_SELECTABLE_CONFIG;
    // desktopModel 已按 asrModelId 拉取，模型切换会通过它触发重算。
  }, [asrEngineType, webModelId, desktopModel]);

  useEffect(() => {
    const resolved = resolveLanguageForModel(config, language);
    if (resolved !== language) {
      setLanguage(resolved);
    }
    // 仅在模型或语言策略变化时同步，不干扰 selectable 模式下用户的手动选择
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.mode, config.language, asrModelId, webModelId, setLanguage]);

  return config;
}
import { useEffect, useState } from 'react';
import type { ModelTimestampDto } from '@/types/model';
import { getWebModelTimestamp } from '../../shared/asr/webModels';
import { useAppStore } from '@/stores/appStore';
import { isTauriRuntime } from '@/utils/runtime';
import { useClientRuntime } from '@/runtime/context';

/** 当前选中的 ASR 模型的时间戳能力（manifest token_timestamp_verified） */
export function useActiveModelTimestamp(): ModelTimestampDto | undefined {
  const { connection } = useClientRuntime();
  const asrEngineType = useAppStore((s) => s.asrEngineType);
  const asrModelId = useAppStore((s) => s.asrModelId);
  const webModelId = useAppStore((s) => s.webModelId);
  const [desktopTimestamp, setDesktopTimestamp] = useState<ModelTimestampDto | undefined>();

  useEffect(() => {
    if (!isTauriRuntime() || asrEngineType !== 'funasr-tauri') {
      setDesktopTimestamp(undefined);
      return;
    }

    let cancelled = false;
    connection.call('models.list')
      .then((models) => {
        if (cancelled) return;
        const active = models.find((model) => model.id === asrModelId);
        setDesktopTimestamp(active?.timestamp);
      })
      .catch(() => {
        if (!cancelled) setDesktopTimestamp(undefined);
      });

    return () => {
      cancelled = true;
    };
  }, [asrEngineType, asrModelId, connection]);

  if (asrEngineType === 'api' || asrEngineType === 'python-runtime') return undefined;

  if (asrEngineType === 'funasr-tauri' && isTauriRuntime()) {
    return desktopTimestamp;
  }

  return getWebModelTimestamp(webModelId);
}

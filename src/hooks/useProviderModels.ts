// Provider 模型列表：唯一来源是 Host 的 providers.models
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ModelInfo, ModelRef, ProviderModels, ProviderSummary } from '../../shared/providers';
import { useClientRuntime } from '@/runtime/context';
import type { ModelDownloadEntry } from '@/services/asrService';

const CHANGED_EVENT = 'flycut-provider-models-changed';

/** Call after a download finishes or a service is added/removed so every model list refreshes. */
export function notifyProviderModelsChanged() {
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

export function findModel(groups: ProviderModels[], ref: ModelRef | null | undefined): { provider: ProviderSummary; model: ModelInfo } | undefined {
  if (!ref) return undefined;
  const group = groups.find(item => item.provider.id === ref.providerId);
  const model = group?.models.find(item => item.id === ref.modelId);
  return group && model ? { provider: group.provider, model } : undefined;
}

export function useProviderModels() {
  const { connection } = useClientRuntime();
  const [state, setState] = useState<{ groups: ProviderModels[]; loading: boolean; error?: string }>({ groups: [], loading: true });
  const seqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refresh = useCallback(() => {
    const seq = ++seqRef.current;
    setState(previous => ({ ...previous, loading: true }));
    return connection.call('providers.models').then(
      groups => {
        if (!mountedRef.current || seq !== seqRef.current) return;
        setState({ groups, loading: false });
      },
      error => {
        if (!mountedRef.current || seq !== seqRef.current) return;
        setState(previous => ({ ...previous, loading: false, error: error instanceof Error ? error.message : String(error) }));
      },
    );
  }, [connection]);

  useEffect(() => {
    void refresh();
    const onChanged = () => { void refresh(); };
    window.addEventListener(CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(CHANGED_EVENT, onChanged);
  }, [refresh]);

  return { ...state, refresh };
}

/** Reactive subscription to runtime-scoped model download & verification state. */
export function useModelDownloads(): Record<string, ModelDownloadEntry> {
  const { asr } = useClientRuntime();
  return useSyncExternalStore(asr.subscribeDownloads, asr.getDownloadsSnapshot, asr.getDownloadsSnapshot);
}

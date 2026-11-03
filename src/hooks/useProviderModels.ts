// Provider 模型列表：唯一来源是 Host 的 providers.models
import { useCallback, useEffect, useState } from 'react';
import type { ModelInfo, ModelRef, ProviderModels, ProviderSummary } from '../../shared/providers';
import { useClientRuntime } from '@/runtime/context';

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
  const refresh = useCallback(() => {
    setState(previous => ({ ...previous, loading: true }));
    return connection.call('providers.models').then(
      groups => setState({ groups, loading: false }),
      error => setState(previous => ({ ...previous, loading: false, error: error instanceof Error ? error.message : String(error) })));
  }, [connection]);
  useEffect(() => {
    void refresh();
    window.addEventListener(CHANGED_EVENT, refresh);
    return () => window.removeEventListener(CHANGED_EVENT, refresh);
  }, [refresh]);
  return { ...state, refresh };
}

// 业务 store 由前端 Cordis Context 持有（`ctx.stores`），每个 FlyCut 实例一份；组件仍以 hook 方式读取
import { useStore, type StoreApi } from 'zustand';
import { useClientRuntime } from '@/runtime/context';
import type { AppState, AppActions } from './appStore';
import type { HistoryState, HistoryActions } from './historyStore';
import type { PipelineState } from './pipelineStore';
import type { ProviderConfigState } from './providerConfigStore';
import type { ASRApiState } from './asrApiStore';

export interface RuntimeStores {
  app: StoreApi<AppState & AppActions>;
  history: StoreApi<HistoryState & HistoryActions>;
  pipeline: StoreApi<PipelineState>;
  providerConfig: StoreApi<ProviderConfigState>;
  asrApi: StoreApi<ASRApiState>;
}
declare module '@deepseek-ai/cordis' { interface Context { stores: RuntimeStores } }

type StateOf<K extends keyof RuntimeStores> = RuntimeStores[K] extends StoreApi<infer S> ? S : never;

/** Store API of the current runtime, for reading state inside callbacks (`api.getState()`). */
export function useRuntimeStoreApi<K extends keyof RuntimeStores>(key: K): RuntimeStores[K] {
  return useClientRuntime().stores[key];
}

/** Builds a `useXStore(selector)` hook bound to the store of the surrounding runtime. */
export function bindRuntimeStore<K extends keyof RuntimeStores>(key: K) {
  function useBound(): StateOf<K>;
  function useBound<U>(selector: (state: StateOf<K>) => U): U;
  function useBound<U>(selector?: (state: StateOf<K>) => U) {
    const api = useRuntimeStoreApi(key) as unknown as StoreApi<StateOf<K>>;
    return useStore(api, selector ?? ((state: StateOf<K>) => state as unknown as U));
  }
  return useBound;
}

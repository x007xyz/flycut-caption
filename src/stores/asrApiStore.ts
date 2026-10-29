import { createStore } from 'zustand/vanilla';
import { bindRuntimeStore } from './runtimeStore';
import { persist } from 'zustand/middleware';
import type { ASRApiConfig } from '@/types/asrApi';

export interface ASRApiState {
  configs: ASRApiConfig[];
  selectedId: string | null;
  save: (config: ASRApiConfig) => void;
  remove: (id: string) => void;
  select: (id: string) => void;
}

/** One instance per client runtime; see `ctx.stores`. */
export const createASRApiStore = () => createStore<ASRApiState>()(persist((set) => ({
  configs: [], selectedId: null,
  save: (config) => set(state => ({ configs: [...state.configs.filter(c => c.id !== config.id), config], selectedId: config.id })),
  remove: (id) => set(state => ({ configs: state.configs.filter(c => c.id !== id), selectedId: state.selectedId === id ? null : state.selectedId })),
  select: (id) => set({ selectedId: id }),
}), {
  name: 'asr-api-settings',
  // API 密钥只留在当前进程内；持久化时显式剔除，不写进 localStorage。
  partialize: state => ({
    configs: state.configs.map(config => {
      const persisted: ASRApiConfig = { ...config };
      delete persisted.apiKey;
      return persisted;
    }),
    selectedId: state.selectedId,
  }),
}));

export const useASRApiStore = bindRuntimeStore('asrApi');

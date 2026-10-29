import { createStore } from 'zustand/vanilla';
import { bindRuntimeStore } from './runtimeStore';
import { persist } from 'zustand/middleware';
import type { ProviderInstanceConfig, ProviderSource } from '@/types/provider';

const DEFAULT_CONFIGS: ProviderInstanceConfig[] = [
  { providerId: 'transformers-web', source: 'local', baseUrl: '', modelIds: { asr: 'whisper-small' }, features: { vad: { useNative: false }, timestamps: { useNative: true } }, settings: {} },
  { providerId: 'funasr-local', source: 'local', baseUrl: '', modelIds: { asr: 'sensevoice-small-int8-zh-en-ja-ko-yue-2024-07-17', vad: 'fsmn-vad' }, features: { vad: { useNative: false, externalModelId: 'fsmn-vad' }, timestamps: { useNative: true } }, settings: {} },
  { providerId: 'qwen-asr', source: 'local', baseUrl: '', modelIds: { asr: 'custom-qwen3-asr-0-6b', align: 'custom-qwen-forced-aligner-0-6b' }, features: { vad: { useNative: false }, timestamps: { useNative: false, externalModelId: 'custom-qwen-forced-aligner-0-6b' } }, settings: {} },
  { providerId: 'audio-separator', source: 'local', baseUrl: '', modelIds: { separator: 'mdx-vocal-balanced' }, features: {}, settings: { device: 'auto', chunkDuration: 300 } },
  { providerId: 'openai-compatible', source: 'api', baseUrl: 'https://api.openai.com/v1', modelIds: { asr: 'whisper-1' }, features: { vad: { useNative: false }, timestamps: { useNative: true } }, settings: { timestamps: 'word' } },
];

export interface ProviderConfigState {
  configs: ProviderInstanceConfig[];
  update: (providerId: string, patch: Partial<ProviderInstanceConfig>) => void;
  setSource: (providerId: string, source: ProviderSource) => void;
  setModel: (providerId: string, role: keyof ProviderInstanceConfig['modelIds'], modelId: string) => void;
  setFeature: (providerId: string, feature: keyof ProviderInstanceConfig['features'], patch: Partial<NonNullable<ProviderInstanceConfig['features'][keyof ProviderInstanceConfig['features']]>>) => void;
}

/** One instance per client runtime; see `ctx.stores`. */
export const createProviderConfigStore = () => createStore<ProviderConfigState>()(persist((set) => ({
  configs: DEFAULT_CONFIGS,
  update: (providerId, patch) => set((state) => ({ configs: state.configs.map((config) => config.providerId === providerId ? { ...config, ...patch } : config) })),
  setSource: (providerId, source) => set((state) => ({ configs: state.configs.map((config) => config.providerId === providerId ? { ...config, source } : config) })),
  setModel: (providerId, role, modelId) => set((state) => ({ configs: state.configs.map((config) => config.providerId === providerId ? { ...config, modelIds: { ...config.modelIds, [role]: modelId } } : config) })),
  setFeature: (providerId, feature, patch) => set((state) => ({ configs: state.configs.map((config) => config.providerId === providerId ? { ...config, features: { ...config.features, [feature]: { ...(config.features?.[feature] ?? { useNative: false }), ...patch } } } : config) })),
}), {
  name: 'provider-configurations',
  partialize: (state) => ({ configs: state.configs.map((config) => {
    const persisted = { ...config };
    delete persisted.apiKey;
    return persisted;
  }) }),
}));

export const useProviderConfigStore = bindRuntimeStore('providerConfig');

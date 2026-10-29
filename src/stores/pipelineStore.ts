import { createStore } from 'zustand/vanilla';
import { bindRuntimeStore } from './runtimeStore';
import { persist } from 'zustand/middleware';
import type { PipelineConfig, PipelineStep } from '@/types/provider';

const DEFAULT_PIPELINE: PipelineConfig = {
  schemaVersion: 1,
  id: 'default-caption-pipeline',
  name: '默认字幕流程',
  description: '当前项目的默认本地识别流程。',
  steps: [
    { id: 'preprocess', providerId: 'audio-separator', capabilityId: 'separate-vocals', enabled: false, config: {} },
    { id: 'recognizer', providerId: 'funasr-local', capabilityId: 'transcribe', enabled: true, config: {} },
  ],
};

export interface PipelineState {
  activePipeline: PipelineConfig;
  setPipeline: (pipeline: PipelineConfig) => void;
  updateStep: (stepId: string, patch: Partial<PipelineStep>) => void;
  resetPipeline: () => void;
}

/** One instance per client runtime; see `ctx.stores`. */
export const createPipelineStore = () => createStore<PipelineState>()(persist((set) => ({
  activePipeline: DEFAULT_PIPELINE,
  setPipeline: (activePipeline) => set({ activePipeline }),
  updateStep: (stepId, patch) => set((state) => ({ activePipeline: { ...state.activePipeline, steps: state.activePipeline.steps.map((step) => step.id === stepId ? { ...step, ...patch } : step) } })),
  resetPipeline: () => set({ activePipeline: DEFAULT_PIPELINE }),
}), { name: 'pipeline-settings' }));

export const usePipelineStore = bindRuntimeStore('pipeline');

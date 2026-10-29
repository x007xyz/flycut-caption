/**
 * Provider packages describe installable capability bundles.
 * A provider can expose more than one capability (for example ASR + VAD),
 * while a pipeline composes capabilities from different providers.
 */
export type ProviderCapabilityKind =
  | 'transcribe'
  | 'separate-vocals'
  | 'vad'
  | 'denoise'
  | 'align'
  | 'translate'
  | 'correct';

export type ProviderCapabilityStatus = 'available' | 'planned';

export interface ProviderConfigField {
  type: 'string' | 'number' | 'boolean' | 'select';
  label: string;
  description?: string;
  default?: string | number | boolean;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
}

export interface ProviderCapability {
  id: string;
  kind: ProviderCapabilityKind;
  name: string;
  description: string;
  status: ProviderCapabilityStatus;
  input: string[];
  output: string[];
  configFields?: Record<string, ProviderConfigField>;
}

export interface ProviderModel {
  id: string;
  name: string;
  role: 'asr' | 'vad' | 'align' | 'separator' | 'text';
  description?: string;
  size?: string;
  downloaded?: boolean;
  supportsVad?: boolean;
  timestampLevel?: 'none' | 'segment' | 'word' | 'token';
  supportsWordTimestamps?: boolean;
}

export type ProviderSource = 'local' | 'api';

export type ProviderFeatureKey = 'vad' | 'timestamps' | 'diarization';

export interface ProviderFeatureConfig {
  useNative: boolean;
  externalModelId?: string;
}

export interface ProviderInstanceConfig {
  providerId: string;
  source: ProviderSource;
  baseUrl: string;
  apiKey?: string;
  modelIds: Partial<Record<ProviderModel['role'], string>>;
  features: Partial<Record<ProviderFeatureKey, ProviderFeatureConfig>>;
  settings: Record<string, string | number | boolean>;
}

export interface ProviderPackage {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  runtime: 'browser' | 'tauri' | 'remote' | 'python' | 'mixed';
  status: ProviderCapabilityStatus;
  capabilities: ProviderCapability[];
  models?: ProviderModel[];
}

export interface PipelineStep {
  id: string;
  providerId: string;
  capabilityId: string;
  modelId?: string;
  enabled: boolean;
  config: Record<string, string | number | boolean>;
}

export interface PipelineConfig {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  steps: PipelineStep[];
}

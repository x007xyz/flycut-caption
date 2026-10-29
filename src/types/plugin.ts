import type { ProviderConfigField } from '@/types/provider';

export type ExtensionKind = 'provider' | 'editor-action' | 'analyzer' | 'exporter';

export interface EditorPluginManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  kind: 'editor-action';
  status: 'available' | 'planned';
  input: string[];
  output: string[];
  configFields?: Record<string, ProviderConfigField>;
}

export interface EditorAnalysisInput {
  chunks: Array<{ timestamp: [number, number]; deleted?: boolean }>;
  totalDuration?: number;
}

export interface EditorRange {
  start: number;
  end: number;
  reason: string;
  confidence?: number;
}

export interface EditorAnalysisResult {
  ranges: EditorRange[];
  totalDuration: number;
  metadata?: Record<string, string | number | boolean>;
}

export interface EditOperation {
  type: 'delete-range' | 'keep-range';
  start: number;
  end: number;
  reason: string;
}

export interface EditorPlugin {
  manifest: EditorPluginManifest;
  analyze: (input: EditorAnalysisInput, config: Record<string, unknown>) => EditorAnalysisResult;
  buildOperations: (result: EditorAnalysisResult) => EditOperation[];
}

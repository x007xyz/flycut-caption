import type { OptionField } from '../../shared/providers';

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
  configFields?: Record<string, OptionField>;
}

export interface EditorAnalysisInput {
  chunks: Array<{ id?: string; text?: string; timestamp: [number, number]; deleted?: boolean;
    wordIds?: string[]; edlWordProjection?: boolean }>;
  wordChunks?: Array<{ id: string; text: string; timestamp: [number, number]; sentenceId?: string; deleted?: boolean }>;
  hasWordTimestamps?: boolean;
  totalDuration?: number;
}

export interface EditorRange {
  start: number;
  end: number;
  reason: string;
  confidence?: number;
  category?: string;
  label?: string;
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
  category?: string;
  label?: string;
  confidence?: number;
}

export interface EditorPlugin {
  manifest: EditorPluginManifest;
  analyze: (input: EditorAnalysisInput, config: Record<string, unknown>) => EditorAnalysisResult;
  buildOperations: (result: EditorAnalysisResult) => EditOperation[];
}

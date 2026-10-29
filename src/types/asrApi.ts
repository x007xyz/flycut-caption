export interface ASRApiConfig {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  /** Kept in memory only; excluded from persisted settings. */
  apiKey?: string;
  timestamps: 'none' | 'segment' | 'word';
  timeoutSeconds: number;
}

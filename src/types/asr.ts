/** Device hint forwarded to the Host Transformers Provider (the Host currently runs on CPU). */
export type ASRDevice = 'webgpu' | 'wasm';

/** Optional VAD / alignment / timestamp settings forwarded with an ASR request. */
export interface ASRExecutionConfig {
  vadModelId?: string;
  alignModelId?: string;
  timestampMode?: 'auto' | 'token' | 'segment';
}

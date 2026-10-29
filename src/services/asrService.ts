// Client Cordis service (`ctx.asr`). Inference is owned by Host Cordis Providers.
import type { ASRApiConfig } from '@/types/asrApi';
import type { ASRProgress, SubtitleTranscript } from '@/types/subtitle';
import type { ASRDevice, ASRExecutionConfig } from '@/types/asr';
import type { PipelineInput } from '../../shared/protocol';
import type { RemoteConnection } from '@/runtime/connection';
import { processAudioForASR } from '@/utils/audioUtils';
import { encodePcmWav } from '../../shared/asr/apiProtocol';
import { DEFAULT_WEB_MODEL_ID } from '../../shared/asr/webModels';
import { WEB_MODELS_DOWNLOADED_EVENT } from './webModelCache';

export type ASREngineType = 'transformers' | 'funasr-tauri' | 'python-runtime' | 'api';
export class ASRService {
  private connection: RemoteConnection;
  constructor(connection: RemoteConnection) { this.connection = connection; }
  private engine: ASREngineType = 'transformers';
  private device: ASRDevice = 'wasm';
  private api?: ASRApiConfig;
  private modelId?: string;
  private webModelId = DEFAULT_WEB_MODEL_ID;
  private ready = false;
  private callbacks = new Set<(progress: ASRProgress) => void>();
  private steps?: PipelineInput['steps'];
  setProgressCallback(callback: (progress: ASRProgress) => void) { this.callbacks.clear(); this.callbacks.add(callback); }
  addProgressCallback(callback: (progress: ASRProgress) => void) { this.callbacks.add(callback); return () => { this.callbacks.delete(callback); }; }
  addWhisperProgressCallback(callback: (progress: ASRProgress) => void) { return this.addProgressCallback(callback); }
  private emit(progress: ASRProgress) { this.callbacks.forEach(callback => callback(progress)); }
  configureApi(config: ASRApiConfig) { this.api = { ...config }; }
  setEngineType(engine: ASREngineType) { if (engine !== this.engine) this.ready = false; this.engine = engine; }
  getEngineType() { return this.engine; }
  setDevice(device: ASRDevice) { this.device = device; }
  getCurrentDevice() { return this.device; }
  configure(config: { device?: ASRDevice }) { if (config.device) this.device = config.device; }
  setWebModel(id: string) { this.webModelId = id; this.ready = false; }
  setPipeline(steps?: PipelineInput['steps']) { this.steps = steps; }
  async loadModel(modelId?: string) { this.modelId = modelId ?? this.modelId; await this.connection.call('host.info'); this.ready = true; this.emit({ status: 'loaded' }); }
  prepareModel(modelId?: string) { return this.loadModel(modelId); }
  isReady() { return this.ready; }
  isWhisperReady() { return this.engine === 'transformers' && this.ready; }
  async transcribeAudio(buffer: ArrayBuffer, language = 'en', modelId?: string, executionConfig?: ASRExecutionConfig): Promise<SubtitleTranscript> {
    const connection = this.connection;
    this.emit({ status: 'loading', data: '准备并上传音频到 FlyCut Host...' });
    const samples = await processAudioForASR(buffer);
    const assetId = await connection.upload(encodePcmWav(samples));
    const job = await connection.call('workflow.start', { asr: {
      providerId: this.engine, assetId, language, device: this.device,
      modelId: modelId ?? (this.engine === 'transformers' ? this.webModelId : this.modelId) ?? this.api?.model ?? 'default',
      ...(this.api && this.engine === 'api' ? { api: this.api } : {}), executionConfig,
    }, steps: this.steps });
    const result = await connection.waitJob<{ transcript: SubtitleTranscript; cuts: Array<{ start: number; end: number }> }>(job.id,
      snapshot => { if (snapshot.progress) this.emit(snapshot.progress); })
      .finally(() => { void connection.call('assets.delete', { assetId }).catch(() => undefined); });
    this.emit({ status: 'complete', result: result.transcript });
    return result.transcript;
  }
  async transcribeWithPath(inputPath: string, language = 'en', modelId?: string, executionConfig?: ASRExecutionConfig) {
    // Native paths are converted to an authenticated upload, never accepted as arbitrary RPC filesystem access.
    const { convertFileSrc } = await import('@tauri-apps/api/core');
    const response = await fetch(convertFileSrc(inputPath));
    if (!response.ok) throw new Error('Cannot read selected media');
    return this.transcribeAudio(await response.arrayBuffer(), language, modelId, executionConfig);
  }
  async transcribeAudioWithAutoLoad(buffer: ArrayBuffer, language = 'en', modelId?: string) {
    await this.prepareModel(modelId); return this.transcribeAudio(buffer, language, modelId);
  }
  async checkAllWebModelsDownloaded(): Promise<string[]> { return this.connection.call('asr.downloaded'); }
  async isWebModelDownloaded(id: string) { return (await this.checkAllWebModelsDownloaded()).includes(id); }
  async downloadWebModel(id: string, _device?: ASRDevice) {
    if (_device) this.device = _device;
    const connection = this.connection;
    const job = await connection.call('asr.download', { modelId: id });
    await connection.waitJob(job.id, snapshot => { if (snapshot.progress) this.emit({ ...snapshot.progress, purpose: 'download' }); });
    this.emit({ status: 'downloaded', purpose: 'download', progress: 100 });
    window.dispatchEvent(new Event(WEB_MODELS_DOWNLOADED_EVENT));
  }
  destroy() { this.callbacks.clear(); this.ready = false; }
}

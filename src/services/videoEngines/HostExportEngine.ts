import type { IVideoProcessingEngine, VideoEngineType, EngineCapabilities, VideoProcessingOptions } from '@/types/videoEngine';
import type { VideoFile, VideoSegment, VideoProcessingProgress } from '@/types/video';
import type { SubtitleChunk } from '@/types/subtitle';
import { buildBurnAssContent, buildBurnTextSubtitleContent } from '@/subtitle/burnAss';
import type { RemoteConnection } from '@/runtime/connection';
import { isTauriRuntime } from '@/utils/runtime';
import { loadMediaBlob } from '@/utils/mediaSource';

export class HostExportEngine implements IVideoProcessingEngine {
  readonly name = 'FlyCut Host FFmpeg';
  readonly type: VideoEngineType = 'host';
  readonly version = 'host';
  private connection: RemoteConnection;
  private assetId?: string;
  constructor(connection: RemoteConnection) { this.connection = connection; }
  private onProgress?: (progress: VideoProcessingProgress) => void;

  async checkCapabilities(): Promise<EngineCapabilities> {
    try {
      await this.connection.call('host.info');
      return { supported: true, formats: ['mp4', 'webm'], features: { trimming: true, concatenation: true, audioProcessing: true, subtitleBurning: true, qualityControl: true } };
    } catch (error) {
      return { supported: false, reason: error instanceof Error ? error.message : 'Host 不可用', formats: [], features: { trimming: false, concatenation: false, audioProcessing: false, subtitleBurning: false, qualityControl: false } };
    }
  }

  async initialize(videoFile: VideoFile, onProgress?: (progress: VideoProcessingProgress) => void) {
    this.onProgress = onProgress;
    // Desktop paths and Host project media carry an empty File placeholder; read the bytes from where they live.
    this.assetId = await this.connection.upload(await loadMediaBlob(videoFile));
    this.report('analyzing', 2, '媒体已上传到 Host');
  }

  async processVideo(segments: VideoSegment[], options: VideoProcessingOptions): Promise<Blob> {
    if (!this.assetId) throw new Error('Host 导出引擎未初始化');
    const chunks: SubtitleChunk[] = options.subtitleChunks ?? segments.filter(segment => segment.keep && segment.text).map(segment => ({
      id: segment.id ?? `${segment.start}-${segment.end}`, text: segment.text ?? '', secondText: segment.secondText,
      timestamp: [segment.start, segment.end] as [number, number], deleted: false,
    }));
    let assContent: string | undefined;
    let subtitleTextContent: string | undefined;
    if (options.subtitleProcessing !== 'none' && options.subtitleStylePair && chunks.length) {
      assContent = buildBurnAssContent({ chunks, keptSegments: segments, stylePair: options.subtitleStylePair,
        exportMode: options.subtitleExportMode ?? 'Bilingual', playResX: options.videoWidth ?? 1920, playResY: options.videoHeight ?? 1080,
        softSubtitle: options.subtitleProcessing === 'soft' });
      if (options.subtitleProcessing === 'soft') subtitleTextContent = buildBurnTextSubtitleContent({ chunks, keptSegments: segments, exportMode: options.subtitleExportMode ?? 'Bilingual' });
    }
    const format = options.format ?? options.outputFormat ?? 'mp4';
    if (format !== 'mp4' && format !== 'webm') throw new Error(`Host 导出不支持 ${format} 格式，请选择 MP4 或 WebM`);
    const job = await this.connection.call('export.start', { assetId: this.assetId, edl: options.edl, segments, options: {
      format, quality: options.quality, preserveAudio: options.preserveAudio,
      subtitleProcessing: options.subtitleProcessing ?? 'none', subtitleExportMode: options.subtitleExportMode, assContent, subtitleTextContent,
    } });
    const result = await this.connection.waitJob<{ assetId: string; mimeType: string }>(job.id, current => this.report('encoding', current.progress?.progress ?? 10, current.progress?.data ?? 'Host 正在导出'));
    if (options.outputPath && isTauriRuntime()) {
      // The shell copies the Host asset to the path chosen in the native dialog; an empty Blob means "already saved".
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('save_host_asset', { assetId: result.assetId, outputPath: options.outputPath });
      void this.connection.call('assets.delete', { assetId: result.assetId }).catch(() => undefined);
      this.report('complete', 100, '导出完成');
      return new Blob([], { type: result.mimeType });
    }
    const blob = await this.connection.download(result.assetId);
    void this.connection.call('assets.delete', { assetId: result.assetId }).catch(() => undefined);
    this.report('complete', 100, '导出完成');
    return blob;
  }

  async cleanup() {
    if (this.assetId) void this.connection.call('assets.delete', { assetId: this.assetId }).catch(() => undefined);
    this.assetId = undefined; this.onProgress = undefined;
  }
  configure() { /* Host owns encoder configuration. */ }
  private report(stage: VideoProcessingProgress['stage'], progress: number, message: string) { this.onProgress?.({ stage, progress, message }); }
}

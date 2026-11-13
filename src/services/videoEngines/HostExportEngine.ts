import type { IVideoProcessingEngine, VideoEngineType, EngineCapabilities, VideoProcessingOptions } from '@/types/videoEngine';
import type { VideoFile, VideoSegment, VideoProcessingProgress } from '@/types/video';
import type { SubtitleChunk } from '@/types/subtitle';
import { buildBurnTextSubtitleContent } from '@/subtitle/softSubtitles';
import { buildExportSubtitleScene } from '@/subtitle/graphicsScene';
import type { RemoteConnection } from '@/runtime/connection';
import { isTauriRuntime } from '@/utils/runtime';
import { loadMediaBlob } from '@/utils/mediaSource';
import { TaskOperationRunner, taskOperationKey } from '@/services/taskOperation';

export class HostExportEngine implements IVideoProcessingEngine {
  readonly name = 'FlyCut Host FFmpeg';
  readonly type: VideoEngineType = 'host';
  readonly version = 'host';
  private connection: RemoteConnection;
  private tasks: TaskOperationRunner;
  private assetId?: string;
  constructor(connection: RemoteConnection, tasks = new TaskOperationRunner(connection)) {
    this.connection = connection; this.tasks = tasks;
  }
  private onProgress?: (progress: VideoProcessingProgress) => void;

  async checkCapabilities(): Promise<EngineCapabilities> {
    try {
      const info = await this.connection.call('host.info');
      const supported = info.capabilities?.export === true;
      return { supported, reason: supported ? undefined : 'Host 导出插件不可用', formats: supported ? ['mp4', 'webm'] : [],
        features: { trimming: supported, concatenation: supported, audioProcessing: supported, subtitleBurning: supported, qualityControl: supported } };
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
    let subtitleTextContent: string | undefined;
    let subtitleScene: ReturnType<typeof buildExportSubtitleScene> | undefined;
    if (options.subtitleProcessing === 'hard' && chunks.length) {
      if (!options.subtitleStylePair) throw new Error('字幕样式缺失，无法渲染硬字幕');
      const duration = segments.filter(segment => segment.keep).reduce((total, segment) => total + segment.end - segment.start, 0);
      subtitleScene = buildExportSubtitleScene({ chunks, wordChunks: options.subtitleWordChunks,
        hasWordTimestamps: options.hasWordTimestamps, keptSegments: segments, stylePair: options.subtitleStylePair,
        displayMode: options.subtitleExportMode ?? 'Bilingual', videoWidth: options.videoWidth ?? 1920,
        videoHeight: options.videoHeight ?? 1080, fps: options.fps ?? 30, duration });
    }
    if (options.subtitleProcessing === 'soft' && chunks.length) {
      subtitleTextContent = buildBurnTextSubtitleContent({ chunks, keptSegments: segments, exportMode: options.subtitleExportMode ?? 'Bilingual' });
    }
    const format = options.format ?? options.outputFormat ?? 'mp4';
    if (format !== 'mp4' && format !== 'webm') throw new Error(`Host 导出不支持 ${format} 格式，请选择 MP4 或 WebM`);
    const operationKey = options.operationKey ?? taskOperationKey('export', this.assetId, format, options.quality,
      options.subtitleProcessing ?? 'none', options.subtitleExportMode, segments.length);
    const completed = await this.tasks.run<{ assetId: string; mimeType: string }>({
      kind: 'export', key: operationKey,
      start: operationId => this.connection.call('export.start', { operationId, assetId: this.assetId!, edl: options.edl, segments, options: {
        format, quality: options.quality, preserveAudio: options.preserveAudio, joinFadeMs: options.joinFadeMs,
        subtitleProcessing: options.subtitleProcessing ?? 'none', subtitleExportMode: options.subtitleExportMode,
        subtitleTransport: subtitleScene ? 'skia-band' : undefined, subtitleScene, subtitleTextContent,
      } }),
      progress: current => this.report('encoding', current.progress?.progress ?? 10, current.progress?.data ?? 'Host 正在导出'),
      verifying: () => this.report('analyzing', 0, options.taskVerifyingMessage ?? 'Checking result…'),
    });
    const result = completed.result;
    if (options.outputPath && isTauriRuntime()) {
      // The shell copies the Host asset to the path chosen in the native dialog; an empty Blob means "already saved".
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('save_host_asset', { assetId: result.assetId, outputPath: options.outputPath });
      void this.connection.call('assets.delete', { assetId: result.assetId }).catch(() => undefined);
      void this.tasks.complete('export', operationKey, completed.hostId).catch(() => undefined);
      this.report('complete', 100, '导出完成');
      return new Blob([], { type: result.mimeType });
    }
    const blob = await this.connection.download(result.assetId);
    void this.connection.call('assets.delete', { assetId: result.assetId }).catch(() => undefined);
    void this.tasks.complete('export', operationKey, completed.hostId).catch(() => undefined);
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

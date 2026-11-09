// Host 视频处理器：唯一导出路径，不再保留本地回退引擎。

import type { VideoFile, VideoSegment, VideoProcessingProgress } from '@/types/video';
import type { IVideoProcessingEngine, VideoEngineType, VideoProcessingOptions } from '@/types/videoEngine';
import type { VideoEngineRegistry } from './videoEngines/VideoEngineFactory';

export class UnifiedVideoProcessor {
  private engine: IVideoProcessingEngine | null = null;
  private engines: VideoEngineRegistry;
  private onProgress?: (progress: VideoProcessingProgress) => void;

  constructor(engines: VideoEngineRegistry, onProgress?: (progress: VideoProcessingProgress) => void) {
    this.engines = engines;
    this.onProgress = onProgress;
  }

  setProgressCallback(onProgress?: (progress: VideoProcessingProgress) => void): void {
    this.onProgress = onProgress;
  }

  async initialize(videoFile: VideoFile): Promise<VideoEngineType> {
    await this.cleanup();
    try {
      this.engine = await this.engines.createEngine('host');
      await this.engine.initialize(videoFile, this.onProgress);
      return 'host';
    } catch (error) {
      throw new Error(`视频处理器初始化失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  async processVideo(segments: VideoSegment[], options: VideoProcessingOptions): Promise<Blob> {
    if (!this.engine) throw new Error('处理器未初始化，请先调用 initialize()');
    return await this.engine.processVideo(segments, options);
  }

  async cleanup(): Promise<void> {
    if (this.engine) {
      await this.engine.cleanup();
      this.engine = null;
    }
  }
}

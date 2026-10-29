// 统一的视频处理器 - 支持多种引擎

import type { VideoFile, VideoSegment, VideoProcessingProgress } from '@/types/video';
import type { IVideoProcessingEngine, VideoEngineType, VideoProcessingOptions } from '@/types/videoEngine';
import type { VideoEngineRegistry } from './videoEngines/VideoEngineFactory';

export class UnifiedVideoProcessor {
  private currentEngine: IVideoProcessingEngine | null = null;
  private onProgress?: (progress: VideoProcessingProgress) => void;
  private engines: VideoEngineRegistry;

  constructor(engines: VideoEngineRegistry, onProgress?: (progress: VideoProcessingProgress) => void) {
    this.engines = engines;
    this.onProgress = onProgress;
  }

  setProgressCallback(onProgress?: (progress: VideoProcessingProgress) => void): void {
    this.onProgress = onProgress;
  }

  /**
   * 初始化视频处理器
   * @param videoFile 视频文件
   * @param preferredEngine 首选引擎类型
   * @param fallbackEngines 备选引擎列表
   */
  async initialize(
    videoFile: VideoFile, 
    preferredEngine?: VideoEngineType,
    fallbackEngines?: VideoEngineType[]
  ): Promise<VideoEngineType> {
    try {
      // 清理之前的引擎
      await this.cleanup();

      const defaults = this.engines.getDefaultEngineOrder();
      const fallbacks = fallbackEngines ?? defaults;
      const engineOrder = preferredEngine
        ? [preferredEngine, ...fallbacks.filter(e => e !== preferredEngine)]
        : fallbacks;

      // 尝试获取最佳可用引擎
      const { engine, type } = await this.engines.getBestAvailableEngine(engineOrder);
      this.currentEngine = engine;

      // 初始化引擎
      await this.currentEngine.initialize(videoFile, this.onProgress);

      console.log(`视频处理器初始化完成，使用引擎: ${type}`);
      return type;
    } catch (error) {
      console.error('视频处理器初始化失败:', error);
      throw new Error(`视频处理器初始化失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
  }



  /**
   * 处理视频
   */
  async processVideo(segments: VideoSegment[], options: VideoProcessingOptions): Promise<Blob> {
    if (!this.currentEngine) {
      throw new Error('处理器未初始化，请先调用 initialize()');
    }

    return await this.currentEngine.processVideo(segments, options);
  }

  /**
   * 获取当前引擎信息
   */
  getCurrentEngineInfo(): { name: string; type: VideoEngineType; version?: string } | null {
    if (!this.currentEngine) return null;
    
    return {
      name: this.currentEngine.name,
      type: this.currentEngine.type,
      version: this.currentEngine.version,
    };
  }

  /**
   * 切换引擎
   */
  async switchEngine(newEngineType: VideoEngineType, videoFile: VideoFile): Promise<void> {
    try {
      console.log(`切换视频处理引擎到: ${newEngineType}`);
      
      // 清理当前引擎
      await this.cleanup();

      // 创建新引擎
      this.currentEngine = await this.engines.createEngine(newEngineType);
      
      // 初始化新引擎
      await this.currentEngine.initialize(videoFile, this.onProgress);
      
      console.log(`成功切换到引擎: ${newEngineType}`);
    } catch (error) {
      console.error(`切换引擎失败:`, error);
      throw new Error(`切换引擎失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  /**
   * 检查所有可用引擎
   */
  async checkAllEngines() {
    return await this.engines.checkAllEngines();
  }

  /**
   * 配置当前引擎
   */
  configureEngine(config: Record<string, unknown>): void {
    if (this.currentEngine?.configure) {
      this.currentEngine.configure(config);
    }
  }

  /**
   * 清理资源
   */
  async cleanup(): Promise<void> {
    if (this.currentEngine) {
      await this.currentEngine.cleanup();
      this.currentEngine = null;
    }
  }

  /**
   * 获取支持的引擎类型
   */
  getSupportedEngines(): VideoEngineType[] {
    return this.engines.getSupportedEngines();
  }
}
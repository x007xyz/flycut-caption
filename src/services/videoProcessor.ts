import { Combinator, MP4Clip, OffscreenSprite } from '@webav/av-cliper';
import type { VideoSegment, VideoFile, VideoProcessingProgress } from '@/types/video';
import { loadMediaBlob } from '@/utils/mediaSource';

export interface ProcessingOptions {
  format?: 'mp4' | 'webm';
  outputFormat?: 'mp4' | 'webm';
  quality: 'high' | 'medium' | 'low';
  preserveAudio: boolean;
}

export class VideoProcessor {
  private combinator: Combinator | null = null;
  private videoClip: MP4Clip | null = null;
  private onProgress?: (progress: VideoProcessingProgress) => void;

  constructor(onProgress?: (progress: VideoProcessingProgress) => void) {
    this.onProgress = onProgress;
  }

  async initialize(videoFile: VideoFile): Promise<void> {
    try {
      this.reportProgress('analyzing', 0, '正在初始化视频处理器...');
      
      // 创建视频片段 - 将File转换为ReadableStream
      const fileStream = (await loadMediaBlob(videoFile)).stream();
      this.videoClip = new MP4Clip(fileStream);
      await this.videoClip.ready;

      this.reportProgress('analyzing', 30, '视频处理器初始化完成');
    } catch (error) {
      console.error('VideoProcessor初始化失败:', error);
      this.reportProgress('error', 0, '初始化失败', error instanceof Error ? error.message : '未知错误');
      throw error;
    }
  }

  async processVideo(
    segments: VideoSegment[],
    options: ProcessingOptions = {
      outputFormat: 'mp4',
      quality: 'medium',
      preserveAudio: true
    }
  ): Promise<Blob> {
    if (!this.videoClip) {
      throw new Error('视频处理器未初始化');
    }

    try {
      this.reportProgress('analyzing', 50, '分析视频片段...');

      // 将要保留的片段按时间排序
      const keepSegments = segments
        .filter(segment => segment.keep)
        .sort((a, b) => a.start - b.start);

      if (keepSegments.length === 0) {
        throw new Error('没有选择要保留的片段');
      }

      this.reportProgress('cutting', 0, '创建视频合成器...');

      // 创建合成器 - 修正audio选项类型
      const combinatorOptions: {
        width: number;
        height: number;
        audio?: false;
      } = {
        width: this.videoClip.meta.width,
        height: this.videoClip.meta.height,
      };
      
      // 如果不保留音频，则设置audio为false
      if (!options.preserveAudio) {
        combinatorOptions.audio = false;
      }
      
      this.combinator = new Combinator(combinatorOptions);

      this.reportProgress('cutting', 20, '添加视频片段...');

      // 简化版实现：为每个保留的片段创建一个OffscreenSprite
      // 注意：这个实现可能不完美，但展示了基本概念
      
      let totalDuration = 0;
      for (let i = 0; i < keepSegments.length; i++) {
        const segment = keepSegments[i];
        const progress = Math.round(20 + (i / keepSegments.length) * 40);
        
        this.reportProgress('cutting', progress, `添加片段 ${i + 1}/${keepSegments.length}`);

        // 创建sprite并设置时间
        const sprite = new OffscreenSprite(this.videoClip);
        
        // 设置sprite的时间范围 - 这需要进一步调试和完善
        sprite.time = {
          offset: totalDuration * 1e6, // 在输出视频中的开始时间
          duration: (segment.end - segment.start) * 1e6 // 片段持续时间
        };

        // 添加到合成器
        await this.combinator.addSprite(sprite, { main: i === 0 });

        totalDuration += (segment.end - segment.start);
      }

      this.reportProgress('encoding', 0, '开始合成视频...');

      // 生成输出流
      const outputStream = this.combinator.output();
      
      this.reportProgress('encoding', 20, '正在读取视频流...');
      
      // 将流转换为Blob
      const chunks: Uint8Array[] = [];
      const reader = outputStream.getReader();

      let progress = 20;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        
        // 更新进度
        progress = Math.min(90, progress + 1);
        this.reportProgress('encoding', progress, '正在编码...');
      }

      const resultBlob = new Blob(chunks, {
        type: 'video/mp4'
      });

      this.reportProgress('complete', 100, '视频处理完成！');
      return resultBlob;

    } catch (error) {
      console.error('视频处理失败:', error);
      const errorMessage = error instanceof Error ? error.message : '处理失败';
      this.reportProgress('error', 0, '视频处理失败', errorMessage);
      throw error;
    }
  }


  private reportProgress(
    stage: VideoProcessingProgress['stage'],
    progress: number,
    message: string,
    error?: string
  ): void {
    if (this.onProgress) {
      this.onProgress({
        stage,
        progress: Math.max(0, Math.min(100, progress)),
        message,
        error,
      });
    }
  }

  async dispose(): Promise<void> {
    try {
      if (this.combinator) {
        await this.combinator.destroy();
        this.combinator = null;
      }
      if (this.videoClip) {
        await this.videoClip.destroy();
        this.videoClip = null;
      }
    } catch (error) {
      console.error('清理视频处理器时出错:', error);
    }
  }
}

export const createVideoProcessor = (onProgress?: (progress: VideoProcessingProgress) => void) => {
  return new VideoProcessor(onProgress);
};
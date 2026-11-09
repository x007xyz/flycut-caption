// FFmpeg.wasm 视频处理引擎实现
import { exportSegments, ffmpegVideoFilter, outputDuration } from '../../../shared/editing/edl';
import { buildBurnTextSubtitleContent } from '@/subtitle/burnAss';
import { buildExportSubtitleScene, ensureSubtitleFonts } from '@/subtitle';
import { createSubtitleOverlayVideo, type SubtitleOverlayVideo } from './subtitleOverlayVideo';

import type { 
  IVideoProcessingEngine, 
  VideoEngineType, 
  EngineCapabilities, 
  VideoProcessingOptions 
} from '@/types/videoEngine';
import type { VideoFile, VideoSegment, VideoProcessingProgress } from '@/types/video';

interface FFmpegDirEntry {
  name: string;
}

interface FFmpegWasmInstance {
  on(event: 'progress', handler: (data: { progress: number }) => void): void;
  on(event: 'log', handler: (data: { message: string }) => void): void;
  load(): Promise<void>;
  writeFile(name: string, data: Uint8Array): Promise<void>;
  readFile(name: string): Promise<Uint8Array>;
  exec(args: string[]): Promise<void>;
  listDir(path: string): Promise<FFmpegDirEntry[]>;
  deleteFile(name: string): Promise<void>;
}

interface FFmpegWasmModule {
  FFmpeg: new () => FFmpegWasmInstance;
}

declare global {
  interface Window {
    FFmpeg?: FFmpegWasmModule;
  }
}

export class FFmpegEngine implements IVideoProcessingEngine {
  readonly name = 'FFmpeg.wasm';
  readonly type: VideoEngineType = 'ffmpeg';
  readonly version = '0.12.0';

  private ffmpeg: FFmpegWasmInstance | null = null;
  private onProgress?: (progress: VideoProcessingProgress) => void;
  private isLoaded = false;
  private inputFileName = 'input.mp4';
  private hasAudio = false;
  private subtitleFile: 'subtitles.vtt' | null = null;
  private subtitleOverlay: SubtitleOverlayVideo | null = null;

  async checkCapabilities(): Promise<EngineCapabilities> {
    try {
      // 检查是否支持 SharedArrayBuffer (FFmpeg.wasm 需要)
      const supportsSharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';
      
      // 检查是否支持 WebAssembly
      const supportsWasm = typeof WebAssembly !== 'undefined';

      if (!supportsSharedArrayBuffer) {
        return {
          supported: false,
          reason: '浏览器不支持 SharedArrayBuffer，请确保网站在 HTTPS 环境下运行并启用了跨域隔离',
          formats: [],
          features: {
            trimming: false,
            concatenation: false,
            audioProcessing: false,
            subtitleBurning: false,
            qualityControl: false,
          }
        };
      }

      if (!supportsWasm) {
        return {
          supported: false,
          reason: '浏览器不支持 WebAssembly',
          formats: [],
          features: {
            trimming: false,
            concatenation: false,
            audioProcessing: false,
            subtitleBurning: false,
            qualityControl: false,
          }
        };
      }

      return {
        supported: true,
        formats: ['mp4', 'webm', 'avi', 'mov', 'mkv'],
        maxFileSize: 2 * 1024 * 1024 * 1024, // 2GB
        features: {
          trimming: true,
          concatenation: true,
          audioProcessing: true,
          subtitleBurning: true, // FFmpeg 支持字幕烧录
          qualityControl: true,
        }
      };
    } catch (error) {
      return {
        supported: false,
        reason: `FFmpeg 引擎检查失败: ${error instanceof Error ? error.message : '未知错误'}`,
        formats: [],
        features: {
          trimming: false,
          concatenation: false,
          audioProcessing: false,
          subtitleBurning: false,
          qualityControl: false,
        }
      };
    }
  }

  async initialize(videoFile: VideoFile, onProgress?: (progress: VideoProcessingProgress) => void): Promise<void> {
    try {
      this.onProgress = onProgress;
      this.reportProgress('analyzing', 0, '加载 FFmpeg.wasm...');

      // 动态加载 FFmpeg.wasm
      if (!window.FFmpeg) {
        await this.loadFFmpegLibrary();
      }

      // 创建 FFmpeg 实例
      const { FFmpeg } = window.FFmpeg!;
      this.ffmpeg = new FFmpeg();

      this.reportProgress('analyzing', 30, '初始化 FFmpeg 实例...');

      // 设置进度回调
      this.ffmpeg.on('progress', ({ progress }: { progress: number }) => {
        this.reportProgress('encoding', progress * 100, '处理中...');
      });

      this.ffmpeg.on('log', ({ message }: { message: string }) => {
        if (/Stream.*Audio:/.test(message)) this.hasAudio = true;
        console.log('FFmpeg:', message);
      });

      // 加载 FFmpeg 核心
      this.reportProgress('analyzing', 60, '加载 FFmpeg 核心...');
      await this.ffmpeg.load();

      this.reportProgress('analyzing', 90, '准备视频文件...');

      // 将视频文件写入 FFmpeg 文件系统
      const videoData = await fetch(videoFile.url).then(r => r.arrayBuffer());
      const videoFileName = `input.${this.getFileExtension(videoFile.name)}`;
      this.inputFileName = videoFileName; this.hasAudio = false;
      await this.ffmpeg.writeFile(videoFileName, new Uint8Array(videoData));

      await this.ffmpeg.exec(['-i', videoFileName, '-t', '0', '-f', 'null', '-']);
      this.isLoaded = true;
      this.reportProgress('analyzing', 100, 'FFmpeg 引擎初始化完成');

      console.log('FFmpeg 引擎初始化成功');
    } catch (error) {
      console.error('FFmpeg 引擎初始化失败:', error);
      throw new Error(`FFmpeg 引擎初始化失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  async processVideo(segments: VideoSegment[], options: VideoProcessingOptions): Promise<Blob> {
    if (!this.isLoaded || !this.ffmpeg) {
      throw new Error('引擎未初始化，请先调用 initialize()');
    }

    try {
      this.reportProgress('encoding', 0, '分析视频片段...');

      // 筛选保留的片段
      const keptSegments = segments
        .filter(seg => seg.keep)
        .sort((a, b) => a.start - b.start);

      if (keptSegments.length === 0) {
        throw new Error('没有要保留的视频片段');
      }

      const inputFileName = this.inputFileName;
      if (options.edl && JSON.stringify(keptSegments.map(s => [s.start, s.end])) !== JSON.stringify(exportSegments(options.edl).map(s => [s.start, s.end])))
        throw new Error('The supplied segments disagree with the EDL');
      this.subtitleFile = null;
      this.subtitleOverlay = null;
      if (options.subtitleProcessing && options.subtitleProcessing !== 'none' && options.subtitleChunks?.length) {
        const mode = options.subtitleExportMode ?? 'Bilingual';
        if (options.subtitleProcessing === 'soft') {
          const content = buildBurnTextSubtitleContent({ chunks: options.subtitleChunks, keptSegments, exportMode: mode });
          this.subtitleFile = 'subtitles.vtt';
          await this.ffmpeg.writeFile(this.subtitleFile, new TextEncoder().encode(content));
        } else {
          if (!options.subtitleStylePair) throw new Error('字幕样式缺失，无法渲染硬字幕');
          await ensureSubtitleFonts();
          const duration = keptSegments.reduce((total, segment) => total + segment.end - segment.start, 0);
          const scene = buildExportSubtitleScene({
            chunks: options.subtitleChunks,
            keptSegments,
            stylePair: options.subtitleStylePair,
            displayMode: mode,
            videoWidth: options.videoWidth ?? 1920,
            videoHeight: options.videoHeight ?? 1080,
            fps: options.fps ?? 30,
            duration,
          });
          this.reportProgress('encoding', 8, '渲染字幕层...');
          this.subtitleOverlay = await createSubtitleOverlayVideo(this.ffmpeg, scene);
        }
      }
      options = { ...options, preserveAudio: options.preserveAudio && this.hasAudio };
      const outputFormat = options.format || 'mp4';
      const outputFileName = `output.${outputFormat}`;

      this.reportProgress('encoding', 10, '构建 FFmpeg 命令...');

      // 构建 FFmpeg 命令
      const ffmpegArgs = this.buildFFmpegCommand(
        inputFileName,
        outputFileName,
        keptSegments,
        options
      );

      console.log('执行 FFmpeg 命令:', ffmpegArgs.join(' '));
      this.reportProgress('encoding', 20, '执行视频处理...');

      // 执行 FFmpeg 命令
      await this.ffmpeg.exec(ffmpegArgs);

      this.reportProgress('encoding', 90, '读取处理结果...');

      // 读取输出文件
      const outputData = await this.ffmpeg.readFile(outputFileName);
      
      // 创建 Blob
      const mimeType = this.getMimeType(outputFormat);
      const outputBlob = new Blob([outputData], { type: mimeType });

      this.reportProgress('complete', 100, '视频处理完成');

      console.log('FFmpeg 视频处理完成:', {
        originalSegments: segments.length,
        keptSegments: keptSegments.length,
        outputSize: outputBlob.size,
        outputType: outputBlob.type
      });

      return outputBlob;
    } catch (error) {
      console.error('FFmpeg 视频处理失败:', error);
      throw new Error(`视频处理失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  async cleanup(): Promise<void> {
    try {
      if (this.ffmpeg) {
        // 清理 FFmpeg 文件系统中的临时文件
        try {
          const files = await this.ffmpeg.listDir('/');
          for (const file of files) {
            if (file.name !== '.' && file.name !== '..') {
              await this.ffmpeg.deleteFile(file.name);
            }
          }
        } catch (e) {
          console.warn('清理 FFmpeg 临时文件时出现警告:', e);
        }

        this.ffmpeg = null;
      }
      
      this.isLoaded = false;
      this.onProgress = undefined;
      this.subtitleOverlay = null;
      console.log('FFmpeg 引擎资源清理完成');
    } catch (error) {
      console.warn('FFmpeg 引擎清理时出现警告:', error);
    }
  }

  configure(config: Record<string, unknown>): void {
    // FFmpeg 引擎特定的配置选项
    console.log('FFmpeg 引擎配置:', config);
  }

  private async loadFFmpegLibrary(): Promise<void> {
    // 动态加载 FFmpeg.wasm 库
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.7/dist/esm/index.js';
    script.type = 'module';
    
    return new Promise((resolve, reject) => {
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('无法加载 FFmpeg.wasm 库'));
      document.head.appendChild(script);
    });
  }

  private buildFFmpegCommand(
    inputFile: string,
    outputFile: string,
    segments: VideoSegment[],
    options: VideoProcessingOptions
  ): string[] {
    const args = ['-i', inputFile];
    if (this.subtitleOverlay) args.push('-i', this.subtitleOverlay.file);
    let video = '0:v:0';
    let audio = '0:a:0?';
    const filters: string[] = [];
    if (options.edl) {
      filters.push(ffmpegVideoFilter(options.edl));
      video = '[vout]';
      if (options.preserveAudio) {
        filters.push(segments.map((s, i) => `[0:a:0]atrim=start=${s.start}:end=${s.end},asetpts=PTS-STARTPTS[a${i}]`).join(';'));
        filters.push(segments.map((_, i) => `[a${i}]`).join('') + `concat=n=${segments.length}:v=0:a=1[aout]`);
        audio = '[aout]';
      }
      args.push('-t', String(outputDuration(options.edl)), '-fps_mode', 'cfr');
    } else if (segments.length === 1) {
      // 单个片段，直接裁剪
      const segment = segments[0];
      if (this.subtitleOverlay) {
        filters.push(`[0:v]trim=start=${segment.start}:end=${segment.end},setpts=PTS-STARTPTS,fps=${this.subtitleOverlay.fps}[vout]`);
        video = '[vout]';
        if (options.preserveAudio) {
          filters.push(`[0:a]atrim=start=${segment.start}:end=${segment.end},asetpts=PTS-STARTPTS[aout]`);
          audio = '[aout]';
        }
        args.push('-t', (segment.end - segment.start).toString());
      } else {
        args.push('-ss', segment.start.toString());
        args.push('-t', (segment.end - segment.start).toString());
      }
    } else {
      // 多个片段，需要使用 concat 滤镜
      const parts: string[] = [];
      segments.forEach((segment, index) => {
        parts.push(`[0:v]trim=start=${segment.start}:end=${segment.end},setpts=PTS-STARTPTS[v${index}]`);
        if (options.preserveAudio) {
          parts.push(`[0:a]atrim=start=${segment.start}:end=${segment.end},asetpts=PTS-STARTPTS[a${index}]`);
        }
      });
      if (options.preserveAudio) {
        parts.push(segments.flatMap((_, i) => `[v${i}][a${i}]`).join('') + `concat=n=${segments.length}:v=1:a=1[outv][outa]`);
        audio = '[outa]';
      } else {
        parts.push(segments.map((_, i) => `[v${i}]`).join('') + `concat=n=${segments.length}:v=1:a=0[outv]`);
      }
      filters.push(...parts);
      video = '[outv]';
    }

    if (this.subtitleOverlay) {
      filters.push('[1:v]format=rgba[sub]', `${video}[sub]overlay=x=0:y=${this.subtitleOverlay.y}:format=yuv420[vsub]`);
      video = '[vsub]';
    }
    if (this.subtitleFile === 'subtitles.vtt') args.push('-i', this.subtitleFile);
    if (filters.length > 0) args.push('-filter_complex', filters.join(';'));
    args.push('-map', video);
    if (options.preserveAudio) args.push('-map', audio);
    if (this.subtitleFile === 'subtitles.vtt') {
      args.push('-map', '1:0', '-c:s', options.format === 'webm' ? 'webvtt' : 'mov_text');
    }

    // 质量 + 速度档（与桌面 FFmpeg 引擎一致）
    const preset =
      options.quality === 'high' ? 'medium'
        : options.quality === 'low' ? 'ultrafast'
          : 'veryfast';
    const crf =
      options.quality === 'high' ? '18'
        : options.quality === 'low' ? '28'
          : '23';

    // 音频处理
    if (!options.preserveAudio) {
      args.push('-an'); // 不包含音频
    }

    // 输出格式
    args.push('-c:v', 'libx264', '-preset', preset, '-crf', crf);
    if (options.preserveAudio) {
      args.push('-c:a', 'aac');
    }

    args.push(outputFile);
    return args;
  }

  private getFileExtension(filename: string): string {
    return filename.split('.').pop()?.toLowerCase() || 'mp4';
  }

  private getMimeType(format: string): string {
    const mimeTypes: Record<string, string> = {
      'mp4': 'video/mp4',
      'webm': 'video/webm',
      'avi': 'video/avi',
      'mov': 'video/quicktime',
      'mkv': 'video/x-matroska',
    };
    return mimeTypes[format] || 'video/mp4';
  }

  private reportProgress(
    stage: VideoProcessingProgress['stage'],
    progress: number,
    message: string,
  ) {
    if (this.onProgress) {
      this.onProgress({
        stage,
        progress: Math.min(100, Math.max(0, progress)),
        message,
      });
    }
  }
}

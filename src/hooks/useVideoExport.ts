import { createEdl } from '../../shared/editing/edl';
import { useHistoryStore } from '@/stores/historyStore';
// 视频导出流程：选择保存位置 → 选择引擎 → 处理 → 保存/通知
import { useCallback, useRef, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useTranslation } from '@/contexts/LocaleProvider';
import { useClientRuntime } from '@/runtime/context';
import {
  useStartVideoProcessing,
  useUpdateVideoProcessingProgress,
  useCompleteVideoProcessing,
  useErrorVideoProcessing
} from '@/stores/messageStore';
import { UnifiedVideoProcessor } from '@/services/UnifiedVideoProcessor';
import { pickVideoExportSaveTarget, writeProcessedVideo, type VideoExportSaveTarget } from '@/utils/exportSavePath';
import { buildVideoExportSegments } from '@/utils/videoExportSegments';
import type { VideoExportOptions } from '@/components/ExportPanel/ExportDialog';
import type { SubtitleStylePair } from '@/subtitle';
import type { SubtitleChunk } from '@/types/subtitle';
import type { VideoFile, VideoSegment, VideoProcessingProgress } from '@/types/video';
import type { VideoProcessingOptions } from '@/types/videoEngine';
import type { FlyCutCaptionProps } from '@/types';

interface UseVideoExportInput extends Pick<FlyCutCaptionProps, 'onProgress' | 'onVideoProcessed' | 'onExportComplete' | 'onError'> {
  videoFile: VideoFile | null;
  chunks: SubtitleChunk[];
  wordChunks: SubtitleChunk[];
  hasWordTimestamps: boolean;
  timelineDuration: number;
  subtitleStylePair: SubtitleStylePair;
  videoMeta: { width: number; height: number };
}

export function useVideoExport({
  videoFile, chunks, wordChunks, hasWordTimestamps, timelineDuration, subtitleStylePair, videoMeta,
  onProgress, onVideoProcessed, onExportComplete, onError,
}: UseVideoExportInput) {
  const { t } = useTranslation();
  const edl = useHistoryStore(s => s.edl);
  const cutError = useHistoryStore(s => s.cutError);
  const updatingCuts = useHistoryStore(s => s.updatingCuts);
  const { videoEngines } = useClientRuntime();
  const setError = useAppStore(state => state.setError);
  const joinFadeMs = useAppStore(state => state.joinFadeMs);

  // 消息中心钩子
  const startVideoProcessing = useStartVideoProcessing();
  const updateVideoProcessingProgress = useUpdateVideoProcessingProgress();
  const completeVideoProcessing = useCompleteVideoProcessing();
  const errorVideoProcessing = useErrorVideoProcessing();

  // 视频处理相关状态
  const [isProcessing, setIsProcessing] = useState(false);
  const [videoProgress, setVideoProgress] = useState<VideoProcessingProgress | null>(null);
  const processingMessageIdRef = useRef<string | null>(null);
  const exportSaveTargetRef = useRef<VideoExportSaveTarget | null>(null);
  const processorRef = useRef<UnifiedVideoProcessor | null>(null);

  const handleProgress = useCallback((progressData: VideoProcessingProgress) => {
    setVideoProgress(progressData);
    const messageId = processingMessageIdRef.current;
    if (messageId) {
      updateVideoProcessingProgress(messageId, progressData);
    }
    onProgress?.(progressData.stage, progressData.progress);
  }, [updateVideoProcessingProgress, onProgress]);

  const processVideo = useCallback(async (
    videoFile: VideoFile,
    segments: VideoSegment[],
    options?: VideoProcessingOptions
  ) => {
    if (isProcessing) {
      console.warn(t('messages.fileUpload.processingFile'));
      return;
    }

    let messageId: string | null = null;

    try {
      setIsProcessing(true);
      setVideoProgress({
        stage: 'analyzing',
        progress: 0,
        message: t('components.workstation.exportProgress'),
      });

      // 开始视频处理消息
      messageId = startVideoProcessing(t('messages.fileUpload.processingFile'));
      processingMessageIdRef.current = messageId;

      // 创建/更新处理器进度回调
      if (!processorRef.current) {
        processorRef.current = new UnifiedVideoProcessor(videoEngines, handleProgress);
      } else {
        processorRef.current.setProgressCallback(handleProgress);
      }

      const resolvedOptions: VideoProcessingOptions = {
        quality: 'medium',
        preserveAudio: true,
        ...options,
        outputPath: options?.outputPath ?? exportSaveTargetRef.current?.outputPath,
      };

      // 初始化 Host 导出处理器
      await processorRef.current.initialize(videoFile);

      // 处理视频
      const resultBlob = await processorRef.current.processVideo(segments, resolvedOptions);

      const saveTarget = exportSaveTargetRef.current;
      const filename = saveTarget?.filename
        ?? `cut_video_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, -1)}.${resolvedOptions.format || 'mp4'}`;

      let savedPath: string | undefined;
      if (saveTarget?.outputPath) {
        savedPath = saveTarget.outputPath;
      } else if (saveTarget) {
        savedPath = await writeProcessedVideo(resultBlob, saveTarget);
      }

      // 完成处理
      if (messageId) {
        const hasUsableBlob = resultBlob.size > 0;
        completeVideoProcessing(
          messageId,
          hasUsableBlob ? resultBlob : null,
          filename,
          savedPath,
        );
        if (hasUsableBlob) {
          onVideoProcessed?.(resultBlob, filename);
        } else if (savedPath) {
          onExportComplete?.(resultBlob, savedPath);
        }
      }

    } catch (error) {
      console.error('视频处理失败:', error);
      console.error('视频处理错误详情:', {
        videoFile: videoFile?.name,
        segments: segments?.length,
        options,
        stack: error instanceof Error ? error.stack : undefined
      });

      if (messageId) {
        errorVideoProcessing(messageId, error instanceof Error ? error.message : '未知错误');
      }
      onError?.(error instanceof Error ? error : new Error('Unknown error'));
    } finally {
      setIsProcessing(false);
      setVideoProgress(null);
      processingMessageIdRef.current = null;
      exportSaveTargetRef.current = null;
    }
  }, [videoEngines, isProcessing, startVideoProcessing, completeVideoProcessing, errorVideoProcessing, handleProgress, onVideoProcessed, onExportComplete, onError, t]);

  // 开始视频处理
  const handleStartProcessing = useCallback(async (options: VideoProcessingOptions) => {
    if (!videoFile) {
      console.error(t('messages.video.videoLoadFailed'));
      return;
    }

    try {
      if (cutError || updatingCuts) throw new Error('Invalid or unsettled cuts');
      const frozen = structuredClone({ chunks, wordChunks, hasWordTimestamps, edl: edl ?? createEdl(timelineDuration) });
      const segments = buildVideoExportSegments({
        edl: frozen.edl,
        chunks,
        wordChunks,
        hasWordTimestamps,
        duration: timelineDuration,
      });

      await processVideo(videoFile, segments, {
        ...options,
        edl: frozen.edl,
        joinFadeMs,
        subtitleChunks: frozen.chunks.filter(c => !c.deleted),
        subtitleWordChunks: frozen.wordChunks,
        hasWordTimestamps: frozen.hasWordTimestamps,
      });
    } catch (error) {
      console.error('视频处理失败:', error);
      console.error('App视频处理错误详情:', {
        videoFile: videoFile?.name,
        error
      });
      setError(`${t('messages.export.exportFailed')}: ${error instanceof Error ? error.message : t('common.error')}`);
    }
  }, [
    videoFile,
    chunks,
    wordChunks,
    hasWordTimestamps,
    timelineDuration,
    edl, cutError, updatingCuts,
    joinFadeMs,
    processVideo,
    setError,
    t,
  ]);

  // 处理视频导出配置：先选择保存位置，再开始处理
  const handleVideoExport = useCallback(async (options: VideoExportOptions) => {
    const format = options.format === 'mp4' ? 'mp4' : 'webm';
    const saveTarget = await pickVideoExportSaveTarget(format, videoFile?.name);
    if (!saveTarget) return;

    exportSaveTargetRef.current = saveTarget;

    await handleStartProcessing({
      format,
      quality: options.quality,
      preserveAudio: true,
      subtitleProcessing: options.subtitleProcessing,
      subtitleStyle: subtitleStylePair.primary,
      subtitleStylePair: subtitleStylePair,
      subtitleExportMode: options.subtitleExportMode,
      videoWidth: videoMeta.width,
      videoHeight: videoMeta.height,
      outputPath: saveTarget.outputPath,
      joinFadeMs,
    });
  }, [handleStartProcessing, subtitleStylePair, videoMeta, videoFile?.name, joinFadeMs]);

  return { isProcessing, videoProgress, handleStartProcessing, handleVideoExport };
}

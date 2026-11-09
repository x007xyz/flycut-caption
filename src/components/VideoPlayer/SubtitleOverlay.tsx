// 字幕覆盖层组件 - 共用 Canvas 2D 图形层
import { useState, useRef, useCallback, useEffect, useMemo, type RefObject } from 'react';
import { cn } from '@/lib/utils';
import { useChunks } from '@/stores/historyStore';
import type { SubtitleStyle, SubtitleDisplayMode } from '@/subtitle';
import {
  buildPreviewSubtitleScene,
  ensureSubtitleFonts,
  retrySubtitleFonts,
  getSubtitleFontState,
  subscribeSubtitleFontState,
  resolveBottomOffset,
  scaleVideoMetric,
} from '@/subtitle';
import { drawFrame, frameKey, findCue } from '../../../shared/subtitle-graphics';
import { useTranslation } from '@/contexts/LocaleProvider';

interface SubtitleOverlayProps {
  currentTime: number;
  primaryStyle: SubtitleStyle;
  /** 副字幕样式（缺省时回退到 primaryStyle） */
  secondaryStyle?: SubtitleStyle;
  /** 显示模式：默认 Bilingual */
  displayMode?: SubtitleDisplayMode;
  /** 拖拽调整底边距，回写主字幕样式（位置共享 primary） */
  onPrimaryStyleChange: (style: SubtitleStyle) => void;
  containerDimensions: { width: number; height: number };
  videoDimensions: { width: number; height: number };
  /** 用于 requestVideoFrameCallback / seeked 的真实视频元素 */
  videoRef?: RefObject<HTMLVideoElement | null>;
  /** 原始媒体时长；没有时按字幕条最晚结束时间推算 */
  duration?: number;
  /** 预览模式下删除片段区间应隐藏字幕 */
  visible?: boolean;
  className?: string;
}

export function SubtitleOverlay({
  currentTime,
  primaryStyle,
  secondaryStyle,
  displayMode = 'Bilingual',
  onPrimaryStyleChange,
  containerDimensions,
  videoDimensions,
  videoRef,
  duration,
  visible = true,
  className,
}: SubtitleOverlayProps) {
  const chunks = useChunks();
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastKeyRef = useRef('');
  const [fontState, setFontState] = useState(getSubtitleFontState);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStartY, setDragStartY] = useState(0);
  const [dragStartOffsetRatio, setDragStartOffsetRatio] = useState(0);

  const canvasSize = containerDimensions;

  const { scaleFactor, actualVideoSize, videoHeight, videoWidth } = useMemo(() => {
    if (!videoDimensions.width || !videoDimensions.height || !containerDimensions.width || !containerDimensions.height) {
      return { scaleFactor: 1, actualVideoSize: { width: 0, height: 0 }, videoHeight: 0, videoWidth: 0 };
    }
    const videoAspectRatio = videoDimensions.width / videoDimensions.height;
    const containerAspectRatio = containerDimensions.width / containerDimensions.height;
    let actualDisplayWidth: number;
    let actualDisplayHeight: number;
    if (videoAspectRatio > containerAspectRatio) {
      actualDisplayWidth = containerDimensions.width;
      actualDisplayHeight = containerDimensions.width / videoAspectRatio;
    } else {
      actualDisplayHeight = containerDimensions.height;
      actualDisplayWidth = containerDimensions.height * videoAspectRatio;
    }
    return {
      scaleFactor: actualDisplayHeight / videoDimensions.height,
      actualVideoSize: { width: actualDisplayWidth, height: actualDisplayHeight },
      videoHeight: videoDimensions.height,
      videoWidth: videoDimensions.width,
    };
  }, [videoDimensions, containerDimensions]);

  const scene = useMemo(() => buildPreviewSubtitleScene({
    chunks: chunks ?? [],
    stylePair: { primary: primaryStyle, secondary: secondaryStyle ?? primaryStyle },
    displayMode,
    videoWidth,
    videoHeight,
    duration: duration ?? 0,
  }), [chunks, primaryStyle, secondaryStyle, displayMode, videoWidth, videoHeight, duration]);

  const currentSubtitle = useMemo(() => findCue(scene.cues, currentTime), [scene, currentTime]);

  useEffect(() => {
    const unsubscribe = subscribeSubtitleFontState(() => setFontState(getSubtitleFontState()));
    if (getSubtitleFontState().status === 'idle') {
      void ensureSubtitleFonts().catch(() => undefined);
    }
    return unsubscribe;
  }, []);

  const drawAt = useCallback((time: number, force = false) => {
    const canvas = canvasRef.current;
    if (!canvas || !canvasSize.width || !canvasSize.height || !videoWidth || !videoHeight) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(2, Math.round(canvasSize.width * dpr));
    const height = Math.max(2, Math.round(canvasSize.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!visible || scene.cues.length === 0 || fontState.status !== 'ready') {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      lastKeyRef.current = '';
      return;
    }
    const key = frameKey(scene, time);
    if (!force && key === lastKeyRef.current) return;
    drawFrame(ctx, scene, time, { scale: canvas.width / scene.width, clear: true });
    lastKeyRef.current = key;
  }, [canvasSize, videoWidth, videoHeight, visible, scene, fontState.status]);

  useEffect(() => {
    lastKeyRef.current = '';
    const video = videoRef?.current;
    drawAt(video?.currentTime ?? 0, true);
  }, [drawAt, videoRef]);

  // 没有 requestVideoFrameCallback 的浏览器用 timeupdate 兜底；有 rVFC 时不重复画。
  useEffect(() => {
    const video = videoRef?.current;
    if (video && typeof video.requestVideoFrameCallback === 'function') return;
    drawAt(currentTime);
  }, [currentTime, drawAt, videoRef]);

  useEffect(() => {
    const video = videoRef?.current;
    if (!video) return;
    let active = true;
    let callbackId: number | undefined;
    const canUseFrameCallback = typeof video.requestVideoFrameCallback === 'function';
    const schedule = () => {
      if (!active || video.paused || video.ended || !canUseFrameCallback) return;
      callbackId = video.requestVideoFrameCallback((_now, metadata) => {
        if (!active) return;
        drawAt(metadata.mediaTime);
        schedule();
      });
    };
    const onPlay = () => schedule();
    const onPause = () => {
      if (callbackId !== undefined && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(callbackId);
      }
      callbackId = undefined;
      drawAt(video.currentTime, true);
    };
    const onSeeked = () => drawAt(video.currentTime, true);
    const onLoaded = () => drawAt(video.currentTime, true);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('loadeddata', onLoaded);
    if (!video.paused) schedule();
    drawAt(video.currentTime, true);
    return () => {
      active = false;
      if (callbackId !== undefined && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(callbackId);
      }
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('loadeddata', onLoaded);
    };
  }, [videoRef, drawAt]);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    setDragStartY(e.clientY);
    setDragStartOffsetRatio(primaryStyle.bottomOffsetRatio);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  }, [primaryStyle.bottomOffsetRatio]);

  const handleDragMove = useCallback((e: MouseEvent) => {
    if (!isDragging || !videoHeight) return;
    const deltaY = dragStartY - e.clientY;
    const deltaVideoPixels = deltaY / scaleFactor;
    const deltaRatio = deltaVideoPixels / videoHeight;
    let newRatio = dragStartOffsetRatio + deltaRatio;
    const minRatio = 20 / videoHeight;
    const maxRatio = (containerDimensions.height * 0.8) / scaleFactor / videoHeight;
    newRatio = Math.max(minRatio, Math.min(maxRatio, newRatio));
    onPrimaryStyleChange({ ...primaryStyle, bottomOffsetRatio: newRatio });
  }, [isDragging, dragStartY, dragStartOffsetRatio, primaryStyle, onPrimaryStyleChange, scaleFactor, containerDimensions.height, videoHeight]);

  const handleDragEnd = useCallback(() => {
    if (!isDragging) return;
    setIsDragging(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, [isDragging]);

  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleDragMove);
      document.addEventListener('mouseup', handleDragEnd);
      return () => {
        document.removeEventListener('mousemove', handleDragMove);
        document.removeEventListener('mouseup', handleDragEnd);
      };
    }
  }, [isDragging, handleDragMove, handleDragEnd]);

  if (!primaryStyle.visible) return null;

  const bottomOffsetDisplay = scaleVideoMetric(
    resolveBottomOffset(primaryStyle, videoHeight),
    actualVideoSize.height || videoHeight,
    videoHeight,
  );
  const showStatus = scene.cues.length > 0 && (fontState.status === 'loading' || fontState.status === 'error');

  return (
    <div className={cn('absolute inset-0 pointer-events-none', className)}>
      <canvas
        ref={canvasRef}
        data-testid="subtitle-overlay-canvas"
        data-subtitle-scene-version={scene.version}
        className="absolute top-[50%] right-0 pointer-events-auto left-[50%] -translate-x-1/2 -translate-y-1/2"
        style={{
          width: canvasSize.width,
          height: canvasSize.height,
          cursor: isDragging ? 'ns-resize' : currentSubtitle ? 'ns-resize' : 'default',
          pointerEvents: fontState.status === 'ready' ? 'auto' : 'none',
          opacity: isDragging ? 0.8 : 1,
          transition: isDragging ? 'none' : 'opacity 0.2s ease',
        }}
        onMouseDown={currentSubtitle ? handleDragStart : undefined}
        title={currentSubtitle ? t('components.videoPlayer.dragSubtitle') : undefined}
      />

      {isDragging && currentSubtitle && (
        <div
          className="absolute left-0 right-0 border-t border-dashed border-primary/60 pointer-events-none"
          style={{ bottom: `${bottomOffsetDisplay}px` }}
        />
      )}

      {!isDragging && currentSubtitle && (
        <div
          className="absolute left-1/2 transform -translate-x-1/2 w-20 h-8 opacity-0 hover:opacity-20 bg-primary rounded cursor-ns-resize pointer-events-auto transition-opacity"
          style={{ bottom: `${bottomOffsetDisplay - 16}px` }}
          onMouseDown={handleDragStart}
          title={t('components.videoPlayer.dragSubtitle')}
        />
      )}

      {showStatus && (
        <div className="absolute inset-x-0 bottom-6 flex justify-center px-4">
          {fontState.status === 'loading' ? (
            <div role="status" className="rounded-md bg-background/90 px-3 py-2 text-sm text-foreground shadow">
              {t('components.videoPlayer.subtitleLoading')}
            </div>
          ) : (
            <div role="alert" className="pointer-events-auto max-w-lg rounded-md border border-destructive/40 bg-background/95 px-3 py-2 text-sm text-foreground shadow">
              <p className="font-medium">{t('components.videoPlayer.subtitleUnavailable')}</p>
              {fontState.error && <p className="mt-1 break-words text-xs text-muted-foreground">{fontState.error}</p>}
              <button
                type="button"
                className="mt-2 rounded border px-2 py-1 text-xs hover:bg-muted"
                onClick={() => { void retrySubtitleFonts().catch(() => undefined); }}
              >
                {t('common.retry')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

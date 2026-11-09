// 字幕覆盖层组件 - Canvas 渲染
import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { useChunks } from '@/stores/historyStore';
import type { SubtitleStyle, SubtitleDisplayMode } from '@/subtitle';
import { resolveBottomOffset, scaleVideoMetric, renderSubtitleFrame } from '@/subtitle';

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
  visible = true,
  className
}: SubtitleOverlayProps) {
  const chunks = useChunks();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [isDragging, setIsDragging] = useState(false);
  const [dragStartY, setDragStartY] = useState(0);
  const [dragStartOffsetRatio, setDragStartOffsetRatio] = useState(0);

  const canvasSize = containerDimensions;

  // 'Second' 模式按副字幕内容匹配；其余按主字幕内容匹配
  const currentSubtitle = useMemo(() => {
    if (!chunks || chunks.length === 0) return null;

    const matchField = displayMode === 'Second' ? 'secondText' : 'text';

    return chunks.find(chunk =>
      !chunk.deleted &&
      currentTime >= chunk.timestamp[0] &&
      currentTime < chunk.timestamp[1] &&
      chunk[matchField] && chunk[matchField]!.trim() !== ''
    ) || null;
  }, [chunks, currentTime, displayMode]);

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

  const renderSubtitleToCanvas = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (!visible || !currentSubtitle) {
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    await renderSubtitleFrame({
      canvas,
      primaryStyle,
      secondaryStyle,
      displayMode,
      content: {
        primaryText: currentSubtitle.text,
        secondText: currentSubtitle.secondText,
      },
      videoHeight,
      videoWidth,
      videoDisplayWidth: actualVideoSize.width,
      videoDisplayHeight: actualVideoSize.height,
    });
  }, [currentSubtitle, primaryStyle, secondaryStyle, displayMode, videoHeight, videoWidth, actualVideoSize, visible]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.width = canvasSize.width;
    canvas.height = canvasSize.height;

    void renderSubtitleToCanvas();
  }, [canvasSize, renderSubtitleToCanvas]);

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

  if (!primaryStyle.visible) {
    return null;
  }

  const bottomOffsetDisplay = scaleVideoMetric(
    resolveBottomOffset(primaryStyle, videoHeight),
    actualVideoSize.height || videoHeight,
    videoHeight,
  );

  return (
    <div className={cn('absolute inset-0 pointer-events-none', className)}>
      <canvas
        ref={canvasRef}
        className="absolute top-[50%] right-0 pointer-events-auto left-[50%] -translate-x-1/2 -translate-y-1/2"
        style={{
          cursor: isDragging ? 'ns-resize' : currentSubtitle ? 'ns-resize' : 'default',
          opacity: isDragging ? 0.8 : 1,
          transition: isDragging ? 'none' : 'opacity 0.2s ease',
        }}
        onMouseDown={currentSubtitle ? handleDragStart : undefined}
        title={currentSubtitle ? "拖拽调整字幕位置" : undefined}
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
          title="点击拖拽调整字幕位置"
        />
      )}
    </div>
  );
}
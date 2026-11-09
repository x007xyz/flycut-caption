import { useHistoryStore } from '@/stores/historyStore';
import { edlCopy } from '@/locales/edl';
// 时间轴：刻度、缩放、字幕片段与音频波形
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AudioWaveform, Eye, EyeOff, Loader2, Maximize2, Scissors, ZoomIn, ZoomOut } from 'lucide-react';
import { useThemeStore } from '@/stores/themeStore';
import { useTranslation } from '@/contexts/LocaleProvider';
import { cn } from '@/lib/utils';
import type { SubtitleChunk } from '@/types/subtitle';
import type { VideoProcessingProgress } from '@/types/video';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const formatTimelineTime = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};


const TIMELINE_ZOOM_LEVELS = [
  { pxPerSec: 5,   minorStep: 10,  majorStep: 60 },  // 10 秒/小格, 1 分钟/大格
  { pxPerSec: 10,  minorStep: 5,   majorStep: 30 },  // 5 秒/小格, 30 秒/大格
  { pxPerSec: 20,  minorStep: 2,   majorStep: 10 },  // 2 秒/小格, 10 秒/大格
  { pxPerSec: 40,  minorStep: 1,   majorStep: 5 },   // 1 秒/小格, 5 秒/大格
  { pxPerSec: 80,  minorStep: 1,   majorStep: 2 },   // 1 秒/小格, 2 秒/大格
  { pxPerSec: 150, minorStep: 0.5, majorStep: 2 },   // 0.5 秒/小格, 2 秒/大格
  { pxPerSec: 300, minorStep: 0.2, majorStep: 1 },   // 0.2 秒/小格, 1 秒/大格
  { pxPerSec: 600, minorStep: 0.1, majorStep: 0.5 }, // 0.1 秒/小格, 0.5 秒/大格
] as const;

export function TimelineWaveform({
  currentTime,
  duration,
  chunks,
  onSeek,
  isASRLoading,
  asrProgress,
  isVideoProcessing,
  videoProgress,
  mediaWaveformPeaks,
}: {
  currentTime: number;
  duration: number;
  chunks: Array<Pick<SubtitleChunk, 'id' | 'timestamp' | 'deleted' | 'text' | 'secondText'>>;
  onSeek?: (time: number) => void;
  /** ASR 是否正在识别 */
  isASRLoading?: boolean;
  /** ASR 进度信息 */
  asrProgress?: import('@/types/subtitle').ASRProgress | null;
  /** 视频是否正在导出处理 */
  isVideoProcessing?: boolean;
  /** 视频导出进度 */
  videoProgress?: VideoProcessingProgress | null;
  mediaWaveformPeaks?: number[] | null;
}) {
  const { t, language } = useTranslation();
  const pending = useHistoryStore(s => s.pendingCuts);
  const copy = edlCopy(language);
  const resolvedTheme = useThemeStore(state => state.resolvedTheme);
  const viewportRef = useRef<HTMLDivElement>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement>(null);
  const [zoomIndex, setZoomIndex] = useState(2);
  const [showSubtitleLayer, setShowSubtitleLayer] = useState(true);
  const [viewportMetrics, setViewportMetrics] = useState({
    width: 0,
    height: 0,
    scrollLeft: 0,
  });
  const safeDuration = Math.max(duration, 1);

  const minZoomIndex = 0;
  const maxZoomIndex = TIMELINE_ZOOM_LEVELS.length - 1;
  const currentZoomLevel = TIMELINE_ZOOM_LEVELS[clamp(zoomIndex, minZoomIndex, maxZoomIndex)];
  const pixelsPerSecond = currentZoomLevel.pxPerSec;
  const minorTickStep = currentZoomLevel.minorStep;
  const majorTickStep = currentZoomLevel.majorStep;

  // 时间轴总宽度（像素）= 媒体时长 × 像素密度，至少铺满视口
  const timelineWidth = Math.max(safeDuration * pixelsPerSecond, viewportMetrics.width);

  // 播放头位置（像素）
  const playheadPosition = clamp(currentTime, 0, safeDuration) * pixelsPerSecond;

  const zoomPercent = pixelsPerSecond;

  const activeRanges = useMemo(() => (
    chunks
      .filter(chunk => !chunk.deleted)
      .map(chunk => chunk.timestamp)
      .sort((a, b) => a[0] - b[0])
  ), [chunks]);

  const waveformPeaks = useMemo(() => {
    // 初始状态（无媒体）：不生成合成波形，避免空时间轴出现波形残留
    if (duration <= 0) return [];
    if (mediaWaveformPeaks?.length) {
      return mediaWaveformPeaks;
    }

    const sampleCount = Math.max(320, Math.ceil(safeDuration * 24));
    let rangeIndex = 0;

    return Array.from({ length: sampleCount }, (_, index) => {
      const progress = sampleCount === 1 ? 0 : index / (sampleCount - 1);
      const time = progress * safeDuration;

      while (
        rangeIndex < activeRanges.length - 1 &&
        activeRanges[rangeIndex][1] < time
      ) {
        rangeIndex += 1;
      }

      const activeRange = activeRanges[rangeIndex];
      const isActive = activeRanges.length === 0 ||
        (activeRange && time >= activeRange[0] && time <= activeRange[1]);

      if (!isActive) return 0;

      const signal =
        Math.abs(Math.sin(index * 0.37)) * 0.38 +
        Math.abs(Math.sin(index * 0.11 + 1.7)) * 0.32 +
        Math.abs(Math.sin(index * 0.023 + 0.4)) * 0.22;
      const pulse = index % 29 === 0 ? 0.2 : 0;

      return clamp((signal + pulse) * 0.72 + 0.12, 0.08, 0.96);
    });
  }, [activeRanges, mediaWaveformPeaks, safeDuration, duration]);

  const handleZoomOut = useCallback(() => {
    setZoomIndex((index) => Math.max(minZoomIndex, index - 1));
  }, [minZoomIndex]);

  const handleZoomIn = useCallback(() => {
    setZoomIndex((index) => Math.min(maxZoomIndex, index + 1));
  }, [maxZoomIndex]);

  const handleFitTimeline = useCallback(() => {
    // 选择让整段媒体刚好铺满视口的档位（向上取整到最近的可用档位）
    const viewportWidth = viewportRef.current?.clientWidth ?? 0;
    if (viewportWidth <= 0) return;
    const targetPxPerSec = viewportWidth / safeDuration;
    let fitIndex = 0;
    for (let i = 0; i < TIMELINE_ZOOM_LEVELS.length; i++) {
      if (TIMELINE_ZOOM_LEVELS[i].pxPerSec >= targetPxPerSec) {
        fitIndex = i;
        break;
      }
      fitIndex = i;
    }
    setZoomIndex(fitIndex);
    viewportRef.current?.scrollTo({ left: 0, behavior: 'smooth' });
  }, [safeDuration]);

  const handleTimelineClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!onSeek || duration <= 0) return;

    const bounds = event.currentTarget.getBoundingClientRect();
    const clickX = event.clientX - bounds.left;
    const clickTime = clickX / pixelsPerSecond;
    onSeek(Math.max(0, Math.min(safeDuration, clickTime)));
  }, [duration, onSeek, safeDuration, pixelsPerSecond]);

  // 自动滚动使播放头保持可见
  useEffect(() => {
    if (duration <= 0) return;
    const viewport = viewportRef.current;
    if (!viewport) return;

    const visibleStart = viewport.scrollLeft;
    const visibleEnd = visibleStart + viewport.clientWidth;
    const margin = 48;

    if (playheadPosition < visibleStart + margin || playheadPosition > visibleEnd - margin) {
      viewport.scrollTo({
        left: Math.max(0, playheadPosition - viewport.clientWidth / 2),
        behavior: 'smooth',
      });
    }
  }, [duration, playheadPosition]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    let frameId = 0;
    const updateMetrics = () => {
      frameId = 0;
      const nextMetrics = {
        width: viewport.clientWidth,
        height: viewport.clientHeight,
        scrollLeft: viewport.scrollLeft,
      };

      setViewportMetrics(previous => (
        previous.width === nextMetrics.width &&
        previous.height === nextMetrics.height &&
        previous.scrollLeft === nextMetrics.scrollLeft
          ? previous
          : nextMetrics
      ));
    };

    const scheduleUpdate = () => {
      if (frameId) return;
      frameId = window.requestAnimationFrame(updateMetrics);
    };

    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(scheduleUpdate)
      : null;

    resizeObserver?.observe(viewport);
    viewport.addEventListener('scroll', scheduleUpdate, { passive: true });
    scheduleUpdate();

    return () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver?.disconnect();
      viewport.removeEventListener('scroll', scheduleUpdate);
    };
  }, []);

  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas || viewportMetrics.width <= 0 || viewportMetrics.height <= 0) return;
    // 初始状态（无媒体）：不绘制刻度/网格/波形，由空状态提示层占位
    if (duration <= 0) return;

    const width = Math.max(1, Math.floor(viewportMetrics.width));
    const height = Math.max(1, Math.floor(viewportMetrics.height));
    const dpr = window.devicePixelRatio || 1;
    const targetWidth = Math.floor(width * dpr);
    const targetHeight = Math.floor(height * dpr);

    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }

    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const context = canvas.getContext('2d');
    if (!context) return;

    const rootStyles = getComputedStyle(document.documentElement);
    const panelColor = rootStyles.getPropertyValue('--aimu-bg-input').trim() || '#f0f0f4';
    const borderColor = rootStyles.getPropertyValue('--aimu-border').trim() || '#e0e0e6';
    const borderLightColor = rootStyles.getPropertyValue('--aimu-border-light').trim() || '#ececf0';
    const textColor = rootStyles.getPropertyValue('--aimu-text-secondary').trim() || '#5a5a62';
    const mutedColor = rootStyles.getPropertyValue('--aimu-text-muted').trim() || '#8d9095';
    const coralColor = rootStyles.getPropertyValue('--aimu-accent-coral').trim() || '#e85555';

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = panelColor;
    context.fillRect(0, 0, width, height);

    const rulerHeight = 24;
    const waveformTop = 32;
    const waveformBottom = height - 4;
    const waveformHeight = Math.max(1, waveformBottom - waveformTop);
    const centerY = waveformTop + waveformHeight / 2;

    context.strokeStyle = borderColor;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, rulerHeight + 0.5);
    context.lineTo(width, rulerHeight + 0.5);
    context.moveTo(0, centerY + 0.5);
    context.lineTo(width, centerY + 0.5);
    context.stroke();

    const visibleStartPx = viewportMetrics.scrollLeft;
    const visibleEndPx = visibleStartPx + width;
    // 刻度只覆盖真实媒体时长
    const timelineEndSecond = safeDuration;
    const tickStep = minorTickStep;
    const ticksPerLabel = Math.max(1, Math.round(majorTickStep / minorTickStep));
    // 以 tick 索引迭代，避免浮点累加误差
    const firstTickIndex = Math.max(0, Math.floor(visibleStartPx / pixelsPerSecond / tickStep));
    const lastTickIndex = Math.min(
      Math.ceil(timelineEndSecond / tickStep),
      Math.ceil(visibleEndPx / pixelsPerSecond / tickStep)
    );

    context.font = '10px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
    context.textBaseline = 'top';

    for (let tickIndex = firstTickIndex; tickIndex <= lastTickIndex; tickIndex++) {
      const second = tickIndex * tickStep;
      const x = Math.round(second * pixelsPerSecond - visibleStartPx) + 0.5;
      const isMajor = tickIndex % ticksPerLabel === 0;

      context.strokeStyle = isMajor ? textColor : mutedColor;
      context.globalAlpha = isMajor ? 0.9 : 0.45;
      context.beginPath();
      context.moveTo(x, isMajor ? 8 : 14);
      context.lineTo(x, rulerHeight);
      context.stroke();

      if (isMajor) {
        context.globalAlpha = 1;
        context.fillStyle = textColor;
        context.fillText(formatTimelineTime(second), x + 4, 4);
      }
    }

    context.globalAlpha = 0.55;
    context.strokeStyle = borderLightColor;
    context.beginPath();
    for (let x = 0; x <= width; x += Math.max(24, pixelsPerSecond)) {
      context.moveTo(Math.round(x) + 0.5, waveformTop);
      context.lineTo(Math.round(x) + 0.5, waveformBottom);
    }
    context.stroke();

    const barStep = pixelsPerSecond < 12 ? 2 : pixelsPerSecond < 40 ? 3 : 4;
    const barWidth = clamp(barStep * 0.58, 1, 3);
    context.fillStyle = coralColor;

    for (let x = 0; x <= width; x += barStep) {
      const time = (visibleStartPx + x) / pixelsPerSecond;
      if (time < 0 || time > safeDuration) continue;

      const peakIndex = Math.floor((time / safeDuration) * (waveformPeaks.length - 1));
      const peak = waveformPeaks[peakIndex] ?? 0;
      if (peak <= 0.01) continue;

      const barHeight = peak * waveformHeight * 0.88;
      const y = centerY - barHeight / 2;

      context.globalAlpha = 0.34 + peak * 0.52;
      if (typeof context.roundRect === 'function') {
        context.beginPath();
        context.roundRect(x, y, barWidth, barHeight, barWidth / 2);
        context.fill();
      } else {
        context.fillRect(x, y, barWidth, barHeight);
      }
    }

    context.globalAlpha = 1;
  }, [
    pixelsPerSecond,
    minorTickStep,
    majorTickStep,
    resolvedTheme,
    safeDuration,
    viewportMetrics,
    waveformPeaks,
    duration,
  ]);

  return (
    <div className="h-[132px] shrink-0 border-t border-aimu-border bg-aimu-panel">
      <div className="flex h-8 items-center justify-between border-b border-aimu-border px-3">
        <div className="flex items-center gap-1.5 text-xs text-aimu-text-secondary">
          <AudioWaveform className="h-4 w-4 text-aimu-coral" />
          <span className="font-medium text-aimu-text-primary">{t('components.workstation.timeline')}</span>
          {isASRLoading ? (
            <span className="flex items-center gap-1.5 text-aimu-coral">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span className="font-mono text-[11px]">
                {asrProgress?.data || t('messages.asr.modelLoading')}
                {asrProgress?.progress !== undefined ? ` · ${Math.round(asrProgress.progress)}%` : ''}
              </span>
            </span>
          ) : isVideoProcessing ? (
            <span className="flex items-center gap-1.5 text-aimu-coral">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span className="font-mono text-[11px]">
                {videoProgress?.message || t('components.workstation.exportProgress')}
                {videoProgress?.progress !== undefined ? ` · ${Math.round(videoProgress.progress)}%` : ''}
              </span>
            </span>
          ) : duration > 0 ? (
            <span className="font-mono text-[11px] text-aimu-text-muted">{formatTimelineTime(currentTime)} / {formatTimelineTime(duration)}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-1 text-aimu-text-muted">
          <button
            type="button"
            onClick={() => setShowSubtitleLayer(isVisible => !isVisible)}
            aria-pressed={showSubtitleLayer}
            className={cn(
              'rounded p-1 hover:bg-aimu-hover hover:text-aimu-text-primary',
              showSubtitleLayer && 'text-aimu-coral'
            )}
            title={showSubtitleLayer
              ? t('components.workstation.hideSubtitleOverlay')
              : t('components.workstation.showSubtitleOverlay')}
          >
            {showSubtitleLayer ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
          <button className="rounded p-1 hover:bg-aimu-hover hover:text-aimu-text-primary" title={t('components.workstation.cut')}>
            <Scissors className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={handleZoomOut}
            disabled={zoomIndex <= minZoomIndex}
            className="rounded p-1 hover:bg-aimu-hover hover:text-aimu-text-primary disabled:cursor-not-allowed disabled:opacity-40"
            title={t('components.subtitleEditor.zoomOut')}
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <span className="w-12 text-center font-mono text-[10px] tabular-nums text-aimu-text-secondary">
            {zoomPercent}px/s
          </span>
          <button
            type="button"
            onClick={handleZoomIn}
            disabled={zoomIndex >= maxZoomIndex}
            className="rounded p-1 hover:bg-aimu-hover hover:text-aimu-text-primary disabled:cursor-not-allowed disabled:opacity-40"
            title={t('components.subtitleEditor.zoomIn')}
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={handleFitTimeline}
            className="rounded p-1 hover:bg-aimu-hover hover:text-aimu-text-primary"
            title={t('components.workstation.fit')}
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="h-[100px] px-3 py-2">
        <div ref={viewportRef} className="h-full overflow-x-auto overflow-y-hidden">
          <div
            data-testid="timeline-ruler"
            className="relative h-full cursor-pointer rounded border border-aimu-border bg-aimu-input"
            style={{ width: `${timelineWidth}px`, minWidth: '100%' }}
            onClick={handleTimelineClick}
          >
            <canvas
              ref={waveformCanvasRef}
              data-testid="timeline-waveform-canvas"
              className="pointer-events-none sticky left-0 top-0 z-0 block h-full"
              aria-hidden="true"
            />
            {pending?.ranges.map((range, index) => <div key={index} data-testid="pending-cut" className="pointer-events-none absolute top-8 bottom-1 z-20 overflow-hidden bg-red-500/60 border border-red-700 text-[10px] text-foreground"
              style={{ left: range.start * pixelsPerSecond, width: (range.end - range.start) * pixelsPerSecond }} title={copy.pending}>
              <span>{copy.pending}</span></div>)}
            {duration <= 0 && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-aimu-text-muted">
                {t('components.workstation.emptyTimelineHint')}
              </div>
            )}
            {showSubtitleLayer && chunks
              .filter(chunk => !chunk.deleted)
              .map((chunk) => {
              const leftPx = chunk.timestamp[0] * pixelsPerSecond;
              const widthPx = (chunk.timestamp[1] - chunk.timestamp[0]) * pixelsPerSecond;
              const label = [chunk.text, chunk.secondText].filter(Boolean).join(' / ');
              return (
                <div
                  key={chunk.id}
                  className={cn(
                    'absolute bottom-1 top-8 z-10 flex cursor-pointer items-center overflow-hidden rounded-sm border px-1.5 shadow-sm',
                    'border-aimu-purple/65 bg-aimu-purple/30'
                  )}
                  style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
                  title={label}
                >
                  <span
                    className={cn(
                      'min-w-0 truncate text-[10px] font-medium leading-none opacity-75',
                      'text-aimu-text-primary'
                    )}
                  >
                    {label}
                  </span>
                </div>
              );
            })}
            {duration > 0 && (
              <div
                className="pointer-events-none absolute bottom-1 top-8 z-20 w-px bg-white shadow-[0_0_0_1px_rgba(245,108,108,0.65)]"
                style={{ left: `${playheadPosition}px` }}
              >
                <div className="absolute -left-1.5 -top-1 h-3 w-3 rounded-full bg-aimu-coral" />
              </div>
            )}
            {(isASRLoading || isVideoProcessing) && (
              <div className="absolute inset-0 z-30 flex items-center justify-center bg-aimu-panel/70 backdrop-blur-[1px]">
                <div className="flex flex-col items-center gap-2 rounded-lg border border-aimu-border bg-aimu-panel px-4 py-2 text-[11px] text-aimu-coral shadow-sm">
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    <span className="font-medium">
                      {isASRLoading
                        ? (asrProgress?.data || t('messages.asr.asrStarted'))
                        : (videoProgress?.message || t('components.workstation.exportProgress'))}
                    </span>
                    {(isASRLoading ? asrProgress?.progress : videoProgress?.progress) !== undefined && (
                      <span className="font-mono text-aimu-text-muted">
                        · {Math.round((isASRLoading ? asrProgress?.progress : videoProgress?.progress) ?? 0)}%
                      </span>
                    )}
                  </div>
                  {isVideoProcessing && videoProgress && (
                    <div className="h-1.5 w-48 overflow-hidden rounded-full bg-aimu-border">
                      <div
                        className="h-full rounded-full bg-aimu-coral transition-all duration-300"
                        style={{ width: `${videoProgress.progress}%` }}
                      />
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

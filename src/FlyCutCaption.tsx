import { edlCopy } from '@/locales/edl';
import { projectCues, outputDuration } from '../shared/editing/edl';
// FlyCut Caption - 智能视频字幕裁剪工具

import { useCallback, useMemo, useState, useRef, useEffect } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useChunks, useWordChunks, useHasWordTimestamps, useHistoryStore } from '@/stores/historyStore';
import { useThemeStore } from '@/stores/themeStore';
import { useHotkeys } from '@/hooks/useHotkeys';
import { LocaleProvider, useTranslation } from '@/contexts/LocaleProvider';
import { ClientRuntime, PluginSlot } from '@/runtime/ui';
import type { EnhancedVideoPlayerRef } from '@/components/VideoPlayer/EnhancedVideoPlayer';
import { useASR } from '@/hooks/useASR';
import { useVideoExport } from '@/hooks/useVideoExport';
import { useMediaLoader } from '@/hooks/useMediaLoader';
import { WorkstationHeader } from '@/components/Workstation/WorkstationHeader';
import { AISettingsPanel } from '@/components/AISettingsPanel';
import { SettingsDialog } from '@/components/ProcessingPanel/SettingsDialog';
import { ExportDialog } from '@/components/ExportPanel/ExportDialog';
import { ThemeInitializer } from '@/components/ThemeInitializer';
import { ToastContainer } from '@/components/MessageCenter';
import { SubtitleSettings } from '@/components/SubtitleSettings';
import {
  registerSubtitleFonts,
  serializeSubtitleExport,
  getExportFilename,
  getExportMimeType,
  getExportFileTypes,
  applyAspectPreset,
  inferAspectPreset,
  type SubtitleExportFormat,
  type SubtitleDisplayMode,
} from '@/subtitle';
import { cn } from '@/lib/utils';
import { TimelineWaveform } from '@/components/Timeline/TimelineWaveform';
import { extractWaveformPeaks } from '@/utils/waveform';
import { saveFile } from '@/utils/createFileWriter';
import { Play, Upload, Loader2 } from 'lucide-react';
import { runSmartCutBlank } from '@/utils/smartCutBlank';
import { toast } from 'sonner';
import type { FlyCutCaptionProps } from './types';
import { defaultConfig } from './types';

type AimuTab = 'style' | 'tools' | 'options' | 'api';

interface BrowserPerformanceMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

/**
 * FlyCut Caption React Component
 *
 * A complete video subtitle editing component with AI-powered speech recognition,
 * visual editing interface, and video processing capabilities.
 *
 * @example
 * ```tsx
 * import { FlyCutCaption } from '@flycut/caption-react'
 * import '@flycut/caption-react/styles'
 *
 * function App() {
 *   return (
 *     <FlyCutCaption
 *       config={{
 *         theme: 'auto',
 *         language: 'zh-CN',
 *         asrLanguage: 'auto',
 *         enableDragDrop: true,
 *         enableExport: true,
 *         enableVideoProcessing: true,
 *         maxFileSize: 500,
 *         supportedFormats: ['mp4', 'webm', 'avi', 'mov', 'mp3', 'wav', 'ogg']
 *       }}
 *       onReady={() => console.log('FlyCut Caption is ready')}
 *       onFileSelected={(file) => console.log('File selected:', file.name)}
 *       onSubtitleGenerated={(subtitles) => console.log('Subtitles generated:', subtitles.length)}
 *       onSubtitleChanged={(subtitles) => console.log('Subtitles changed:', subtitles.length)}
 *       onVideoProcessed={(blob, filename) => console.log('Video processed:', filename)}
 *       onExportComplete={(blob, filename) => console.log('Export complete:', filename)}
 *       onError={(error) => console.error('Error:', error)}
 *       onProgress={(stage, progress) => console.log(`${stage}: ${progress}%`)}
 *     />
 *   )
 * }
 * ```
 */
export function FlyCutCaptionContent(props: FlyCutCaptionProps) {
  const {
    className,
    style,
    config = {},
    onReady,
    onFileSelected,
    onSubtitleChanged,
    onVideoProcessed,
    onExportComplete,
    onError,
    onProgress,
    onLanguageChange,
    onSubtitleGenerated,
  } = props;

  // Merge user config with defaults
  const mergedConfig = useMemo(() => ({
    ...defaultConfig,
    ...config
  }), [config]);

  const stage = useAppStore(state => state.stage);
  const videoFile = useAppStore(state => state.videoFile);
  const chunks = useChunks();
  const edl = useHistoryStore(s => s.edl);
  const cutError = useHistoryStore(s => s.cutError);
  const updatingCuts = useHistoryStore(s => s.updatingCuts);
  const wordChunks = useWordChunks();
  const hasWordTimestamps = useHasWordTimestamps();
  const insertBlankChunks = useHistoryStore(state => state.proposeCuts);
  const smartCutSilenceThreshold = useAppStore(state => state.smartCutSilenceThreshold);
  const videoDuration = useAppStore(state => state.videoPlayerState.duration);

  // 内存使用情况状态 (Aimu 风格)
  const [memory, setMemory] = useState({ used: '42.63 MB', allocated: '54.17 MB', limit: '3.5 GB' });
  const [mediaWaveformPeaks, setMediaWaveformPeaks] = useState<number[] | null>(null);

  useEffect(() => {
    const updateMemory = () => {
      const performanceWithMemory =
        typeof window !== 'undefined'
          ? window.performance as Performance & { memory?: BrowserPerformanceMemory }
          : undefined;

      if (performanceWithMemory?.memory) {
        const mem = performanceWithMemory.memory;
        const limitGB = mem.jsHeapSizeLimit / 1024 / 1024 / 1024;
        setMemory({
          used: `${(mem.usedJSHeapSize / 1024 / 1024).toFixed(2)} MB`,
          allocated: `${(mem.totalJSHeapSize / 1024 / 1024).toFixed(2)} MB`,
          limit: isNaN(limitGB) ? '4.0 GB' : `${limitGB.toFixed(1)} GB`
        });
      } else {
        const used = (40 + Math.random() * 5).toFixed(2);
        const allocated = (50 + Math.random() * 5).toFixed(2);
        setMemory({
          used: `${used} MB`,
          allocated: `${allocated} MB`,
          limit: '4.0 GB'
        });
      }
    };

    updateMemory();
    const interval = setInterval(updateMemory, 5000);
    return () => clearInterval(interval);
  }, []);

  // Tab 状态 (Aimu 风格)
  const [activeTab, setActiveTab] = useState<AimuTab>('style');

  // F-0013: the correction review can send the user to the existing AI model tab without another settings system.
  useEffect(() => {
    const openAISettings = () => setActiveTab('api');
    window.addEventListener('flycut:open-ai-settings', openAISettings);
    return () => window.removeEventListener('flycut:open-ai-settings', openAISettings);
  }, []);

  // 主题管理
  const { resolvedTheme } = useThemeStore();
  const effectiveTheme = mergedConfig.theme === 'auto' ? resolvedTheme : mergedConfig.theme;

  // 国际化
  const { t, language } = useTranslation();

  // 语言选项

  const tabOptions: Array<{ id: AimuTab; label: string }> = [
    { id: 'style', label: t('components.workstation.style') },
    { id: 'tools', label: t('components.workstation.tools') },
    { id: 'options', label: t('components.workstation.options') },
    { id: 'api', label: t('components.workstation.api') },
  ];

  const plannedFeatures = {
    tools: [
      {
        title: t('components.workstation.swapTitle'),
        description: t('components.workstation.swapDescription'),
      },
      {
        title: t('components.workstation.aiTranslationTitle'),
        description: t('components.workstation.aiTranslationDescription'),
      },
      {
        title: t('components.workstation.ttsTitle'),
        description: t('components.workstation.ttsDescription'),
      },
    ],
    options: [
      {
        title: t('components.workstation.timelineWaveformTitle'),
        description: t('components.workstation.timelineWaveformDescription'),
      },
      {
        title: t('components.workstation.shortcutEditorTitle'),
        description: t('components.workstation.shortcutEditorDescription'),
      },
      {
        title: t('components.workstation.batchOperationsTitle'),
        description: t('components.workstation.batchOperationsDescription'),
      },
    ],
    api: [
      {
        title: t('components.workstation.onlineHardcodingTitle'),
        description: t('components.workstation.onlineHardcodingDescription'),
      },
      {
        title: t('components.workstation.videoTranscodingTitle'),
        description: t('components.workstation.videoTranscodingDescription'),
      },
      {
        title: t('components.workstation.externalAsrTitle'),
        description: t('components.workstation.externalAsrDescription'),
      },
    ],
  };

  const renderFeatureItems = (items: Array<{ title: string; description: string }>) => (
    <div className="space-y-1.5">
      {items.map((item) => (
        <div key={item.title} className="flex items-center gap-2 p-2 border border-border rounded bg-muted/5">
          <span className="w-1.5 h-1.5 bg-amber-500 rounded-full flex-shrink-0" />
          <div className="flex-1">
            <div className="text-xs font-semibold">{item.title}</div>
            <div className="text-[10px] text-muted-foreground">{item.description}</div>
          </div>
        </div>
      ))}
    </div>
  );

  // Component is ready, render the main content
  // 初始状态为空：不再自动填充演示字幕，由「使用示例视频」按钮显式加载

  useEffect(() => {
    let cancelled = false;

    if (!videoFile) {
      setMediaWaveformPeaks(null);
      return () => {
        cancelled = true;
      };
    }

    setMediaWaveformPeaks(null);
    extractWaveformPeaks(videoFile).then((peaks) => {
      if (!cancelled) {
        setMediaWaveformPeaks(peaks);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [videoFile]);

  // ASR 语音识别：进入 transcribe 阶段后自动开始识别，
  // 不再弹出 ASR 窗口与消息，改由字幕编辑器/时间轴展示加载状态。
  const { isASRLoading, asrProgress, startASR } = useASR({ onSubtitleGenerated });
  const asrStartedRef = useRef(false);

  useEffect(() => {
    if (stage === 'transcribe' && videoFile && !isASRLoading && !asrStartedRef.current) {
      asrStartedRef.current = true;
      startASR(videoFile);
    }
    // 进入非 transcribe 阶段时重置标记，允许下次重新触发
    if (stage !== 'transcribe') {
      asrStartedRef.current = false;
    }
  }, [stage, videoFile, isASRLoading, startASR]);

  // Component ready effect
  useEffect(() => {
    // Initialize component
    const timer = setTimeout(() => {
      onReady?.()
    }, 100) // Small delay to ensure component is fully mounted

    return () => clearTimeout(timer)
  }, [onReady]);

  // 初始化主题 - 确保 wrapper 与全局 DOM 使用同一套变量
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(effectiveTheme);
  }, [effectiveTheme]);


  // 启用快捷键
  useHotkeys({
    enableHistoryHotkeys: true,
    enableGlobalHotkeys: true, // 全局启用，即使焦点不在特定元素上也能工作
  });

  // 在组件层用 useMemo 做过滤，保证只有 chunks 引用变更时才重新计算
  const activeChunks = useMemo(
    () => chunks.filter(c => !c.deleted),
    [chunks]
  );

  const currentTime = useAppStore(state => state.currentTime);
  const setCurrentTime = useAppStore(state => state.setCurrentTime);


  // 导出对话框状态
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportDialogType, setExportDialogType] = useState<'subtitles' | 'video' | 'jianying'>('video');
  const [settingsOpen, setSettingsOpen] = useState(false);

  // 字幕样式状态：主/副字幕独立样式对，位置（底边距/比例）共享 primary
  // 存在 appStore 里，项目模式的自动保存要订阅它（F-0002/AC-3）
  const subtitleStylePair = useAppStore(state => state.subtitleStylePair);
  const setSubtitleStylePair = useAppStore(state => state.setSubtitleStylePair);
  const subtitleStyleRestored = useAppStore(state => state.subtitleStyleRestored);
  // 显示模式（控制播放器预览），持久化在 appStore
  const display = useAppStore(state => state.display);
  const setDisplay = useAppStore(state => state.setDisplay);

  useEffect(() => {
    registerSubtitleFonts();
  }, []);

  // 视频播放器引用
  const videoPlayerRef = useRef<EnhancedVideoPlayerRef>(null);
  const media = useMediaLoader({ onFileSelected, onMedia: props.onMedia });
  const { isFileLoading, fileLoadProgress, isSampleLoading, sampleLoadProgress, isMediaLoading, handleLoadSampleVideo, handleUploadClick } = media;

  const timelineDuration = useMemo(() => {
    const chunkEndTime = chunks.reduce((maxTime, chunk) => Math.max(maxTime, chunk.timestamp[1]), 0);
    return Math.max(videoFile?.duration || 0, chunkEndTime);
  }, [chunks, videoFile?.duration]);

  const handleTimelineSeek = useCallback((time: number) => {
    const nextTime = Math.max(0, Math.min(timelineDuration, time));
    setCurrentTime(nextTime);
    videoPlayerRef.current?.seekTo(nextTime);
  }, [setCurrentTime, timelineDuration]);




  const [videoMeta, setVideoMeta] = useState({ width: 1920, height: 1080 });

  const { isProcessing, videoProgress, handleVideoExport } = useVideoExport({
    videoFile, chunks, wordChunks, hasWordTimestamps, timelineDuration, subtitleStylePair, videoMeta,
    onProgress, onVideoProcessed, onExportComplete, onError,
  });

  // 导出字幕
  const handleExportSubtitles = useCallback(async (format: SubtitleExportFormat, exportMode: SubtitleDisplayMode) => {
    if (!edl || cutError || updatingCuts || !outputDuration(edl)) { toast.error(t('common.error')); return; }
    const keptChunks = projectCues(edl, chunks);
    if (keptChunks.length === 0) {
      toast.error(t('messages.subtitle.emptySubtitleText'));
      return;
    }

    try {
      const content = serializeSubtitleExport(format, keptChunks, {
        ass: {
          playResX: videoMeta.width,
          playResY: videoMeta.height,
          stylePair: subtitleStylePair,
          exportMode,
        },
        exportMode,
      });

      const filename = getExportFilename(format);
      const types = getExportFileTypes(format);
      const blob = new Blob([content], { type: getExportMimeType(format) });
      await saveFile(blob, filename, types);
      onExportComplete?.(blob, filename);
    } catch (error) {
      console.error('字幕导出失败:', error);
      const detail = error instanceof Error ? error.message : t('common.error');
      toast.error(t('messages.subtitle.exportFailed'), { description: detail });
    }
  }, [edl, cutError, updatingCuts, chunks, videoMeta, subtitleStylePair, onExportComplete, t]);



  // 打开视频导出对话框
  const handleOpenVideoExportDialog = useCallback(() => {
    setExportDialogType('video');
    setExportDialogOpen(true);
  }, []);

  // 打开字幕导出对话框
  const handleOpenSubtitleExportDialog = useCallback(() => {
    setExportDialogType('subtitles');
    setExportDialogOpen(true);
  }, []);

  const handleOpenJianyingDraftDialog = useCallback(() => {
    setExportDialogType('jianying');
    setExportDialogOpen(true);
  }, []);

  // 智能剪切空白段
  const handleSmartCutBlank = useCallback(() => {
    runSmartCutBlank({
      chunks,
      threshold: smartCutSilenceThreshold,
      totalDuration: videoDuration,
      insertBlankChunks,
      onEmpty: () => toast.info(t('components.workstation.smartCutEmpty')),
      onDone: (result) => {
        toast.success(
          t('components.workstation.smartCutDone')
            .replace('{count}', String(result.segments.length))
            .replace('{seconds}', result.totalBlankSeconds.toFixed(1)) + ' · ' + edlCopy(language).preview,
        );
      },
    });
  }, [chunks, smartCutSilenceThreshold, videoDuration, insertBlankChunks, language, t]);


  // 监听字幕变化并通知外部
  useEffect(() => {
    onSubtitleChanged?.(activeChunks);
  }, [activeChunks, onSubtitleChanged]);

  return (
    <div
      className={`flycut-caption-wrapper ${effectiveTheme} ${className || ''}`}
      style={style}
    >
      <div className="h-screen bg-background flex flex-col">
        {/* 顶部标题栏 - Aimu 风格 */}
        <WorkstationHeader media={media} mergedConfig={mergedConfig} onLanguageChange={onLanguageChange} onOpenVideoExport={handleOpenVideoExportDialog}
          onOpenSubtitleExport={handleOpenSubtitleExportDialog} onOpenJianyingDraft={handleOpenJianyingDraftDialog}
          onSmartCutBlank={handleSmartCutBlank} onOpenSettings={() => setSettingsOpen(true)} slot={props.headerSlot} />

        {/* 主要内容区域 - Aimu 风格左右分栏 */}
        <div className="flex-1 flex overflow-hidden bg-background">
          <>
              {/* 左侧：视频播放器 + 字幕设置 - 占 50% 宽度 */}
              <div className="w-1/2 flex-shrink-0 flex flex-col border-r border-border bg-background overflow-hidden">
                {/* 视频播放器区域 */}
                <div className="relative flex-1 bg-aimu-input flex items-center justify-center overflow-hidden">
                  {videoFile ? (
                    <div className="w-full h-full">
                      <PluginSlot id="player"
                        ref={videoPlayerRef}
                        videoUrl={videoFile.url}
                        className="w-full h-full"
                        onTimeUpdate={(time) => setCurrentTime(time)}
                        primaryStyle={subtitleStylePair.primary}
                        secondaryStyle={subtitleStylePair.secondary}
                        displayMode={display}
                        onPrimaryStyleChange={(s) => setSubtitleStylePair(prev => ({ ...prev, primary: s }))}
                        onVideoDimensionsChange={(dimensions) => {
                          setVideoMeta(dimensions);
                          // 从项目里载入的样式保留用户选的画幅，不按画面尺寸重新推断
                          if (subtitleStyleRestored) return;
                          const preset = inferAspectPreset(dimensions.width, dimensions.height);
                          // aspectPreset 仅作用于 primary（位置/比例共享）
                          setSubtitleStylePair((prev) => (
                            prev.primary.aspectPreset === preset
                              ? prev
                              : { ...prev, primary: applyAspectPreset(prev.primary, preset) }
                          ));
                        }}
                      />
                    </div>
                  ) : props.playerPlaceholder ? props.playerPlaceholder : (
                    <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-8">
                      <button
                        onClick={handleUploadClick}
                        disabled={isMediaLoading}
                        className="flex w-full max-w-md flex-col items-center justify-center rounded-lg border border-dashed border-aimu-border bg-aimu-panel px-6 py-10 text-center transition-colors hover:bg-aimu-hover disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isFileLoading ? (
                          <>
                            <Loader2 className="mb-3 h-10 w-10 animate-spin text-aimu-text-muted" />
                            <span className="text-sm font-medium text-aimu-text-primary">
                              {t('components.workstation.loadingMedia')}
                              {fileLoadProgress !== null ? ` ${fileLoadProgress}%` : ''}
                            </span>
                          </>
                        ) : (
                          <>
                            <Upload className="mb-3 h-10 w-10 text-aimu-text-muted" />
                            <span className="text-sm font-medium text-aimu-text-primary">
                              {t('components.workstation.dropFile')}
                            </span>
                            <span className="mt-1 text-[11px] text-aimu-text-muted">
                              {t('components.workstation.supportedFormatsShort')}
                            </span>
                          </>
                        )}
                      </button>
                      <div className="flex items-center gap-2 text-[11px] text-aimu-text-muted">
                        <span>{t('components.workstation.orDivider')}</span>
                      </div>
                      <button
                        onClick={() => void handleLoadSampleVideo()}
                        disabled={isSampleLoading}
                        className="flex items-center gap-2 rounded-md border border-aimu-coral/35 bg-aimu-red-bg px-4 py-2 text-sm font-medium text-aimu-coral transition-colors hover:bg-aimu-coral/15 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isSampleLoading ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            <span>
                              {t('components.workstation.loadingSampleVideo')}
                              {sampleLoadProgress !== null ? ` ${sampleLoadProgress}%` : ''}
                            </span>
                          </>
                        ) : (
                          <>
                            <Play className="h-4 w-4" />
                            {t('components.workstation.useSampleVideo')}
                          </>
                        )}
                      </button>
                    </div>
                  )}
                </div>

                {/* 视频下方：字幕设置与待办事项（Tabs 切换） */}
                <div className="h-60 border-t border-border bg-card flex flex-col overflow-hidden">
                  {/* Tab 头部 */}
                  <div className="flex border-b border-border bg-muted/10 px-4">
                    {tabOptions.map((tab) => (
                      <button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id)}
                        className={cn(
                          'px-4 py-2 text-xs font-medium transition-colors',
                          activeTab === tab.id
                            ? 'bg-aimu-purple text-white'
                            : 'text-muted-foreground hover:text-foreground'
                        )}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>

                  {/* Tab 内容 */}
                  <div className="flex-1 overflow-y-auto p-4">
                    {activeTab === 'style' ? (
                      <div className="flex flex-col h-full">
                        {props.styleHeaderSlot}
                        <SubtitleSettings
                          stylePair={subtitleStylePair}
                          onStylePairChange={setSubtitleStylePair}
                          displayMode={display}
                          onDisplayModeChange={setDisplay}
                        />
                        {props.styleFooterSlot}
                      </div>
                    ) : activeTab === 'tools' ? (
                      <div className="space-y-2">
                        <PluginSlot id="tools" />
                        <div className="text-xs text-muted-foreground font-medium mb-2">
                          {t('components.workstation.plannedTools')}
                        </div>
                        {renderFeatureItems(plannedFeatures.tools)}
                      </div>
                    ) : activeTab === 'options' ? (
                      <PluginSlot id="options" onOpenSettings={() => setSettingsOpen(true)} />
                    ) : (
                      <AISettingsPanel />
                    )}
                  </div>
                </div>
              </div>

              {/* 右侧：字幕编辑器 (SubtitleEditorPanel) - 占 50% 宽度 */}
              <div className="flex-1 flex flex-col bg-background overflow-hidden">
                <div className="flex-1 overflow-hidden flex flex-col">
                  <div className="flex-1 overflow-hidden">
                    <PluginSlot id="subtitle-editor"
                      videoPlayerRef={videoPlayerRef}
                      isASRLoading={isASRLoading}
                      asrProgress={asrProgress}
                    />
                  </div>
                </div>
              </div>
          </>
        </div>

        <TimelineWaveform
          currentTime={currentTime}
          duration={timelineDuration}
          chunks={chunks}
          onSeek={handleTimelineSeek}
          isASRLoading={isASRLoading}
          asrProgress={asrProgress}
          isVideoProcessing={isProcessing}
          videoProgress={videoProgress}
          mediaWaveformPeaks={mediaWaveformPeaks}
        />

        {/* 底部状态栏 - Aimu 风格 */}
        <footer className="flex-shrink-0 h-7 border-t border-border bg-background px-4 flex items-center justify-between text-[11px] text-muted-foreground select-none">
          <div className="flex items-center">
            {t('components.workstation.tip')}
          </div>
          <div className="flex items-center gap-3 font-mono">
            <div>{t('components.workstation.used')}: {memory.used}</div>
            <div className="text-border">|</div>
            <div>{t('components.workstation.allocated')}: {memory.allocated}</div>
            <div className="text-border">|</div>
            <div>{t('components.workstation.limit')}: {memory.limit}</div>
          </div>
        </footer>

        {/* 导出配置对话框 */}
        <ExportDialog
          open={exportDialogOpen}
          onOpenChange={setExportDialogOpen}
          exportType={exportDialogType}
          defaultExportMode={display}
          onExportSubtitles={(format, mode) => handleExportSubtitles(format, mode)}
          onExportVideo={handleVideoExport}
        />

        {/* 设置对话框（模型下载） */}
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      </div>
    </div>
  );
}

const FlyCutCaption: React.FC<FlyCutCaptionProps> = (props) => {
  return (
    <LocaleProvider
      language={props.config?.language || 'en'}
      locale={props.locale}
      onLanguageChange={props.onLanguageChange}
    >
      <ThemeInitializer />
      <ClientRuntime shell={FlyCutCaptionContent}><PluginSlot id="shell" {...props} /></ClientRuntime>
      <ToastContainer />
    </LocaleProvider>
  );
};

// Add display name for better debugging
FlyCutCaption.displayName = 'FlyCutCaption'

export default FlyCutCaption;

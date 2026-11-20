// 导出设置对话框组件

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { 
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { 
  Download, 
  FileText, 
  Video, 
  Settings,
  AlertCircle,
  CheckCircle,
  Loader2,
} from 'lucide-react';
import { isTauriRuntime } from '@/utils/runtime';
import { useTranslation } from '@/contexts/LocaleProvider';
import type { SubtitleDisplayMode } from '@/subtitle';
import { useClientRuntime } from '@/runtime/context';
import { JianyingDraftInfoPanel } from './JianyingDraftInfoPanel';
import type { SoftSubtitleCandidate } from '@/subtitle/softSubtitles';
import { SUBTITLE_FONTS } from '@/config/subtitleFonts';

export interface VideoExportOptions {
  format: 'mp4' | 'webm' | 'mkv';
  quality: 'high' | 'medium' | 'low';
  subtitleProcessing: 'none' | 'soft' | 'hard';
  subtitleExportMode: SubtitleDisplayMode;
  softTrackIds?: string[];
  softAllowPartial?: boolean;
  audioMode?: 'original' | 'dubbing' | 'dubbing-background' | 'dubbing-ducked';
  audioAssetId?: string;
  aiLabel?: string;
  subtitleTracks?: Array<{ id: string; name: string; languageCode: string; content: string; default?: boolean }>;
}

interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  exportType: 'subtitles' | 'video' | 'jianying';
  onExportSubtitles: (format: 'srt' | 'json' | 'vtt' | 'ass', exportMode: SubtitleDisplayMode, languageTrackId?: string) => void | Promise<void>;
  onExportVideo: (options: VideoExportOptions) => void;
  defaultExportMode?: SubtitleDisplayMode;
  videoMeta: { width: number; height: number };
  softTracks?: SoftSubtitleCandidate[];
  hasDubbings?: boolean;
  hasBackground?: boolean;
}

interface ExportEnvironment {
  isTauri: boolean;
  hostExportAvailable: boolean;
  hostError?: string;
  checking: boolean;
}

export function ExportDialog({
  open,
  onOpenChange,
  exportType,
  onExportSubtitles,
  onExportVideo,
  defaultExportMode,
  videoMeta,
  softTracks = [],
  hasDubbings = false,
  hasBackground = false,
}: ExportDialogProps) {
  const { connection } = useClientRuntime();
  const { t } = useTranslation();
  const initialExportMode: SubtitleDisplayMode = defaultExportMode ?? 'Bilingual';
  const [subtitleExportMode, setSubtitleExportMode] = useState<SubtitleDisplayMode>(initialExportMode);
  const [videoOptions, setVideoOptions] = useState<VideoExportOptions>({
    format: 'mp4',
    quality: 'medium',
    subtitleProcessing: 'none',
    subtitleExportMode: initialExportMode,
  });

  const [isExportingSubtitles, setIsExportingSubtitles] = useState(false);
  const [selectedSoftTracks, setSelectedSoftTracks] = useState<string[]>(['primary']);
  const [allowPartial, setAllowPartial] = useState(false);
  const [subtitleTrackId, setSubtitleTrackId] = useState<string>('primary');
  const [audioMode, setAudioMode] = useState<NonNullable<VideoExportOptions['audioMode']>>('original');

  const [env, setEnv] = useState<ExportEnvironment>({
    isTauri: isTauriRuntime(),
    hostExportAvailable: false,
    checking: true,
  });

  useEffect(() => {
    if (!open) return;
    const ready = softTracks.filter(track => track.missing + track.outdated === 0).map(track => track.id);
    setSelectedSoftTracks(ready.length ? ready : ['primary']);
    setAllowPartial(false);
    setSubtitleTrackId(softTracks.find(track => track.active)?.id ?? 'primary');
  }, [open, softTracks]);

  useEffect(() => {
    if (!open || exportType !== 'video') return;

    const isTauri = isTauriRuntime();
    let cancelled = false;
    (async () => {
      try {
        const status = await connection.call('host.info');
        const available = status.capabilities?.export === true;
        if (cancelled) return;
        setEnv({
          isTauri,
          hostExportAvailable: available,
          hostError: available ? undefined : 'Host 导出插件不可用',
          checking: false,
        });
      } catch (error) {
        if (cancelled) return;
        setEnv({
          isTauri,
          hostExportAvailable: false,
          hostError: error instanceof Error ? error.message : 'Host 导出插件检查失败',
          checking: false,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, exportType, connection]);

  const canExportVideo = env.hostExportAvailable;

  const handleSubtitleExport = async (format: 'srt' | 'json' | 'vtt' | 'ass') => {
    if (isExportingSubtitles) return;

    setIsExportingSubtitles(true);
    try {
      await onExportSubtitles(format, subtitleExportMode, subtitleExportMode === 'Main' ? undefined : subtitleTrackId);
      onOpenChange(false);
    } finally {
      setIsExportingSubtitles(false);
    }
  };

  const handleVideoExport = () => {
    if (!canExportVideo) return;
    onExportVideo({ ...videoOptions, subtitleExportMode, audioMode,
      ...(videoOptions.subtitleProcessing === 'soft' ? { softTrackIds: selectedSoftTracks, softAllowPartial: allowPartial } : {}) });
    onOpenChange(false);
  };

  const renderSubtitleOption = (
    mode: VideoExportOptions['subtitleProcessing'],
    title: string,
    description: string,
    enabled: boolean,
    disabledHint?: string,
  ) => (
    <button
      type="button"
      disabled={!enabled}
      onClick={() => enabled && setVideoOptions(prev => ({ ...prev, subtitleProcessing: mode }))}
      className={cn(
        'w-full p-3 border rounded-lg text-left transition-colors',
        !enabled && 'opacity-50 cursor-not-allowed',
        enabled && videoOptions.subtitleProcessing === mode
          ? 'border-primary bg-primary/10'
          : enabled && 'hover:bg-muted/50'
      )}
    >
      <div className="font-semibold">{title}</div>
      <div className="text-xs text-muted-foreground">
        {enabled ? description : (disabledHint ?? description)}
      </div>
    </button>
  );

  const exportModeOptions: Array<{ id: SubtitleDisplayMode; label: string }> = [
    { id: 'Bilingual', label: t('components.workstation.exportBilingual') },
    { id: 'Main', label: t('components.workstation.exportMain') },
    { id: 'Second', label: t('components.workstation.exportSecond') },
  ];

  const renderLanguageTrackSelector = () => {
    if (softTracks.length <= 1 || subtitleExportMode === 'Main') return null;
    return <div className="space-y-2">
      <label className="text-sm font-medium">语言轨 / Language track</label>
      <div className="grid grid-cols-2 gap-1">
        {softTracks.map(track => <button key={track.id} type="button" onClick={() => setSubtitleTrackId(track.id)}
          className={cn('rounded border p-1.5 text-left text-xs transition-colors', subtitleTrackId === track.id ? 'border-primary bg-primary/10' : 'hover:bg-muted/50')}>
          <span className="block font-medium">{track.name}</span>
          <span className="text-[10px] text-muted-foreground">{track.languageCode} · {track.total - track.missing - track.outdated}/{track.total}</span>
        </button>)}
      </div>
    </div>;
  };

  const renderExportContentSelector = () => (
    <div className="space-y-2">
      <label className="text-sm font-medium">{t('components.workstation.exportContent')}</label>
      <div className="grid grid-cols-3 gap-2">
        {exportModeOptions.map((opt) => (
          <button
            key={opt.id}
            type="button"
            onClick={() => setSubtitleExportMode(opt.id)}
            className={cn(
              'p-2 border rounded text-xs transition-colors',
              subtitleExportMode === opt.id
                ? 'border-primary bg-primary/10'
                : 'hover:bg-muted/50'
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );

  const activeSoftTrack = softTracks.find(track => track.active) ?? softTracks[0];
  const burnLanguage = activeSoftTrack?.languageCode?.slice(0, 2).toLowerCase() ?? 'und';
  const burnable = burnLanguage === 'und' || SUBTITLE_FONTS.some(font => font.languages.includes('auto') || font.languages.includes(burnLanguage));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center space-x-2">
            {exportType === 'jianying' ? (
              <>
                <FileText className="h-5 w-5 text-primary" />
                <span>剪映草稿 / Jianying draft</span>
              </>
            ) : exportType === 'subtitles' ? (
              <>
                <FileText className="h-5 w-5 text-primary" />
                <span>导出字幕</span>
              </>
            ) : (
              <>
                <Video className="h-5 w-5 text-primary" />
                <span>导出视频</span>
              </>
            )}
          </DialogTitle>
          <DialogDescription>
            {exportType === 'jianying'
              ? '兼容性研究与支持状态 / Compatibility research and support status'
              : exportType === 'subtitles' ? '选择字幕格式并导出字幕文件' : '配置视频导出选项'}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {exportType === 'jianying' ? (
            <JianyingDraftInfoPanel active={open} videoMeta={videoMeta} />
          ) : exportType === 'subtitles' ? (
            <div className="space-y-4">
              {renderExportContentSelector()}
              {renderLanguageTrackSelector()}

              {isExportingSubtitles && (
                <div className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-primary">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>{t('components.workstation.exportingSubtitles')}</span>
                </div>
              )}

              <div className="grid grid-cols-1 gap-3">
                <button
                  type="button"
                  disabled={isExportingSubtitles}
                  onClick={() => void handleSubtitleExport('srt')}
                  className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <div className="flex items-center space-x-3">
                    <div className="w-10 h-10 bg-blue-100 dark:bg-blue-900/30 rounded-lg flex items-center justify-center">
                      <FileText className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                    </div>
                    <div className="text-left">
                      <div className="font-semibold">SRT 格式</div>
                      <div className="text-sm text-muted-foreground">标准字幕文件</div>
                    </div>
                  </div>
                  <Download className="w-4 h-4 text-muted-foreground" />
                </button>

                <button
                  type="button"
                  disabled={isExportingSubtitles}
                  onClick={() => void handleSubtitleExport('json')}
                  className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <div className="flex items-center space-x-3">
                    <div className="w-10 h-10 bg-green-100 dark:bg-green-900/30 rounded-lg flex items-center justify-center">
                      <Settings className="w-5 h-5 text-green-600 dark:text-green-400" />
                    </div>
                    <div className="text-left">
                      <div className="font-semibold">JSON 格式</div>
                      <div className="text-sm text-muted-foreground">带时间戳数据</div>
                    </div>
                  </div>
                  <Download className="w-4 h-4 text-muted-foreground" />
                </button>

                <button
                  type="button"
                  disabled={isExportingSubtitles}
                  onClick={() => void handleSubtitleExport('vtt')}
                  className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <div className="flex items-center space-x-3">
                    <div className="w-10 h-10 bg-purple-100 dark:bg-purple-900/30 rounded-lg flex items-center justify-center">
                      <FileText className="w-5 h-5 text-purple-600 dark:text-purple-400" />
                    </div>
                    <div className="text-left">
                      <div className="font-semibold">VTT 格式</div>
                      <div className="text-sm text-muted-foreground">Web 视频标准字幕</div>
                    </div>
                  </div>
                  <Download className="w-4 h-4 text-muted-foreground" />
                </button>

                <button
                  type="button"
                  disabled={isExportingSubtitles}
                  onClick={() => void handleSubtitleExport('ass')}
                  className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <div className="flex items-center space-x-3">
                    <div className="w-10 h-10 bg-orange-100 dark:bg-orange-900/30 rounded-lg flex items-center justify-center">
                      <FileText className="w-5 h-5 text-orange-600 dark:text-orange-400" />
                    </div>
                    <div className="text-left">
                      <div className="font-semibold">ASS 格式</div>
                      <div className="text-sm text-muted-foreground">含样式，适合专业剪辑</div>
                    </div>
                  </div>
                  <Download className="w-4 h-4 text-muted-foreground" />
                </button>
              </div>

              <div className="flex items-start space-x-2 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg text-sm">
                <CheckCircle className="w-4 h-4 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" />
                <div>
                  <div className="font-medium text-blue-900 dark:text-blue-100">仅导出保留的字幕</div>
                  <div className="text-blue-700 dark:text-blue-300 mt-1">
                    已删除的字幕片段不会包含在导出文件中
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {env.checking && (
                <div className="flex items-center space-x-2 p-3 bg-muted rounded-lg text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>正在检查 Host 导出…</span>
                </div>
              )}

              {!env.checking && !env.hostExportAvailable && (
                <div className="flex items-start space-x-2 p-3 bg-destructive/10 rounded-lg text-sm">
                  <AlertCircle className="w-4 h-4 text-destructive mt-0.5 flex-shrink-0" />
                  <div>
                    <div className="font-medium text-destructive">Host 导出不可用</div>
                    <div className="text-muted-foreground mt-1">
                      {env.hostError ?? '请连接 Host 后再导出。'}
                    </div>
                  </div>
                </div>
              )}

              {!env.checking && env.hostExportAvailable && (
                <div className="flex items-start space-x-2 p-3 bg-green-50 dark:bg-green-900/20 rounded-lg text-sm">
                  <CheckCircle className="w-4 h-4 text-green-600 dark:text-green-400 mt-0.5 flex-shrink-0" />
                  <div>
                    <div className="font-medium text-green-900 dark:text-green-100">
                      Host 导出就绪
                    </div>
                    <div className="text-green-700 dark:text-green-300 mt-1 text-xs">
                      字幕场景和编码都由 Host 处理。
                    </div>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <label className="text-sm font-medium">输出格式</label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    onClick={() => setVideoOptions(prev => ({ ...prev, format: 'mp4' }))}
                    className={cn(
                      'p-3 border rounded-lg text-left transition-colors',
                      videoOptions.format === 'mp4'
                        ? 'border-primary bg-primary/10'
                        : 'hover:bg-muted/50'
                    )}
                  >
                    <div className="font-semibold">MP4</div>
                    <div className="text-xs text-muted-foreground">广泛兼容</div>
                  </button>
                  <button
                    onClick={() => setVideoOptions(prev => ({ ...prev, format: 'webm' }))}
                    className={cn(
                      'p-3 border rounded-lg text-left transition-colors',
                      videoOptions.format === 'webm'
                        ? 'border-primary bg-primary/10'
                        : 'hover:bg-muted/50'
                    )}
                  >
                    <div className="font-semibold">WebM</div>
                    <div className="text-xs text-muted-foreground">体积更小</div>
                  </button>
                  <button
                    onClick={() => setVideoOptions(prev => ({ ...prev, format: 'mkv' }))}
                    className={cn(
                      'p-3 border rounded-lg text-left transition-colors',
                      videoOptions.format === 'mkv'
                        ? 'border-primary bg-primary/10'
                        : 'hover:bg-muted/50'
                    )}
                  >
                    <div className="font-semibold">MKV</div>
                    <div className="text-xs text-muted-foreground">多软字幕轨</div>
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">输出质量</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['high', 'medium', 'low'] as const).map((quality) => (
                    <button
                      key={quality}
                      onClick={() => setVideoOptions(prev => ({ ...prev, quality }))}
                      className={cn(
                        'p-2 border rounded text-sm transition-colors',
                        videoOptions.quality === quality
                          ? 'border-primary bg-primary/10'
                          : 'hover:bg-muted/50'
                      )}
                    >
                      {quality === 'high' ? '高' : quality === 'medium' ? '中' : '低'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">字幕处理</label>
                <div className="space-y-2">
                  {renderSubtitleOption('none', '无字幕', '不处理字幕，仅导出视频', true)}
                  {renderSubtitleOption(
                    'soft',
                    '软烧录',
                    '字幕作为单独轨道嵌入，播放器可开关',
                    env.hostExportAvailable,
                    '需要 Host 导出能力',
                  )}
                  {renderSubtitleOption(
                    'hard',
                    '硬烧录',
                    'Host + Skia 字幕条带烧录到画面',
                    env.hostExportAvailable && burnable,
                    burnable ? '需要 Host 导出能力' : '此语言暂不支持烧录 / Burn-in is not available for this language',
                  )}
                </div>
              </div>

              <div className="space-y-2" data-testid="audio-mode-selector">
                <label className="text-sm font-medium">音轨 / Audio</label>
                <div className="grid grid-cols-2 gap-1">
                  {([['original', '原声'], ['dubbing', '配音'], ['dubbing-background', '配音+背景'], ['dubbing-ducked', '配音+压低原声']] as const).map(([id, label]) => (
                    <button key={id} type="button" disabled={(id !== 'original' && !hasDubbings) || (id === 'dubbing-background' && !hasBackground)}
                      onClick={() => setAudioMode(id)}
                      className={cn('rounded border p-1.5 text-xs', audioMode === id ? 'border-primary bg-primary/10' : 'hover:bg-muted/50', ((id !== 'original' && !hasDubbings) || (id === 'dubbing-background' && !hasBackground)) && 'opacity-40')}>
                      {label}
                    </button>
                  ))}
                </div>
                {audioMode !== 'original' && <p className="text-[11px] text-muted-foreground">成片默认写入 AI 配音标注；缺少/过期/过长配音会阻止导出。</p>}
              </div>

              {videoOptions.subtitleProcessing !== 'none' && (
                <>
                  {renderExportContentSelector()}
                  {videoOptions.subtitleProcessing === 'soft' && softTracks.length > 1 && <div className="space-y-1 rounded border p-2" data-testid="soft-track-selector">
                    <div className="text-sm font-medium">软字幕轨 / Soft subtitle tracks</div>
                    {videoOptions.format === 'webm' && <p className="text-xs text-orange-600">WebM 只支持一条软字幕轨</p>}
                    {softTracks.map(track => {
                      const issues = track.missing + track.outdated;
                      return <label key={track.id} className="flex items-center gap-2 text-xs">
                        <input type="checkbox" data-testid={`soft-track-${track.id}`} checked={selectedSoftTracks.includes(track.id)}
                          disabled={issues > 0 && !allowPartial}
                          onChange={() => setSelectedSoftTracks(previous => previous.includes(track.id)
                            ? previous.filter(id => id !== track.id)
                            : [...previous, track.id])} />
                        <span className="font-medium">{track.name}</span>
                        <span className="text-muted-foreground">{track.languageCode}</span>
                        {issues > 0 && <span className="text-orange-600">{issues} 条缺译/过期</span>}
                      </label>;
                    })}
                    {softTracks.some(track => track.missing + track.outdated > 0) && <label className="flex items-center gap-2 text-xs text-orange-700">
                      <input type="checkbox" data-testid="soft-track-partial" checked={allowPartial} onChange={event => setAllowPartial(event.target.checked)} />
                      导出已完成部分（缺译/过期条目会省略）
                    </label>}
                  </div>}
                </>
              )}

              <div className="flex items-start space-x-2 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg text-sm">
                <CheckCircle className="w-4 h-4 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" />
                <div>
                  <div className="font-medium text-blue-900 dark:text-blue-100">保存位置</div>
                  <div className="text-blue-700 dark:text-blue-300 mt-1">
                    {env.isTauri
                      ? '点击「开始导出」后会弹出系统保存对话框，视频将直接写入您选择的路径。处理进度会显示在时间轴区域。'
                      : '点击「开始导出」后由 Host 导出，完成后在浏览器中保存结果。'}
                  </div>
                </div>
              </div>

              <div className="flex items-start space-x-2 p-3 bg-orange-50 dark:bg-orange-900/20 rounded-lg text-sm">
                <AlertCircle className="w-4 h-4 text-orange-600 dark:text-orange-400 mt-0.5 flex-shrink-0" />
                <div>
                  <div className="font-medium text-orange-900 dark:text-orange-100">导出说明</div>
                  <div className="text-orange-700 dark:text-orange-300 mt-1">
                    所有视频导出都由 Host 执行；桌面端使用随包 FFmpeg，Web 端连接远程 Host。MP4 软字幕使用 QuickTime 文本轨，WebM 使用 WebVTT。
                  </div>
                </div>
              </div>
            </div>
          )}
        </DialogBody>

        {exportType === 'video' && (
          <DialogFooter className="border-t">
            <button
              onClick={() => onOpenChange(false)}
              className="px-4 py-2 text-sm border rounded-md hover:bg-muted/50 transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleVideoExport}
              disabled={!canExportVideo}
              className={cn(
                'px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md transition-colors',
                canExportVideo ? 'hover:bg-primary/90' : 'opacity-50 cursor-not-allowed',
              )}
            >
              开始导出
            </button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

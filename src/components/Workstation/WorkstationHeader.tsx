// 工作台顶部栏：品牌、创建/导出菜单、智能剪切、撤销重做、语言与设置
import type { ReactNode } from 'react';
import { ChevronDown, Download, FileText, Github, Keyboard, Link2, Loader2, Play, Redo2, Settings, Undo2, Upload, Video, Wand2 } from 'lucide-react';
import { useTranslation, useLocale } from '@/contexts/LocaleProvider';
import { useAppStore } from '@/stores/appStore';
import { useChunks, useHistoryStore } from '@/stores/historyStore';
import { useHostReady } from '@/runtime/connectionHooks';
import { ThemeToggle } from '@/components/ThemeToggle';
import { MessageCenterButton } from '@/components/MessageCenter';
import { ConnectionStatus } from '@/components/Connection';
import { LanguageSelector } from '@/components/LanguageSelector';
import { BrandLogo } from '@/components/BrandLogo';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import type { useMediaLoader } from '@/hooks/useMediaLoader';
import type { FlyCutCaptionConfig, FlyCutCaptionProps } from '@/types';

const languageOptions = [
  { code: 'zh', name: '中文', nativeName: '中文' },
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語' }
];

export interface WorkstationHeaderProps {
  media: ReturnType<typeof useMediaLoader>;
  mergedConfig: Required<FlyCutCaptionConfig>;
  onLanguageChange?: FlyCutCaptionProps['onLanguageChange'];
  onOpenVideoExport: () => void;
  onOpenSubtitleExport: () => void;
  onSmartCutBlank: () => void;
  onOpenSettings: () => void;
  /** 顶栏左侧、品牌之后的扩展位置，例如项目面包屑和保存状态 */
  slot?: ReactNode;
}

export function WorkstationHeader({ media, mergedConfig, onLanguageChange, onOpenVideoExport, onOpenSubtitleExport, onSmartCutBlank, onOpenSettings, slot }: WorkstationHeaderProps) {
  const { t } = useTranslation();
  const { language, setLanguage } = useLocale();
  const videoFile = useAppStore(state => state.videoFile);
  const chunks = useChunks();
  const cutsBlocked = useHistoryStore(s => !!s.cutError || s.updatingCuts || (!!s.edl && s.duration === 0));
  const hostReady = useHostReady();
  const { uploadInputRef, urlInput, setUrlInput, isUrlLoading, urlLoadProgress, isFileLoading, fileLoadProgress, isSampleLoading, sampleLoadProgress, isMediaLoading, handleLoadSampleVideo, handleNativeFileSelect, handleUploadClick, handleUrlLoad } = media;

  return (
    <header className="flex-shrink-0 h-14 bg-card border-b border-border z-10 flex items-center justify-between px-4">
      {/* LEFT */}
      <div className="flex items-center space-x-4">
        <div className="flex items-center space-x-2">
          <a href="https://www.aimu-app.com/" target="_blank" rel="noreferrer" className="-ml-1 rounded px-1 py-1 hover:text-primary transition-colors">
            <BrandLogo label={t('components.workstation.appName')} />
          </a>
          <span className="text-[10px] px-1.5 py-0.5 bg-primary/10 text-primary rounded font-mono">v{__FLYCUT_VERSION__}</span>
        </div>

        <div className="h-4 w-px bg-border mx-2"></div>

        {slot && (<>{slot}<div className="h-4 w-px bg-border mx-2"></div></>)}

        <div className="create-menu relative">
          <button data-testid="create-trigger" className="flex items-center space-x-1.5 text-sm font-medium hover:text-primary transition-colors">
            <Wand2 className="w-4 h-4" />
            <span>{t('components.workstation.create')}</span>
          </button>
          <div data-testid="create-popover" className="create-popover aimu-floating-panel absolute left-0 top-full z-50 mt-4 w-[280px] rounded border p-3 shadow-2xl backdrop-blur">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-aimu-text-primary">
              <Upload className="h-3.5 w-3.5 text-aimu-coral" />
              <span>{t('components.workstation.create')}</span>
            </div>
            <input
              ref={uploadInputRef}
              type="file"
              accept="video/mp4,video/webm,video/quicktime,video/ogg,audio/mp3,audio/wav,audio/ogg,audio/m4a"
              className="hidden"
              onChange={handleNativeFileSelect}
            />
            <button
              onClick={handleUploadClick}
              disabled={isMediaLoading || !hostReady}
              className="flex w-full flex-col items-center justify-center rounded border border-dashed border-aimu-border bg-aimu-input px-3 py-4 text-center transition-colors hover:bg-aimu-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isFileLoading ? (
                <>
                  <Loader2 className="mb-2 h-5 w-5 animate-spin text-aimu-text-muted" />
                  <span className="text-xs font-medium text-aimu-text-primary">
                    {t('components.workstation.loadingMedia')}
                    {fileLoadProgress !== null ? ` ${fileLoadProgress}%` : ''}
                  </span>
                </>
              ) : (
                <>
                  <Upload className="mb-2 h-5 w-5 text-aimu-text-muted" />
                  <span className="text-xs font-medium text-aimu-text-primary">{t('components.workstation.dropFile')}</span>
                  <span className="mt-1 text-[10px] leading-4 text-aimu-text-muted">{t('components.workstation.supportedFormatsShort')}</span>
                </>
              )}
            </button>
            <div className="my-3 flex items-center gap-2">
              <div className="h-px flex-1 bg-aimu-border" />
              <span className="text-[10px] text-aimu-text-muted">{t('components.workstation.orDivider')}</span>
              <div className="h-px flex-1 bg-aimu-border" />
            </div>
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Link2 className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-aimu-text-muted" />
                <input
                  data-testid="create-url-input"
                  type="url"
                  value={urlInput}
                  onChange={(event) => setUrlInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void handleUrlLoad();
                    }
                  }}
                  placeholder={t('components.workstation.urlPlaceholder')}
                  className="h-8 w-full rounded border border-aimu-border bg-aimu-input pl-8 pr-2 text-xs text-aimu-text-primary placeholder:text-aimu-text-muted focus:border-aimu-coral/50 focus:outline-none"
                  disabled={isUrlLoading}
                />
              </div>
              <button
                type="button"
                data-testid="create-url-load"
                onClick={() => void handleUrlLoad()}
                disabled={!urlInput.trim() || isUrlLoading || !hostReady}
                className="flex h-8 shrink-0 items-center justify-center gap-1.5 rounded border border-aimu-coral/35 bg-aimu-red-bg px-3 text-xs font-medium text-aimu-coral transition-colors hover:bg-aimu-coral/15 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isUrlLoading ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>
                      {t('components.workstation.loadingMedia')}
                      {urlLoadProgress !== null ? ` ${urlLoadProgress}%` : ''}
                    </span>
                  </>
                ) : (
                  t('components.workstation.loadUrl')
                )}
              </button>
            </div>
            <button
              type="button"
              data-testid="create-sample-load"
              onClick={() => void handleLoadSampleVideo()}
              disabled={isSampleLoading || isUrlLoading || !hostReady}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded border border-aimu-coral/35 bg-aimu-red-bg px-3 py-2 text-xs font-medium text-aimu-coral transition-colors hover:bg-aimu-coral/15 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSampleLoading ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>
                    {t('components.workstation.loadingSampleVideo')}
                    {sampleLoadProgress !== null ? ` ${sampleLoadProgress}%` : ''}
                  </span>
                </>
              ) : (
                <>
                  <Play className="h-3.5 w-3.5" />
                  {t('components.workstation.useSampleVideo')}
                </>
              )}
            </button>
          </div>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center space-x-1.5 text-sm font-medium hover:text-primary transition-colors">
              <Download className="w-4 h-4" />
              <span>{t('components.workstation.export')}</span>
              <ChevronDown className="w-3 h-3 opacity-70" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={onOpenVideoExport}
              disabled={!videoFile || cutsBlocked || !hostReady}
              className="flex items-center gap-2"
            >
              <Video className="w-4 h-4" />
              <span>{t('components.workstation.exportVideo')}</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={onOpenSubtitleExport}
              disabled={chunks.length === 0 || cutsBlocked || !hostReady}
              className="flex items-center gap-2"
            >
              <FileText className="w-4 h-4" />
              <span>{t('components.workstation.exportSubtitles')}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <button
          onClick={onSmartCutBlank}
          disabled={chunks.length === 0 || cutsBlocked || !hostReady}
          className="flex items-center space-x-1.5 text-sm font-medium hover:text-primary transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          title={t('components.workstation.smartCutBlankTitle')}
        >
          <Wand2 className="w-4 h-4" />
          <span>{t('components.workstation.smartCutBlank')}</span>
        </button>

        <div className="h-4 w-px bg-border mx-2"></div>

        <div className="flex items-center space-x-3 text-muted-foreground">
          <button className="hover:text-foreground transition-colors"><Undo2 className="w-4 h-4" /></button>
          <button className="hover:text-foreground transition-colors"><Redo2 className="w-4 h-4" /></button>
          <button className="hover:text-foreground transition-colors"><Keyboard className="w-4 h-4" /></button>
        </div>
      </div>

      {/* RIGHT */}
      <div className="flex items-center space-x-3 text-xs">
        <a data-testid="github-link" href="https://github.com/x007xyz/flycut-caption" target="_blank" rel="noreferrer" className="flex items-center space-x-1.5 text-muted-foreground hover:text-foreground transition-colors font-medium px-2">
          <Github className="w-3.5 h-3.5" />
          <span>GitHub</span>
        </a>

        <div className="h-4 w-px bg-border mx-1"></div>

        {mergedConfig.enableLanguageSelector !== false && (
          <LanguageSelector
            variant="minimal"
            currentLanguage={language}
            languages={languageOptions}
            onLanguageChange={(newLanguage) => {
              setLanguage(newLanguage);
              if (onLanguageChange) {
                onLanguageChange(newLanguage);
              }
            }}
          />
        )}

        {mergedConfig.enableThemeToggle !== false && (
          <ThemeToggle variant="button" />
        )}

        <ConnectionStatus />
        <MessageCenterButton />
        <button
          onClick={() => onOpenSettings()}
          className="flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title="设置"
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}

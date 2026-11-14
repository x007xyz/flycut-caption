import { CutHistoryPanel } from './CutHistoryPanel';
// 字幕编辑器面板 - 在同一位置切换显示「编辑模式」与「原语言模式」
// 编辑模式：现有的双语/主/副字幕编辑（SubtitleList）
// 原语言模式：字词级标注/删除，与播放器/时间轴无交互，确认后才生效（OriginalEditor）

import { cn } from '@/lib/utils';
import { SubtitleList } from './SubtitleList';
import { OriginalEditor } from './OriginalEditor';
import { FindReplaceBar } from './FindReplaceBar';
import { EditingSuggestionsPanel } from './EditingSuggestionsPanel';
import { SilenceCutPanel } from './SilenceCutPanel';
import { AgentSuggestionsBar } from './AgentSuggestionsBar';
import { LanguageTrackBar } from './LanguageTrackBar';
import { useFindReplace } from '@/hooks/useFindReplace';
import { useTranslation } from '@/contexts/LocaleProvider';
import { useEffect, useState, type RefObject } from 'react';
import type { EnhancedVideoPlayerRef } from '@/components/VideoPlayer/EnhancedVideoPlayer';
import type { ASRProgress } from '@/types/subtitle';
import type { ProviderModels } from '../../../shared/providers';
import { Scissors, Languages, AlertCircle } from 'lucide-react';
import { useWordChunks, useHasWordTimestamps, useHistoryStore } from '@/stores/historyStore';
import { canDeleteByWordAtRuntime } from '@/utils/wordLevelEdit';
import { useKeywordRecommendation } from '@/hooks/useKeywordRecommendation';
import { KeywordEmphasisPanel } from './KeywordEmphasisPanel';
import { keywordCopy } from '@/locales/keywords';
import { Tag } from 'lucide-react';

export type SubtitleEditorView = 'processed' | 'original';

interface SubtitleEditorPanelProps {
  className?: string;
  videoPlayerRef?: RefObject<EnhancedVideoPlayerRef>;
  isASRLoading?: boolean;
  asrProgress?: ASRProgress | null;
  onStartASR?: () => void;
  onOpenSettings?: () => void;
  modelGroups?: ProviderModels[];
  modelsLoading?: boolean;
  modelsError?: string;
  onRefreshModels?: () => void;
}

export function SubtitleEditorPanel({
  className,
  videoPlayerRef,
  isASRLoading,
  asrProgress,
  onStartASR,
  onOpenSettings,
  modelGroups,
  modelsLoading,
  modelsError,
  onRefreshModels,
}: SubtitleEditorPanelProps) {
  const { t, language } = useTranslation();
  const [view, setView] = useState<SubtitleEditorView>('processed');
  const find = useFindReplace();
  const keywordReview = useKeywordRecommendation();
  const openFind = find.openFind;
  const wordChunks = useWordChunks();
  const updating = useHistoryStore(s => s.updatingCuts);
  const hasWordTimestamps = useHasWordTimestamps();
  const originalModeAvailable = canDeleteByWordAtRuntime({ hasWordTimestamps, wordChunks });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'f' || event.shiftKey || event.altKey) return;
      if (!(event.metaKey || event.ctrlKey) || event.isComposing) return;
      event.preventDefault();
      if (view === 'original') setView('processed');
      openFind();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openFind, view]);

  useEffect(() => {
    const openKeywords = () => keywordReview.openPanel();
    window.addEventListener('flycut:open-keyword-recommend', openKeywords);
    return () => window.removeEventListener('flycut:open-keyword-recommend', openKeywords);
  }, [keywordReview]);

  const kwCopy = keywordCopy(language);

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* 视图切换（编辑 / 原语言） */}
      <div className="flex items-center h-10 px-3 border-b border-aimu-border bg-aimu-panel shrink-0">
        <div className="flex items-center bg-aimu-input rounded p-0.5">
          <button
            onClick={() => setView('processed')}
            className={cn(
              'flex items-center gap-1 px-3 py-1 text-xs rounded transition-colors',
              view === 'processed'
                ? 'bg-aimu-purple text-white'
                : 'text-aimu-text-secondary hover:text-aimu-text-primary'
            )}
          >
            <Scissors className="w-3 h-3" />
            {t('components.workstation.editModeProcessed')}
          </button>
          <button
            onClick={() => originalModeAvailable && setView('original')}
            disabled={!originalModeAvailable}
            title={!originalModeAvailable ? t('components.workstation.originalWordLevelRequired') : undefined}
            className={cn(
              'flex items-center gap-1 px-3 py-1 text-xs rounded transition-colors',
              !originalModeAvailable && 'opacity-40 cursor-not-allowed',
              view === 'original' && originalModeAvailable
                ? 'bg-aimu-coral text-white'
                : 'text-aimu-text-secondary hover:text-aimu-text-primary',
            )}
          >
            <Languages className="w-3 h-3" />
            {t('components.workstation.editorOriginal')}
            {!originalModeAvailable && <AlertCircle className="w-3 h-3 text-amber-500" />}
          </button>
        </div>
        <button
          type="button"
          data-testid="keyword-open"
          onClick={keywordReview.openPanel}
          className="ml-2 flex items-center gap-1 rounded px-2 py-1 text-xs text-aimu-text-secondary transition-colors hover:text-aimu-text-primary"
        >
          <Tag className="w-3 h-3" />
          {kwCopy.panelEntry}
        </button>
      </div>

      <KeywordEmphasisPanel review={keywordReview} />
      <LanguageTrackBar />
      <CutHistoryPanel />
      <AgentSuggestionsBar />
      <EditingSuggestionsPanel onSeek={time => videoPlayerRef?.current?.seekTo(time)} />
      <SilenceCutPanel onSeek={time => videoPlayerRef?.current?.seekTo(time)} />
      <FindReplaceBar find={find} />
      <div className="flex-1 overflow-hidden" inert={updating}>
        {view === 'processed' ? (
          <SubtitleList
            find={find}
            videoPlayerRef={videoPlayerRef}
            isASRLoading={isASRLoading}
            asrProgress={asrProgress}
            onStartASR={onStartASR}
            onOpenSettings={onOpenSettings}
            modelGroups={modelGroups}
            modelsLoading={modelsLoading}
            modelsError={modelsError}
            onRefreshModels={onRefreshModels}
          />
        ) : (
          <OriginalEditor isASRLoading={isASRLoading} />
        )}
      </div>
    </div>
  );
}

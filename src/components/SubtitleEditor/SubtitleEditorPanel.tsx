import { CutHistoryPanel } from './CutHistoryPanel';
// 字幕编辑器面板 - 在同一位置切换显示「编辑模式」与「原语言模式」
// 编辑模式：现有的双语/主/副字幕编辑（SubtitleList）
// 原语言模式：字词级标注/删除，与播放器/时间轴无交互，确认后才生效（OriginalEditor）

import { cn } from '@/lib/utils';
import { SubtitleList } from './SubtitleList';
import { OriginalEditor } from './OriginalEditor';
import { useTranslation } from '@/contexts/LocaleProvider';
import { useState, type RefObject } from 'react';
import type { EnhancedVideoPlayerRef } from '@/components/VideoPlayer/EnhancedVideoPlayer';
import type { ASRProgress } from '@/types/subtitle';
import { Scissors, Languages, AlertCircle } from 'lucide-react';
import { useWordChunks, useHasWordTimestamps, useHistoryStore } from '@/stores/historyStore';
import { canDeleteByWordAtRuntime } from '@/utils/wordLevelEdit';

export type SubtitleEditorView = 'processed' | 'original';

interface SubtitleEditorPanelProps {
  className?: string;
  videoPlayerRef?: RefObject<EnhancedVideoPlayerRef>;
  isASRLoading?: boolean;
  asrProgress?: ASRProgress | null;
}

export function SubtitleEditorPanel({
  className,
  videoPlayerRef,
  isASRLoading,
  asrProgress,
}: SubtitleEditorPanelProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<SubtitleEditorView>('processed');
  const wordChunks = useWordChunks();
  const updating = useHistoryStore(s => s.updatingCuts);
  const hasWordTimestamps = useHasWordTimestamps();
  const originalModeAvailable = canDeleteByWordAtRuntime({ hasWordTimestamps, wordChunks });

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
      </div>

      <CutHistoryPanel />
      <div className="flex-1 overflow-hidden" inert={updating}>
        {view === 'processed' ? (
          <SubtitleList
            videoPlayerRef={videoPlayerRef}
            isASRLoading={isASRLoading}
            asrProgress={asrProgress}
          />
        ) : (
          <OriginalEditor isASRLoading={isASRLoading} />
        )}
      </div>
    </div>
  );
}

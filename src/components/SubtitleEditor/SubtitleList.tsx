import { edlCopy } from '@/locales/edl';
// 字幕列表组件

import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react';
import { cn } from '@/lib/utils';
import { useHistoryStore, useChunks, useHistoryText, useHistoryLanguage, useHistoryDuration, useCanUndo, useCanRedo, useUndo, useRedo } from '@/stores/historyStore';
import { useAppStore } from '@/stores/appStore';
import { isTimeInRange } from '@/utils/timeUtils';
import { runSmartCutBlank } from '@/utils/smartCutBlank';
import { FileText, Trash2, RotateCcw, Undo, Redo, Languages, Loader2, Mic, AlertCircle, Wand2, Scissors } from 'lucide-react';
import { toast } from 'sonner';
import { SubtitleItem } from './SubtitleItem';
import type { EnhancedVideoPlayerRef } from '@/components/VideoPlayer/EnhancedVideoPlayer';
import { useTranslation } from '@/contexts/LocaleProvider';
import type { ASRProgress } from '@/types/subtitle';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { COMMON_LANGUAGES } from '@/constants/languages';
import { useAI } from '@/hooks/useAI';
import { useCorrectionReview } from '@/hooks/useCorrectionReview';
import { CorrectionReviewPanel } from './CorrectionReviewPanel';
import type { FindReplaceActions, FindReplaceState } from '@/hooks/useFindReplace';
import type { FindMatch } from '../../../shared/text/findReplace';
import { languageTrackCopy } from '@/locales/languageTracks';

interface SubtitleListProps {
  className?: string;
  find?: FindReplaceState & FindReplaceActions;
  currentTime?: number;
  isPlaying?: boolean;
  onSeek?: (time: number) => void;
  onPlayPause?: () => void;
  videoPlayerRef?: RefObject<EnhancedVideoPlayerRef>;
  /** ASR 是否正在识别 */
  isASRLoading?: boolean;
  /** ASR 进度信息 */
  asrProgress?: ASRProgress | null;
}

export function SubtitleList({
  className,
  find,
  videoPlayerRef,
  isASRLoading,
  asrProgress,
}: SubtitleListProps) {
  const { t, language: uiLanguage } = useTranslation();
  const chunks = useChunks();
  const text = useHistoryText();
  const language = useHistoryLanguage();
  const duration = useHistoryDuration();
  
  // 历史记录操作
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();
  const undo = useUndo();
  const redo = useRedo();
  
  const transcript = useMemo(() => ({
    text,
    chunks,
    language,
    duration,
  }), [text, chunks, language, duration]);
  
  const activeChunks = useMemo(
    () => chunks.filter(c => !c.deleted),
    [chunks]
  );
  
  const currentTime = useAppStore(state => state.currentTime);
  const setCurrentTime = useAppStore(state => state.setCurrentTime);
  const displayMode = useAppStore(state => state.display);
  const setDisplayMode = useAppStore(state => state.setDisplay);
  const aiModels = useAppStore(state => state.aiModels);
  const selectedAIModelId = useAppStore(state => state.selectedAIModelId);
  const setSelectedAIModelId = useAppStore(state => state.setSelectedAIModelId);

  const { isAILoading, aiProgress, hasModels, runTranslation } = useAI();
  const review = useCorrectionReview();
  const [targetLang, setTargetLang] = useState<string>('en');

  const deleteSelected = useHistoryStore(state => state.deleteSelected);
  const restoreSelected = useHistoryStore(state => state.restoreSelected);
  const insertBlankChunks = useHistoryStore(state => state.proposeCuts);
  const smartCutSilenceThreshold = useAppStore(state => state.smartCutSilenceThreshold);
  const videoDuration = useAppStore(state => state.videoPlayerState.duration);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const findMatchesByChunk = useMemo(() => {
    const byChunk = new Map<string, FindMatch[]>();
    for (const match of find?.matches ?? []) {
      const list = byChunk.get(match.chunkId) ?? [];
      list.push(match);
      byChunk.set(match.chunkId, list);
    }
    return byChunk;
  }, [find?.matches]);

  const activeFindChunkId = find?.matches[find.current]?.chunkId;
  useEffect(() => {
    if (!activeFindChunkId) return;
    const row = document.querySelector(`[data-chunk-id="${activeFindChunkId}"]`);
    row?.scrollIntoView({ block: 'center' });
  }, [activeFindChunkId]);

  const seekTo = useCallback((time: number) => {
    setCurrentTime(time);
    videoPlayerRef.current?.seekTo(time);
  }, [setCurrentTime, videoPlayerRef]);

  const currentChunk = useMemo(() => {
    let result = null;
    for (const chunk of transcript.chunks) {
      if (isTimeInRange(currentTime, chunk.timestamp)) {
        // 边界处优先选择后一段（start 更大的），避免相邻字幕共享时间点时高亮不切换
        if (!result || chunk.timestamp[0] > result.timestamp[0]) {
          result = chunk;
        }
      }
    }
    return result;
  }, [transcript.chunks, currentTime]);

  const statistics = useMemo(() => {
    const realChunks = transcript.chunks.filter(chunk => !chunk.isBlankSpacer);
    const deletedChunks = realChunks.filter(chunk => chunk.deleted);
    const activeCount = realChunks.filter(chunk => !chunk.deleted).length;
    const deletedCount = deletedChunks.length;
    const blankCount = transcript.chunks.filter(chunk => chunk.isBlankSpacer).length;
    const totalCount = realChunks.length;

    return {
      totalCount,
      activeCount,
      deletedCount,
      blankCount,
    };
  }, [transcript.chunks]);

  const handleToggleSelection = (chunkId: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(chunkId)) {
      newSelected.delete(chunkId);
    } else {
      newSelected.add(chunkId);
    }
    setSelectedIds(newSelected);
  };

  const handleDeleteSelected = () => {
    if (selectedIds.size > 0) {
      deleteSelected(selectedIds);
      setSelectedIds(new Set());
    }
  };

  const handleSelectAll = () => {
    const allActiveIds = new Set(activeChunks.map(chunk => chunk.id));
    setSelectedIds(allActiveIds);
  };

  const handleClearSelection = () => {
    setSelectedIds(new Set());
  };

  const handleSmartCutBlank = useCallback(() => {
    runSmartCutBlank({
      chunks: transcript.chunks,
      threshold: smartCutSilenceThreshold,
      totalDuration: videoDuration,
      insertBlankChunks,
      onEmpty: () => toast.info(t('components.workstation.smartCutEmpty')),
      onDone: (result) => {
        toast.success(
          t('components.workstation.smartCutDone')
            .replace('{count}', String(result.segments.length))
            .replace('{seconds}', result.totalBlankSeconds.toFixed(1)) + ' · ' + edlCopy(uiLanguage).preview,
        );
      },
    });
  }, [
    transcript.chunks,
    smartCutSilenceThreshold,
    videoDuration,
    insertBlankChunks,
    uiLanguage, t,
  ]);

  const handleRestoreDeleted = () => {
    const deletedIds = new Set(
      transcript.chunks
        .filter(chunk => chunk.deleted && !chunk.isBlankSpacer)
        .map(chunk => chunk.id)
    );
    if (deletedIds.size > 0) {
      restoreSelected(deletedIds);
    }
  };

  // ASR 识别中：在字幕编辑器内展示加载状态
  if (isASRLoading) {
    const isError = asrProgress?.status === 'error';
    const progressValue = asrProgress?.progress ?? 0;
    const stageLabel = asrProgress?.data || (asrProgress?.status === 'running'
      ? t('messages.asr.asrProgress')
      : t('messages.asr.modelLoading'));

    return (
      <div className={cn('flex flex-col h-full bg-aimu-panel', className)}>
        <div className="flex-1 flex flex-col items-center justify-center p-8 select-none">
          {isError ? (
            <AlertCircle className="h-10 w-10 text-aimu-coral mb-4" />
          ) : (
            <Loader2 className="h-10 w-10 text-aimu-coral animate-spin mb-4" />
          )}
          <div className="flex items-center gap-2 text-aimu-text-primary font-medium mb-1">
            {!isError && <Mic className="h-4 w-4 text-aimu-coral" />}
            <span>{isError ? t('messages.asr.asrFailed') : t('messages.asr.asrStarted')}</span>
          </div>
          <p className="text-sm text-aimu-text-muted text-center max-w-xs">
            {isError ? (asrProgress?.error || t('messages.asr.asrFailed')) : stageLabel}
          </p>
          {!isError && asrProgress?.progress !== undefined && (
            <div className="w-48 mt-4 space-y-1.5">
              <div className="w-full bg-aimu-input rounded-full h-1.5 overflow-hidden">
                <div
                  className="bg-aimu-coral h-1.5 rounded-full transition-all duration-300"
                  style={{ width: `${progressValue}%` }}
                />
              </div>
              <div className="flex justify-between text-[10px] text-aimu-text-muted font-mono">
                <span>{t('components.asrPanel.progress')}</span>
                <span>{Math.round(progressValue)}%</span>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!transcript.chunks || transcript.chunks.length === 0) {
    return (
      <div className={cn('flex flex-col items-center justify-center p-8 bg-aimu-panel h-full', className)}>
        <FileText className="h-12 w-12 text-aimu-text-muted mb-4" />
        <p className="text-aimu-text-muted text-center">
          {languageTrackCopy(uiLanguage).empty}
          <br />
          {t('components.fileUpload.dragDropText')}
        </p>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col h-full bg-aimu-panel', className)}>
      {/* Panel Header (~40px tall, border-bottom) */}
      <div className="flex items-center justify-between h-10 px-3 border-b border-aimu-border shrink-0">
        {/* LEFT: Display mode segmented control */}
        <div className="flex items-center bg-aimu-input rounded p-0.5">
          <button
            onClick={() => setDisplayMode('Bilingual')}
            className={cn(
              'px-3 py-1 text-xs rounded transition-colors',
              displayMode === 'Bilingual' 
                ? 'bg-aimu-purple text-white' 
                : 'text-aimu-text-secondary hover:text-aimu-text-primary'
            )}
          >
            {t('components.workstation.displayBilingual')}
          </button>
          <button
            onClick={() => setDisplayMode('Main')}
            className={cn(
              'px-3 py-1 text-xs rounded transition-colors',
              displayMode === 'Main' 
                ? 'bg-aimu-purple text-white' 
                : 'text-aimu-text-secondary hover:text-aimu-text-primary'
            )}
          >
            {t('components.workstation.displayMain')}
          </button>
          <button
            onClick={() => setDisplayMode('Second')}
            className={cn(
              'px-3 py-1 text-xs rounded transition-colors',
              displayMode === 'Second' 
                ? 'bg-aimu-purple text-white' 
                : 'text-aimu-text-secondary hover:text-aimu-text-primary'
            )}
          >
            {t('components.workstation.displaySecond')}
          </button>
        </div>

        {/* RIGHT: AI model + target language + correct + translate */}
        <div className="flex items-center gap-1.5">
          {/* AI 模型选择 */}
          <Select
            value={selectedAIModelId ?? ''}
            onValueChange={(v) => setSelectedAIModelId(v || null)}
            disabled={isAILoading}
          >
            <SelectTrigger className="h-6 w-24 text-xs bg-aimu-input border-aimu-border">
              <SelectValue placeholder={t('components.aiSettings.selectModel')} />
            </SelectTrigger>
            <SelectContent>
              {!hasModels ? (
                <SelectItem value="__none" disabled>
                  {t('components.aiSettings.noModel')}
                </SelectItem>
              ) : (
                aiModels.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>

          {/* 目标语言 */}
          <Select value={targetLang} onValueChange={setTargetLang} disabled={isAILoading}>
            <SelectTrigger className="h-6 w-20 text-xs bg-aimu-input border-aimu-border">
              <div className="flex items-center gap-1">
                <Languages className="w-3 h-3" />
                <SelectValue />
              </div>
            </SelectTrigger>
            <SelectContent>
              {COMMON_LANGUAGES.map((lang) => (
                <SelectItem key={lang.code} value={lang.code}>
                  {lang.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* 纠错 */}
          <button
            data-testid="correction-open"
            onClick={review.openPanel}
            disabled={isAILoading && review.phase !== 'running'}
            className={cn(
              'flex items-center gap-1 px-2 py-0.5 text-xs rounded font-medium transition-colors',
              isAILoading
                ? 'bg-aimu-purple/50 text-white -not-allowed'
                : 'bg-aimu-purple text-white hover:bg-aimu-purple/90 disabled:opacity-40 disabled:-not-allowed',
            )}
            title={t('components.workstation.correctSubtitle')}
          >
            {review.phase === 'running' && aiProgress?.data ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Wand2 className="w-3 h-3" />
            )}
            <span>{review.phase === 'running' ? t('components.workstation.correcting') : t('components.workstation.correctStart')}</span>
          </button>

          {/* 翻译 */}
          <button
            onClick={() => runTranslation(targetLang)}
            disabled={isAILoading || !selectedAIModelId}
            className={cn(
              'flex items-center gap-1 px-2 py-0.5 text-xs rounded font-medium transition-colors',
              isAILoading
                ? 'bg-aimu-red-bg/70 text-aimu-coral -not-allowed'
                : 'bg-aimu-red-bg text-aimu-coral hover:bg-aimu-red-bg/80 disabled:opacity-40 disabled:-not-allowed',
            )}
            title={t('components.workstation.translateStart')}
          >
            {isAILoading ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Languages className="w-3 h-3" />
            )}
            <span>{isAILoading ? t('components.workstation.translating') : t('components.workstation.translateStart')}</span>
          </button>
        </div>
      </div>

      <CorrectionReviewPanel review={review} />

      {/* Subtitle List (scrollable) */}
      <div className="flex-1 overflow-y-auto">
        {transcript.chunks
          .filter(chunk => !chunk.deleted)
          .map((chunk, index) => {
            const isActive = !chunk.deleted;
            const isCurrent = currentChunk?.id === chunk.id;
            const isSelected = selectedIds.has(chunk.id);

            return (
              <SubtitleItem
                key={chunk.id}
                chunk={chunk}
                index={index}
                findMatches={findMatchesByChunk.get(chunk.id)}
                findActive={activeFindChunkId === chunk.id}
                isActive={isActive}
                isCurrent={isCurrent}
                isSelected={isSelected}
                textSuggestion={review.suggestionsById.get(chunk.id)}
                textPreview={review.preview && (review.phase === 'review' || review.phase === 'partial' || review.phase === 'applying')}
                onSuggestionChange={review.updateSuggestion}
                onToggleSelection={handleToggleSelection}
                onSeekTo={seekTo}
              />
            );
          })}
      </div>

      {/* Status/toolbar area at the bottom */}
      <div className="flex items-center justify-between p-2 border-t border-aimu-border bg-aimu-panel shrink-0">
        <div className="flex items-center gap-1">
          <button
            onClick={undo}
            disabled={!canUndo}
            className="p-1.5 text-aimu-text-muted hover:text-aimu-text-primary disabled:opacity-30 transition-colors rounded"
            title={t('components.subtitleEditor.undoDelete')}
          >
            <Undo className="w-4 h-4" />
          </button>
          <button
            onClick={redo}
            disabled={!canRedo}
            className="p-1.5 text-aimu-text-muted hover:text-aimu-text-primary disabled:opacity-30 transition-colors rounded"
            title={t('components.subtitleEditor.redoDelete')}
          >
            <Redo className="w-4 h-4" />
          </button>
          
          <div className="w-px h-4 bg-aimu-border mx-1"></div>

          <button
            onClick={handleSmartCutBlank}
            className="flex items-center gap-1 px-2 py-1 text-xs text-aimu-text-secondary hover:text-aimu-purple transition-colors"
            title={t('components.workstation.smartCutBlankTitle')}
          >
            <Scissors className="w-3.5 h-3.5" />
            <span>{t('components.workstation.smartCutBlank')}</span>
          </button>

          <div className="w-px h-4 bg-aimu-border mx-1"></div>
          
          <button
            onClick={handleSelectAll}
            className="px-2 py-1 text-xs text-aimu-text-secondary hover:text-aimu-text-primary transition-colors"
          >
            {t('components.subtitleEditor.selectAll')}
          </button>
          <button
            onClick={handleClearSelection}
            className="px-2 py-1 text-xs text-aimu-text-secondary hover:text-aimu-text-primary transition-colors"
          >
            {t('components.subtitleEditor.clearSelection')}
          </button>
        </div>

        <div className="flex items-center gap-2">
          <div className="text-[11px] text-aimu-text-muted font-mono mr-2">
            {t('components.workstation.total')}: {statistics.totalCount} | {t('components.workstation.active')}: {statistics.activeCount}
            {statistics.blankCount > 0 && ` | ${t('components.workstation.blankSegment')}: ${statistics.blankCount}`}
          </div>
          
          <button
            onClick={handleDeleteSelected}
            disabled={selectedIds.size === 0}
            className="flex items-center gap-1 px-2 py-1 text-xs text-aimu-coral hover:bg-aimu-red-bg rounded disabled:opacity-30 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>{t('components.subtitleEditor.deleteSelected')} ({selectedIds.size})</span>
          </button>

          {statistics.deletedCount > 0 && (
            <button
              onClick={handleRestoreDeleted}
              className="flex items-center gap-1 px-2 py-1 text-xs text-green-500 hover:bg-green-500/10 rounded transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>{t('components.workstation.restore')} ({statistics.deletedCount})</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

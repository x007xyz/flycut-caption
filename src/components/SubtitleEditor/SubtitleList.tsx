import { edlCopy } from '@/locales/edl';
// 字幕列表组件

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { cn } from '@/lib/utils';
import { useHistoryStore, useChunks, useHistoryText, useHistoryLanguage, useHistoryDuration, useCanUndo, useCanRedo, useUndo, useRedo } from '@/stores/historyStore';
import { useAppStore } from '@/stores/appStore';
import { useProjectStore } from '@/stores/projectStore';
import { speakerForCue } from '../../../shared/speakers';
import { isTimeInRange } from '@/utils/timeUtils';
import { runSmartCutBlank } from '@/utils/smartCutBlank';
import { FileText, Trash2, RotateCcw, Undo, Redo, Languages, Loader2, Mic, AlertCircle, Wand2, Scissors, Volume2 } from 'lucide-react';
import { toast } from 'sonner';
import { SubtitleItem, type SubtitleItemDraft } from './SubtitleItem';
import { useVariableRows } from './useVariableRows';
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
import { useBatchTranslation } from '@/hooks/useBatchTranslation';
import { useCueDubbing } from '@/hooks/useCueDubbing';
import { CorrectionReviewPanel } from './CorrectionReviewPanel';
import { TranslationPanel } from './TranslationPanel';
import { SingleCueDubbingPanel } from './SingleCueDubbingPanel';
import { TrackDubbingPanel } from './TrackDubbingPanel';
import { VoiceClonePanel } from './VoiceClonePanel';
import { SpeakerPanel } from './SpeakerPanel';
import { SeparationPanel } from './SeparationPanel';
import { ClipsPanel } from './ClipsPanel';
import { useClips } from '@/hooks/useClips';
import { useClipExport } from '@/hooks/useClipExport';
import { useSeparation } from '@/hooks/useSeparation';
import { useSpeakers } from '@/hooks/useSpeakers';
import { useTrackDubbing } from '@/hooks/useTrackDubbing';
import { dubbingCopy } from '@/locales/dubbing';
import type { FindReplaceActions, FindReplaceState } from '@/hooks/useFindReplace';
import type { FindMatch } from '../../../shared/text/findReplace';
import { languageTrackCopy } from '@/locales/languageTracks';
import type { ProviderModels } from '../../../shared/providers';
import { RecommendedModelCard } from '@/components/ASR/RecommendedModelCard';
import { asrModelsCopy } from '@/locales/models';
import { findModel } from '@/hooks/useProviderModels';

interface StoredSubtitleDraft extends SubtitleItemDraft {
  baseMainText: string;
  baseSecondText: string;
  preview: boolean;
}

function VirtualSubtitleRow({ index, top, registerRow, children }: {
  index: number; top: number; registerRow: (index: number, node: HTMLElement | null) => void; children: ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = rowRef.current;
    registerRow(index, node);
    return () => registerRow(index, null);
  }, [index, registerRow]);
  return (
    <div
      ref={rowRef}
      data-virtual-row-index={index}
      style={{ position: 'absolute', top, left: 0, right: 0 }}
    >
      {children}
    </div>
  );
}

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
  onStartASR?: () => void;
  onOpenSettings?: () => void;
  modelGroups?: ProviderModels[];
  modelsLoading?: boolean;
  modelsError?: string;
  onRefreshModels?: () => void;
}

export function SubtitleList({
  className,
  find,
  videoPlayerRef,
  isASRLoading,
  asrProgress,
  onStartASR,
  onOpenSettings,
  modelGroups,
  modelsLoading,
  modelsError,
  onRefreshModels,
}: SubtitleListProps) {
  const { t, language: uiLanguage } = useTranslation();
  const chunks = useChunks();
  const speakerFilter = useAppStore(state => state.speakerFilter);
  const speakerSegments = useProjectStore(state => state.current?.speakerSegments);
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
    () => chunks.filter(c => !c.deleted && (!speakerFilter || speakerForCue(speakerSegments ?? [], c.timestamp) === speakerFilter)),
    [chunks, speakerFilter, speakerSegments]
  );
  
  const videoFile = useAppStore(state => state.videoFile);
  const asrModel = useAppStore(state => state.asrModel);
  const currentTime = useAppStore(state => state.currentTime);
  const setCurrentTime = useAppStore(state => state.setCurrentTime);
  const displayMode = useAppStore(state => state.display);
  const setDisplayMode = useAppStore(state => state.setDisplay);
  const aiModels = useAppStore(state => state.aiModels);
  const selectedAIModelId = useAppStore(state => state.selectedAIModelId);
  const setSelectedAIModelId = useAppStore(state => state.setSelectedAIModelId);

  const { isAILoading, aiProgress, hasModels } = useAI();
  const review = useCorrectionReview();
  const [targetLang, setTargetLang] = useState<string>('en');

  const deleteSelected = useHistoryStore(state => state.deleteSelected);
  const restoreSelected = useHistoryStore(state => state.restoreSelected);
  const insertBlankChunks = useHistoryStore(state => state.proposeCuts);
  const smartCutSilenceThreshold = useAppStore(state => state.smartCutSilenceThreshold);
  const videoDuration = useAppStore(state => state.videoPlayerState.duration);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const translation = useBatchTranslation(targetLang, setTargetLang, selectedIds);
  const projectId = useProjectStore(state => state.current?.projectId ?? '');
  const videoId = useProjectStore(state => state.current?.videoId ?? '');
  const activeById = useMemo(() => new Map(activeChunks.map(chunk => [chunk.id, chunk])), [activeChunks]);
  const indexById = useMemo(() => new Map(activeChunks.map((chunk, index) => [chunk.id, index])), [activeChunks]);
  const draftScope = `${projectId}:${videoId}`;
  const draftsRef = useRef(new Map<string, StoredSubtitleDraft>());
  const updateChunk = useHistoryStore(state => state.update);
  const dubText = dubbingCopy(uiLanguage);
  const isPreviewing = review.preview && (review.phase === 'review' || review.phase === 'partial' || review.phase === 'applying');
  const virtual = useVariableRows({
    count: activeChunks.length,
    estimate: displayMode === 'Bilingual' ? 128 : 104,
    measurementKey: `${draftScope}:${displayMode}`,
  });
  const { range, contentRef, registerRow, scrollToIndex, isIndexVisible, markManualScroll, manualScrollAt } = virtual;

  const clearDraftField = useCallback((id: string, field: 'mainText' | 'secondText') => {
    const draft = draftsRef.current.get(id);
    if (!draft) return;
    const next = { ...draft, [field]: undefined };
    if (next.mainText === undefined && next.secondText === undefined && next.isExpanded === undefined) draftsRef.current.delete(id);
    else draftsRef.current.set(id, next);
  }, []);

  const updateDraft = useCallback((id: string, patch: SubtitleItemDraft) => {
    const chunk = activeById.get(id);
    if (!chunk) return;
    const previous = draftsRef.current.get(id);
    const next: StoredSubtitleDraft = {
      ...previous,
      baseMainText: previous?.baseMainText ?? chunk.text,
      baseSecondText: previous?.baseSecondText ?? (chunk.secondText || ''),
      preview: isPreviewing,
      ...patch,
    };
    if (next.mainText === chunk.text && next.secondText === undefined && next.isExpanded === undefined) draftsRef.current.delete(id);
    else draftsRef.current.set(id, next);
  }, [activeById, isPreviewing]);

  const flushDrafts = useCallback((ids?: Iterable<string>) => {
    const selected = new Set(ids ?? draftsRef.current.keys());
    for (const id of selected) {
      const draft = draftsRef.current.get(id);
      if (!draft) continue;
      const chunk = chunks.find(item => item.id === id);
      if (!chunk) { draftsRef.current.delete(id); continue; }
      if (!draft.preview) {
        const patch: { text?: string; secondText?: string } = {};
        if (draft.mainText !== undefined && draft.mainText.trim() !== chunk.text) patch.text = draft.mainText.trim();
        if (draft.secondText !== undefined && draft.secondText.trim() !== (chunk.secondText || '')) patch.secondText = draft.secondText.trim();
        if (Object.keys(patch).length) updateChunk(id, patch);
      }
      const next = { ...draft, mainText: undefined, secondText: undefined };
      if (next.isExpanded === undefined) draftsRef.current.delete(id);
      else draftsRef.current.set(id, next);
    }
  }, [chunks, updateChunk]);

  useEffect(() => {
    draftsRef.current.clear();
  }, [draftScope]);

  useEffect(() => {
    for (const [id, draft] of draftsRef.current) {
      const chunk = chunks.find(item => item.id === id);
      if (!chunk || chunk.text !== draft.baseMainText || (chunk.secondText || '') !== draft.baseSecondText) {
        draftsRef.current.delete(id);
      }
    }
  }, [chunks]);

  useEffect(() => {
    const outside = [...draftsRef.current.keys()].filter(id => {
      const index = indexById.get(id);
      return index !== undefined && (index < range.start || index >= range.end);
    });
    if (outside.length) flushDrafts(outside);
  }, [flushDrafts, indexById, range.end, range.start]);
  const dubbing = useCueDubbing({ modelGroups, modelsLoading, modelsError, onFlushDrafts: () => flushDrafts() });
  const trackDubbing = useTrackDubbing(modelGroups ?? [], onOpenSettings);
  const [voicePanelOpen, setVoicePanelOpen] = useState(false);
  const speakers = useSpeakers(modelGroups ?? []);
  const separation = useSeparation(modelGroups ?? []);
  const clips = useClips(time => videoPlayerRef?.current?.seekTo(time));
  const clipExport = useClipExport();

  useEffect(() => {
    const flushBeforeLeavingList = (event: PointerEvent) => {
      const node = contentRef.current;
      if (!node || (event.target instanceof Node && node.contains(event.target))) return;
      flushDrafts();
    };
    const flushOnPageHide = () => flushDrafts();
    document.addEventListener('pointerdown', flushBeforeLeavingList, true);
    window.addEventListener('pagehide', flushOnPageHide);
    return () => {
      document.removeEventListener('pointerdown', flushBeforeLeavingList, true);
      window.removeEventListener('pagehide', flushOnPageHide);
    };
  }, [contentRef, flushDrafts]);

  const handleVirtualKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>('[data-virtual-row-index]');
    if (!row) return;
    const rowIndex = Number(row.dataset.virtualRowIndex);
    const controls = [...row.querySelectorAll<HTMLElement>('input:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter(element => element.getClientRects().length > 0);
    const position = controls.indexOf(target);
    if (position < 0) return;
    const backwards = event.shiftKey;
    const atBoundary = backwards
      ? rowIndex === range.start && position === 0
      : rowIndex === Math.max(range.start, range.end - 1) && position === controls.length - 1;
    if (!atBoundary) return;
    const nextIndex = rowIndex + (backwards ? -1 : 1);
    if (nextIndex < 0 || nextIndex >= activeChunks.length) return;
    event.preventDefault();
    scrollToIndex(nextIndex, 'auto');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const nextRow = contentRef.current?.querySelector<HTMLElement>(`[data-virtual-row-index="${nextIndex}"]`);
      if (!nextRow) return;
      const nextControls = [...nextRow.querySelectorAll<HTMLElement>('input:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter(element => element.getClientRects().length > 0);
      (backwards ? nextControls.at(-1) : nextControls[0])?.focus();
    }));
  }, [activeChunks.length, contentRef, range.end, range.start, scrollToIndex]);

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
    const index = indexById.get(activeFindChunkId);
    if (index !== undefined) scrollToIndex(index, 'center');
  }, [activeFindChunkId, indexById, scrollToIndex]);

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

  const currentChunkId = currentChunk?.id;
  const followStateRef = useRef({ indexById, isIndexVisible, manualScrollAt, scrollToIndex });
  followStateRef.current = { indexById, isIndexVisible, manualScrollAt, scrollToIndex };
  useEffect(() => {
    if (!currentChunkId) return;
    const follow = followStateRef.current;
    const index = follow.indexById.get(currentChunkId);
    if (index === undefined || follow.isIndexVisible(index)) return;
    if (performance.now() - follow.manualScrollAt() < 3000) return;
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement && contentRef.current?.contains(active)) return;
    follow.scrollToIndex(index, 'center');
  }, [contentRef, currentChunkId]);

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
    if (videoFile) {
      const mc = asrModelsCopy(uiLanguage);
      const selectedReady = findModel(modelGroups ?? [], asrModel)?.model.status === 'ready';
      return (
        <div data-testid="subtitle-model-guide" className={cn('flex flex-col items-center justify-center overflow-y-auto p-6 bg-aimu-panel h-full', className)}>
          <div className="w-full max-w-xl space-y-3">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold text-aimu-text-primary">{selectedReady ? mc.readyToTranscribeTitle : mc.missingTitle}</h2>
              <p className="text-xs text-aimu-text-muted">{selectedReady ? mc.readyToTranscribeDesc : mc.missingDesc}</p>
            </div>
            <RecommendedModelCard
              showTranscribeAction
              groups={modelGroups ?? []}
              loading={Boolean(modelsLoading)}
              error={modelsError}
              onRefresh={onRefreshModels}
              onOpenSettings={onOpenSettings}
              onStartASR={onStartASR}
            />
          </div>
        </div>
      );
    }
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
            data-testid="translation-open"
            onClick={() => translation.openPanel()}
            disabled={isAILoading && translation.phase !== 'running'}
            className={cn(
              'flex items-center gap-1 px-2 py-0.5 text-xs rounded font-medium transition-colors',
              isAILoading
                ? 'bg-aimu-red-bg/70 text-aimu-coral -not-allowed'
                : 'bg-aimu-red-bg text-aimu-coral hover:bg-aimu-red-bg/80 disabled:opacity-40 disabled:-not-allowed',
            )}
            title={t('components.workstation.translateStart')}
          >
            {translation.phase === 'running' ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Languages className="w-3 h-3" />
            )}
            <span>{translation.phase === 'running' ? t('components.workstation.translating') : t('components.workstation.translateStart')}</span>
          </button>

          {/* 短片推荐 */}
          <button data-testid="clips-open" onClick={clips.openPanel}
            className={cn('flex items-center gap-1 px-2 py-0.5 text-xs rounded font-medium transition-colors',
              clips.open ? 'bg-aimu-purple text-white' : 'bg-aimu-input text-aimu-text-secondary hover:text-aimu-text-primary')}>
            短片推荐
          </button>

          {/* 人声分离 */}
          <button data-testid="separation-open" onClick={separation.openPanel}
            className={cn('flex items-center gap-1 px-2 py-0.5 text-xs rounded font-medium transition-colors',
              separation.open ? 'bg-aimu-purple text-white' : 'bg-aimu-input text-aimu-text-secondary hover:text-aimu-text-primary')}>
            人声分离
          </button>

          {/* 说话人 */}
          <button data-testid="speaker-open" onClick={speakers.openPanel}
            className={cn('flex items-center gap-1 px-2 py-0.5 text-xs rounded font-medium transition-colors',
              speakers.open ? 'bg-aimu-purple text-white' : 'bg-aimu-input text-aimu-text-secondary hover:text-aimu-text-primary')}>
            说话人
          </button>

          {/* 声音克隆 */}
          <button data-testid="voice-clone-open" onClick={() => setVoicePanelOpen(value => !value)}
            className={cn('flex items-center gap-1 px-2 py-0.5 text-xs rounded font-medium transition-colors',
              voicePanelOpen ? 'bg-aimu-purple text-white' : 'bg-aimu-input text-aimu-text-secondary hover:text-aimu-text-primary')}>
            声音克隆
          </button>

          {/* 整段配音 */}
          <button
            data-testid="track-dubbing-open"
            onClick={trackDubbing.openPanel}
            className={cn(
              'flex items-center gap-1 px-2 py-0.5 text-xs rounded font-medium transition-colors',
              trackDubbing.open ? 'bg-aimu-purple text-white' : 'bg-aimu-input text-aimu-text-secondary hover:text-aimu-text-primary',
            )}
          >
            整段配音
          </button>

          {/* 单条配音 */}
          <button
            data-testid="cue-dubbing-open"
            onClick={dubbing.openPanel}
            className={cn(
              'flex items-center gap-1 px-2 py-0.5 text-xs rounded font-medium transition-colors',
              dubbing.open
                ? 'bg-aimu-purple text-white'
                : 'bg-aimu-input text-aimu-text-secondary hover:text-aimu-text-primary',
            )}
            title={dubText.title}
          >
            <Volume2 className="w-3 h-3" />
            <span>{dubText.dubButton}</span>
          </button>
        </div>
      </div>

      <CorrectionReviewPanel review={review} />
      <TranslationPanel translation={translation} />
      <SingleCueDubbingPanel dubbing={dubbing} onOpenSettings={onOpenSettings} />
      <TrackDubbingPanel state={trackDubbing} />
      <VoiceClonePanel open={voicePanelOpen} onClose={() => setVoicePanelOpen(false)} />
      <SpeakerPanel state={speakers} />
      <SeparationPanel state={separation} />
      <ClipsPanel state={clips} onExport={clip => void clipExport.exportClip(clip)} exportPhase={clipExport.phase} exportProgress={clipExport.progress} exportError={clipExport.error}
        onBatch={clips => void clipExport.batchExport(clips)} batch={clipExport.batch} onBatchCancel={() => void clipExport.batchCancel()}
        hasReframe={clipExport.hasReframe} followSubject={clipExport.followSubject} setFollowSubject={clipExport.setFollowSubject} />

      {/* Subtitle List (virtualized scroll window) */}
      <div
        ref={virtual.scrollRef}
        data-testid="subtitle-virtual-scroll"
        className="flex-1 overflow-y-auto"
        style={{ overflowAnchor: 'none' }}
        onScroll={virtual.onScroll}
        onWheel={markManualScroll}
        onTouchMove={markManualScroll}
        onPointerDown={(event) => { if (event.target === event.currentTarget) markManualScroll(); }}
        onMouseDown={(event) => { if (event.target === event.currentTarget) markManualScroll(); }}
        onKeyDownCapture={handleVirtualKeyDown}
      >
        <div ref={contentRef} className="relative w-full" style={{ height: virtual.layout.totalSize }}>
          {activeChunks.slice(range.start, range.end).map((chunk, offset) => {
            const index = range.start + offset;
            const rowDub = dubbing.statusForChunk(chunk);
            const rowDubKey = rowDub.artifact ? `${rowDub.artifact.trackId}:${rowDub.artifact.chunkId}` : null;
            return (
              <VirtualSubtitleRow
                key={chunk.id}
                index={index}
                top={virtual.layout.starts[index]}
                registerRow={registerRow}
              >
                <SubtitleItem
                  chunk={chunk}
                  index={index}
                  draft={draftsRef.current.get(chunk.id)}
                  onDraftChange={updateDraft}
                  onDraftCommitted={clearDraftField}
                  findMatches={findMatchesByChunk.get(chunk.id)}
                  findActive={activeFindChunkId === chunk.id}
                  isActive
                  isCurrent={currentChunk?.id === chunk.id}
                  isSelected={selectedIds.has(chunk.id)}
                  textSuggestion={review.suggestionsById.get(chunk.id)}
                  textPreview={isPreviewing}
                  onSuggestionChange={review.updateSuggestion}
                  onToggleSelection={handleToggleSelection}
                  onSeekTo={seekTo}
                  dubbingArtifact={rowDub.artifact}
                  dubbingStatus={rowDub.status}
                  isDubbingPlaying={Boolean(rowDubKey && dubbing.playingCueKey === rowDubKey)}
                  onOpenDubbing={dubbing.openForCue}
                  onToggleDubbingPlay={artifact => void dubbing.togglePlayArtifact(artifact)}
                />
              </VirtualSubtitleRow>
            );
          })}
        </div>
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

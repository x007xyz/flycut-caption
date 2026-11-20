import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { COMMON_LANGUAGES, getLanguageName } from '@/constants/languages';
import { useTranslation } from '@/contexts/LocaleProvider';
import { useAI } from '@/hooks/useAI';
import { translationCopy } from '@/locales/translation';
import { useClientRuntime } from '@/runtime/context';
import { applyLanguageTranslationsWithPersistence } from '@/services/translationPersistence';
import { useAppStore } from '@/stores/appStore';
import { useHistoryStore } from '@/stores/historyStore';
import { useProjectStore } from '@/stores/projectStore';
import { toast } from 'sonner';
import { findTrackForLanguage, isTranslationOutdated } from '../../shared/languageTracks';
import { findTerminologyIssues } from '../../shared/terminology';
import {
  evaluateTranslationConstraints,
  splitTranslationBatches,
  validateTranslationResults,
  type TranslationBatch,
  type TranslationConstraintResult,
  type TranslationLimits,
} from '../../shared/text/translation';
import type { AIModelView } from '@/types/ai';

export type TranslationScope = 'all' | 'untranslated' | 'outdated' | 'selected';
export type TranslationPhase = 'idle' | 'running' | 'partial' | 'review' | 'applying' | 'applied';
export type TranslationBatchStatus = 'pending' | 'running' | 'done' | 'invalid' | 'failed' | 'cancelled' | 'excluded';

export interface TranslationBatchState extends TranslationBatch {
  status: TranslationBatchStatus;
  error?: string;
}

export interface TranslationDraftItem {
  id: string;
  sourceText: string;
  timestamp: [number, number];
  translatedText: string;
  aiText: string;
  manuallyEdited: boolean;
  batchId: string;
  constraints: TranslationConstraintResult;
}

export interface TranslationApplyError {
  kind: 'stale' | 'conflict' | 'failed';
  message?: string;
}

interface RawDraftItem {
  id: string;
  sourceText: string;
  timestamp: [number, number];
  translatedText: string;
  aiText: string;
  manuallyEdited: boolean;
  batchId: string;
}

interface BaseSnapshot {
  sources: Map<string, string>;
  trackId: string | null;
  entriesJson: string;
  terminologyRevision: number;
}

export interface OutdatedCueOption {
  id: string;
  sourceText: string;
  oldSourceText: string;
  currentTranslation: string;
}

export interface BatchTranslationController {
  open: boolean;
  phase: TranslationPhase;
  model: AIModelView | null;
  hasModels: boolean;
  sourceLang: string;
  targetLang: string;
  scope: TranslationScope;
  limits: TranslationLimits;
  activeCueCount: number;
  outdatedCues: OutdatedCueOption[];
  selectedOutdatedIds: Set<string>;
  plannedBatches: TranslationBatch[];
  plannedCueCount: number;
  plannedSentenceCount: number;
  batches: TranslationBatchState[];
  blockingBatches: TranslationBatchState[];
  drafts: TranslationDraftItem[];
  staleNow: boolean;
  changedIds: string[];
  applyError: TranslationApplyError | null;
  appliedCount: number;
  appliedTrackName: string;
  canApply: boolean;
  terminologyRevision: number;
  terminologyCount: number;
  terminologyIssues: Array<{ id: string; terms: string[] }>;
  openPanel: (initialScope?: TranslationScope) => void;
  closePanel: () => void;
  setSourceLang: (lang: string) => void;
  setTargetLang: (lang: string) => void;
  setScope: (scope: TranslationScope) => void;
  setLimits: (limits: Partial<TranslationLimits>) => void;
  toggleOutdatedId: (id: string) => void;
  selectAllOutdated: () => void;
  clearOutdatedSelection: () => void;
  start: () => void;
  cancelRun: () => void;
  retryBatch: (batchId: string) => void;
  retryFailedBatches: () => void;
  excludeBatch: (batchId: string) => void;
  updateDraftText: (id: string, text: string) => void;
  restoreDraftAi: (id: string) => void;
  confirmStaleReview: () => void;
  retranslateChanged: () => void;
  apply: () => Promise<void>;
  clearApplyError: () => void;
}

export function useBatchTranslation(
  targetLang: string,
  setTargetLang: (lang: string) => void,
  selectedChunkIds: ReadonlySet<string>,
): BatchTranslationController {
  const ctx = useClientRuntime();
  const { requestTranslation, hasModels } = useAI();
  const { language: uiLanguage } = useTranslation();
  const copy = translationCopy(uiLanguage);

  const chunks = useHistoryStore((s) => s.chunks);
  const historyLanguage = useHistoryStore((s) => s.language);
  const languageTracks = useHistoryStore((s) => s.languageTracks);
  const activeLanguageTrackId = useHistoryStore((s) => s.activeLanguageTrackId);

  const aiModels = useAppStore((s) => s.aiModels);
  const selectedAIModelId = useAppStore((s) => s.selectedAIModelId);
  const aiSettingsHostId = useAppStore((s) => s.aiSettingsHostId);
  const limits = useAppStore((s) => s.translationLimits);
  const setLimits = useAppStore((s) => s.setTranslationLimits);
  const setAIProgress = useAppStore((s) => s.setAIProgress);
  const clearAIProgress = useAppStore((s) => s.clearAIProgress);
  const setAITask = useAppStore((s) => s.setAITask);
  const videoFile = useAppStore((s) => s.videoFile);

  const projectId = useProjectStore((s) => s.current?.projectId ?? '');
  const videoId = useProjectStore((s) => s.current?.videoId ?? '');
  const terminology = useProjectStore((s) => s.current?.terminology);
  const currentTerminologyRevision = useProjectStore((s) => s.current?.terminologyRevision ?? 0);
  const targetTerms = useMemo(() => {
    const language = targetLang.toLowerCase();
    const short = language.split(/[-_]/)[0];
    return (terminology ?? []).flatMap((entry) => {
      const translation = entry.translations?.[language] ?? entry.translations?.[short];
      return translation?.trim() ? [{ term: entry.term, translation: translation.trim() }] : [];
    });
  }, [terminology, targetLang]);
  const runTermsRef = useRef<Array<{ term: string; translation: string }>>([]);

  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<TranslationPhase>('idle');
  const [sourceLang, setSourceLang] = useState<string>(() =>
    COMMON_LANGUAGES.some((item) => item.code === historyLanguage) ? historyLanguage : 'auto',
  );
  const [scope, setScope] = useState<TranslationScope>('all');
  const [selectedOutdatedIds, setSelectedOutdatedIds] = useState<Set<string>>(new Set());
  const [batches, setBatches] = useState<TranslationBatchState[]>([]);
  const [rawDrafts, setRawDrafts] = useState<Map<string, RawDraftItem>>(new Map());
  const [applyError, setApplyError] = useState<TranslationApplyError | null>(null);
  const [appliedCount, setAppliedCount] = useState(0);
  const [appliedTrackName, setAppliedTrackName] = useState('');
  const [baseSnapshot, setBaseSnapshot] = useState<BaseSnapshot | null>(null);

  const batchesRef = useRef<TranslationBatchState[]>([]);
  const draftsRef = useRef<Map<string, RawDraftItem>>(new Map());
  const runRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const setBatchesSafe = useCallback((updater: (prev: TranslationBatchState[]) => TranslationBatchState[]) => {
    setBatches((prev) => {
      const next = updater(prev);
      batchesRef.current = next;
      return next;
    });
  }, []);

  const setDraftsSafe = useCallback((updater: (prev: Map<string, RawDraftItem>) => Map<string, RawDraftItem>) => {
    setRawDrafts((prev) => {
      const next = updater(prev);
      draftsRef.current = next;
      return next;
    });
  }, []);

  const model = useMemo(
    () => (selectedAIModelId ? aiModels.find((item) => item.id === selectedAIModelId) ?? null : null),
    [aiModels, selectedAIModelId],
  );

  const activeCues = useMemo(
    () => chunks.filter((c) => !c.deleted && !c.isBlankSpacer && c.text.trim() !== ''),
    [chunks],
  );

  const targetTrack = useMemo(() => {
    if (!targetLang) return undefined;
    return findTrackForLanguage(languageTracks, targetLang)
      ?? languageTracks.find((track) => track.id === activeLanguageTrackId && track.languageCode === targetLang);
  }, [activeLanguageTrackId, languageTracks, targetLang]);

  const outdatedCues = useMemo<OutdatedCueOption[]>(() => {
    const track = targetTrack ?? languageTracks.find((item) => item.id === activeLanguageTrackId);
    if (!track) return [];
    const options: OutdatedCueOption[] = [];
    for (const cue of activeCues) {
      const entry = track.entries[cue.id];
      if (entry && isTranslationOutdated(entry, cue)) {
        options.push({
          id: cue.id,
          sourceText: cue.text,
          oldSourceText: entry.sourceText,
          currentTranslation: entry.text,
        });
      }
    }
    return options;
  }, [activeCues, activeLanguageTrackId, languageTracks, targetTrack]);

  useEffect(() => {
    setSelectedOutdatedIds((prev) => {
      const validIds = new Set(outdatedCues.map((item) => item.id));
      if (!validIds.size) return new Set();
      const kept = [...prev].filter((id) => validIds.has(id));
      if (kept.length > 0) return new Set(kept);
      const fromList = outdatedCues.filter((item) => selectedChunkIds.has(item.id)).map((item) => item.id);
      return new Set(fromList.length ? fromList : validIds);
    });
  }, [outdatedCues, selectedChunkIds]);

  const isolationScope = `${projectId}:${videoId}:${videoFile?.name ?? ''}:${aiSettingsHostId ?? ''}`;
  useEffect(() => {
    runRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setOpen(false);
    setPhase('idle');
    setBatchesSafe(() => []);
    setDraftsSafe(() => new Map());
    setApplyError(null);
    setAppliedCount(0);
    setAppliedTrackName('');
    setBaseSnapshot(null);
  }, [isolationScope, setBatchesSafe, setDraftsSafe]);

  useEffect(() => {
    if (COMMON_LANGUAGES.some((item) => item.code === historyLanguage)) {
      setSourceLang(historyLanguage);
    }
  }, [historyLanguage]);

  const targetCueIds = useMemo(() => {
    if (scope === 'all') return activeCues.map((c) => c.id);
    if (scope === 'untranslated') {
      return activeCues.filter((c) => !targetTrack?.entries[c.id]?.text.trim()).map((c) => c.id);
    }
    if (scope === 'outdated') {
      return outdatedCues.filter((c) => selectedOutdatedIds.has(c.id)).map((c) => c.id);
    }
    return activeCues.filter((c) => selectedChunkIds.has(c.id)).map((c) => c.id);
  }, [activeCues, outdatedCues, scope, selectedChunkIds, selectedOutdatedIds, targetTrack]);

  const plannedBatches = useMemo(
    () => splitTranslationBatches(activeCues, targetCueIds),
    [activeCues, targetCueIds],
  );
  const plannedCueCount = useMemo(
    () => plannedBatches.reduce((sum, batch) => sum + batch.items.length, 0),
    [plannedBatches],
  );
  const plannedSentenceCount = useMemo(
    () => plannedBatches.reduce((sum, batch) => sum + batch.semanticGroups.length, 0),
    [plannedBatches],
  );

  const captureBaseSnapshot = useCallback((): BaseSnapshot => {
    const sources = new Map(activeCues.map((cue) => [cue.id, cue.text]));
    runTermsRef.current = targetTerms;
    return {
      sources,
      trackId: targetTrack?.id ?? null,
      entriesJson: JSON.stringify(targetTrack?.entries ?? {}),
      terminologyRevision: currentTerminologyRevision,
    };
  }, [activeCues, targetTrack, targetTerms, currentTerminologyRevision]);

  const changedIds = useMemo(() => {
    if (!baseSnapshot || !['review', 'partial', 'applying'].includes(phase)) return [];
    const cueById = new Map(activeCues.map((cue) => [cue.id, cue]));
    const changed: string[] = [];
    for (const draft of rawDrafts.values()) {
      const current = cueById.get(draft.id);
      if (!current || current.text !== baseSnapshot.sources.get(draft.id)) {
        changed.push(draft.id);
      }
    }
    return changed;
  }, [activeCues, baseSnapshot, phase, rawDrafts]);

  const staleNow = useMemo(() => {
    if (!baseSnapshot || !['review', 'partial', 'applying'].includes(phase)) return false;
    if (changedIds.length > 0) return true;
    const currentTrackId = targetTrack?.id ?? null;
    const currentEntriesJson = JSON.stringify(targetTrack?.entries ?? {});
    return currentTrackId !== baseSnapshot.trackId || currentEntriesJson !== baseSnapshot.entriesJson
      || currentTerminologyRevision !== baseSnapshot.terminologyRevision;
  }, [baseSnapshot, changedIds.length, currentTerminologyRevision, phase, targetTrack]);

  const terminologyIssues = useMemo(() => {
    if (!['review', 'partial', 'applying'].includes(phase)) return [];
    return findTerminologyIssues([...rawDrafts.values()], targetTerms);
  }, [phase, rawDrafts, targetTerms]);

  const executeBatches = useCallback(
    async (targets: TranslationBatchState[], runId: number, controller: AbortController, activeModel: AIModelView, lang: string, srcLang: string) => {
      let done = batchesRef.current.filter((b) => b.status === 'done' || b.status === 'excluded').length;
      const total = batchesRef.current.length || targets.length;
      const cueMap = new Map(activeCues.map((c) => [c.id, c]));

      for (const target of targets) {
        if (runRef.current !== runId || controller.signal.aborted) return;
        setBatchesSafe((prev) =>
          prev.map((b) => (b.id === target.id ? { ...b, status: 'running', error: undefined } : b)),
        );

        try {
          const raw = await requestTranslation(target.items, activeModel.id, lang, {
            sourceLang: srcLang,
            semanticGroups: target.semanticGroups,
            contextBefore: target.contextBefore,
            contextAfter: target.contextAfter,
            terms: runTermsRef.current,
            signal: controller.signal,
          });
          if (runRef.current !== runId || controller.signal.aborted) return;

          let validated: Array<{ id: string; text: string }>;
          try {
            validated = validateTranslationResults(target.items, raw);
          } catch (validationError) {
            const message = validationError instanceof Error ? validationError.message : copy.invalid;
            setBatchesSafe((prev) =>
              prev.map((b) => (b.id === target.id ? { ...b, status: 'invalid', error: message } : b)),
            );
            done += 1;
            setAIProgress({ status: 'running', progress: Math.round((done / total) * 100), data: copy.processing });
            continue;
          }

          setDraftsSafe((prev) => {
            const next = new Map(prev);
            for (const entry of validated) {
              const cue = cueMap.get(entry.id);
              const existing = next.get(entry.id);
              if (existing?.manuallyEdited) {
                next.set(entry.id, { ...existing, aiText: entry.text, batchId: target.id });
              } else {
                next.set(entry.id, {
                  id: entry.id,
                  sourceText: cue?.text ?? target.items.find((item) => item.id === entry.id)?.text ?? '',
                  timestamp: cue?.timestamp ?? [0, 0],
                  translatedText: entry.text,
                  aiText: entry.text,
                  manuallyEdited: false,
                  batchId: target.id,
                });
              }
            }
            return next;
          });

          setBatchesSafe((prev) =>
            prev.map((b) => (b.id === target.id ? { ...b, status: 'done', error: undefined } : b)),
          );
        } catch (requestError) {
          if (runRef.current !== runId || controller.signal.aborted) return;
          const message = requestError instanceof Error ? requestError.message : copy.failed;
          const isInvalid = /翻译结果无效|Invalid translation result|校验失败|条数不一致|无法解析/.test(message);
          setBatchesSafe((prev) =>
            prev.map((b) =>
              b.id === target.id
                ? { ...b, status: isInvalid ? 'invalid' : 'failed', error: message }
                : b,
            ),
          );
        }

        done += 1;
        setAIProgress({ status: 'running', progress: Math.round((done / total) * 100), data: copy.processing });
      }

      if (runRef.current !== runId || controller.signal.aborted) return;
      abortRef.current = null;
      setPhase('review');
      setAIProgress({ status: 'complete', progress: 100, data: copy.completed });
      window.setTimeout(() => clearAIProgress(), 1000);
    },
    [activeCues, clearAIProgress, copy.completed, copy.failed, copy.invalid, copy.processing, requestTranslation, setAIProgress, setBatchesSafe, setDraftsSafe],
  );

  const start = useCallback(() => {
    setOpen(true);
    setApplyError(null);
    if (!model || !targetLang || !plannedBatches.length) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    const runId = ++runRef.current;
    abortRef.current = controller;

    const initialBatches: TranslationBatchState[] = plannedBatches.map((batch) => ({
      ...batch,
      status: 'pending',
    }));
    setBaseSnapshot(captureBaseSnapshot());
    setBatchesSafe(() => initialBatches);
    setDraftsSafe(() => new Map());
    setAppliedCount(0);
    setPhase('running');
    setAITask('translation');
    setAIProgress({ status: 'running', progress: 0, data: copy.processing });

    void executeBatches(initialBatches, runId, controller, model, targetLang, sourceLang);
  }, [captureBaseSnapshot, copy.processing, executeBatches, model, plannedBatches, setAIProgress, setAITask, setBatchesSafe, setDraftsSafe, sourceLang, targetLang]);

  const cancelRun = useCallback(() => {
    runRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setBatchesSafe((prev) =>
      prev.map((b) => (b.status === 'pending' || b.status === 'running' ? { ...b, status: 'cancelled' } : b)),
    );
    const hasCompleted = draftsRef.current.size > 0;
    setPhase(hasCompleted ? 'partial' : 'idle');
    clearAIProgress();
  }, [clearAIProgress, setBatchesSafe]);

  const retryBatches = useCallback(
    (targetIds: Set<string>) => {
      if (!model || !targetLang || staleNow) return;
      const targets = batchesRef.current
        .filter((b) => targetIds.has(b.id) && ['failed', 'invalid', 'cancelled'].includes(b.status))
        .map((b) => ({ ...b, status: 'pending' as const, error: undefined }));
      if (!targets.length) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      const runId = ++runRef.current;
      abortRef.current = controller;

      setApplyError(null);
      setBatchesSafe((prev) =>
        prev.map((b) => (targetIds.has(b.id) ? { ...b, status: 'pending', error: undefined } : b)),
      );
      setPhase('running');
      setAITask('translation');
      setAIProgress({ status: 'running', progress: 0, data: copy.processing });

      void executeBatches(targets, runId, controller, model, targetLang, sourceLang);
    },
    [copy.processing, executeBatches, model, setAIProgress, setAITask, setBatchesSafe, sourceLang, staleNow, targetLang],
  );

  const retryBatch = useCallback((batchId: string) => retryBatches(new Set([batchId])), [retryBatches]);

  const retryFailedBatches = useCallback(() => {
    const ids = new Set(
      batchesRef.current.filter((b) => ['failed', 'invalid', 'cancelled'].includes(b.status)).map((b) => b.id),
    );
    retryBatches(ids);
  }, [retryBatches]);

  const excludeBatch = useCallback((batchId: string) => {
    setBatchesSafe((prev) =>
      prev.map((b) => (b.id === batchId ? { ...b, status: 'excluded', error: undefined } : b)),
    );
  }, [setBatchesSafe]);

  const updateDraftText = useCallback((id: string, text: string) => {
    setDraftsSafe((prev) => {
      const item = prev.get(id);
      if (!item) return prev;
      const next = new Map(prev);
      next.set(id, {
        ...item,
        translatedText: text,
        manuallyEdited: text !== item.aiText,
      });
      return next;
    });
  }, [setDraftsSafe]);

  const restoreDraftAi = useCallback((id: string) => {
    setDraftsSafe((prev) => {
      const item = prev.get(id);
      if (!item) return prev;
      const next = new Map(prev);
      next.set(id, {
        ...item,
        translatedText: item.aiText,
        manuallyEdited: false,
      });
      return next;
    });
  }, [setDraftsSafe]);

  const confirmStaleReview = useCallback(() => {
    const cueMap = new Map(activeCues.map((c) => [c.id, c]));
    setDraftsSafe((prev) => {
      const next = new Map<string, RawDraftItem>();
      for (const [id, item] of prev) {
        const cue = cueMap.get(id);
        if (!cue) continue;
        next.set(id, { ...item, sourceText: cue.text, timestamp: cue.timestamp });
      }
      return next;
    });
    setBaseSnapshot(captureBaseSnapshot());
    setApplyError(null);
  }, [activeCues, captureBaseSnapshot, setDraftsSafe]);

  const retranslateChanged = useCallback(() => {
    if (!model || !targetLang) return;
    const ids = changedIds.length ? changedIds : [...draftsRef.current.keys()];
    const nextBatches = splitTranslationBatches(activeCues, ids).map((batch) => ({
      ...batch,
      id: `retranslate-${batch.id}`,
      status: 'pending' as const,
    }));
    if (!nextBatches.length) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    const runId = ++runRef.current;
    abortRef.current = controller;

    setBaseSnapshot(captureBaseSnapshot());
    setBatchesSafe((prev) => [
      ...prev.filter((b) => b.status === 'done'),
      ...nextBatches,
    ]);
    setApplyError(null);
    setPhase('running');
    setAITask('translation');
    setAIProgress({ status: 'running', progress: 0, data: copy.processing });

    void executeBatches(nextBatches, runId, controller, model, targetLang, sourceLang);
  }, [activeCues, captureBaseSnapshot, changedIds, copy.processing, executeBatches, model, setAIProgress, setAITask, setBatchesSafe, sourceLang, targetLang]);

  const drafts = useMemo<TranslationDraftItem[]>(() => {
    const order = new Map(activeCues.map((cue, index) => [cue.id, index]));
    return [...rawDrafts.values()]
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
      .map((item) => ({
        ...item,
        constraints: evaluateTranslationConstraints(item.translatedText, item.timestamp, limits),
      }));
  }, [activeCues, limits, rawDrafts]);

  const blockingBatches = useMemo(
    () => batches.filter((b) => ['pending', 'running', 'invalid', 'failed'].includes(b.status)),
    [batches],
  );

  const hasNonEmptyDrafts = useMemo(
    () => drafts.some((d) => d.translatedText.trim() !== ''),
    [drafts],
  );

  const canApply =
    (phase === 'review' || phase === 'partial')
    && !staleNow
    && blockingBatches.length === 0
    && hasNonEmptyDrafts
    && !drafts.some((d) => !d.translatedText.trim());

  const apply = useCallback(async () => {
    if (!targetLang || staleNow) {
      setApplyError({ kind: 'stale' });
      return;
    }
    if (!canApply) return;
    const updates = drafts
      .filter((d) => d.translatedText.trim() !== '')
      .map((d) => ({ id: d.id, text: d.translatedText.trim(), expectedSource: d.sourceText }));
    if (!updates.length) return;

    const trackName = targetTrack?.name ?? getLanguageName(targetLang);
    setPhase('applying');
    setApplyError(null);

    const result = await applyLanguageTranslationsWithPersistence(ctx, {
      trackId: targetTrack?.id,
      languageCode: targetLang,
      name: trackName,
      updates,
    });

    if (result.ok) {
      const count = result.count ?? updates.length;
      setAppliedCount(count);
      setAppliedTrackName(trackName);
      setPhase('applied');
      setBatchesSafe(() => []);
      setDraftsSafe(() => new Map());
      setBaseSnapshot(null);
      toast.success(uiLanguage.startsWith('zh') ? `字幕翻译完成：共处理 ${count} 条` : `Translation completed: ${count} cues`);
      return;
    }

    setPhase('review');
    setApplyError({
      kind: result.error === 'conflict' ? 'conflict' : result.error === 'stale' ? 'stale' : 'failed',
      message: result.message,
    });
  }, [canApply, ctx, drafts, setBatchesSafe, setDraftsSafe, staleNow, targetLang, targetTrack, uiLanguage]);

  const openPanel = useCallback((initialScope?: TranslationScope) => {
    setOpen(true);
    setApplyError(null);
    if (initialScope) setScope(initialScope);
    if (phase === 'applied') {
      setPhase('idle');
      setAppliedCount(0);
    }
  }, [phase]);

  const closePanel = useCallback(() => {
    if (phase === 'applying') return;
    if (phase === 'running') cancelRun();
    setOpen(false);
  }, [cancelRun, phase]);

  const toggleOutdatedId = useCallback((id: string) => {
    setSelectedOutdatedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAllOutdated = useCallback(() => {
    setSelectedOutdatedIds(new Set(outdatedCues.map((item) => item.id)));
  }, [outdatedCues]);

  const clearOutdatedSelection = useCallback(() => {
    setSelectedOutdatedIds(new Set());
  }, []);

  return {
    open,
    phase,
    model,
    hasModels,
    sourceLang,
    targetLang,
    scope,
    limits,
    activeCueCount: activeCues.length,
    outdatedCues,
    selectedOutdatedIds,
    plannedBatches,
    plannedCueCount,
    plannedSentenceCount,
    batches,
    blockingBatches,
    drafts,
    staleNow,
    changedIds,
    applyError,
    appliedCount,
    appliedTrackName,
    canApply,
    terminologyRevision: currentTerminologyRevision,
    terminologyCount: targetTerms.length,
    terminologyIssues,
    openPanel,
    closePanel,
    setSourceLang,
    setTargetLang,
    setScope,
    setLimits,
    toggleOutdatedId,
    selectAllOutdated,
    clearOutdatedSelection,
    start,
    cancelRun,
    retryBatch,
    retryFailedBatches,
    excludeBatch,
    updateDraftText,
    restoreDraftAi,
    confirmStaleReview,
    retranslateChanged,
    apply,
    clearApplyError: () => setApplyError(null),
  };
}


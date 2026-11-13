// F-0013: AI correction orchestration. Model output stays in this review layer until one atomic confirm.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useClientRuntime } from '@/runtime/context';
import { useAI } from '@/hooks/useAI';
import { useAppStore } from '@/stores/appStore';
import { useHistoryStore } from '@/stores/historyStore';
import { useTranslation } from '@/contexts/LocaleProvider';
import { correctionCopy, fillCorrection } from '@/locales/correction';
import type { AIModelView, AISubtitleItem } from '@/types/ai';
import { splitCorrectionBatches, validateCorrectionResults, validateTextUpdates,
  type CorrectionSuggestion, type TextUpdate } from '../../shared/text/corrections';
import { applyTextBatchWithPersistence } from '@/services/textPersistence';

export type CorrectionPhase = 'idle' | 'running' | 'partial' | 'review' | 'applying' | 'applied';
export type CorrectionBatchStatus = 'pending' | 'generating' | 'done' | 'invalid' | 'failed' | 'excluded' | 'cancelled';

export interface CorrectionBatch {
  id: string;
  items: AISubtitleItem[];
  status: CorrectionBatchStatus;
  error?: string;
}

export type CorrectionError = 'stale' | 'apply-failed' | 'no-subtitles' | null;

export interface CorrectionReview {
  open: boolean;
  phase: CorrectionPhase;
  batches: CorrectionBatch[];
  suggestions: CorrectionSuggestion[];
  suggestionsById: Map<string, CorrectionSuggestion>;
  preview: boolean;
  error: CorrectionError;
  discardPrompt: boolean;
  appliedCount: number;
  model: AIModelView | null;
  hasModels: boolean;
  activeCount: number;
  changeCount: number;
  excludedCount: number;
  blockingBatches: CorrectionBatch[];
  staleNow: boolean;
  canApply: boolean;
  openPanel: () => void;
  closePanel: () => void;
  start: () => void;
  cancelRun: () => void;
  retryFailed: () => void;
  excludeBatch: (id: string) => void;
  reviewPartial: () => void;
  togglePreview: () => void;
  updateSuggestion: (id: string, text: string) => void;
  keepOriginal: (id: string) => void;
  restoreAi: (id: string) => void;
  requestCancelReview: () => void;
  confirmDiscard: () => void;
  dismissDiscard: () => void;
  apply: () => Promise<void>;
}

export function useCorrectionReview(): CorrectionReview {
  const ctx = useClientRuntime();
  const { requestCorrection, hasModels } = useAI();
  const { language } = useTranslation();
  const c = correctionCopy(language);
  const chunks = useHistoryStore(state => state.chunks);
  const edl = useHistoryStore(state => state.edl);
  const wordChunks = useHistoryStore(state => state.wordChunks);
  const aiModels = useAppStore(state => state.aiModels);
  const selectedAIModelId = useAppStore(state => state.selectedAIModelId);
  const setAIProgress = useAppStore(state => state.setAIProgress);
  const setAITask = useAppStore(state => state.setAITask);
  const videoFile = useAppStore(state => state.videoFile);

  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<CorrectionPhase>('idle');
  const [batches, setBatches] = useState<CorrectionBatch[]>([]);
  const [suggestions, setSuggestions] = useState<CorrectionSuggestion[]>([]);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<CorrectionError>(null);
  const [discardPrompt, setDiscardPrompt] = useState(false);
  const [appliedCount, setAppliedCount] = useState(0);
  const batchesRef = useRef<CorrectionBatch[]>([]);
  const suggestionsRef = useRef<CorrectionSuggestion[]>([]);
  const baseRef = useRef('');
  const runRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const model = useMemo(() => selectedAIModelId ? aiModels.find(item => item.id === selectedAIModelId) ?? null : null,
    [aiModels, selectedAIModelId]);
  const currentBase = useMemo(() => JSON.stringify([edl, chunks, wordChunks]), [edl, chunks, wordChunks]);
  const activeItems = useMemo<AISubtitleItem[]>(() => chunks
    .filter(chunk => !chunk.deleted && !chunk.isBlankSpacer && chunk.text.trim() !== '')
    .map(chunk => ({ id: chunk.id, text: chunk.text })), [chunks]);

  const setBatchesSafe = useCallback((update: (previous: CorrectionBatch[]) => CorrectionBatch[]) => {
    setBatches(previous => { const next = update(previous); batchesRef.current = next; return next; });
  }, []);
  const setSuggestionsSafe = useCallback((update: (previous: CorrectionSuggestion[]) => CorrectionSuggestion[]) => {
    setSuggestions(previous => { const next = update(previous); suggestionsRef.current = next; return next; });
  }, []);

  useEffect(() => {
    runRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setOpen(false); setPhase('idle'); setBatchesSafe(() => []); setSuggestionsSafe(() => []);
    setPreview(false); setError(null); setDiscardPrompt(false); setAppliedCount(0); baseRef.current = '';
  }, [videoFile, setBatchesSafe, setSuggestionsSafe]);

  const execute = useCallback(async (targets: CorrectionBatch[], run: number, controller: AbortController) => {
    if (!model) return;
    let done = 0;
    const total = targets.length;
    for (const target of targets) {
      if (runRef.current !== run) return;
      setBatchesSafe(previous => previous.map(batch => batch.id === target.id ? { ...batch, status: 'generating', error: undefined } : batch));
      try {
        const raw = await requestCorrection(target.items, model.id, controller.signal);
        if (runRef.current !== run) return;
        let results: AISubtitleItem[];
        try {
          results = validateCorrectionResults(target.items, raw);
        } catch (validationError) {
          const message = validationError instanceof Error ? validationError.message : String(validationError);
          setBatchesSafe(previous => previous.map(batch => batch.id === target.id ? { ...batch, status: 'invalid', error: message } : batch));
          done += 1;
          setAIProgress({ status: 'running', progress: Math.round(done / total * 100), data: c.progress });
          continue;
        }
        const additions: CorrectionSuggestion[] = results.flatMap((result, index) => {
          const before = target.items[index]?.text ?? '';
          if (result.text === before) return [];
          return [{ id: result.id, before, after: result.text, aiText: result.text, selected: true, adjusted: false, batchId: target.id }];
        });
        setSuggestionsSafe(previous => [...previous.filter(item => item.batchId !== target.id), ...additions]);
        setBatchesSafe(previous => previous.map(batch => batch.id === target.id ? { ...batch, status: 'done', error: undefined } : batch));
      } catch (requestError) {
        if (runRef.current !== run) return;
        const message = requestError instanceof Error ? requestError.message : String(requestError);
        const invalid = /校验失败|条数不一致|无法解析|结果无效/.test(message);
        setBatchesSafe(previous => previous.map(batch => batch.id === target.id ? { ...batch, status: invalid ? 'invalid' : 'failed', error: message } : batch));
      }
      done += 1;
      setAIProgress({ status: 'running', progress: Math.round(done / total * 100), data: c.progress });
    }
    if (runRef.current !== run) return;
    abortRef.current = null;
    setPhase('review');
    setAIProgress({ status: 'complete', progress: 100, data: c.applied });
  }, [c.applied, c.progress, model, requestCorrection, setAIProgress, setBatchesSafe, setSuggestionsSafe]);

  const start = useCallback(() => {
    setOpen(true); setError(null); setDiscardPrompt(false);
    if (!model) return;
    if (!activeItems.length) { setError('no-subtitles'); return; }
    const groups = splitCorrectionBatches(activeItems);
    const nextBatches: CorrectionBatch[] = groups.map((items, index) => ({ id: `batch-${index + 1}`, items, status: 'pending' }));
    abortRef.current?.abort();
    const controller = new AbortController();
    const run = ++runRef.current;
    abortRef.current = controller;
    baseRef.current = currentBase;
    setBatchesSafe(() => nextBatches); setSuggestionsSafe(() => []);
    setPreview(true); setPhase('running'); setAppliedCount(0);
    setAITask('correction');
    setAIProgress({ status: 'running', progress: 0, data: c.generating });
    void execute(nextBatches, run, controller);
  }, [activeItems, c.generating, currentBase, execute, model, setAIProgress, setAITask, setBatchesSafe, setSuggestionsSafe]);

  const cancelRun = useCallback(() => {
    runRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    const hasResults = suggestionsRef.current.some(item => item.after !== item.before);
    setBatchesSafe(previous => previous.map(batch =>
      batch.status === 'pending' || batch.status === 'generating' ? { ...batch, status: 'cancelled' } : batch));
    setPhase(hasResults ? 'partial' : 'idle');
    if (!hasResults) { setSuggestionsSafe(() => []); setBatchesSafe(() => []); setPreview(false); }
    setAIProgress({ status: 'complete', progress: 100, data: c.cancel });
  }, [c.cancel, setAIProgress, setBatchesSafe, setSuggestionsSafe]);

  const resetReview = useCallback((close: boolean) => {
    runRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase('idle'); setBatchesSafe(() => []); setSuggestionsSafe(() => []); setPreview(false);
    setError(null); setDiscardPrompt(false); setAppliedCount(0); baseRef.current = '';
    setAIProgress({ status: 'complete', progress: 100, data: '' });
    if (close) setOpen(false);
  }, [setAIProgress, setBatchesSafe, setSuggestionsSafe]);

  const retryFailed = useCallback(() => {
    if (!model) return;
    if (currentBase !== baseRef.current) { setError('stale'); return; }
    const targets = batchesRef.current.filter(batch => batch.status === 'failed' || batch.status === 'invalid')
      .map(batch => ({ ...batch, status: 'pending' as const, error: undefined }));
    if (!targets.length) return;
    const ids = new Set(targets.map(batch => batch.id));
    setSuggestionsSafe(previous => previous.filter(item => !ids.has(item.batchId)));
    setBatchesSafe(previous => previous.map(batch => ids.has(batch.id) ? { ...batch, status: 'pending', error: undefined } : batch));
    abortRef.current?.abort();
    const controller = new AbortController();
    const run = ++runRef.current;
    abortRef.current = controller;
    setError(null); setPhase('running');
    setAIProgress({ status: 'running', progress: 0, data: c.generating });
    void execute(targets, run, controller);
  }, [c.generating, currentBase, execute, model, setAIProgress, setBatchesSafe, setSuggestionsSafe]);

  const excludeBatch = useCallback((id: string) => {
    setSuggestionsSafe(previous => previous.filter(item => item.batchId !== id));
    setBatchesSafe(previous => previous.map(batch => batch.id === id ? { ...batch, status: 'excluded', error: undefined } : batch));
  }, [setBatchesSafe, setSuggestionsSafe]);

  const reviewPartial = useCallback(() => setPhase('review'), []);
  const togglePreview = useCallback(() => setPreview(value => !value), []);
  const updateSuggestion = useCallback((id: string, text: string) => {
    setSuggestionsSafe(previous => previous.map(item => item.id === id
      ? { ...item, after: text, adjusted: text !== item.aiText } : item));
  }, [setSuggestionsSafe]);
  const keepOriginal = useCallback((id: string) => {
    setSuggestionsSafe(previous => previous.map(item => item.id === id ? { ...item, selected: false } : item));
  }, [setSuggestionsSafe]);
  const restoreAi = useCallback((id: string) => {
    setSuggestionsSafe(previous => previous.map(item => item.id === id
      ? { ...item, selected: true, after: item.aiText, adjusted: false } : item));
  }, [setSuggestionsSafe]);

  const requestCancelReview = useCallback(() => {
    const dirty = suggestionsRef.current.some(item => item.adjusted);
    if (dirty) setDiscardPrompt(true); else resetReview(true);
  }, [resetReview]);
  const confirmDiscard = useCallback(() => resetReview(true), [resetReview]);
  const dismissDiscard = useCallback(() => setDiscardPrompt(false), []);

  const apply = useCallback(async () => {
    if (phase !== 'review') return;
    if (currentBase !== baseRef.current) { setError('stale'); return; }
    const selected = suggestionsRef.current.filter(item => item.selected && item.after !== item.before);
    const updates: TextUpdate[] = selected.map(item => ({ id: item.id, before: item.before, text: item.after }));
    const validation = validateTextUpdates(chunks, updates);
    if ('reason' in validation) {
      setError(validation.reason === 'stale' ? 'stale' : 'apply-failed');
      return;
    }
    setPhase('applying'); setError(null);
    const result = await applyTextBatchWithPersistence(ctx, updates);
    if (result.ok) {
      const count = result.count ?? updates.length;
      setAppliedCount(count); setPhase('applied'); setPreview(false);
      setSuggestionsSafe(() => []); setBatchesSafe(() => []);
      setAIProgress({ status: 'complete', progress: 100, data: '' });
      toast.success(fillCorrection(c.applied, { count }));
      return;
    }
    setPhase('review');
    setError(result.error === 'stale' ? 'stale' : 'apply-failed');
  }, [c.applied, chunks, ctx, currentBase, phase, setAIProgress, setBatchesSafe, setSuggestionsSafe]);

  const openPanel = useCallback(() => {
    setOpen(true); setError(null);
    if (phase === 'applied') resetReview(false);
  }, [phase, resetReview]);
  const closePanel = useCallback(() => {
    if (phase === 'running') { cancelRun(); setOpen(false); return; }
    if (phase === 'review' || phase === 'partial' || phase === 'applying') { requestCancelReview(); return; }
    resetReview(true);
  }, [cancelRun, phase, requestCancelReview, resetReview]);

  const suggestionsById = useMemo(() => new Map(suggestions.map(item => [item.id, item])), [suggestions]);
  const changeCount = useMemo(() => suggestions.filter(item => item.selected && item.after !== item.before).length, [suggestions]);
  const hasBlankSelected = useMemo(() => suggestions.some(item => item.selected && item.after !== item.before && !item.after.trim()), [suggestions]);
  const blockingBatches = useMemo(() => batches.filter(batch =>
    batch.status === 'pending' || batch.status === 'generating' || batch.status === 'invalid' || batch.status === 'failed'), [batches]);
  const excludedCount = useMemo(() => batches.filter(batch => batch.status === 'excluded').reduce((sum, batch) => sum + batch.items.length, 0), [batches]);
  const staleNow = useMemo(() => ['review', 'partial', 'applying'].includes(phase) && !!baseRef.current && baseRef.current !== currentBase,
    [currentBase, phase]);
  const canApply = phase === 'review' && !blockingBatches.length && changeCount > 0 && !hasBlankSelected;

  return {
    open, phase, batches, suggestions, suggestionsById, preview, error, discardPrompt, appliedCount, model, hasModels,
    activeCount: activeItems.length, changeCount, excludedCount, blockingBatches, staleNow, canApply,
    openPanel, closePanel, start, cancelRun, retryFailed, excludeBatch, reviewPartial, togglePreview,
    updateSuggestion, keepOriginal, restoreAi, requestCancelReview, confirmDiscard, dismissDiscard, apply,
  };
}

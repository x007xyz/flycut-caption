// F-0025: AI keyword recommendation orchestration. Model output stays in this review layer until one confirm.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useClientRuntime } from '@/runtime/context';
import { useAI } from '@/hooks/useAI';
import { useAppStore } from '@/stores/appStore';
import { useHistoryStore } from '@/stores/historyStore';
import type { AIModelView } from '@/types/ai';
import {
  createKeywordBase, splitKeywordBatches, validateKeywordModelResponse,
  type KeywordSuggestRequest, type SubtitleKeyword,
} from '../../shared/text/keywords';
import { applyKeywordBatchWithPersistence } from '@/services/keywordPersistence';

export type KeywordPhase = 'idle' | 'loading' | 'preflight' | 'running' | 'review' | 'applying' | 'done';
export type KeywordError = 'no-subtitles' | 'no-model' | 'request-failed' | 'invalid' | 'stale' | 'apply-failed' | null;

export interface KeywordCandidate {
  id: string;
  text: string;
  keywords: SubtitleKeyword[];
  enabled: boolean[];
}

export interface KeywordReview {
  open: boolean;
  phase: KeywordPhase;
  model: AIModelView | null;
  hasModels: boolean;
  activeCount: number;
  totalChars: number;
  batchCount: number;
  progress: { done: number; total: number };
  candidates: KeywordCandidate[];
  error: KeywordError;
  errorDetail: string;
  staleNow: boolean;
  appliedCount: number;
  enabledCount: number;
  openPanel: () => void;
  closePanel: () => void;
  start: () => Promise<void>;
  cancelRun: () => void;
  retry: () => void;
  toggleCandidate: (id: string, index: number) => void;
  selectAll: () => void;
  clearSelection: () => void;
  apply: () => Promise<void>;
  acknowledgeStale: () => void;
  dismissError: () => void;
}

const MAX_BATCH_ITEMS = 20;
const MAX_BATCH_CHARS = 2400;

export function useKeywordRecommendation(): KeywordReview {
  const ctx = useClientRuntime();
  const { hasModels } = useAI();
  const aiService = ctx.ai;
  const aiModels = useAppStore(state => state.aiModels);
  const selectedAIModelId = useAppStore(state => state.selectedAIModelId);
  const chunks = useHistoryStore(state => state.chunks);

  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<KeywordPhase>('idle');
  const [candidates, setCandidates] = useState<KeywordCandidate[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<KeywordError>(null);
  const [errorDetail, setErrorDetail] = useState('');
  const [staleNow, setStaleNow] = useState(false);
  const [appliedCount, setAppliedCount] = useState(0);

  const runRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const baseRef = useRef<{ base: string; request: KeywordSuggestRequest } | null>(null);

  const model = useMemo(() => selectedAIModelId
    ? aiModels.find(item => item.id === selectedAIModelId) ?? null : null, [aiModels, selectedAIModelId]);

  const activeChunks = useMemo(
    () => chunks.filter(chunk => !chunk.deleted && !chunk.isBlankSpacer && chunk.text.trim() !== ''), [chunks]);
  const totalChars = useMemo(() => activeChunks.reduce((sum, chunk) => sum + chunk.text.length, 0), [activeChunks]);
  const batchCount = useMemo(() => splitKeywordBatches(
    activeChunks.map(chunk => ({ id: chunk.id, text: chunk.text })), MAX_BATCH_ITEMS, MAX_BATCH_CHARS).length, [activeChunks]);

  const enabledCount = useMemo(
    () => candidates.reduce((sum, candidate) => sum + candidate.enabled.filter(Boolean).length, 0), [candidates]);

  // Any change to the source text invalidates a finished review snapshot.
  useEffect(() => {
    if (!baseRef.current) return;
    const next = createKeywordBase(activeChunks.map(chunk => ({ id: chunk.id, text: chunk.text })));
    if (next !== baseRef.current.base && (phase === 'review' || phase === 'applying')) setStaleNow(true);
  }, [activeChunks, phase]);

  const openPanel = useCallback(() => {
    setOpen(true);
    setError(null);
    setErrorDetail('');
    setPhase(prev => (prev === 'review' || prev === 'done' ? prev : (activeChunks.length ? 'preflight' : 'idle')));
  }, [activeChunks.length]);

  const closePanel = useCallback(() => {
    setOpen(false);
    setPhase('idle');
    setCandidates([]);
    setProgress({ done: 0, total: 0 });
    setError(null);
    setErrorDetail('');
    setStaleNow(false);
    setAppliedCount(0);
    baseRef.current = null;
  }, []);

  const cancelRun = useCallback(() => {
    runRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setPhase('preflight');
  }, []);

  const start = useCallback(async () => {
    if (!activeChunks.length) { setError('no-subtitles'); return; }
    if (!model) { setError('no-model'); return; }
    runRef.current += 1;
    const run = runRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    const items = activeChunks.map(chunk => ({ id: chunk.id, text: chunk.text }));
    const base = createKeywordBase(items);
    const batches = splitKeywordBatches(items, MAX_BATCH_ITEMS, MAX_BATCH_CHARS);
    const request: KeywordSuggestRequest = { base, language: 'zh', items };
    baseRef.current = { base, request };

    setError(null); setErrorDetail(''); setStaleNow(false); setCandidates([]);
    setProgress({ done: 0, total: batches.length });
    setPhase('running');

    const collected: KeywordCandidate[] = [];
    for (const [index, batch] of batches.entries()) {
      if (run !== runRef.current || controller.signal.aborted) return;
      try {
        const result = await aiService.suggestKeywords(model.id, { ...request, items: batch }, controller.signal);
        if (run !== runRef.current || controller.signal.aborted) return;
        const validated = validateKeywordModelResponse(result, { ...request, items: batch });
        for (const entry of validated) {
          const source = batch.find(item => item.id === entry.id);
          collected.push({ id: entry.id, text: source?.text ?? '', keywords: entry.keywords, enabled: entry.keywords.map(() => true) });
        }
        setCandidates([...collected]);
        setProgress({ done: index + 1, total: batches.length });
      } catch (caught) {
        if (run !== runRef.current || controller.signal.aborted) return;
        const message = caught instanceof Error ? caught.message : String(caught);
        setError(/base/i.test(message) ? 'stale' : 'request-failed');
        setErrorDetail(message);
        setPhase('preflight');
        return;
      }
    }
    if (run !== runRef.current || controller.signal.aborted) return;
    controllerRef.current = null;
    setPhase('review');
  }, [activeChunks, aiService, model]);

  const retry = useCallback(() => { void start(); }, [start]);

  const toggleCandidate = useCallback((id: string, index: number) => {
    setCandidates(prev => prev.map(candidate => candidate.id !== id ? candidate
      : { ...candidate, enabled: candidate.enabled.map((value, i) => (i === index ? !value : value)) }));
  }, []);

  const selectAll = useCallback(() => {
    setCandidates(prev => prev.map(candidate => ({ ...candidate, enabled: candidate.keywords.map(() => true) })));
  }, []);

  const clearSelection = useCallback(() => {
    setCandidates(prev => prev.map(candidate => ({ ...candidate, enabled: candidate.keywords.map(() => false) })));
  }, []);

  const dismissError = useCallback(() => { setError(null); setErrorDetail(''); }, []);
  const acknowledgeStale = useCallback(() => { setStaleNow(false); setPhase('preflight'); setCandidates([]); }, []);

  const apply = useCallback(async () => {
    if (staleNow) return;
    const updates = candidates
      .map(candidate => ({
        id: candidate.id,
        keywords: candidate.keywords.filter((_, index) => candidate.enabled[index]),
      }))
      .filter(update => update.keywords.length > 0)
      .map(update => ({
        id: update.id,
        keywords: update.keywords
          .slice().sort((a, b) => a.start - b.start)
          .map(keyword => ({ ...keyword, source: 'ai' as const })),
      }));
    if (!updates.length) { setPhase('review'); return; }
    setPhase('applying');
    const result = await applyKeywordBatchWithPersistence(ctx, updates);
    if (!result.ok) {
      setError(result.error === 'empty' ? 'invalid' : 'apply-failed');
      setErrorDetail(result.error ?? 'apply-failed');
      setPhase('review');
      return;
    }
    setAppliedCount(result.count ?? updates.length);
    setPhase('done');
  }, [candidates, ctx, staleNow]);

  return useMemo(() => ({
    open, phase, model, hasModels, activeCount: activeChunks.length, totalChars, batchCount, progress,
    candidates, error, errorDetail, staleNow, appliedCount, enabledCount,
    openPanel, closePanel, start, cancelRun, retry, toggleCandidate, selectAll, clearSelection, apply,
    acknowledgeStale, dismissError,
  }), [open, phase, model, hasModels, activeChunks.length, totalChars, batchCount, progress, candidates,
    error, errorDetail, staleNow, appliedCount, enabledCount, openPanel, closePanel, start, cancelRun, retry,
    toggleCandidate, selectAll, clearSelection, apply, acknowledgeStale, dismissError]);
}


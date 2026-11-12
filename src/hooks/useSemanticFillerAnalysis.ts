// F-0009: semantic filler orchestration. The model receives only bounded windows and configId;
// successful batches stay pending until the shared history confirmation path applies them.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useClientRuntime } from '@/runtime/context';
import { useConnectionState } from '@/runtime/connectionHooks';
import { useAppStore } from '@/stores/appStore';
import { useHistoryStore } from '@/stores/historyStore';
import type { AIModelView } from '@/types/ai';
import { analyzeFillers, inspectFillerGate, type FillerRuleInput } from '../../shared/editing/fillerRules';
import {
  buildSemanticWindowPlan, createSemanticBase, mergeSemanticSuggestions,
  type SemanticWindowPlan,
} from '../../shared/editing/semanticFillers';
import type { CutSuggestion, SuggestionBatch } from '../../shared/editing/suggestions';
import {
  isCancellation, runSemanticBatchQueue, type SemanticBatchState, type SemanticQueueProgress,
} from '@/services/semanticFillerAnalysis';

export type SemanticPhase =
  | 'idle' | 'no-model' | 'word-gate' | 'preflight' | 'preparing'
  | 'running' | 'review' | 'partial' | 'empty' | 'cross-kind';

export interface SemanticFillerAnalysis {
  phase: SemanticPhase;
  model: AIModelView | null;
  hasModels: boolean;
  remoteHost: boolean;
  plan: SemanticWindowPlan | null;
  batches: SemanticBatchState[];
  progress: SemanticQueueProgress;
  base: string;
  baseReady: boolean;
  error: 'stale' | 'invalid' | 'failed' | null;
  open: () => void;
  start: (remoteAcknowledged?: boolean) => Promise<void>;
  cancel: () => void;
  retryFailed: () => Promise<void>;
  reset: () => void;
}

const EMPTY_PROGRESS: SemanticQueueProgress = { completed: 0, total: 0 };

function toRuleSuggestions(candidates: ReturnType<typeof analyzeFillers>['candidates']): CutSuggestion[] {
  return candidates.map(candidate => ({
    id: candidate.id,
    start: candidate.start,
    end: candidate.end,
    reason: candidate.reason,
    category: candidate.category,
    label: candidate.label,
    confidence: candidate.confidence,
    selected: candidate.defaultSelected,
    source: 'rule',
    sources: ['rule'],
  }));
}

function batchOrigin(ruleCount: number, semanticCount: number): SuggestionBatch['origin'] {
  if (ruleCount && semanticCount) return 'mixed';
  return semanticCount ? 'semantic' : 'rule';
}

export function useSemanticFillerAnalysis(): SemanticFillerAnalysis {
  const ctx = useClientRuntime();
  const chunks = useHistoryStore(state => state.chunks);
  const wordChunks = useHistoryStore(state => state.wordChunks);
  const hasWordTimestamps = useHistoryStore(state => state.hasWordTimestamps);
  const edl = useHistoryStore(state => state.edl);
  const language = useHistoryStore(state => state.language);
  const sourceDuration = useHistoryStore(state => state.sourceDuration);
  const proposeSuggestions = useHistoryStore(state => state.proposeSuggestions);
  const aiModels = useAppStore(state => state.aiModels);
  const selectedAIModelId = useAppStore(state => state.selectedAIModelId);
  const aiSettingsHostId = useAppStore(state => state.aiSettingsHostId);
  const videoFile = useAppStore(state => state.videoFile);
  const hostId = useConnectionState(state => state.identity?.hostId);
  const source = useConnectionState(state => state.target?.source);

  const model = useMemo(() => aiModels.find(item => item.id === selectedAIModelId) ?? null,
    [aiModels, selectedAIModelId]);
  const settingsReady = !!hostId && aiSettingsHostId === hostId;
  const remoteHost = !!source && source !== 'desktop' && source !== 'same-origin';
  const transcriptId = videoFile?.remotePath ?? videoFile?.name ?? chunks[0]?.id ?? 'current-editor';
  const dependenciesKey = useMemo(() => [hostId ?? '', JSON.stringify([edl, chunks, wordChunks, sourceDuration])].join(':'),
    [hostId, edl, chunks, wordChunks, sourceDuration]);

  const [currentBase, setCurrentBase] = useState('');
  const currentBaseRef = useRef('');
  const baseRequestRef = useRef(0);
  const [phase, setPhase] = useState<SemanticPhase>('idle');
  const [plan, setPlan] = useState<SemanticWindowPlan | null>(null);
  const [batches, setBatches] = useState<SemanticBatchState[]>([]);
  const [progress, setProgress] = useState<SemanticQueueProgress>(EMPTY_PROGRESS);
  const [error, setError] = useState<SemanticFillerAnalysis['error']>(null);
  const runRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);

  useEffect(() => {
    const request = ++baseRequestRef.current;
    if (!edl) {
      setCurrentBase(''); currentBaseRef.current = ''; return;
    }
    void createSemanticBase({ edl, chunks, wordChunks, sourceDuration, transcriptId })
      .then(value => {
        if (baseRequestRef.current !== request) return;
        currentBaseRef.current = value;
        setCurrentBase(value);
      })
      .catch(() => {
        if (baseRequestRef.current !== request) return;
        currentBaseRef.current = '';
        setCurrentBase('');
      });
  }, [chunks, dependenciesKey, edl, sourceDuration, transcriptId, wordChunks]);

  const reset = useCallback(() => {
    runRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    runningRef.current = false;
    setPhase('idle');
    setPlan(null);
    setBatches([]);
    setProgress(EMPTY_PROGRESS);
    setError(null);
  }, []);

  useEffect(() => {
    reset();
  }, [hostId, reset, videoFile]);

  const ruleInput = useMemo<FillerRuleInput | null>(() => {
    if (!edl) return null;
    return {
      chunks, wordChunks, hasWordTimestamps,
      sourceDuration: sourceDuration || edl.sourceDurationUs / 1e6,
      existingDeleted: edl.deleted.map(range => ({ start: range.startUs / 1e6, end: range.endUs / 1e6 })),
    };
  }, [chunks, edl, hasWordTimestamps, sourceDuration, wordChunks]);

  const buildPlan = useCallback((base: string): SemanticWindowPlan | null => {
    if (!edl || !ruleInput || !hasWordTimestamps) return null;
    const gate = inspectFillerGate(ruleInput);
    if (!gate.ok) return null;
    return buildSemanticWindowPlan({
      base,
      transcriptId,
      language,
      chunks,
      wordChunks,
      existingDeleted: ruleInput.existingDeleted,
    });
  }, [chunks, edl, hasWordTimestamps, language, ruleInput, transcriptId, wordChunks]);

  const open = useCallback(() => {
    runRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    runningRef.current = false;
    setError(null);
    const currentModel = aiModels.find(item => item.id === selectedAIModelId);
    if (!settingsReady || !currentModel) { setPhase('no-model'); return; }
    if (!hasWordTimestamps || !edl) { setPhase('word-gate'); return; }
    try {
      const preview = buildPlan('preflight');
      if (!preview || !preview.totalBatches) {
        setPlan(preview);
        setPhase('empty');
        return;
      }
      setPlan(preview);
      setBatches([]);
      setProgress({ completed: 0, total: preview.totalBatches });
      setPhase('preflight');
    } catch {
      setPhase('word-gate');
    }
  }, [aiModels, buildPlan, edl, hasWordTimestamps, selectedAIModelId, settingsReady]);

  const materialize = useCallback((finalBatches: SemanticBatchState[], base: string, cancelled: boolean) => {
    const semantic = finalBatches.filter(batch => batch.status === 'success')
      .flatMap(batch => batch.candidates);
    if (cancelled && !semantic.length) {
      setPhase('idle');
      return;
    }
    if (!ruleInput) { setPhase('word-gate'); return; }
    const ruleResult = inspectFillerGate(ruleInput).ok ? analyzeFillers(ruleInput) : { candidates: [] as ReturnType<typeof analyzeFillers>['candidates'] };
    const ruleItems = toRuleSuggestions(ruleResult.candidates);
    const items = mergeSemanticSuggestions(ruleItems, semantic);
    if (!items.length) {
      setPhase('empty');
      return;
    }
    const status = proposeSuggestions({
      kind: 'filler',
      base,
      stateKey: JSON.stringify([edl, chunks, wordChunks]),
      preview: false,
      items,
      origin: batchOrigin(ruleItems.length, semantic.length),
    });
    if (status === 'cross-kind') { setPhase('cross-kind'); return; }
    if (status === 'invalid') { setError('invalid'); setPhase('partial'); return; }
    const incomplete = finalBatches.some(batch => batch.status === 'failed' || batch.status === 'invalid' || batch.status === 'cancelled');
    setError(finalBatches.some(batch => batch.status === 'invalid') ? 'invalid'
      : finalBatches.some(batch => batch.status === 'failed') ? 'failed' : null);
    if (!incomplete && !semantic.length) { setPhase('empty'); return; }
    setPhase(incomplete ? 'partial' : 'review');
  }, [chunks, edl, proposeSuggestions, ruleInput, wordChunks]);

  const execute = useCallback(async (sourceBatches: SemanticBatchState[], run: number, controller: AbortController,
    base: string, configId: string) => {
    setError(null);
    const finalBatches = await runSemanticBatchQueue({
      connection: ctx.connection,
      configId,
      batches: sourceBatches,
      signal: controller.signal,
      onProgress: (nextProgress, nextBatches) => {
        if (runRef.current !== run) return;
        setProgress(nextProgress);
        setBatches(nextBatches.map(batch => ({ ...batch, candidates: [...batch.candidates] })));
      },
    });
    if (runRef.current !== run) return;
    runningRef.current = false;
    abortRef.current = null;
    setBatches(finalBatches);
    if (currentBaseRef.current !== base) {
      setError('stale');
      setPhase('idle');
      return;
    }
    materialize(finalBatches, base, controller.signal.aborted || finalBatches.some(batch => batch.status === 'cancelled'));
  }, [ctx.connection, materialize]);

  const start = useCallback(async (remoteAcknowledged = false) => {
    if (runningRef.current) return;
    if (!settingsReady || !model) { setPhase('no-model'); return; }
    if (remoteHost && !remoteAcknowledged) { setPhase('preflight'); return; }
    if (!hasWordTimestamps || !edl) { setPhase('word-gate'); return; }
    runningRef.current = true;
    setPhase('preparing');
    setError(null);
    const run = ++runRef.current;
    try {
      const base = await createSemanticBase({ edl, chunks, wordChunks, sourceDuration, transcriptId });
      if (runRef.current !== run) return;
      currentBaseRef.current = base;
      setCurrentBase(base);
      const nextPlan = buildPlan(base);
      if (!nextPlan) { setPhase('word-gate'); runningRef.current = false; return; }
      setPlan(nextPlan);
      if (!nextPlan.totalBatches) { setPhase('empty'); runningRef.current = false; return; }
      const nextBatches: SemanticBatchState[] = nextPlan.windows.map((window, index) => ({
        id: 'semantic-' + String(index + 1),
        index: index + 1,
        window,
        status: 'pending',
        candidates: [],
      }));
      const controller = new AbortController();
      abortRef.current = controller;
      setBatches(nextBatches);
      setProgress({ completed: 0, total: nextBatches.length });
      setPhase('running');
      await execute(nextBatches, run, controller, base, model.id);
    } catch {
      if (runRef.current !== run) return;
      runningRef.current = false;
      abortRef.current = null;
      setError('failed');
      setPhase('partial');
    }
  }, [buildPlan, chunks, edl, execute, hasWordTimestamps, model, remoteHost, settingsReady, sourceDuration, transcriptId, wordChunks]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const retryFailed = useCallback(async () => {
    if (runningRef.current || !model) return;
    const base = currentBaseRef.current;
    const targets = batches.filter(batch => batch.status === 'failed' || batch.status === 'invalid');
    if (!base || !targets.length) return;
    if (!currentBase || currentBase !== base) { setError('stale'); return; }
    runningRef.current = true;
    const targetIds = new Set(targets.map(batch => batch.id));
    const nextBatches = batches.map(batch => targetIds.has(batch.id)
      ? { ...batch, status: 'pending' as const, candidates: [], error: undefined } : batch);
    const controller = new AbortController();
    const run = ++runRef.current;
    abortRef.current = controller;
    setBatches(nextBatches);
    setPhase('running');
    setError(null);
    try { await execute(nextBatches, run, controller, base, model.id); }
    catch (failure) {
      if (runRef.current !== run) return;
      runningRef.current = false;
      abortRef.current = null;
      if (!isCancellation(failure, controller.signal)) { setError('failed'); setPhase('partial'); }
    }
  }, [batches, currentBase, execute, model]);

  return {
    phase, model, hasModels: aiModels.length > 0, remoteHost, plan, batches, progress,
    base: currentBase, baseReady: !!currentBase, error, open, start, cancel, retryFailed, reset,
  };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { useClientRuntime } from '@/runtime/context';
import { useRuntimeStoreApi } from '@/stores/runtimeStore';
import { useHistoryStore } from '@/stores/historyStore';
import { useProviderModels } from '@/hooks/useProviderModels';
import { useTranslation } from '@/contexts/LocaleProvider';
import { useAppStore } from '@/stores/appStore';
import { silenceCopy } from '@/locales/silence';
import { DEFAULT_SILENCE_PARAMS, validateSilenceParams, type SilenceParams } from '../../../shared/editing/silence';
import { populateSuggestionTexts } from '../../../shared/editing/suggestions';
import type { ModelRef } from '../../../shared/providers';
import { PendingSuggestionsList } from './PendingSuggestionsList';
import { Button } from '@/components/ui/button';
import { applyPendingWithPersistence } from '@/services/cutPersistence';

type Phase = 'idle' | 'analyzing' | 'empty' | 'error' | 'invalid' | 'no-model';

interface SilenceResult {
  vadType: 'fsmn' | 'silero';
  durationSeconds: number;
  hasReliableWordTimestamps: boolean;
  warnings: string[];
  candidates: Array<{ id: string; start: number; end: number; reason: string; category: string; confidence: number; defaultSelected: boolean }>;
}

export function SilenceCutPanel({ onSeek }: { onSeek?: (time: number) => void }) {
  const ctx = useClientRuntime();
  const historyApi = useRuntimeStoreApi('history');
  const batch = useHistoryStore(state => state.pendingSuggestions);
  const updatingCuts = useHistoryStore(state => state.updatingCuts);
  const cutError = useHistoryStore(state => state.cutError);
  const proposeSuggestions = useHistoryStore(state => state.proposeSuggestions);
  const confirmPending = useHistoryStore(state => state.confirmPending);
  const { groups } = useProviderModels();
  const joinFadeMs = useAppStore(state => state.joinFadeMs);
  const setJoinFadeMs = useAppStore(state => state.setJoinFadeMs);
  const { language } = useTranslation();
  const c = silenceCopy(language);
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [params, setParams] = useState<SilenceParams>(DEFAULT_SILENCE_PARAMS);
  const [model, setModel] = useState<ModelRef | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const jobRef = useRef<string | null>(null);
  const vadModels = groups.flatMap(group => group.models
    .filter(item => item.role === 'vad' && item.status === 'ready')
    .map(item => ({ providerId: group.provider.id, model: item })));

  useEffect(() => {
    if (!model && vadModels.length) setModel({ providerId: vadModels[0].providerId, modelId: vadModels[0].model.id });
  }, [model, vadModels]);

  const analyze = useCallback(async () => {
    setOpen(true);
    setSaveError(null);
    if (!model) { setPhase('no-model'); return; }
    if (validateSilenceParams(params).length) { setPhase('invalid'); return; }
    const current = ctx.stores.project.getState().current;
    if (!current) { setPhase('error'); return; }
    setPhase('analyzing'); setProgress(null);
    if (!await ctx.projects.flush()) { setPhase('error'); return; }
    try {
      const job = await ctx.connection.call('silence.analyze', { projectId: current.projectId, videoId: current.videoId, model, params });
      jobRef.current = job.id;
      const result = await ctx.connection.waitJob<SilenceResult>(job.id, snapshot => {
        setProgress(typeof snapshot.progress?.progress === 'number' ? snapshot.progress.progress : null);
      });
      jobRef.current = null;
      if (!result.candidates.length) { setPhase('empty'); return; }
      const latest = historyApi.getState();
      const base = JSON.stringify([latest.edl, latest.chunks, latest.wordChunks]);
      const items = populateSuggestionTexts(
        result.candidates.map(candidate => ({
          id: candidate.id, start: candidate.start, end: candidate.end, reason: candidate.reason,
          category: candidate.category, confidence: candidate.confidence, selected: candidate.defaultSelected,
          source: 'silence' as const, sources: ['silence' as const],
        })),
        latest.chunks,
        latest.wordChunks,
      );
      const status = proposeSuggestions({ kind: 'silence', base, preview: false, items });
      setPhase(status === 'cross-kind' ? 'error' : 'idle');
    } catch (error) {
      jobRef.current = null;
      setPhase(error instanceof Error && /cancel/i.test(error.message) ? 'idle' : 'error');
    }
  }, [ctx.connection, ctx.projects, ctx.stores.project, historyApi, model, params, proposeSuggestions]);

  const cancel = useCallback(async () => {
    if (jobRef.current) await ctx.connection.call('jobs.cancel', { id: jobRef.current }).catch(() => undefined);
    jobRef.current = null;
    setPhase('idle');
  }, [ctx.connection]);

  const apply = useCallback(async () => {
    const result = await applyPendingWithPersistence(ctx, confirmPending);
    setSaveError(result.error ?? null);
  }, [confirmPending, ctx]);

  const error = saveError ?? (cutError?.includes('outdated') ? 'stale' : cutError ? 'apply-failed' : null);
  return (
    <div className="border-b border-aimu-border" data-testid="silence-panel">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        <Button size="sm" variant={open ? 'secondary' : 'ghost'} onClick={() => setOpen(value => !value)}>
          {phase === 'analyzing' ? c.analyzing : c.entry}
        </Button>
        {batch?.kind === 'silence' && <span className="rounded bg-aimu-red-bg px-1.5 py-0.5 text-[10px] text-aimu-coral">{batch.items.length}</span>}
        {phase === 'analyzing' && <Button size="sm" variant="ghost" onClick={() => void cancel()}>{c.cancel}</Button>}
      </div>
      {open && (
        <div className="space-y-2 px-3 pb-2 text-xs">
          {!vadModels.length && <p className="text-aimu-coral" role="alert">{c.noModel}</p>}
          {!!vadModels.length && (
            <label className="flex items-center gap-2">
              <span className="text-aimu-text-muted">{c.model}</span>
              <select className="h-7 rounded border border-aimu-border bg-aimu-input px-2"
                value={model?.modelId ?? ''} onChange={event => {
                  const picked = vadModels.find(item => item.model.id === event.target.value);
                  if (picked) setModel({ providerId: picked.providerId, modelId: picked.model.id });
                }}>
                {vadModels.map(item => <option key={item.providerId + item.model.id} value={item.model.id}>{item.model.name}</option>)}
              </select>
            </label>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <label>{c.minPause} <input type="number" min={0.05} step={0.05} value={params.minPauseSeconds}
              onChange={event => setParams(previous => ({ ...previous, minPauseSeconds: Number(event.target.value) }))}
              className="h-7 w-16 rounded border border-aimu-border bg-aimu-input px-1" /></label>
            <label>{c.guard} <input type="number" min={0} step={0.05} value={params.guardSeconds}
              onChange={event => setParams(previous => ({ ...previous, guardSeconds: Number(event.target.value) }))}
              className="h-7 w-16 rounded border border-aimu-border bg-aimu-input px-1" /></label>
            <label>{c.retain} <input type="number" min={0} step={0.05} value={params.retainSeconds}
              onChange={event => setParams(previous => ({ ...previous, retainSeconds: Number(event.target.value) }))}
              className="h-7 w-16 rounded border border-aimu-border bg-aimu-input px-1" /></label>
            <select value={params.mode} onChange={event => setParams(previous => ({ ...previous, mode: event.target.value as SilenceParams['mode'] }))}
              className="h-7 rounded border border-aimu-border bg-aimu-input px-2">
              <option value="shorten">{c.shorten}</option>
              <option value="remove">{c.remove}</option>
            </select>
            <label className="flex items-center gap-1 text-aimu-text-secondary">
              <input type="checkbox" checked={joinFadeMs > 0} onChange={event => setJoinFadeMs(event.target.checked ? 5 : 0)}
                className="h-3.5 w-3.5 rounded border-aimu-border text-aimu-purple" />
              {c.joinFade}
            </label>
            <Button size="sm" data-testid="silence-analyze" disabled={phase === 'analyzing' || !vadModels.length} onClick={() => void analyze()}>
              {phase === 'analyzing' ? c.analyzing : c.entry}
            </Button>
          </div>
          {phase === 'invalid' && <p className="text-aimu-coral" role="alert">{c.checkParams}</p>}
          {phase === 'error' && <p className="text-aimu-coral" role="alert">{c.failed}</p>}
          {phase === 'empty' && <p className="text-aimu-text-muted">{c.empty}</p>}
          {phase === 'analyzing' && <p className="text-aimu-text-muted" role="status">{c.progress}{progress !== null ? ` ${Math.round(progress)}%` : ''}</p>}
        </div>
      )}
      {batch?.kind === 'silence' && (
        <PendingSuggestionsList batch={batch} updating={updatingCuts} error={error} onApply={() => void apply()} onSeek={onSeek} />
      )}
    </div>
  );
}

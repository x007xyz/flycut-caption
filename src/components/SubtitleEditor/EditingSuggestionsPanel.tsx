import { useCallback, useState } from 'react';
import { useClientRuntime } from '@/runtime/context';
import { useChunks, useHasWordTimestamps, useHistoryStore, useWordChunks } from '@/stores/historyStore';
import { useTranslation } from '@/contexts/LocaleProvider';
import { fillerCopy } from '@/locales/filler';
import { analyzeFillers, inspectFillerGate, type FillerRuleInput } from '../../../shared/editing/fillerRules';
import { populateSuggestionTexts } from '../../../shared/editing/suggestions';
import { PendingSuggestionsList } from './PendingSuggestionsList';
import { Button } from '@/components/ui/button';
import { applyPendingWithPersistence } from '@/services/cutPersistence';
import { useSemanticFillerAnalysis } from '@/hooks/useSemanticFillerAnalysis';
import { cn } from '@/lib/utils';

type Phase = 'idle' | 'analyzing' | 'gate' | 'empty' | 'results' | 'cross-kind';

export function EditingSuggestionsPanel({ onSeek }: { onSeek?: (time: number) => void }) {
  const ctx = useClientRuntime();
  const chunks = useChunks();
  const wordChunks = useWordChunks();
  const hasWordTimestamps = useHasWordTimestamps();
  const batch = useHistoryStore(state => state.pendingSuggestions);
  const edl = useHistoryStore(state => state.edl);
  const sourceDuration = useHistoryStore(state => state.sourceDuration);
  const updatingCuts = useHistoryStore(state => state.updatingCuts);
  const cutError = useHistoryStore(state => state.cutError);
  const proposeSuggestions = useHistoryStore(state => state.proposeSuggestions);
  const confirmPending = useHistoryStore(state => state.confirmPending);
  const cancelPending = useHistoryStore(state => state.cancelPending);
  const { language } = useTranslation();
  const c = fillerCopy(language);
  const semantic = useSemanticFillerAnalysis();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [semanticOpen, setSemanticOpen] = useState(false);
  const [remoteAcknowledged, setRemoteAcknowledged] = useState(false);

  const analyze = useCallback(async () => {
    setOpen(true);
    setSemanticOpen(false);
    setPhase('analyzing');
    setSaveError(null);
    if (!edl) { setPhase('gate'); return; }
    const input: FillerRuleInput = {
      chunks, wordChunks, hasWordTimestamps,
      sourceDuration: sourceDuration || edl.sourceDurationUs / 1e6,
      existingDeleted: edl.deleted.map(range => ({ start: range.startUs / 1e6, end: range.endUs / 1e6 })),
    };
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const gate = inspectFillerGate(input);
    if (!gate.ok) { setPhase('gate'); return; }
    const result = analyzeFillers(input);
    if (!result.candidates.length) { setPhase('empty'); return; }
    const base = JSON.stringify([edl, chunks, wordChunks]);
    const items = populateSuggestionTexts(
      result.candidates.map(candidate => ({
        id: candidate.id, start: candidate.start, end: candidate.end,
        reason: candidate.reason, category: candidate.category, label: candidate.label,
        confidence: candidate.confidence, selected: candidate.defaultSelected,
        source: 'rule' as const, sources: ['rule' as const],
      })),
      chunks,
      wordChunks,
    );
    const status = proposeSuggestions({ kind: 'filler', base, preview: false, origin: 'rule', items });
    setPhase(status === 'cross-kind' ? 'cross-kind' : 'results');
  }, [chunks, edl, hasWordTimestamps, proposeSuggestions, sourceDuration, wordChunks]);

  const openSemantic = () => {
    setSemanticOpen(true);
    setOpen(false);
    setRemoteAcknowledged(false);
    semantic.open();
  };

  const resetSemantic = semantic.reset;
  const closeSemantic = useCallback(() => {
    resetSemantic();
    setSemanticOpen(false);
    setRemoteAcknowledged(false);
  }, [resetSemantic]);

  const apply = useCallback(async () => {
    const wasSemantic = batch?.origin === 'semantic' || batch?.origin === 'mixed';
    const result = await applyPendingWithPersistence(ctx, confirmPending);
    setSaveError(result.error ?? null);
    if (result.ok) {
      setPhase('idle');
      if (wasSemantic) closeSemantic();
    }
  }, [batch?.origin, closeSemantic, confirmPending, ctx]);

  const semanticBatch = batch?.origin === 'semantic' || batch?.origin === 'mixed';
  const stale = !!semanticBatch && !!batch && semantic.baseReady && semantic.base !== batch.base;
  const error = saveError ?? (cutError?.includes('outdated') ? 'stale' : cutError ? 'apply-failed' : null);
  const attention = semantic.batches.filter(item => item.status === 'failed' || item.status === 'invalid').length;
  const cancelled = semantic.batches.some(item => item.status === 'cancelled');
  const current = semantic.progress.currentBatch ?? Math.min(semantic.progress.completed + 1, semantic.progress.total || 1);
  const progressText = c.semanticProgress.replace('{current}', String(current))
    .replace('{total}', String(semantic.progress.total)).replace('{done}', String(semantic.progress.completed));

  return (
    <div className="border-b border-aimu-border" data-testid="editing-suggestions">
      <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs">
        <Button size="sm" variant={open ? 'secondary' : 'ghost'} onClick={() => { if (!open) void analyze(); else setOpen(false); }}>
          {phase === 'analyzing' ? c.finding : c.entry}
        </Button>
        <Button size="sm" variant={semanticOpen ? 'secondary' : 'ghost'} data-testid="semantic-filler-open" onClick={openSemantic}>
          {semantic.phase === 'running' || semantic.phase === 'preparing' ? c.semanticFinding : c.semanticEntry}
        </Button>
        {batch?.kind === 'filler' && <span className="rounded bg-aimu-red-bg px-1.5 py-0.5 text-[10px] text-aimu-coral">{batch.items.length}</span>}
        {batch?.kind === 'filler' && <button className="text-aimu-text-muted hover:text-aimu-text-primary" onClick={() => {
          if (semanticBatch) setSemanticOpen(value => !value); else setOpen(value => !value);
        }}>{semanticBatch ? (semanticOpen ? '收起' : '展开') : (open ? '收起' : '展开')}</button>}
        {phase === 'analyzing' && <Button size="sm" variant="ghost" onClick={() => setPhase('idle')}>{c.cancel}</Button>}
      </div>

      {open && phase === 'analyzing' && <p className="px-3 pb-2 text-xs text-aimu-text-muted" role="status">{c.finding}</p>}
      {open && phase === 'gate' && (
        <div className="px-3 pb-2 text-xs text-aimu-coral" role="alert">
          <p>{c.wordGate}</p>
          <Button size="sm" variant="ghost" onClick={() => void analyze()}>{c.retry}</Button>
        </div>
      )}
      {open && phase === 'empty' && <p className="px-3 pb-2 text-xs text-aimu-text-muted">{c.empty}</p>}
      {open && phase === 'cross-kind' && <p className="px-3 pb-2 text-xs text-aimu-coral" role="alert">{c.crossKind}</p>}

      {semanticOpen && (
        <section className="border-t border-aimu-border px-3 py-2 text-xs" data-testid="semantic-filler-panel">
          <div className="mb-2 flex items-start justify-between gap-3">
            <strong>{c.semanticEntry}</strong>
            <Button size="sm" variant="ghost" onClick={closeSemantic}>{c.cancel}</Button>
          </div>

          {semantic.phase === 'no-model' && (
            <div className="rounded border border-aimu-border bg-aimu-panel p-2" role="alert">
              <p className="text-aimu-coral">{c.semanticNoModel}</p>
              <p className="mt-1 text-aimu-text-muted">{c.semanticNoModelHint}</p>
            </div>
          )}
          {semantic.phase === 'word-gate' && <p className="text-aimu-coral" role="alert">{c.wordGate}</p>}
          {semantic.phase === 'empty' && <p className="text-aimu-text-muted" role="status">{c.semanticEmpty}</p>}
          {semantic.phase === 'cross-kind' && <p className="text-aimu-coral" role="alert">{c.crossKind}</p>}

          {semantic.phase === 'preflight' && (
            <div className="space-y-2 rounded border border-aimu-border bg-aimu-panel p-2">
              <p className="font-medium text-aimu-text-primary">{c.semanticPreflight}</p>
              <p>{c.semanticTarget}: <strong>{semantic.model?.name}</strong> · <span className="font-mono">{semantic.model?.model}</span></p>
              <p className="break-all text-aimu-text-muted">{semantic.model?.baseUrl}</p>
              <p>{c.semanticScope.replace('{batches}', String(semantic.plan?.totalBatches ?? 0))
                .replace('{sentences}', String(semantic.plan?.targetSentenceCount ?? 0))
                .replace('{words}', String(semantic.plan?.targetWordCount ?? 0))}</p>
              <p className="text-aimu-text-muted">{c.semanticOnlyText}</p>
              {semantic.remoteHost && <p className="text-aimu-text-muted">{c.semanticRemote}</p>}
              {semantic.remoteHost && (
                <label className="flex items-start gap-2 rounded bg-aimu-input p-2">
                  <input type="checkbox" className="mt-0.5" checked={remoteAcknowledged}
                    onChange={event => setRemoteAcknowledged(event.target.checked)} />
                  <span>{c.semanticAcknowledge}</span>
                </label>
              )}
              <Button size="sm" data-testid="semantic-start" disabled={semantic.remoteHost && !remoteAcknowledged}
                onClick={() => void semantic.start(remoteAcknowledged)}>{c.semanticStart}</Button>
            </div>
          )}

          {(semantic.phase === 'preparing' || semantic.phase === 'running') && (
            <div className="rounded border border-aimu-border bg-aimu-panel p-2" role="status">
              <p>{semantic.phase === 'preparing' ? c.semanticPreparing : progressText}</p>
              <div className="mt-2 h-1.5 overflow-hidden rounded bg-aimu-input">
                <div className="h-full bg-aimu-purple transition-all"
                  style={{ width: String(semantic.progress.total ? semantic.progress.completed / semantic.progress.total * 100 : 0) + '%' }} />
              </div>
              <Button size="sm" variant="ghost" className="mt-2" data-testid="semantic-cancel-running" onClick={semantic.cancel}>{c.cancel}</Button>
            </div>
          )}

          {attention > 0 && (
            <div className={cn('mt-2 rounded border border-aimu-coral/40 bg-aimu-panel p-2', semantic.error === 'invalid' && 'text-aimu-coral')}>
              <p role="alert">{semantic.error === 'invalid' ? c.invalidResult : c.semanticPartial.replace('{count}', String(attention))}</p>
              <Button size="sm" variant="outline" className="mt-1" disabled={stale || semantic.phase === 'running'}
                onClick={() => void semantic.retryFailed()}>{c.retryFailedBatches}</Button>
            </div>
          )}
          {cancelled && semantic.phase !== 'running' && <p className="mt-2 text-aimu-text-muted" role="status">{c.semanticCancelled}</p>}
          {semantic.error === 'stale' && <p className="mt-2 text-aimu-coral" role="alert">{c.stale}</p>}
          {semantic.error === 'failed' && attention === 0 && <p className="mt-2 text-aimu-coral" role="alert">{c.analysisFailed}</p>}
        </section>
      )}

      {batch?.kind === 'filler' && (
        <PendingSuggestionsList batch={batch} updating={updatingCuts} error={error} stale={stale}
          onApply={() => void apply()} onSeek={onSeek}
          onCancel={() => { cancelPending(); closeSemantic(); setOpen(false); }} />
      )}
    </div>
  );
}


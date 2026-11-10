import { useCallback, useState } from 'react';
import { useClientRuntime } from '@/runtime/context';
import { useChunks, useHasWordTimestamps, useHistoryStore, useWordChunks } from '@/stores/historyStore';
import { useTranslation } from '@/contexts/LocaleProvider';
import { fillerCopy } from '@/locales/filler';
import { analyzeFillers, inspectFillerGate, type FillerRuleInput } from '../../../shared/editing/fillerRules';
import { PendingSuggestionsList } from './PendingSuggestionsList';
import { Button } from '@/components/ui/button';
import { applyPendingWithPersistence } from '@/services/cutPersistence';

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
  const { language } = useTranslation();
  const c = fillerCopy(language);
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);

  const analyze = useCallback(async () => {
    setOpen(true);
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
    const status = proposeSuggestions({
      kind: 'filler', base, preview: false,
      items: result.candidates.map(candidate => ({
        id: candidate.id, start: candidate.start, end: candidate.end,
        reason: candidate.reason, category: candidate.category, label: candidate.label,
        confidence: candidate.confidence, selected: candidate.defaultSelected,
      })),
    });
    setPhase(status === 'cross-kind' ? 'cross-kind' : 'results');
  }, [chunks, edl, hasWordTimestamps, proposeSuggestions, sourceDuration, wordChunks]);

  const apply = useCallback(async () => {
    const result = await applyPendingWithPersistence(ctx, confirmPending);
    setSaveError(result.error ?? null);
    if (result.ok) setPhase('idle');
  }, [confirmPending, ctx]);

  const error = saveError ?? (cutError?.includes('outdated') ? 'stale' : cutError ? 'apply-failed' : null);

  return (
    <div className="border-b border-aimu-border" data-testid="editing-suggestions">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        <Button size="sm" variant={open ? 'secondary' : 'ghost'} onClick={() => { if (!open) void analyze(); else setOpen(false); }}>
          {phase === 'analyzing' ? c.finding : c.entry}
        </Button>
        {batch?.kind === 'filler' && <span className="rounded bg-aimu-red-bg px-1.5 py-0.5 text-[10px] text-aimu-coral">{batch.items.length}</span>}
        {batch?.kind === 'filler' && <button className="text-aimu-text-muted hover:text-aimu-text-primary" onClick={() => setOpen(value => !value)}>{open ? '收起' : '展开'}</button>}
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
      {batch?.kind === 'filler' && (
        <PendingSuggestionsList batch={batch} updating={updatingCuts} error={error}
          onApply={() => void apply()} onSeek={onSeek} />
      )}
    </div>
  );
}

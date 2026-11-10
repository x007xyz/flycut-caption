import { useState } from 'react';
import { useHistoryStore } from '@/stores/historyStore';
import { useClientRuntime } from '@/runtime/context';
import { useTranslation } from '@/contexts/LocaleProvider';
import { edlCopy, cutKindLabel } from '@/locales/edl';
import { outputDuration, type CutRecord } from '../../../shared/editing/edl';

export function CutHistoryPanel() {
  const ctx = useClientRuntime(); const state = useHistoryStore();
  const { language } = useTranslation(); const c = edlCopy(language);
  const [open, setOpen] = useState(false); const [phase, setPhase] = useState<'idle' | 'loading' | 'error'>('idle');
  const [rows, setRows] = useState<CutRecord[]>([]); const [selected, setSelected] = useState<CutRecord | null>(null);
  const [busy, setBusy] = useState(false); const [failedRestore, setFailedRestore] = useState(false);
  const flushCuts = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await ctx.projects.flush()) return true;
      if (ctx.stores.project.getState().save.status !== 'pending') return false;
    }
    return false;
  };
  const load = async () => {
    setOpen(true); setPhase('loading'); setSelected(null); setFailedRestore(false);
    const owner = ctx.stores.project.getState().current;
    try {
      if (!owner) { setRows(ctx.stores.history.getState().cutHistory); setPhase('idle'); return; }
      if (!await flushCuts()) throw new Error('Save failed');
      const result = await ctx.connection.call('projects.open', { projectId: owner.projectId, videoId: owner.videoId });
      const latest = ctx.stores.project.getState().current;
      if (latest?.projectId !== owner.projectId || latest.videoId !== owner.videoId) return;
      if (result.status !== 'ok') throw new Error('Project unavailable');
      setRows(result.edits?.editing?.history ?? []); setPhase('idle');
    } catch { setPhase('error'); }
  };
  const restore = async () => {
    if (!selected || busy) return;
    setBusy(true); setFailedRestore(false);
    const before = ctx.stores.history.getState(); const owner = ctx.stores.project.getState().current;
    before.restoreHistory(selected.id);
    const appliedState = ctx.stores.history.getState(); const applied = appliedState.edl;
    ctx.stores.history.setState({ updatingCuts: true });
    const success = !ctx.stores.history.getState().cutError && (!owner || await flushCuts() || await ctx.projects.verifyCurrentEditsSaved());
    const current = ctx.stores.project.getState().current;
    const sameOwner = current?.projectId === owner?.projectId && current?.videoId === owner?.videoId;
    if (!success && sameOwner && ctx.stores.history.getState().edl === applied) {
      const now = ctx.stores.history.getState();
      const oldChunks = new Map(before.chunks.map(chunk => [chunk.id, chunk]));
      const appliedChunks = new Map(appliedState.chunks.map(chunk => [chunk.id, chunk]));
      const oldWords = new Map(before.wordChunks.map(chunk => [chunk.id, chunk]));
      ctx.stores.history.setState({ edl: before.edl, cutHistory: before.cutHistory, duration: before.duration,
        chunks: now.chunks.map(chunk => ({ ...chunk, deleted: oldChunks.get(chunk.id)?.deleted,
          ...(chunk.text === appliedChunks.get(chunk.id)?.text ? { text: oldChunks.get(chunk.id)?.text ?? chunk.text } : {}) })),
        wordChunks: now.wordChunks.map(chunk => ({ ...chunk, deleted: oldWords.get(chunk.id)?.deleted })),
        undoStack: before.undoStack, redoStack: before.redoStack, canUndo: before.canUndo, canRedo: before.canRedo,
        cutError: null });
      setFailedRestore(true);
    }
    ctx.stores.history.setState({ updatingCuts: false }); setBusy(false);
    if (success) { setSelected(null); setRows(ctx.stores.history.getState().cutHistory); }
  };
  const button = 'rounded border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-40';
  return <div className="border-b border-border p-2 text-foreground text-xs" data-testid="cut-controls">
    <button className={button} onClick={() => void load()}>{c.history}</button>
    {state.updatingCuts && <p role="status">{c.updating}</p>}
    {state.cutError && <div role="alert" className="p-2 text-destructive">
      <p>{c.invalid}</p><p>{state.cutError.includes('outdated') ? c.stale : c.invalidHint}</p>
      <button className={button} onClick={() => state.edl ? state.clearCutError() : location.reload()}>{c.retry}</button>
      <button className={button} onClick={() => void ctx.projects.goHome()}>{c.back}</button>
    </div>}
    {open && <section role="dialog" aria-label={c.history} className="mt-2 rounded border border-border bg-background p-3">
      <div className="flex justify-between"><strong>{c.history}</strong><button className={button} disabled={busy} onClick={() => { setOpen(false); state.previewHistory(null); }}>{c.close}</button></div>
      {phase === 'loading' && <p role="status">{c.loading}</p>}
      {phase === 'error' && <div role="alert">{c.failed} <button className={button} onClick={() => void load()}>{c.retry}</button></div>}
      {phase === 'idle' && !rows.length && <p>{c.noHistory}</p>}
      <div className="max-h-44 overflow-y-auto">{phase === 'idle' && [...rows].reverse().map(row => <div key={row.id} className="my-1 flex flex-wrap items-center gap-2 border-b border-border py-1">
        <time>{new Date(row.at).toLocaleString(language)}</time><span>{cutKindLabel(row.kind, language)} · {outputDuration(row.edl).toFixed(2)}s</span>
        <button className={button} disabled={busy} onClick={() => ctx.stores.history.setState({ historyPreview: row.edl })}>{c.previewCuts}</button>
        <button className={button} disabled={busy} onClick={() => { setSelected(row); setFailedRestore(false); }}>{c.restore}</button>
      </div>)}</div>
      {selected && <div role="alertdialog" aria-label={c.restoreTitle} className="border border-border p-2 mt-2">
        <strong>{c.restoreTitle}</strong><p>{c.restoreHint}</p>
        <time>{new Date(selected.at).toLocaleString(language)}</time> · {outputDuration(state.edl ?? selected.edl).toFixed(2)}s → {outputDuration(selected.edl).toFixed(2)}s
        {failedRestore && <p role="alert">{c.restoreFailed}</p>}
        <button className={button} disabled={busy} onClick={() => void restore()}>{busy ? c.restoring : c.restore}</button>
        <button className={button} disabled={busy} onClick={() => setSelected(null)}>{c.cancel}</button>
      </div>}
    </section>}
  </div>;
}

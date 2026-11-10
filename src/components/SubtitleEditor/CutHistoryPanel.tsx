import { useState } from 'react';
import { useHistoryStore } from '@/stores/historyStore';
import { useClientRuntime } from '@/runtime/context';
import { useTranslation } from '@/contexts/LocaleProvider';
import { edlCopy, cutKindLabel, textKindLabel } from '@/locales/edl';
import { outputDuration, type CutRecord } from '../../../shared/editing/edl';
import type { TextRecord } from '../../../shared/text/corrections';
import { restoreTextHistoryWithPersistence } from '@/services/textPersistence';

type HistoryRow =
  | { kind: 'cut'; id: string; at: string; cut: CutRecord }
  | { kind: 'text'; id: string; at: string; text: TextRecord };

const rowsOf = (cuts: readonly CutRecord[], texts: readonly TextRecord[]): HistoryRow[] => [
  ...cuts.map(cut => ({ kind: 'cut' as const, id: cut.id, at: cut.at, cut })),
  ...texts.map(text => ({ kind: 'text' as const, id: text.id, at: text.at, text })),
].sort((left, right) => left.at.localeCompare(right.at));

export function CutHistoryPanel() {
  const ctx = useClientRuntime(); const state = useHistoryStore();
  const { language } = useTranslation(); const c = edlCopy(language);
  const [open, setOpen] = useState(false); const [phase, setPhase] = useState<'idle' | 'loading' | 'error'>('idle');
  const [rows, setRows] = useState<HistoryRow[]>([]); const [selected, setSelected] = useState<HistoryRow | null>(null);
  const [busy, setBusy] = useState(false); const [failedRestore, setFailedRestore] = useState(false);
  const countText = (text: TextRecord) => c.textChanges.replace('{count}', String(text.after.length ?? text.before.length));
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
      if (!owner) {
        const history = ctx.stores.history.getState();
        setRows(rowsOf(history.cutHistory, history.textHistory)); setPhase('idle'); return;
      }
      if (!await flushCuts()) throw new Error('Save failed');
      const result = await ctx.connection.call('projects.open', { projectId: owner.projectId, videoId: owner.videoId });
      const latest = ctx.stores.project.getState().current;
      if (latest?.projectId !== owner.projectId || latest.videoId !== owner.videoId) return;
      if (result.status !== 'ok') throw new Error('Project unavailable');
      setRows(rowsOf(result.edits?.editing?.history ?? [], result.edits?.textHistory ?? [])); setPhase('idle');
    } catch { setPhase('error'); }
  };
  const preview = (row: HistoryRow) => {
    if (row.kind === 'text') {
      state.previewHistory(null); state.previewTextHistory(row.id);
    } else {
      state.previewTextHistory(null); ctx.stores.history.setState({ historyPreview: row.cut.edl });
    }
  };
  const restoreCut = async (row: Extract<HistoryRow, { kind: 'cut' }>) => {
    const before = ctx.stores.history.getState(); const owner = ctx.stores.project.getState().current;
    before.restoreHistory(row.id);
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
    return success;
  };
  const restore = async () => {
    if (!selected || busy) return;
    setBusy(true); setFailedRestore(false);
    let success = false;
    if (selected.kind === 'text') {
      const result = await restoreTextHistoryWithPersistence(ctx, selected.id);
      success = result.ok;
      if (!success) { setFailedRestore(true); setBusy(false); return; }
    } else {
      success = await restoreCut(selected);
    }
    setBusy(false);
    if (success) {
      setSelected(null);
      const history = ctx.stores.history.getState();
      setRows(rowsOf(history.cutHistory, history.textHistory));
    } else setFailedRestore(true);
  };
  const button = 'rounded border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-40';
  const textError = state.textError;
  return <div className="border-b border-border p-2 text-foreground text-xs" data-testid="cut-controls">
    <button className={button} onClick={() => void load()}>{c.history}</button>
    {state.updatingCuts && <p role="status">{c.updating}</p>}
    {state.cutError && <div role="alert" className="p-2 text-destructive">
      <p>{c.invalid}</p><p>{state.cutError.includes('outdated') ? c.stale : c.invalidHint}</p>
      <button className={button} onClick={() => state.edl ? state.clearCutError() : location.reload()}>{c.retry}</button>
      <button className={button} onClick={() => void ctx.projects.goHome()}>{c.back}</button>
    </div>}
    {open && <section role="dialog" aria-label={c.history} className="mt-2 rounded border border-border bg-background p-3">
      <div className="flex justify-between"><strong>{c.history}</strong><button className={button} disabled={busy} onClick={() => { setOpen(false); state.previewHistory(null); state.previewTextHistory(null); }}>{c.close}</button></div>
      {phase === 'loading' && <p role="status">{c.loading}</p>}
      {phase === 'error' && <div role="alert">{c.failed} <button className={button} onClick={() => void load()}>{c.retry}</button></div>}
      {phase === 'idle' && !rows.length && <p>{c.noHistory}</p>}
      <div className="max-h-56 overflow-y-auto">{phase === 'idle' && [...rows].reverse().map(row => <div key={`${row.kind}-${row.id}`} className="my-1 flex flex-wrap items-center gap-2 border-b border-border py-1">
        <time>{new Date(row.at).toLocaleString(language)}</time>
        {row.kind === 'cut'
          ? <span>{cutKindLabel(row.cut.kind, language)} · {outputDuration(row.cut.edl).toFixed(2)}s</span>
          : <span>{textKindLabel(row.text.kind, language)} · {countText(row.text)}</span>}
        <button className={button} disabled={busy} onClick={() => preview(row)}>{row.kind === 'cut' ? c.previewCuts : c.previewText}</button>
        <button className={button} disabled={busy} onClick={() => { setSelected(row); setFailedRestore(false); }}>{c.restore}</button>
      </div>)}</div>
      {state.textHistoryPreview && <div data-testid="text-history-preview" className="mt-2 rounded border border-border p-2">
        <strong>{countText(state.textHistoryPreview)}</strong>
        <div className="mt-1 space-y-1">{state.textHistoryPreview.before.map((before, index) => {
          const after = state.textHistoryPreview?.after[index];
          return <p key={before.id} className="text-aimu-text-muted"><span className="font-mono text-[10px]">{before.id}</span> ·
            <span className="mx-1">{c.before}: {before.text}</span>→<span className="mx-1">{c.after}: {after?.text ?? ''}</span></p>;
        })}</div>
      </div>}
      {selected && <div role="alertdialog" aria-label={selected.kind === 'cut' ? c.restoreTitle : c.restoreTextTitle} className="border border-border p-2 mt-2">
        <strong>{selected.kind === 'cut' ? c.restoreTitle : c.restoreTextTitle}</strong>
        <p>{selected.kind === 'cut' ? c.restoreHint : c.restoreTextHint}</p>
        <time>{new Date(selected.at).toLocaleString(language)}</time>
        {selected.kind === 'cut'
          ? <> · {outputDuration(state.edl ?? selected.cut.edl).toFixed(2)}s → {outputDuration(selected.cut.edl).toFixed(2)}s</>
          : <> · {countText(selected.text)}</>}
        {failedRestore && <p role="alert" className="mt-1 text-destructive">
          {selected.kind === 'text' ? (textError?.includes('changed') ? c.textConflict : c.textRestoreFailed) : c.restoreFailed}
        </p>}
        {failedRestore && selected.kind === 'text' && textError && <p className="text-[10px] text-muted-foreground">{textError}</p>}
        <div className="mt-1 flex gap-1">
          <button className={button} disabled={busy} onClick={() => void restore()}>{busy ? (selected.kind === 'text' ? c.restoringText : c.restoring) : c.restore}</button>
          <button className={button} disabled={busy} onClick={() => { setSelected(null); setFailedRestore(false); }}>{c.cancel}</button>
        </div>
      </div>}
    </section>}
  </div>;
}

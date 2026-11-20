import type { Context } from '@deepseek-ai/cordis';
import type { TextUpdate } from '../../shared/text/corrections';
import type { SplitPlan } from '../../shared/asr/sentenceSplitting';

export interface TextPersistenceResult {
  ok: boolean;
  count?: number;
  error?: 'empty' | 'duplicate' | 'unknown' | 'blank' | 'stale' | 'missing' | 'conflict' | 'apply-failed' | 'invalid';
}

/** Save the current formal edits, confirming a lost response by reading the project back. */
async function persistFormal(ctx: Context): Promise<boolean> {
  const owner = ctx.stores.project.getState().current;
  if (!owner) return true;
  try {
    if (await ctx.projects.flush()) return true;
    return await ctx.projects.verifyCurrentEditsSaved();
  } catch {
    return false;
  }
}

/**
 * Apply one AI correction batch and persist it as one operation. If the Host write fails before anything else
 * changes, put the formal text back and keep the review layer intact.
 */
export async function applyTextBatchWithPersistence(ctx: Context, updates: TextUpdate[]): Promise<TextPersistenceResult> {
  const history = ctx.stores.history;
  const owner = ctx.stores.project.getState().current;
  const before = history.getState();
  const result = before.applyTextBatch(updates, 'ai-correction');
  if (!result.ok) return { ok: false, error: result.error };
  const applied = history.getState();
  history.setState({ updatingCuts: true });
  const saved = await persistFormal(ctx);
  const current = ctx.stores.project.getState().current;
  const sameOwner = current?.projectId === owner?.projectId && current?.videoId === owner?.videoId;
  const unchanged = history.getState().chunks === applied.chunks;
  if (!saved && sameOwner && unchanged) {
    history.setState({ chunks: before.chunks, text: before.text, duration: before.duration, textHistory: before.textHistory,
      textHistoryPreview: before.textHistoryPreview, textError: null, undoStack: before.undoStack, redoStack: before.redoStack,
      canUndo: before.canUndo, canRedo: before.canRedo, updatingCuts: false });
    return { ok: false, error: 'apply-failed' };
  }
  history.setState({ updatingCuts: false });
  return { ok: saved, count: result.count, error: saved ? undefined : 'apply-failed' };
}

/** Apply reviewed sentence splits and persist them; a failed write restores the exact pre-apply state. */
export async function applySentenceSplitsWithPersistence(ctx: Context, plans: SplitPlan[]): Promise<TextPersistenceResult> {
  const history = ctx.stores.history;
  const owner = ctx.stores.project.getState().current;
  const before = history.getState();
  const result = before.applySentenceSplits(plans);
  if (!result.ok) return { ok: false, error: result.error };
  const applied = history.getState();
  history.setState({ updatingCuts: true });
  const saved = await persistFormal(ctx);
  const current = ctx.stores.project.getState().current;
  const sameOwner = current?.projectId === owner?.projectId && current?.videoId === owner?.videoId;
  const unchanged = history.getState().chunks === applied.chunks;
  if (!saved && sameOwner && unchanged) {
    history.setState({ chunks: before.chunks, wordChunks: before.wordChunks, text: before.text, duration: before.duration,
      undoStack: before.undoStack, redoStack: before.redoStack, canUndo: before.canUndo, canRedo: before.canRedo,
      cutError: null, updatingCuts: false });
    return { ok: false, error: 'apply-failed' };
  }
  history.setState({ updatingCuts: false });
  return { ok: saved, count: result.count, error: saved ? undefined : 'apply-failed' };
}

/** Restore one text record and persist it. A later edit to an affected subtitle is reported, never overwritten. */
export async function restoreTextHistoryWithPersistence(ctx: Context, id: string): Promise<TextPersistenceResult> {
  const history = ctx.stores.history;
  const owner = ctx.stores.project.getState().current;
  const before = history.getState();
  const result = before.restoreTextHistory(id);
  if (!result.ok) return { ok: false, error: result.error };
  const applied = history.getState();
  history.setState({ updatingCuts: true });
  const saved = await persistFormal(ctx);
  const current = ctx.stores.project.getState().current;
  const sameOwner = current?.projectId === owner?.projectId && current?.videoId === owner?.videoId;
  const unchanged = history.getState().chunks === applied.chunks;
  if (!saved && sameOwner && unchanged) {
    history.setState({ chunks: before.chunks, text: before.text, duration: before.duration, textHistory: before.textHistory,
      textHistoryPreview: before.textHistoryPreview, textError: null, undoStack: before.undoStack, redoStack: before.redoStack,
      canUndo: before.canUndo, canRedo: before.canRedo, updatingCuts: false });
    return { ok: false, error: 'apply-failed' };
  }
  history.setState({ updatingCuts: false });
  return { ok: saved, count: result.count, error: saved ? undefined : 'apply-failed' };
}

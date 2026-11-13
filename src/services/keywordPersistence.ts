import type { Context } from '@deepseek-ai/cordis';
import type { SubtitleKeyword } from '../../shared/text/keywords';

export interface KeywordPersistenceResult {
  ok: boolean;
  count?: number;
  error?: 'empty' | 'apply-failed';
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
 * F-0025: apply one confirmed keyword batch and persist it as one operation. Keywords never change
 * subtitle text, timestamps or the EDL, so the rollback only restores chunks plus undo stacks.
 */
export async function applyKeywordBatchWithPersistence(
  ctx: Context,
  updates: Array<{ id: string; keywords: SubtitleKeyword[] | undefined }>,
): Promise<KeywordPersistenceResult> {
  if (!updates.length) return { ok: false, error: 'empty' };
  const history = ctx.stores.history;
  const owner = ctx.stores.project.getState().current;
  const before = history.getState();
  history.getState().batchSetKeywords(updates);
  const applied = history.getState();
  if (applied.chunks === before.chunks) return { ok: false, error: 'empty' };
  history.setState({ updatingCuts: true });
  const saved = await persistFormal(ctx);
  const current = ctx.stores.project.getState().current;
  const sameOwner = current?.projectId === owner?.projectId && current?.videoId === owner?.videoId;
  const unchanged = history.getState().chunks === applied.chunks;
  if (!saved && sameOwner && unchanged) {
    history.setState({ chunks: before.chunks, text: before.text, duration: before.duration,
      undoStack: before.undoStack, redoStack: before.redoStack, canUndo: before.canUndo, canRedo: before.canRedo,
      updatingCuts: false });
    return { ok: false, error: 'apply-failed' };
  }
  history.setState({ updatingCuts: false });
  return { ok: saved, count: updates.length, error: saved ? undefined : 'apply-failed' };
}


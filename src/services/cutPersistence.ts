import type { Context } from '@deepseek-ai/cordis';

export interface CutApplyResult {
  ok: boolean;
  error?: 'stale' | 'apply-failed';
  rolledBack: boolean;
}

/**
 * Applies a pending suggestion batch and persists it. If the Host write fails and neither the
 * owner nor the local formal state changed meanwhile, restore the pre-apply snapshot.
 */
export async function applyPendingWithPersistence(
  ctx: Context,
  confirmPending: () => void,
): Promise<CutApplyResult> {
  const history = ctx.stores.history;
  const before = history.getState();
  const hostSuggestionId = before.pendingSuggestions?.hostSuggestionId;
  confirmPending();
  const applied = history.getState();
  if (applied.cutError) {
    return { ok: false, error: applied.cutError.includes('outdated') ? 'stale' : 'apply-failed', rolledBack: false };
  }
  history.setState({ updatingCuts: true });
  const owner = ctx.stores.project.getState().current;
  let saved = false;
  try {
    saved = await ctx.projects.flush();
    if (!saved && owner) saved = await ctx.projects.verifyCurrentEditsSaved();
  } catch {
    saved = false;
  }
  const current = ctx.stores.project.getState().current;
  const sameOwner = current?.projectId === owner?.projectId && current?.videoId === owner?.videoId;
  const unchanged = history.getState().edl === applied.edl;
  if (!saved && sameOwner && unchanged) {
    history.setState({ ...before, cutError: null, updatingCuts: false });
    return { ok: false, error: 'apply-failed', rolledBack: true };
  }
  history.setState({ updatingCuts: false });
  if (saved && hostSuggestionId && owner) {
    await ctx.connection.call('projects.suggestions.dismiss', {
      projectId: owner.projectId,
      videoId: owner.videoId,
      suggestionId: hostSuggestionId,
    }).catch(() => undefined);
  }
  return { ok: saved, error: saved ? undefined : 'apply-failed', rolledBack: false };
}

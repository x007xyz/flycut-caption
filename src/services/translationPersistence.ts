import type { Context } from '@deepseek-ai/cordis';

export interface ApplyTranslationsInput {
  trackId?: string;
  languageCode: string;
  name: string;
  updates: Array<{ id: string; text: string; expectedSource?: string }>;
}

export interface TranslationPersistenceResult {
  ok: boolean;
  count?: number;
  error?: 'empty' | 'stale' | 'conflict' | 'apply-failed';
  message?: string;
}

/**
 * Save formal language-track updates to the Host. When a flush result is uncertain,
 * read back from the Host via verifyCurrentEditsSaved before rolling back.
 */
async function persistTranslations(ctx: Context): Promise<{ saved: boolean; conflict?: boolean; message?: string }> {
  const owner = ctx.stores.project.getState().current;
  if (!owner) return { saved: true };
  try {
    if (await ctx.projects.flush()) return { saved: true };
    const projectState = ctx.stores.project.getState();
    if (projectState.save.status === 'conflict' || projectState.projectDeleted) {
      return { saved: false, conflict: true, message: projectState.save.error };
    }
    const verified = await ctx.projects.verifyCurrentEditsSaved();
    if (verified) return { saved: true };
    const latest = ctx.stores.project.getState();
    if (latest.save.status === 'conflict' || latest.projectDeleted) {
      return { saved: false, conflict: true, message: latest.save.error };
    }
    return { saved: false, message: latest.save.error };
  } catch (error) {
    return { saved: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function applyLanguageTranslationsWithPersistence(
  ctx: Context,
  input: ApplyTranslationsInput,
): Promise<TranslationPersistenceResult> {
  if (!input.updates.length) return { ok: false, error: 'empty' };

  const history = ctx.stores.history;
  const owner = ctx.stores.project.getState().current;
  const before = history.getState();
  if (before.updatingCuts) return { ok: false, error: 'stale' };

  const byId = new Map(before.chunks.map((chunk) => [chunk.id, chunk]));
  for (const update of input.updates) {
    const chunk = byId.get(update.id);
    if (!chunk) return { ok: false, error: 'stale' };
    if (update.expectedSource !== undefined && chunk.text !== update.expectedSource) {
      return { ok: false, error: 'stale' };
    }
  }

  before.applyLanguageTranslations({
    trackId: input.trackId,
    languageCode: input.languageCode,
    name: input.name,
    updates: input.updates.map((u) => ({ id: u.id, text: u.text })),
  });
  const applied = history.getState();
  history.setState({ updatingCuts: true });

  const outcome = await persistTranslations(ctx);
  const current = ctx.stores.project.getState().current;
  const sameOwner = current?.projectId === owner?.projectId && current?.videoId === owner?.videoId;
  const unchanged = history.getState().chunks === applied.chunks
    && history.getState().languageTracks === applied.languageTracks;

  if (!outcome.saved && sameOwner && unchanged) {
    history.setState({
      chunks: before.chunks,
      text: before.text,
      duration: before.duration,
      languageTracks: before.languageTracks,
      activeLanguageTrackId: before.activeLanguageTrackId,
      undoStack: before.undoStack,
      redoStack: before.redoStack,
      canUndo: before.canUndo,
      canRedo: before.canRedo,
      updatingCuts: false,
    });
    return {
      ok: false,
      error: outcome.conflict ? 'conflict' : 'apply-failed',
      message: outcome.message,
    };
  }

  history.setState({ updatingCuts: false });
  if (!outcome.saved) {
    return { ok: false, error: outcome.conflict ? 'conflict' : 'apply-failed', message: outcome.message };
  }
  return { ok: true, count: input.updates.length };
}

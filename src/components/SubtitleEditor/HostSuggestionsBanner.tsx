import { useCallback, useEffect, useRef, useState } from 'react';
import { useClientRuntime } from '@/runtime/context';
import { useRuntimeStoreApi } from '@/stores/runtimeStore';
import { useHistoryStore } from '@/stores/historyStore';
import { useProjectStore } from '@/stores/projectStore';
import { useTranslation } from '@/contexts/LocaleProvider';
import { fillerCopy } from '@/locales/filler';
import { Button } from '@/components/ui/button';
import type { PendingProjectSuggestion } from '../../../shared/projectOps';

export function HostSuggestionsBanner() {
  const ctx = useClientRuntime();
  const historyApi = useRuntimeStoreApi('history');
  const current = useProjectStore(state => state.current);
  const edl = useHistoryStore(state => state.edl);
  const pendingBatch = useHistoryStore(state => state.pendingSuggestions);
  const updatingCuts = useHistoryStore(state => state.updatingCuts);
  const proposeSuggestions = useHistoryStore(state => state.proposeSuggestions);
  const cancelPending = useHistoryStore(state => state.cancelPending);
  const { language } = useTranslation();
  const c = fillerCopy(language);

  const [suggestions, setSuggestions] = useState<PendingProjectSuggestion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  const hadHostBatchRef = useRef(false);

  const projectId = current?.projectId;
  const videoId = current?.videoId;

  const refresh = useCallback(async () => {
    if (!projectId || !videoId || !ctx.connection.isReady()) {
      setSuggestions([]);
      return;
    }
    try {
      const list = await ctx.connection.call('projects.suggestions.list', { projectId, videoId });
      setSuggestions(Array.isArray(list) ? list : []);
    } catch {
      // Optional in standalone/mock contexts without Host project suggestions handler
    }
  }, [ctx, projectId, videoId]);

  useEffect(() => {
    if (projectId && videoId && ctx.connection.isReady()) {
      void refresh();
    } else {
      setSuggestions([]);
    }
    let wasReady = ctx.connection.isReady();
    const offConn = ctx.connection.subscribe(() => {
      const ready = ctx.connection.isReady();
      if (ready && !wasReady) void refresh();
      wasReady = ready;
    });
    const offEvent = ctx.connection.on('project/suggestions-updated', payload => {
      if (payload.projectId === projectId && (!payload.videoId || payload.videoId === videoId)) {
        void refresh();
      }
    });
    return () => {
      offConn();
      offEvent();
    };
  }, [ctx, projectId, videoId, refresh]);

  useEffect(() => {
    const isHostBatch = !!pendingBatch?.hostSuggestionId;
    if (hadHostBatchRef.current && !isHostBatch && !updatingCuts) {
      void refresh();
    }
    if (isHostBatch || !updatingCuts) {
      hadHostBatchRef.current = isHostBatch;
    }
  }, [pendingBatch, updatingCuts, refresh]);

  const latest = suggestions[0];
  if (!current || !latest) return null;

  const isStale = latest.baseRevision !== current.videoRevision;
  const alreadyLoaded = pendingBatch?.hostSuggestionId === latest.id;

  const handleLoad = () => {
    setError(null);
    const state = historyApi.getState();
    if (!state.edl) return;
    const stateKey = JSON.stringify([state.edl, state.chunks, state.wordChunks]);
    const status = proposeSuggestions({
      ...latest.batch,
      stateKey,
      hostSuggestionId: latest.id,
    });
    if (status === 'cross-kind') {
      setError(c.crossKind);
    } else if (status === 'invalid') {
      setError(c.invalidResult);
    }
  };

  const handleDismiss = async () => {
    if (!projectId || !videoId) return;
    setDismissingId(latest.id);
    setError(null);
    try {
      await ctx.connection.call('projects.suggestions.dismiss', {
        projectId,
        videoId,
        suggestionId: latest.id,
      });
      if (historyApi.getState().pendingSuggestions?.hostSuggestionId === latest.id) {
        cancelPending();
      }
      setSuggestions(prev => prev.filter(item => item.id !== latest.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDismissingId(null);
    }
  };

  return (
    <div
      data-testid="host-suggestions-banner"
      className="border-b border-aimu-border bg-aimu-purple/5 px-3 py-2 text-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-aimu-text-primary">
            {c.hostPendingTitle.replace('{count}', String(latest.batch.items.length))}
          </p>
          <p className="text-[11px] text-aimu-text-muted">{c.hostPendingHint}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            data-testid="host-suggestions-load"
            disabled={!edl || alreadyLoaded || dismissingId === latest.id}
            onClick={handleLoad}
          >
            {c.hostPendingLoad}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="host-suggestions-dismiss"
            disabled={dismissingId === latest.id}
            onClick={() => { void handleDismiss(); }}
          >
            {c.hostPendingDismiss}
          </Button>
        </div>
      </div>
      {isStale && (
        <p data-testid="host-suggestions-stale" role="alert" className="mt-1 text-[11px] text-aimu-coral">
          {c.hostPendingStale}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-1 text-[11px] text-aimu-coral">
          {error}
        </p>
      )}
    </div>
  );
}


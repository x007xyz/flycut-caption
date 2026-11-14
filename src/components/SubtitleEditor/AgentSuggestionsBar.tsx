import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Eye, Loader2, RefreshCw, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/contexts/LocaleProvider';
import { fillerCopy } from '@/locales/filler';
import { useClientRuntime } from '@/runtime/context';
import { applyPendingWithPersistence } from '@/services/cutPersistence';
import { useHistoryStore } from '@/stores/historyStore';
import { useProjectStore } from '@/stores/projectStore';
import { formatTimeWithMs } from '@/utils/timeUtils';
import { suggestionSummary } from '../../../shared/editing/suggestions';
import type { PendingProjectSuggestion } from '../../../shared/projectOps';

type BarPhase = 'loading' | 'ready' | 'processing' | 'completed' | 'stale' | 'error';

export function AgentSuggestionsBar() {
  const ctx = useClientRuntime();
  const current = useProjectStore((s) => s.current);
  const proposeSuggestions = useHistoryStore((s) => s.proposeSuggestions);
  const confirmPending = useHistoryStore((s) => s.confirmPending);
  const cancelPending = useHistoryStore((s) => s.cancelPending);
  const edl = useHistoryStore((s) => s.edl);
  const pendingBatch = useHistoryStore((s) => s.pendingSuggestions);
  const { language } = useTranslation();
  const c = fillerCopy(language);

  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<BarPhase>('ready');
  const [items, setItems] = useState<PendingProjectSuggestion[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [lastKind, setLastKind] = useState<'fillers' | 'silence'>('fillers');
  const [activePreviewId, setActivePreviewId] = useState<string | null>(null);
  const epochRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const scopeRef = useRef<string>('');

  const currentScope = current ? `${current.projectId}:${current.videoId}` : '';
  scopeRef.current = currentScope;

  const loadSuggestions = useCallback(async (showSpinner = true) => {
    const target = ctx.stores.project.getState().current;
    if (!target) {
      setItems([]);
      setPhase('ready');
      return;
    }
    const seq = ++epochRef.current;
    const targetScope = `${target.projectId}:${target.videoId}`;
    if (showSpinner) setPhase('loading');
    setErrorMsg(null);
    try {
      const list = await ctx.connection.call('projects.suggestions.list', {
        projectId: target.projectId,
        videoId: target.videoId,
      });
      if (epochRef.current !== seq || scopeRef.current !== targetScope) return;
      setItems(list);
      if (list.length > 0) setOpen(true);
      setPhase('ready');
    } catch (error) {
      if (epochRef.current !== seq || scopeRef.current !== targetScope) return;
      setErrorMsg(error instanceof Error ? error.message : String(error));
      setPhase('error');
    }
  }, [ctx.connection, ctx.stores.project]);

  useEffect(() => {
    epochRef.current += 1;
    abortRef.current?.abort();
    setActiveJobId(null);
    setActivePreviewId(null);
    setErrorMsg(null);
    if (!current) {
      setItems([]);
      setPhase('ready');
      return;
    }
    void loadSuggestions(false);
  }, [current?.projectId, current?.videoId, loadSuggestions]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return ctx.connection.on('project/suggestions-updated', (payload) => {
      const cur = ctx.stores.project.getState().current;
      if (!cur || payload.projectId !== cur.projectId || payload.videoId !== cur.videoId) return;
      void loadSuggestions(false);
    });
  }, [ctx.connection, ctx.stores.project, loadSuggestions]);

  const runSuggestion = async (kind: 'fillers' | 'silence') => {
    if (!current || phase === 'processing') return;
    setLastKind(kind);
    setOpen(true);
    setErrorMsg(null);
    const seq = ++epochRef.current;
    const targetScope = `${current.projectId}:${current.videoId}`;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setPhase('processing');
    try {
      if (ctx.projects.hasUnsavedChanges()) {
        const flushed = await ctx.projects.flush();
        if (!flushed) throw new Error(c.analysisFailed);
      }
      const latestCur = ctx.stores.project.getState().current;
      if (!latestCur || epochRef.current !== seq || scopeRef.current !== targetScope) return;
      const job = await ctx.connection.call('projects.suggestEdits', {
        projectId: latestCur.projectId,
        videoId: latestCur.videoId,
        expectedRevision: latestCur.videoRevision,
        kind,
        ...(kind === 'silence' ? { silenceMethod: 'auto' as const } : {}),
        operationId: crypto.randomUUID(),
      });
      if (epochRef.current !== seq || scopeRef.current !== targetScope) return;
      setActiveJobId(job.id);
      await ctx.connection.waitJob(job.id, undefined, controller.signal);
      if (epochRef.current !== seq || scopeRef.current !== targetScope) return;
      setActiveJobId(null);
      await loadSuggestions(false);
    } catch (error) {
      setActiveJobId(null);
      if (epochRef.current !== seq || scopeRef.current !== targetScope) return;
      if (controller.signal.aborted) {
        setPhase('ready');
        return;
      }
      const msg = error instanceof Error ? error.message : String(error);
      if (/内容已更新|Content changed|VERSION_CONFLICT/i.test(msg)) {
        setPhase('stale');
        setErrorMsg(msg);
        return;
      }
      setErrorMsg(msg);
      setPhase('error');
    }
  };

  const cancelRun = () => {
    const jid = activeJobId;
    abortRef.current?.abort();
    setActiveJobId(null);
    if (jid) void ctx.connection.call('jobs.cancel', { id: jid }).catch(() => undefined);
    setPhase('ready');
  };

  const previewOnTimeline = (item: PendingProjectSuggestion): boolean => {
    if (!current || !edl) return false;
    if (current.videoRevision !== item.baseRevision) {
      setPhase('stale');
      setErrorMsg(c.agentStale);
      return false;
    }
    const hist = ctx.stores.history.getState();
    const base = JSON.stringify([hist.edl, hist.chunks, hist.wordChunks]);
    if (pendingBatch && pendingBatch.kind !== item.batch.kind) {
      cancelPending();
    }
    const status = proposeSuggestions({ ...item.batch, base, preview: true });
    if (status !== 'ok') {
      setErrorMsg(c.agentCrossKind);
      setPhase('error');
      return false;
    }
    setActivePreviewId(item.id);
    setPhase('ready');
    return true;
  };

  const applyHostSuggestion = async (item: PendingProjectSuggestion) => {
    if (!current || phase === 'processing') return;
    if (current.videoRevision !== item.baseRevision) {
      setPhase('stale');
      setErrorMsg(c.agentStale);
      return;
    }
    if (activePreviewId !== item.id || !pendingBatch) {
      if (!previewOnTimeline(item)) return;
    }
    setPhase('processing');
    setErrorMsg(null);
    const res = await applyPendingWithPersistence(ctx, confirmPending);
    if (!res.ok) {
      setPhase(res.error === 'stale' ? 'stale' : 'error');
      setErrorMsg(res.error === 'stale' ? c.agentStale : c.applyFailed);
      return;
    }
    await ctx.connection.call('projects.suggestions.dismiss', {
      projectId: item.projectId,
      videoId: item.videoId,
      suggestionId: item.id,
    }).catch(() => undefined);
    setActivePreviewId(null);
    setItems((prev) => prev.filter((x) => x.id !== item.id));
    setPhase('completed');
  };

  const dismissHostSuggestion = async (item: PendingProjectSuggestion) => {
    setErrorMsg(null);
    try {
      await ctx.connection.call('projects.suggestions.dismiss', {
        projectId: item.projectId,
        videoId: item.videoId,
        suggestionId: item.id,
      });
      if (activePreviewId === item.id) {
        cancelPending();
        setActivePreviewId(null);
      }
      setItems((prev) => prev.filter((x) => x.id !== item.id));
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : String(error));
      setPhase('error');
    }
  };

  if (!current) return null;

  return (
    <div className="border-b border-aimu-border" data-testid="agent-suggestions-bar">
      <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs">
        <Button
          size="sm"
          variant={open ? 'secondary' : 'ghost'}
          data-testid="agent-suggestions-toggle"
          onClick={() => setOpen((v) => !v)}
        >
          <Sparkles className="h-3.5 w-3.5" />
          {c.agentEntry}
        </Button>
        {items.length > 0 && (
          <span className="rounded bg-aimu-purple/15 px-1.5 py-0.5 text-[10px] font-medium text-aimu-purple" data-testid="agent-suggestions-count">
            {items.length}
          </span>
        )}
        {open && (
          <Button size="sm" variant="ghost" disabled={phase === 'loading' || phase === 'processing'} onClick={() => { void loadSuggestions(true); }}>
            <RefreshCw className="h-3 w-3" />
          </Button>
        )}
      </div>

      {open && (
        <div className="space-y-2 px-3 pb-2 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="outline" disabled={phase === 'processing' || !edl} onClick={() => { void runSuggestion('fillers'); }}>
              {c.agentRunFillers}
            </Button>
            <Button size="sm" variant="outline" disabled={phase === 'processing' || !edl} onClick={() => { void runSuggestion('silence'); }}>
              {c.agentRunSilence}
            </Button>
          </div>

          {phase === 'loading' && (
            <div className="flex items-center gap-2 text-aimu-text-muted" role="status">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>{c.agentLoading}</span>
            </div>
          )}

          {phase === 'processing' && (
            <div className="flex items-center gap-2 text-aimu-text-muted" role="status">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>{c.agentProcessing}</span>
              <Button size="sm" variant="ghost" onClick={cancelRun}>{c.cancel}</Button>
            </div>
          )}

          {phase === 'completed' && (
            <div className="flex items-center gap-1.5 rounded border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-1.5 text-emerald-600 dark:text-emerald-400" role="status">
              <CheckCircle2 className="h-3.5 w-3.5" />
              <span>{c.agentCompleted}</span>
            </div>
          )}

          {phase === 'stale' && (
            <div className="flex items-center justify-between gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-foreground" role="alert">
              <span>{c.agentStale}</span>
              <Button size="sm" variant="outline" onClick={() => { void loadSuggestions(true); }}>
                {c.agentReviewAgain}
              </Button>
            </div>
          )}

          {phase === 'error' && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-aimu-coral/40 bg-aimu-coral/5 px-2.5 py-1.5 text-aimu-coral" role="alert">
              <span>{errorMsg ?? c.analysisFailed}</span>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="outline" onClick={() => { setPhase('ready'); setErrorMsg(null); }}>
                  {c.agentBack}
                </Button>
                <Button size="sm" onClick={() => { void runSuggestion(lastKind); }}>
                  {c.retry}
                </Button>
              </div>
            </div>
          )}

          {phase !== 'loading' && items.length === 0 && phase !== 'completed' && (
            <p className="rounded border border-dashed border-aimu-border px-2.5 py-2 text-aimu-text-muted">{c.agentEmpty}</p>
          )}

          {items.map((item) => {
            const summary = suggestionSummary(item.batch);
            const isStale = current.videoRevision !== item.baseRevision;
            return (
              <div key={item.id} data-testid="host-suggestion-card" className="flex flex-wrap items-center justify-between gap-2 rounded border border-aimu-border bg-aimu-panel p-2">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-aimu-text-primary">
                      {item.batch.kind === 'silence' ? c.sourceSilence : c.sourceRule} · {summary.total}
                    </span>
                    <span className="text-aimu-text-muted">{c.estimated.replace('{duration}', formatTimeWithMs(summary.durationSeconds))}</span>
                    {isStale && (
                      <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                        <AlertTriangle className="h-3 w-3" />
                        {c.agentStale}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="outline" disabled={phase === 'processing'} onClick={() => previewOnTimeline(item)}>
                    <Eye className="h-3 w-3" />
                    {c.agentPreview}
                  </Button>
                  <Button size="sm" disabled={phase === 'processing'} onClick={() => { void applyHostSuggestion(item); }}>
                    {item.batch.kind === 'silence' ? c.applySilence : c.applyFiller}
                  </Button>
                  <Button size="sm" variant="ghost" aria-label={c.agentDismiss} disabled={phase === 'processing'} onClick={() => { void dismissHostSuggestion(item); }}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

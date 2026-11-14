// F-0051/F-0052: client-side confirmation center for destructive requests created by CLI / MCP / Agent.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useClientRuntime } from '@/runtime/context';
import { cn } from '@/lib/utils';
import type { ConfirmationKind, ConfirmationRequest, ConfirmationSource } from '../../../shared/confirmations';
import { useProjectText } from './useProjectText';

const SOURCE_LABEL: Record<ConfirmationSource, string> = {
  mcp: 'MCP',
  cli: 'CLI',
  agent: 'Agent',
};

export interface ClientConfirmationsProps {
  compact?: boolean;
  variant?: 'sidebar' | 'header';
}

export function ClientConfirmations({ compact = false, variant = 'sidebar' }: ClientConfirmationsProps) {
  const ctx = useClientRuntime();
  const { tp } = useProjectText();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ConfirmationRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedAction, setFailedAction] = useState<{ id: string; decision: 'approve' | 'reject' } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listEpochRef = useRef(0);

  const kindLabel = useCallback((kind: ConfirmationKind | string) => {
    switch (kind) {
      case 'trash-project': return tp('confirmationsKindTrash');
      case 'purge-project': return tp('confirmationsKindPurge');
      case 'remove-video': return tp('confirmationsKindRemoveVideo');
      case 'overwrite-export': return tp('confirmationsKindOverwrite');
      default: return kind;
    }
  }, [tp]);

  const refresh = useCallback(async () => {
    if (!ctx.connection.isReady()) return;
    const epoch = ++listEpochRef.current;
    setLoading(true);
    setError(null);
    setFailedAction(null);
    try {
      const list = await ctx.connection.call('confirmations.list', { status: 'pending' });
      if (epoch !== listEpochRef.current) return;
      setItems(Array.isArray(list) ? list.filter(item => item.status === 'pending') : []);
    } catch (caught) {
      if (epoch !== listEpochRef.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [ctx]);

  useEffect(() => {
    if (ctx.connection.isReady()) void refresh();
    let wasReady = ctx.connection.isReady();
    const offConn = ctx.connection.subscribe(() => {
      const ready = ctx.connection.isReady();
      if (ready && !wasReady) void refresh();
      wasReady = ready;
    });
    const offEvent = ctx.connection.on('confirmation/updated', ({ confirmation }) => {
      listEpochRef.current += 1;
      setItems(prev => {
        const rest = prev.filter(item => item.id !== confirmation.id);
        return confirmation.status === 'pending' ? [confirmation, ...rest] : rest;
      });
    });
    return () => {
      offConn();
      offEvent();
    };
  }, [ctx, refresh]);

  useEffect(() => {
    if (open && ctx.connection.isReady()) void refresh();
  }, [open, ctx, refresh]);

  useEffect(() => {
    if (!open || variant !== 'header') return;
    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, [open, variant]);

  const decide = useCallback(async (id: string, decision: 'approve' | 'reject') => {
    const targetItem = items.find(item => item.id === id);
    setBusy(id);
    setError(null);
    setFailedAction(null);
    try {
      await ctx.connection.call('confirmations.decide', { id, decision, actor: 'ui-client' });
      await refresh();
      if (decision === 'approve' && targetItem) {
        void ctx.projects?.syncAfterConfirmation(targetItem.kind, targetItem.target);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setFailedAction({ id, decision });
    } finally {
      setBusy(null);
    }
  }, [ctx, items, refresh]);

  const pending = useMemo(() => items.filter(item => item.status === 'pending'), [items]);

  const panelBody = (
    <div
      data-testid="confirmations-panel"
      role="dialog"
      aria-label={tp('confirmationsNav')}
      className={cn(
        'rounded border border-border bg-card p-2.5 text-xs shadow-lg',
        variant === 'header'
          ? 'absolute right-0 top-full z-50 mt-2 w-80'
          : 'mx-2 mb-2',
      )}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="font-medium text-foreground">{tp('confirmationsNav')}</span>
        <span className="text-[10px] text-muted-foreground">{tp('confirmationsClientOnly')}</span>
      </div>
      <p className="mb-2 text-[11px] text-muted-foreground">{tp('confirmationsHint')}</p>
      {error && (
        <div data-testid="confirmations-error" role="alert" className="mb-2 flex items-center justify-between gap-2 rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-600 dark:text-red-300">
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button
            type="button"
            data-testid="confirmations-retry"
            onClick={() => {
              if (failedAction) void decide(failedAction.id, failedAction.decision);
              else void refresh();
            }}
            className="shrink-0 rounded border border-current px-1.5 py-0.5 text-[10px] font-medium hover:bg-red-500/10"
          >
            {tp('confirmationsRetry')}
          </button>
        </div>
      )}
      {loading && <p data-testid="confirmations-loading" className="text-[11px] text-muted-foreground">Loading…</p>}
      {!loading && pending.length === 0 && (
        <p data-testid="confirmations-empty" className="text-[11px] text-muted-foreground">{tp('confirmationsEmpty')}</p>
      )}
      <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
        {pending.map(item => {
          const targetLabel = [item.target?.projectName, item.target?.videoName, item.target?.outputName].filter(Boolean).join(' · ');
          return (
            <div key={item.id} data-testid="confirmation-item" className="rounded border border-border/70 bg-background/60 p-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-foreground">{kindLabel(item.kind)}</span>
                <span
                  data-testid="confirmation-source"
                  className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase text-primary"
                >
                  {SOURCE_LABEL[item.source] ?? item.source}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-foreground/90">
                {item.summary || targetLabel}
              </p>
              {targetLabel && item.summary && !item.summary.includes(targetLabel) && (
                <p className="mt-0.5 text-[10px] text-muted-foreground">{targetLabel}</p>
              )}
              <p data-testid="confirmation-id" className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                {tp('confirmationsIdLabel', { id: item.id })}
              </p>
              <div className="mt-2 flex gap-1.5">
                <button
                  type="button"
                  data-testid="confirmations-approve"
                  disabled={busy === item.id}
                  onClick={() => { void decide(item.id, 'approve'); }}
                  className="rounded bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-40"
                >
                  {tp('confirmationsApprove')}
                </button>
                <button
                  type="button"
                  data-testid="confirmations-reject"
                  disabled={busy === item.id}
                  onClick={() => { void decide(item.id, 'reject'); }}
                  className="rounded border border-border px-2 py-1 text-[11px] text-foreground hover:bg-muted disabled:opacity-40"
                >
                  {tp('confirmationsReject')}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  if (variant === 'header') {
    return (
      <div ref={containerRef} className="relative flex items-center text-xs">
        <button
          type="button"
          data-testid="confirmations-open"
          aria-expanded={open}
          onClick={() => setOpen(prev => !prev)}
          title={tp('confirmationsNav')}
          className={cn(
            'relative flex h-8 items-center gap-1 rounded-md px-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
            open && 'bg-muted text-foreground',
          )}
        >
          <ShieldCheck className="h-4 w-4" />
          {pending.length > 0 && (
            <span
              data-testid="confirmations-count"
              className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-200"
            >
              {pending.length}
            </span>
          )}
        </button>
        {open && panelBody}
      </div>
    );
  }

  return (
    <div ref={containerRef} className={cn('text-xs', compact && 'px-1')}>
      <button
        type="button"
        data-testid="confirmations-open"
        aria-expanded={open}
        onClick={() => setOpen(prev => !prev)}
        className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-aimu-hover hover:text-foreground"
      >
        <ShieldCheck className="h-4 w-4" />
        {tp('confirmationsNav')}
        {pending.length > 0 && (
          <span
            data-testid="confirmations-count"
            className="ml-auto rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-200"
          >
            {pending.length}
          </span>
        )}
      </button>
      {open && panelBody}
    </div>
  );
}



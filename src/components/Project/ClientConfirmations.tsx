// F-0051: client-side confirmation center for destructive requests created by CLI / MCP / Agent.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useClientRuntime } from '@/runtime/context';
import { useProjectText } from './useProjectText';
import { cn } from '@/lib/utils';
import { ShieldCheck } from 'lucide-react';

interface ConfirmationItem {
  id: string;
  kind: string;
  source: string;
  status: string;
  summary: string;
  target?: { projectName?: string; videoName?: string; outputName?: string; format?: string };
}

const KIND_LABEL: Record<string, string> = {
  'trash-project': 'trash-project',
  'purge-project': 'purge-project',
  'remove-video': 'remove-video',
  'overwrite-export': 'overwrite-export',
};

export function ClientConfirmations({ compact = false }: { compact?: boolean }) {
  const ctx = useClientRuntime();
  const { tp } = useProjectText();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ConfirmationItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const list = await ctx.connection.call('confirmations.list', { status: 'pending' }) as ConfirmationItem[];
      setItems(Array.isArray(list) ? list : []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally { setLoading(false); }
  }, [ctx]);

  useEffect(() => { if (open) void refresh(); }, [open, refresh]);
  useEffect(() => { void refresh().catch(() => undefined); }, [refresh]);

  const decide = useCallback(async (id: string, decision: 'approve' | 'reject') => {
    setBusy(id);
    try {
      await ctx.connection.call('confirmations.decide', { id, decision, actor: 'ui-client' });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally { setBusy(null); }
  }, [ctx, refresh]);

  const pending = useMemo(() => items.filter(item => item.status === 'pending'), [items]);

  return (
    <div className={cn('text-xs', compact && 'px-1')}>
      <button
        type="button"
        data-testid="confirmations-open"
        onClick={() => setOpen(prev => !prev)}
        className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-aimu-hover hover:text-foreground"
      >
        <ShieldCheck className="h-4 w-4" />
        {tp('confirmationsNav')}
        {pending.length > 0 && (
          <span data-testid="confirmations-count" className="ml-auto rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-200">
            {pending.length}
          </span>
        )}
      </button>

      {open && (
        <div data-testid="confirmations-panel" role="dialog" aria-label={tp('confirmationsNav')}
          className="mx-2 mb-2 rounded border border-border bg-card p-2">
          <p className="mb-2 text-[11px] text-muted-foreground">{tp('confirmationsHint')}</p>
          {error && <p data-testid="confirmations-error" role="alert" className="mb-2 text-[11px] text-red-600 dark:text-red-300">{error}</p>}
          {loading && <p data-testid="confirmations-loading" className="text-[11px] text-muted-foreground">Loading…</p>}
          {!loading && pending.length === 0 && (
            <p data-testid="confirmations-empty" className="text-[11px] text-muted-foreground">{tp('confirmationsEmpty')}</p>
          )}
          <div className="flex flex-col gap-1">
            {pending.map(item => (
              <div key={item.id} data-testid="confirmation-item" className="rounded border border-border/70 p-2">
                <p className="font-medium text-foreground">
                  {KIND_LABEL[item.kind] ?? item.kind}
                  <span className="ml-1 text-[10px] uppercase text-muted-foreground">{item.source}</span>
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {item.summary || [item.target?.projectName, item.target?.videoName, item.target?.outputName].filter(Boolean).join(' · ')}
                </p>
                <div className="mt-1 flex gap-1">
                  <button type="button" data-testid="confirmations-approve" disabled={busy === item.id}
                    onClick={() => { void decide(item.id, 'approve'); }}
                    className="rounded bg-primary px-2 py-0.5 text-[11px] text-primary-foreground disabled:opacity-40">
                    {tp('confirmationsApprove')}
                  </button>
                  <button type="button" data-testid="confirmations-reject" disabled={busy === item.id}
                    onClick={() => { void decide(item.id, 'reject'); }}
                    className="rounded border border-border px-2 py-0.5 text-[11px] disabled:opacity-40">
                    {tp('confirmationsReject')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}


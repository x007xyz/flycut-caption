import { useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, Replace, Search, X } from 'lucide-react';
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { FindReplaceState, FindReplaceActions } from '@/hooks/useFindReplace';
import { useTranslation } from '@/contexts/LocaleProvider';
import { findCopy } from '@/locales/findReplace';

type FindReplace = FindReplaceState & FindReplaceActions;

export function FindReplaceBar({ find }: { find: FindReplace }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { language } = useTranslation();
  const c = findCopy(language);

  useEffect(() => {
    if (!find.open) return;
    const frame = requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [find.open]);

  if (!find.open) return null;

  const total = find.matches.length;
  const current = total === 0 ? 0 : find.current + 1;

  return (
    <>
      <div className="border-b border-aimu-border bg-aimu-panel px-3 py-2 text-xs" data-testid="find-replace">
        <div className="flex flex-wrap items-center gap-2">
          <Search className="h-3.5 w-3.5 text-aimu-text-muted" />
          <input
            ref={inputRef}
            autoFocus
            data-find-input
            data-testid="find-input"
            value={find.query}
            onChange={event => find.setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') { event.preventDefault(); find.closeFind(); }
              else if (event.key === 'Enter') {
                event.preventDefault();
                if (event.shiftKey) find.previous(); else find.next();
              }
            }}
            placeholder={c.find}
            aria-label={c.findLabel}
            className="h-7 w-48 rounded border border-aimu-border bg-aimu-input px-2 text-xs text-aimu-text-primary outline-none focus:ring-1 focus:ring-aimu-purple"
          />
          <span className="min-w-12 text-center font-mono text-aimu-text-muted" data-testid="find-count">
            {find.query ? `${current}/${total}` : '0/0'}
          </span>
          <button
            type="button"
            data-testid="find-previous"
            className="rounded p-1 text-aimu-text-muted hover:bg-aimu-hover hover:text-aimu-text-primary disabled:opacity-30"
            disabled={!total}
            onClick={find.previous}
            aria-label={c.previous}
          >
            <ChevronUp className="h-4 w-4" />
          </button>
          <button
            type="button"
            data-testid="find-next"
            className="rounded p-1 text-aimu-text-muted hover:bg-aimu-hover hover:text-aimu-text-primary disabled:opacity-30"
            disabled={!total}
            onClick={find.next}
            aria-label={c.next}
          >
            <ChevronDown className="h-4 w-4" />
          </button>
          <label className="flex items-center gap-1 text-aimu-text-secondary">
            <input
              type="checkbox"
              data-testid="find-match-case"
              checked={find.matchCase}
              onChange={event => find.setMatchCase(event.target.checked)}
              className="h-3.5 w-3.5 rounded border-aimu-border text-aimu-purple"
            />
            {c.matchCase}
          </label>
          <div className="mx-1 h-4 w-px bg-aimu-border" />
          <Replace className="h-3.5 w-3.5 text-aimu-text-muted" />
          <input
            data-find-input
            data-testid="replace-input"
            value={find.replacement}
            onChange={event => find.setReplacement(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') { event.preventDefault(); find.closeFind(); }
            }}
            placeholder={c.replaceWith}
            aria-label={c.replaceLabel}
            className="h-7 w-44 rounded border border-aimu-border bg-aimu-input px-2 text-xs text-aimu-text-primary outline-none focus:ring-1 focus:ring-aimu-purple"
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            data-testid="find-replace-one"
            disabled={!total}
            onClick={find.replaceCurrent}
          >
            {c.replace}
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid="find-replace-all"
            disabled={!total}
            onClick={find.previewAll}
          >
            {c.replaceAll}
          </Button>
          <button
            type="button"
            data-testid="find-close"
            className="ml-auto rounded p-1 text-aimu-text-muted hover:bg-aimu-hover hover:text-aimu-text-primary"
            onClick={find.closeFind}
            aria-label={c.close}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {find.query && total === 0 && <p className="mt-1 text-aimu-text-muted">{c.noMatches}</p>}
        {find.status === 'stale' && (
          <p className="mt-1 text-aimu-coral" role="alert">{c.stale}</p>
        )}
        {find.status === 'error' && (
          <p className="mt-1 text-aimu-coral" role="alert">{c.failed}</p>
        )}
      </div>

      <Dialog open={!!find.preview} onOpenChange={open => { if (!open) find.cancelPreview(); }}>
        <DialogContent data-testid="find-preview">
          <DialogHeader>
            <DialogTitle>{c.confirmTitle}</DialogTitle>
            <DialogDescription>
              {find.preview ? c.confirmHint.replace('{total}', String(find.preview.total)).replace('{count}', String(find.preview.rows.length)) : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="max-h-[50vh] overflow-y-auto">
            <div className="space-y-3">
              {find.preview?.rows.map(row => (
                <div key={row.chunkId} className="rounded border border-aimu-border p-2 text-xs">
                  <p className="text-aimu-text-muted line-through">- {row.before}</p>
                  <p className="mt-1 text-aimu-text-primary">+ {row.after}</p>
                </div>
              ))}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" data-testid="find-cancel" onClick={find.cancelPreview}>
              {c.cancel}
            </Button>
            <Button type="button" data-testid="find-confirm" onClick={find.confirmAll}>
              {c.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

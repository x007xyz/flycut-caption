import { useState } from 'react';
import { AlertCircle, CheckCircle2, Edit3, Loader2, Plus, Sparkles, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useClientRuntime } from '@/runtime/context';
import { useProjectStore } from '@/stores/projectStore';
import { validateTermDraft } from '../../../shared/terminology';
import { useProjectText } from './useProjectText';

export function HotwordsDialog() {
  const { projects } = useClientRuntime();
  const state = useProjectStore((s) => s.hotwordsDialog);
  const { tp } = useProjectText();
  const [draftTerm, setDraftTerm] = useState('');
  const [draftWeight, setDraftWeight] = useState('');
  const [draftAsHotword, setDraftAsHotword] = useState(true);
  const [editingId, setEditingId] = useState<string | undefined>();
  const [fieldError, setFieldError] = useState<string | undefined>();

  const open = state.phase !== 'idle';
  const busy = state.phase === 'loading' || state.phase === 'saving';

  const resetForm = () => {
    setDraftTerm('');
    setDraftWeight('');
    setDraftAsHotword(true);
    setEditingId(undefined);
    setFieldError(undefined);
  };

  const handleAddOrUpdate = () => {
    const checked = validateTermDraft({ term: draftTerm, weightRaw: draftWeight }, state.terms, editingId);
    if (checked.ok === false) {
      setFieldError(checked.message);
      return;
    }
    setFieldError(undefined);
    if (editingId) {
      projects.updateHotwordEntry(editingId, { term: checked.term, weight: checked.weight, asHotword: draftAsHotword });
    } else {
      projects.addHotwordEntry({ term: checked.term, weight: checked.weight, asHotword: draftAsHotword });
    }
    resetForm();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && state.phase !== 'saving') { resetForm(); projects.closeHotwordsDialog(); } }}>
      <DialogContent className="sm:max-w-lg" data-testid="hotwords-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <span>{tp('hotwordsTitle')}</span>
            {state.projectName && <span className="truncate text-sm font-normal text-muted-foreground">· {state.projectName}</span>}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {tp('hotwordsTermPlaceholder')}
          </DialogDescription>
        </DialogHeader>

        {state.phase === 'loading' && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>{tp('hotwordsLoading')}</span>
          </div>
        )}

        {state.phase !== 'loading' && (
          <div className="space-y-4">
            <div className="grid grid-cols-12 items-end gap-2">
              <div className="col-span-6 space-y-1">
                <Label htmlFor="hotword-term-input" className="text-xs">{tp('hotwordsTermLabel')}</Label>
                <Input
                  id="hotword-term-input"
                  value={draftTerm}
                  placeholder={tp('hotwordsTermPlaceholder')}
                  disabled={busy}
                  onChange={(e) => { setDraftTerm(e.target.value); if (fieldError) setFieldError(undefined); }}
                />
              </div>
              <div className="col-span-3 space-y-1">
                <Label htmlFor="hotword-weight-input" className="text-xs">{tp('hotwordsWeightLabel')}</Label>
                <Input
                  id="hotword-weight-input"
                  value={draftWeight}
                  placeholder={tp('hotwordsWeightPlaceholder')}
                  disabled={busy}
                  onChange={(e) => { setDraftWeight(e.target.value); if (fieldError) setFieldError(undefined); }}
                />
              </div>
              <div className="col-span-3 flex gap-1">
                <Button type="button" size="sm" className="w-full" disabled={busy} onClick={handleAddOrUpdate}>
                  <Plus className="h-3.5 w-3.5" />
                  {editingId ? tp('hotwordsUpdate') : tp('hotwordsAdd')}
                </Button>
              </div>
            </div>

            {fieldError && (
              <p className="flex items-center gap-1.5 text-xs text-aimu-coral" role="alert">
                <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
                <span>{fieldError}</span>
              </p>
            )}

            {state.terms.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
                {tp('hotwordsEmpty')}
              </div>
            ) : (
              <ul className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
                {state.terms.map((item) => (
                  <li key={item.id} className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs">
                    <input
                      type="checkbox"
                      aria-label={`${tp('hotwordsEnabled')} ${item.term}`}
                      checked={item.asHotword}
                      disabled={busy}
                      onChange={() => projects.toggleHotwordEntry(item.id)}
                    />
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">{item.term}</span>
                    {item.weight !== undefined && (
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">w:{item.weight}</span>
                    )}
                    <button
                      type="button"
                      aria-label={`${tp('hotwordsEdit')} ${item.term}`}
                      disabled={busy}
                      onClick={() => {
                        setEditingId(item.id);
                        setDraftTerm(item.term);
                        setDraftWeight(item.weight !== undefined ? String(item.weight) : '');
                        setDraftAsHotword(item.asHotword);
                        setFieldError(undefined);
                      }}
                      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={`${tp('hotwordsRemove')} ${item.term}`}
                      disabled={busy}
                      onClick={() => projects.removeHotwordEntry(item.id)}
                      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-aimu-coral"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {state.phase === 'saving' && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                <span>{tp('hotwordsProcessing')}</span>
              </div>
            )}

            {state.phase === 'completed' && (
              <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400" role="status">
                <CheckCircle2 className="h-3.5 w-3.5" />
                <span>{tp('hotwordsCompleted')}</span>
              </div>
            )}

            {state.phase === 'stale' && (
              <div className="flex items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-foreground" role="alert">
                <span>{tp('hotwordsStale')}</span>
                <Button type="button" size="sm" variant="outline" onClick={() => { void projects.reloadHotwordsDialog(); }}>
                  {tp('hotwordsReviewAgain')}
                </Button>
              </div>
            )}

            {state.phase === 'error' && (
              <div className="space-y-1 rounded-md border border-aimu-coral/40 bg-aimu-coral/5 px-3 py-2 text-xs text-aimu-coral" role="alert">
                <p className="font-medium">{state.error}</p>
                {state.uncertain && <p className="text-muted-foreground">{tp('hotwordsUncertain')}</p>}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {state.phase === 'error' ? (
            <>
              <Button type="button" variant="outline" onClick={() => { resetForm(); projects.closeHotwordsDialog(); }}>
                {tp('hotwordsBack')}
              </Button>
              <Button type="button" onClick={() => { void projects.saveHotwordsDialog(); }}>
                {tp('hotwordsRetry')}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" disabled={state.phase === 'saving'} onClick={() => { resetForm(); projects.closeHotwordsDialog(); }}>
                {state.phase === 'completed' ? tp('hotwordsClose') : tp('hotwordsCancel')}
              </Button>
              <Button
                type="button"
                disabled={busy || state.phase === 'stale' || !state.projectId}
                onClick={() => { void projects.saveHotwordsDialog(); }}
              >
                {tp('hotwordsSave')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

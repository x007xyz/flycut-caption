import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Languages, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { COMMON_LANGUAGES, getLanguageName } from '@/constants/languages';
import { useTranslation } from '@/contexts/LocaleProvider';
import { useClientRuntime } from '@/runtime/context';
import { useProjectStore } from '@/stores/projectStore';
import { useHistoryStore } from '@/stores/historyStore';
import type { ProjectService } from '@/services/projectService';
import { languageTrackCounts, LEGACY_LANGUAGE_TRACK_NAME, type LanguageTrack } from '../../../shared/languageTracks';
import { fillLanguageTrack, languageTrackCopy } from '@/locales/languageTracks';

interface TrackForm { mode: 'add' | 'edit'; id?: string; name: string; languageCode: string }
interface DeleteTarget { id: string; name: string; count: number }

function trackLabel(track: LanguageTrack, unknownLabel: string, legacyLabel: string) {
  const name = track.origin === 'legacy-second-text' && track.name === LEGACY_LANGUAGE_TRACK_NAME ? legacyLabel : track.name;
  return `${name} · ${track.languageCode ? getLanguageName(track.languageCode) : unknownLabel}`;
}

function TrackEditorDialog({ open, initial, onClose, onSubmit }: {
  open: boolean;
  initial: TrackForm | null;
  onClose: () => void;
  onSubmit: (input: { name: string; languageCode: string | null }) => void;
}) {
  const { language } = useTranslation();
  const copy = languageTrackCopy(language);
  const [name, setName] = useState('');
  const [languageCode, setLanguageCode] = useState('en');

  useEffect(() => {
    if (!open || !initial) return;
    setName(initial.name);
    setLanguageCode(initial.languageCode);
  }, [open, initial]);

  const changeLanguage = (code: string) => {
    const previousDefault = languageCode ? getLanguageName(languageCode) : '';
    setLanguageCode(code);
    if (!name.trim() || name === previousDefault) setName(code ? getLanguageName(code) : copy.unspecified);
  };
  const valid = !!name.trim() && (!!languageCode || initial?.mode === 'edit');

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={event => {
          event.preventDefault();
          if (valid) onSubmit({ name: name.trim(), languageCode: languageCode || null });
        }}>
          <DialogHeader>
            <DialogTitle>{initial?.mode === 'edit' ? copy.editTitle : copy.addTitle}</DialogTitle>
            <DialogDescription>{initial?.mode === 'edit' ? copy.editHint : copy.addHint}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="language-track-language">{copy.language}</Label>
              <select id="language-track-language" value={languageCode} onChange={event => changeLanguage(event.target.value)}
                className="h-9 w-full rounded-md border border-aimu-border bg-aimu-input px-3 text-sm text-aimu-text-primary outline-none focus:ring-2 focus:ring-aimu-purple/30">
                {initial?.mode === 'edit' && <option value="">{copy.unspecified}</option>}
                {COMMON_LANGUAGES.map(item => <option key={item.code} value={item.code}>{item.name} ({item.code})</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="language-track-name">{copy.name}</Label>
              <Input id="language-track-name" value={name} maxLength={80} onChange={event => setName(event.target.value)} autoFocus />
            </div>
            {!valid && <p role="alert" className="text-xs text-aimu-coral">{copy.required}</p>}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>{copy.cancel}</Button>
            <Button type="submit" disabled={!valid}>{copy.save}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteTrackDialog({ target, onClose, onConfirm }: { target: DeleteTarget | null; onClose: () => void; onConfirm: () => void }) {
  const { language } = useTranslation();
  const copy = languageTrackCopy(language);
  return (
    <Dialog open={!!target} onOpenChange={next => { if (!next) onClose(); }}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader className="flex-row items-start gap-3 px-6 pt-6">
          <Trash2 className="mt-0.5 h-5 w-5 flex-shrink-0 text-aimu-coral" />
          <div>
            <DialogTitle>{fillLanguageTrack(copy.deleteTitle, { name: target?.name ?? '' })}</DialogTitle>
            <DialogDescription className="mt-1.5">{copy.deleteHint}</DialogDescription>
          </div>
        </DialogHeader>
        {target && <DialogBody className="px-6 pt-3"><p className="rounded bg-aimu-input px-3 py-2 text-xs text-aimu-text-muted">{fillLanguageTrack(copy.countLabel, { count: target.count })}</p></DialogBody>}
        <DialogFooter className="px-6 pt-4 pb-6">
          <Button variant="ghost" onClick={onClose}>{copy.cancel}</Button>
          <Button variant="destructive" onClick={onConfirm}>{copy.confirmDelete}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** F-0030 track management; it lives inside the existing subtitle editor and saves through the project service. */
export function LanguageTrackBar() {
  const runtime = useClientRuntime();
  const projects = (runtime as typeof runtime & { projects?: ProjectService }).projects;
  const { language } = useTranslation();
  const copy = languageTrackCopy(language);
  const tracks = useHistoryStore(state => state.languageTracks);
  const activeId = useHistoryStore(state => state.activeLanguageTrackId);
  const chunks = useHistoryStore(state => state.chunks);
  const selectTrack = useHistoryStore(state => state.selectLanguageTrack);
  const addTrack = useHistoryStore(state => state.addLanguageTrack);
  const editTrack = useHistoryStore(state => state.editLanguageTrack);
  const removeTrack = useHistoryStore(state => state.removeLanguageTrack);
  const save = useProjectStore(state => state.save);
  const inProjectEditor = useProjectStore(state => !!state.current);
  const [form, setForm] = useState<TrackForm | null>(null);
  const [deleting, setDeleting] = useState<DeleteTarget | null>(null);

  const active = tracks.find(track => track.id === activeId);
  const counts = useMemo(() => languageTrackCounts(active, chunks), [active, chunks]);
  if (!inProjectEditor || !chunks.length) return null;

  const displayName = active
    ? active.origin === 'legacy-second-text' && active.name === LEGACY_LANGUAGE_TRACK_NAME ? copy.legacyName : active.name
    : '';

  const status = save.status === 'pending' || save.status === 'saving'
    ? <span className="inline-flex items-center gap-1 text-aimu-text-muted" data-testid="language-track-processing"><Loader2 className="h-3 w-3 animate-spin" />{copy.processing}</span>
    : save.status === 'saved'
      ? <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400" data-testid="language-track-completed"><Check className="h-3 w-3" />{copy.completed}</span>
      : save.status === 'conflict'
        ? <span className="inline-flex items-center gap-1 text-aimu-coral" data-testid="language-track-conflict"><AlertTriangle className="h-3 w-3" />{copy.conflict}
            <button type="button" className="underline underline-offset-2" onClick={() => projects?.openConflict()}>{copy.reviewConflict}</button></span>
        : save.status === 'offline'
          ? <span className="text-amber-700 dark:text-amber-400" data-testid="language-track-offline">{copy.offline}</span>
          : <span className="inline-flex flex-wrap items-center gap-1 text-aimu-coral" role="alert" data-testid="language-track-failed">
              <AlertTriangle className="h-3 w-3" />{copy.failed}{save.error ? `: ${save.error}` : ''}
              <button type="button" className="underline underline-offset-2" onClick={() => { void projects?.flush(); }}>{copy.retry}</button>
              <button type="button" className="underline underline-offset-2" onClick={() => { void projects?.goHome(); }}>{copy.back}</button>
            </span>;

  return (
    <>
      <section aria-label={copy.title} data-testid="language-track-bar" className="shrink-0 border-b border-aimu-border bg-aimu-panel px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1 text-xs font-medium text-aimu-text-secondary"><Languages className="h-3.5 w-3.5 text-aimu-purple" />{copy.title}</span>
          {!tracks.length ? (
            <span className="text-xs text-aimu-text-muted" data-testid="language-track-empty">{copy.empty}</span>
          ) : (
            <>
              <select aria-label={copy.title} value={activeId ?? ''} onChange={event => selectTrack(event.target.value)}
                data-testid="language-track-select" className="h-7 max-w-56 rounded border border-aimu-border bg-aimu-input px-2 text-xs text-aimu-text-primary">
                {tracks.map(track => <option key={track.id} value={track.id}>{trackLabel(track, copy.unspecified, copy.legacyName)}</option>)}
              </select>
              {activeId && <button type="button" className="p-1 text-aimu-text-muted hover:text-aimu-text-primary" title={copy.rename}
                aria-label={copy.rename} onClick={() => {
                  if (active) setForm({ mode: 'edit', id: active.id, name: displayName, languageCode: active.languageCode ?? '' });
                }}><Pencil className="h-3.5 w-3.5" /></button>}
              {activeId && <button type="button" className="p-1 text-aimu-text-muted hover:text-aimu-coral" title={copy.delete}
                aria-label={copy.delete} onClick={() => active && setDeleting({ id: active.id, name: displayName, count: counts.translated })}><Trash2 className="h-3.5 w-3.5" /></button>}
            </>
          )}
          <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" data-testid="language-track-add"
            onClick={() => setForm({ mode: 'add', name: getLanguageName('en'), languageCode: 'en' })}><Plus className="h-3.5 w-3.5" />{copy.add}</Button>
          <span className="ml-auto text-[11px]" aria-live="polite">{status}</span>
        </div>
        {active && (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-aimu-text-muted">
            <span data-testid="language-track-count">{fillLanguageTrack(copy.translatedCount, { count: counts.translated })}</span>
            {counts.outdated > 0 && <span className="text-amber-700 dark:text-amber-400">{fillLanguageTrack(copy.outdatedCount, { count: counts.outdated })}</span>}
            {!active.languageCode && <span role="alert" className="text-amber-700 dark:text-amber-400" data-testid="language-track-unspecified">{copy.unknownLanguage}
              <button type="button" className="ml-1 underline underline-offset-2" onClick={() => setForm({ mode: 'edit', id: active.id, name: displayName, languageCode: '' })}>{copy.setLanguage}</button></span>}
            {counts.translated === 0 && <span data-testid="language-track-empty-translations">{copy.emptyTrack}</span>}
          </div>
        )}
      </section>
      <TrackEditorDialog open={!!form} initial={form} onClose={() => setForm(null)} onSubmit={input => {
        if (!form) return;
        if (form.mode === 'add') addTrack(input); else if (form.id) editTrack(form.id, input);
        setForm(null);
      }} />
      <DeleteTrackDialog target={deleting} onClose={() => setDeleting(null)} onConfirm={() => {
        if (deleting) removeTrack(deleting.id);
        setDeleting(null);
      }} />
    </>
  );
}

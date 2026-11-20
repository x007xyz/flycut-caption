import { useState } from 'react';
import { useTranslation } from '@/contexts/LocaleProvider';
import { customPresetCopy, fillCustomPreset } from '@/locales/customPresets';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AlertTriangle, Check, Loader2, Plus, Trash2 } from 'lucide-react';
import type { CustomPresetState } from '@/hooks/useCustomStylePresets';
import type { SubtitleStyle } from '@/subtitle';

function PresetPreview({ style }: { style: SubtitleStyle }) {
  return <span aria-hidden className="text-lg leading-none" style={{
    color: style.color,
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle,
    textDecoration: style.textDecoration,
    WebkitTextStroke: style.borderWidth > 0 ? `${Math.min(style.borderWidth, 3)}px ${style.borderColor}` : undefined,
  }}>Aa</span>;
}

export function CustomPresetsSection({ state, style }: { state: CustomPresetState; style: SubtitleStyle }) {
  const { language } = useTranslation();
  const c = customPresetCopy(language);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [formError, setFormError] = useState<string | undefined>();
  const [duplicateId, setDuplicateId] = useState<string | undefined>();
  const [confirmId, setConfirmId] = useState<string | undefined>();
  const busy = state.phase === 'saving';

  if (!state.available) return <p data-testid="custom-preset-unavailable" className="text-[11px] text-aimu-text-muted">{c.unavailable}</p>;

  const closeForm = () => { setFormOpen(false); setName(''); setFormError(undefined); setDuplicateId(undefined); };
  const save = async () => {
    setFormError(undefined);
    const result = await state.create(name);
    if (result.ok) { closeForm(); return; }
    if (result.duplicateId) { setDuplicateId(result.duplicateId); return; }
    setFormError(result.error);
  };

  return <div data-testid="custom-presets-section" className="space-y-1.5">
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium text-aimu-text-secondary">{c.section}</span>
      {state.presets.length > 0 && <span className="text-[10px] text-aimu-text-muted">{fillCustomPreset(c.count, { count: state.presets.length })}</span>}
      <Button size="sm" variant="ghost" data-testid="custom-preset-save-open" className="ml-auto h-7 px-2 text-[11px]"
        disabled={busy || state.phase === 'loading'} onClick={() => { setFormOpen(true); setFormError(undefined); setDuplicateId(undefined); }}>
        <Plus className="mr-1 h-3 w-3" />{c.saveAs}
      </Button>
    </div>

    {state.phase === 'loading' && <p role="status" data-testid="custom-preset-loading" className="flex items-center gap-1 text-[11px] text-aimu-text-muted">
      <Loader2 className="h-3 w-3 animate-spin" />{c.loading}
    </p>}

    {state.phase === 'error' && <div role="alert" data-testid="custom-preset-error" className="rounded border border-aimu-coral/40 bg-aimu-red-bg p-2 text-[11px] text-aimu-coral">
      <p>{state.error ?? c.failed}</p>
      <div className="mt-1 flex gap-1">
        <Button size="sm" variant="outline" data-testid="custom-preset-retry" onClick={() => void state.retry()}>{c.retry}</Button>
        <Button size="sm" variant="ghost" onClick={() => void state.reload()}>{c.back}</Button>
      </div>
    </div>}

    {state.phase === 'stale' && <div role="alert" data-testid="custom-preset-stale" className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[11px]">
      <p className="font-medium text-amber-800 dark:text-amber-200">{c.stale}</p>
      <p className="text-aimu-text-muted">{c.staleHint}</p>
      <Button size="sm" variant="outline" data-testid="custom-preset-reload" className="mt-1" onClick={() => void state.reload()}>{c.reload}</Button>
    </div>}

    {state.notice && <p role="status" data-testid="custom-preset-notice"
      className={state.notice === 'font-missing' ? 'flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300' : 'flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-300'}>
      {state.notice === 'font-missing' ? <AlertTriangle className="h-3 w-3" /> : <Check className="h-3 w-3" />}
      {state.notice === 'saved' ? c.saved : state.notice === 'deleted' ? c.deleted : state.notice === 'applied' ? c.applied : c.fontMissing}
      <button type="button" className="ml-1 underline" onClick={state.dismissNotice}>{c.cancel}</button>
    </p>}

    {formOpen && <div data-testid="custom-preset-form" className="space-y-1.5 rounded border border-aimu-border bg-background p-2">
      <div className="flex items-center gap-2">
        <Input data-testid="custom-preset-name" value={name} placeholder={c.namePlaceholder} disabled={busy}
          onChange={event => { setName(event.target.value); setFormError(undefined); setDuplicateId(undefined); }}
          className="h-7 flex-1 border-aimu-border bg-aimu-input text-[11px]" />
        <span className="flex h-8 w-10 items-center justify-center rounded border border-aimu-border bg-aimu-input" title={c.preview}>
          <PresetPreview style={style} />
        </span>
      </div>
      {formError && <p role="alert" className="text-[11px] text-aimu-coral">{formError}</p>}
      {duplicateId && <div role="alert" data-testid="custom-preset-overwrite" className="rounded border border-amber-500/40 bg-amber-500/10 p-1.5 text-[11px]">
        <p className="text-amber-800 dark:text-amber-200">{c.overwriteTitle}</p>
        <div className="mt-1 flex gap-1">
          <Button size="sm" data-testid="custom-preset-overwrite-confirm" disabled={busy}
            onClick={() => void state.overwrite(duplicateId, name).then(ok => { if (ok) closeForm(); })}>{c.overwrite}</Button>
          <Button size="sm" variant="ghost" onClick={closeForm}>{c.cancel}</Button>
        </div>
      </div>}
      <div className="flex gap-1">
        <Button size="sm" data-testid="custom-preset-save" disabled={busy || !name.trim()} onClick={() => void save()}>{c.save}</Button>
        <Button size="sm" variant="ghost" data-testid="custom-preset-cancel" disabled={busy} onClick={closeForm}>{c.cancel}</Button>
      </div>
    </div>}

    {!formOpen && state.presets.length === 0 && state.phase === 'ready' && <p data-testid="custom-preset-empty" className="text-[11px] text-aimu-text-muted">{c.empty}</p>}

    {state.presets.length > 0 && <div data-testid="custom-preset-list" className="space-y-1">
      {state.presets.map(preset => <div key={preset.id} data-testid="custom-preset-item" className="flex items-center gap-1.5 rounded border border-aimu-border bg-background p-1.5">
        <span className="flex h-7 w-9 shrink-0 items-center justify-center rounded border border-aimu-border bg-aimu-input">
          <PresetPreview style={preset.primary as unknown as SubtitleStyle} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-aimu-text-primary">{preset.name}</span>
        {confirmId === preset.id ? <>
          <span className="text-[10px] text-aimu-text-muted">{c.confirmRemove}</span>
          <Button size="sm" variant="destructive" data-testid="custom-preset-confirm-delete" disabled={busy}
            onClick={() => void state.remove(preset.id).then(ok => { if (ok) setConfirmId(undefined); })}>{c.confirm}</Button>
          <Button size="sm" variant="ghost" data-testid="custom-preset-keep" onClick={() => setConfirmId(undefined)}>{c.keep}</Button>
        </> : <>
          <Button size="sm" variant="outline" data-testid="custom-preset-apply" disabled={busy} onClick={() => state.apply(preset.id)}>{c.apply}</Button>
          <Button size="sm" variant="ghost" data-testid="custom-preset-delete" disabled={busy} onClick={() => setConfirmId(preset.id)}><Trash2 className="h-3 w-3" /></Button>
        </>}
      </div>)}
    </div>}

    {busy && <p role="status" className="flex items-center gap-1 text-[11px] text-aimu-text-muted"><Loader2 className="h-3 w-3 animate-spin" />{c.saving}</p>}
  </div>;
}

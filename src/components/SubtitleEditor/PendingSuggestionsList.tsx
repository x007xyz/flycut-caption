import { useTranslation } from '@/contexts/LocaleProvider';
import { fillerCopy } from '@/locales/filler';
import { formatTimeWithMs } from '@/utils/timeUtils';
import { useHistoryStore } from '@/stores/historyStore';
import { suggestionSummary, type SuggestionBatch } from '../../../shared/editing/suggestions';
import { Button } from '@/components/ui/button';

interface PendingSuggestionsListProps {
  batch: SuggestionBatch;
  updating: boolean;
  error?: string | null;
  stale?: boolean;
  onApply: () => void;
  onCancel?: () => void;
  onSeek?: (time: number) => void;
}

export function PendingSuggestionsList({ batch, updating, error, stale = false, onApply, onCancel, onSeek }: PendingSuggestionsListProps) {
  const { language } = useTranslation();
  const c = fillerCopy(language);
  const toggleSuggestion = useHistoryStore(state => state.toggleSuggestion);
  const setCategorySelected = useHistoryStore(state => state.setSuggestionCategorySelected);
  const rejectSuggestion = useHistoryStore(state => state.rejectSuggestion);
  const auditionSuggestion = useHistoryStore(state => state.auditionSuggestion);
  const stopAudition = useHistoryStore(state => state.stopAudition);
  const previewPending = useHistoryStore(state => state.previewPending);
  const cancelPending = useHistoryStore(state => state.cancelPending);
  const audition = useHistoryStore(state => state.audition);
  const summary = suggestionSummary(batch);
  const categories = [...new Set(batch.items.map(item => item.category).filter((value): value is string => !!value))];
  const semanticBatch = batch.origin === 'semantic' || batch.origin === 'mixed';
  const reason = (item: SuggestionBatch['items'][number]) => item.semanticReason ?? (item.reason.includes('repeated') ? c.reasonRepeat
    : item.reason.includes('vad-edge') ? c.reasonEdge
    : item.reason.includes('vad-pause') ? c.reasonPause : c.reasonStandalone);
  const category = (item: SuggestionBatch['items'][number]) => item.category === 'repeated-word' ? c.categoryRepeat
    : item.category === 'pause' ? c.categoryPause
    : item.category === 'contextual-filler' ? c.categoryContextual
    : item.category === 'self-correction' ? c.categorySelfCorrection
    : item.category === 'fragment' ? c.categoryFragment
    : item.category === 'repetition' ? c.categoryRepeat : c.categoryStandalone;
  const sources = (item: SuggestionBatch['items'][number]) => {
    const values = item.sources?.length ? item.sources : [item.source ?? 'rule'];
    return values.map(value => value === 'semantic' ? c.sourceSemantic : c.sourceRule);
  };
  const confidence = (item: SuggestionBatch['items'][number]) => item.semanticConfidence === 'high' ? c.confidenceHigh
    : item.semanticConfidence === 'medium' ? c.confidenceMedium
    : item.semanticConfidence === 'low' ? c.confidenceLow : null;
  const applyLabel = batch.kind === 'filler' ? c.applyFiller : c.applySilence;
  const cancel = onCancel ?? cancelPending;

  return (
    <section className="border-b border-aimu-border p-2 text-xs" data-testid="cut-suggestions">
      <div className="flex flex-wrap items-center gap-2">
        <strong>{semanticBatch ? c.semanticReview : c.pending} · {batch.items.length}</strong>
        <span className="text-aimu-text-muted">{c.selectedCount.replace('{selected}', String(summary.selected)).replace('{total}', String(summary.total))}</span>
        <span className="text-aimu-text-muted">{c.estimated.replace('{duration}', formatTimeWithMs(summary.durationSeconds))}</span>
        {batch.preview && <span className="rounded bg-amber-400/20 px-1.5 py-0.5 text-amber-700 dark:text-amber-300">{c.previewNotice}</span>}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <Button size="sm" variant="ghost" disabled={updating} onClick={() => batch.items.forEach(item => { if (!item.selected) toggleSuggestion(item.id); })}>{c.selectAll}</Button>
        <Button size="sm" variant="ghost" disabled={updating} onClick={() => batch.items.forEach(item => { if (item.selected) toggleSuggestion(item.id); })}>{c.selectNone}</Button>
        {categories.map(value => (
          <Button key={value} size="sm" variant="outline" disabled={updating}
            onClick={() => setCategorySelected(value, !batch.items.filter(item => item.category === value).every(item => item.selected))}>
            {value === 'repeated-word' ? c.categoryRepeat : c.categoryStandalone}
          </Button>
        ))}
        <Button size="sm" variant="secondary" disabled={updating || stale || !summary.selected} onClick={() => previewPending(!batch.preview)}>
          {batch.preview ? c.currentCuts : c.previewCuts}
        </Button>
        <Button size="sm" disabled={updating || stale || !summary.selected} onClick={onApply}>{updating ? c.applying : applyLabel}</Button>
        <Button size="sm" variant="ghost" disabled={updating} onClick={cancel}>{c.cancel}</Button>
        {audition && <Button size="sm" variant="ghost" onClick={stopAudition}>{c.stopAudition}</Button>}
      </div>
      {summary.total > 1 && <p className="mt-1 text-aimu-text-muted">{c.overlap}</p>}
      {semanticBatch && stale && <p className="mt-1 text-aimu-coral" role="alert">{c.stale}</p>}
      {error === 'stale' && <p className="mt-1 text-aimu-coral" role="alert">{c.stale}</p>}
      {error === 'apply-failed' && <p className="mt-1 text-aimu-coral" role="alert">{c.applyFailed}</p>}
      <div className="mt-2 max-h-64 space-y-1 overflow-y-auto">
        {batch.items.map(item => (
          <div key={item.id} data-testid="pending-suggestion-item" className="rounded border border-aimu-border bg-aimu-panel p-2">
            <div className="flex items-start gap-2">
              <input type="checkbox" checked={item.selected} disabled={updating} onChange={() => toggleSuggestion(item.id)}
                className="mt-0.5 h-3.5 w-3.5 rounded border-aimu-border text-aimu-purple" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium text-aimu-text-primary">{item.label ?? item.reason}</span>
                  <span className="rounded bg-aimu-purple/10 px-1.5 py-0.5 text-[10px] text-aimu-purple">{category(item)}</span>
                  {sources(item).map(source => (
                    <span key={source} data-testid="suggestion-source" className="rounded bg-aimu-input px-1.5 py-0.5 text-[10px] text-aimu-text-secondary">{source}</span>
                  ))}
                  {confidence(item) && <span className="rounded bg-aimu-input px-1.5 py-0.5 text-[10px] text-aimu-text-secondary">{confidence(item)}</span>}
                  {(item.confidence ?? 1) < 0.7 && <span className="rounded bg-amber-400/20 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">{c.review}</span>}
                </div>
                <p className="text-aimu-text-muted">{reason(item)}</p>
                <p className="font-mono text-[10px] text-aimu-text-muted">{formatTimeWithMs(item.start)} – {formatTimeWithMs(item.end)}</p>
              </div>
              <div className="flex shrink-0 flex-col gap-1">
                <Button size="sm" variant="ghost" disabled={updating || stale} onClick={() => { auditionSuggestion(item.id, 'before'); onSeek?.(Math.max(0, item.start - 2)); }}>
                  {c.beforeCut}
                </Button>
                <Button size="sm" variant="ghost" disabled={updating || stale} onClick={() => { auditionSuggestion(item.id, 'after'); onSeek?.(Math.max(0, item.start - 2)); }}>
                  {c.afterCut}
                </Button>
                {audition?.id === item.id && <span className="text-center text-[10px] text-aimu-coral">{c.auditioning}</span>}
                <Button size="sm" variant="ghost" disabled={updating} onClick={() => rejectSuggestion(item.id)}>{c.reject}</Button>
              </div>
            </div>
          </div>
        ))}
      </div>
      <p className="mt-1 text-aimu-text-muted">{c.hint}</p>
    </section>
  );
}

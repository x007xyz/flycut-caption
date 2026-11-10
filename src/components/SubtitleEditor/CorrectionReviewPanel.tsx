import { useTranslation } from '@/contexts/LocaleProvider';
import { correctionCopy, fillCorrection } from '@/locales/correction';
import { markTextDiff } from '../../../shared/text/corrections';
import type { CorrectionReview } from '@/hooks/useCorrectionReview';
import { Button } from '@/components/ui/button';
import { AlertTriangle, Check, Info, Loader2, ShieldAlert, X } from 'lucide-react';

function DiffText({ before, after }: { before: string; after: string }) {
  const diff = markTextDiff(before, after);
  return <span className="break-words text-aimu-text-secondary">{diff.prefix}
    {diff.before && <del className="rounded bg-red-500/10 px-0.5 text-red-700 dark:text-red-300">{diff.before}</del>}
    {diff.after && <ins className="rounded bg-emerald-500/10 px-0.5 text-emerald-700 no-underline dark:text-emerald-300">{diff.after}</ins>}
    {diff.suffix}</span>;
}

export function CorrectionReviewPanel({ review }: { review: CorrectionReview }) {
  const { language } = useTranslation();
  const c = correctionCopy(language);
  if (!review.open) return null;
  const done = review.batches.filter(batch => !['pending', 'generating'].includes(batch.status)).length;
  const total = review.batches.length;
  const reviewing = review.phase === 'review' || review.phase === 'partial' || review.phase === 'applying';
  const openSettings = () => window.dispatchEvent(new CustomEvent('flycut:open-ai-settings'));

  return <section data-testid="correction-review" className="border-b border-aimu-border bg-aimu-panel p-2 text-xs">
    <div className="flex flex-wrap items-center gap-2">
      <strong className="text-aimu-text-primary">{c.title}</strong>
      {review.model && <span className="rounded bg-aimu-purple/10 px-1.5 py-0.5 text-[10px] text-aimu-purple">{review.model.name}</span>}
      {review.preview && reviewing && <span className="rounded bg-amber-400/20 px-1.5 py-0.5 text-amber-700 dark:text-amber-300">{c.previewNotice}</span>}
      <span className="ml-auto" />
      {review.phase === 'applied'
        ? <Button size="sm" variant="ghost" onClick={review.closePanel}>{c.close}</Button>
        : <Button size="sm" variant="ghost" data-testid="correction-close" disabled={review.phase === 'applying'} onClick={review.closePanel}><X className="h-3.5 w-3.5" /></Button>}
    </div>

    {!review.hasModels && <div role="alert" className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 p-2">
      <p className="flex items-center gap-1 text-amber-800 dark:text-amber-200"><AlertTriangle className="h-3.5 w-3.5" />{c.noModel}</p>
      <Button size="sm" variant="outline" data-testid="correction-settings" className="mt-1" onClick={openSettings}>{c.openSettings}</Button>
    </div>}

    {review.hasModels && !review.model && <div role="alert" className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 p-2">
      <p className="text-amber-800 dark:text-amber-200">{c.noModel}</p>
      <Button size="sm" variant="outline" data-testid="correction-settings" className="mt-1" onClick={openSettings}>{c.openSettings}</Button>
    </div>}

    {(review.phase === 'idle' || review.phase === 'applied') && review.hasModels && review.model && <div className="mt-2 flex flex-wrap items-center gap-2">
      <span className="text-aimu-text-muted">{fillCorrection(c.sending, { count: review.activeCount })}</span>
      {review.activeCount > 0
        ? <Button size="sm" data-testid="correction-start" onClick={review.start}>{c.start}</Button>
        : <span className="text-aimu-text-muted">{c.noSubtitles}</span>}
    </div>}

    {review.phase === 'idle' && review.error === 'no-subtitles' && <p role="alert" className="mt-1 text-aimu-coral">{c.noSubtitles}</p>}

    {review.phase === 'running' && <div className="mt-2 space-y-1">
      <p role="status" className="flex items-center gap-1 text-aimu-text-secondary"><Loader2 className="h-3.5 w-3.5 animate-spin" />{c.generating}</p>
      <p className="text-aimu-text-muted">{fillCorrection(c.progress, { done, total })}</p>
      <Button size="sm" variant="outline" data-testid="correction-cancel" onClick={review.cancelRun}>{c.cancel}</Button>
    </div>}

    {review.phase === 'partial' && <div role="status" className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-amber-800 dark:text-amber-200">
      <p className="flex items-center gap-1"><Info className="h-3.5 w-3.5" />{c.partial}</p>
      <Button size="sm" variant="outline" data-testid="correction-review-partial" className="mt-1" onClick={review.reviewPartial}>{c.reviewPartial}</Button>
    </div>}

    {review.phase === 'applied' && <p role="status" className="mt-2 flex items-center gap-1 text-emerald-700 dark:text-emerald-300"><Check className="h-3.5 w-3.5" />{fillCorrection(c.applied, { count: review.appliedCount })}</p>}

    {reviewing && <>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant={review.preview ? 'ghost' : 'secondary'} data-testid="correction-current-toggle"
          disabled={review.phase === 'applying'} onClick={() => { if (review.preview) review.togglePreview(); }}>{c.currentSubtitles}</Button>
        <Button size="sm" variant={review.preview ? 'secondary' : 'ghost'} data-testid="correction-preview-toggle"
          disabled={review.phase === 'applying'} onClick={() => { if (!review.preview) review.togglePreview(); }}>{c.previewChanges}</Button>
        <span className="text-aimu-text-muted">{fillCorrection(c.changes, { count: review.changeCount })}</span>
        {review.excludedCount > 0 && <span className="text-aimu-text-muted">{fillCorrection(c.excluded, { count: review.excludedCount })}</span>}
      </div>

      {(review.staleNow || review.error === 'stale') && <div role="alert" data-testid="correction-stale" className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 p-2">
        <p className="font-medium text-amber-800 dark:text-amber-200">{c.stale}</p>
        <p className="text-aimu-text-muted">{c.staleHint}</p>
        <div className="mt-1 flex gap-1">
          <Button size="sm" variant="outline" onClick={review.requestCancelReview}>{c.keepCurrent}</Button>
          <Button size="sm" onClick={review.start}>{c.analyzeAgain}</Button>
        </div>
      </div>}
      {review.error === 'apply-failed' && <div role="alert" className="mt-2 rounded border border-aimu-coral/40 bg-aimu-red-bg p-2 text-aimu-coral">
        <p>{c.applyFailed}</p>
        <Button size="sm" variant="outline" data-testid="correction-retry-apply" className="mt-1" disabled={review.phase === 'applying'} onClick={() => void review.apply()}>{c.retryApply}</Button>
      </div>}

      {review.blockingBatches.length > 0 && <div className="mt-2 space-y-1">
        <p role="alert" className="flex items-center gap-1 text-aimu-coral"><ShieldAlert className="h-3.5 w-3.5" />{review.blockingBatches.some(batch => batch.status === 'invalid') ? c.invalid : c.failed}</p>
        {review.blockingBatches.map(batch => <div key={batch.id} className="rounded border border-aimu-coral/40 bg-aimu-red-bg/40 p-2">
          <p className="text-aimu-text-secondary">{batch.id} · {batch.status === 'invalid' ? c.invalid : c.failed}</p>
          {batch.error && <p className="break-words text-[10px] text-aimu-text-muted">{batch.error}</p>}
          <Button size="sm" variant="ghost" data-testid="correction-exclude" onClick={() => review.excludeBatch(batch.id)}>{c.exclude}</Button>
        </div>)}
        <Button size="sm" variant="outline" data-testid="correction-retry" onClick={review.retryFailed}>{c.retryFailed}</Button>
      </div>}

      {review.changeCount === 0 && review.phase !== 'applying' && <p className="mt-2 text-aimu-text-muted">{c.noChanges}</p>}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button size="sm" data-testid="correction-apply" disabled={!review.canApply || review.phase === 'applying'}
          onClick={() => void review.apply()}>{review.phase === 'applying' ? c.applying : fillCorrection(c.apply, { count: review.changeCount })}</Button>
        <Button size="sm" variant="ghost" data-testid="correction-cancel-changes" disabled={review.phase === 'applying'} onClick={review.requestCancelReview}>{c.cancelChanges}</Button>
      </div>

      <div className="mt-2 max-h-56 space-y-1 overflow-y-auto">
        {review.suggestions.map(item => <div key={item.id} data-testid="correction-suggestion-item"
          className="rounded border border-aimu-border bg-background p-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded bg-aimu-purple/10 px-1.5 py-0.5 text-[10px] text-aimu-purple">{item.adjusted ? c.adjusted : c.aiSuggestion}</span>
            {!item.selected && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-aimu-text-muted">{c.keepOriginalBadge}</span>}
            <span className="text-[10px] text-aimu-text-muted">{item.id} · {item.batchId}</span>
          </div>
          <p className="mt-1 text-aimu-text-primary"><DiffText before={item.before} after={item.selected ? item.after : item.before} /></p>
          <div className="mt-1 flex flex-wrap gap-1">
            {item.selected
              ? <Button size="sm" variant="ghost" data-testid="correction-keep-original" onClick={() => review.keepOriginal(item.id)}>{c.keepOriginal}</Button>
              : <Button size="sm" variant="ghost" data-testid="correction-restore-ai" onClick={() => review.restoreAi(item.id)}>{c.restoreAi}</Button>}
          </div>
        </div>)}
      </div>
    </>}

    {review.discardPrompt && <div role="alertdialog" aria-label={c.discardTitle} data-testid="correction-discard"
      className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 p-2">
      <p className="font-medium text-amber-800 dark:text-amber-200">{c.discardTitle}</p>
      <p className="text-aimu-text-muted">{c.discardHint}</p>
      <div className="mt-1 flex gap-1">
        <Button size="sm" variant="destructive" data-testid="correction-discard-confirm" onClick={review.confirmDiscard}>{c.discard}</Button>
        <Button size="sm" variant="outline" data-testid="correction-discard-cancel" onClick={review.dismissDiscard}>{c.keepEditing}</Button>
      </div>
    </div>}
  </section>;
}

// F-0025: AI keyword recommendation review panel. Candidates stay pending until one confirm.
import { useTranslation } from '@/contexts/LocaleProvider';
import { keywordCopy } from '@/locales/keywords';
import type { KeywordReview } from '@/hooks/useKeywordRecommendation';

function fill(template: string, values: Record<string, string | number>) {
  return Object.entries(values).reduce((acc, [key, value]) => acc.replaceAll('{' + key + '}', String(value)), template);
}

export function KeywordEmphasisPanel({ review }: { review: KeywordReview }) {
  const { language } = useTranslation();
  const copy = keywordCopy(language);
  if (!review.open) return null;

  return (
    <div data-testid="keyword-panel" className="mx-3 mb-2 rounded border border-aimu-border bg-aimu-panel p-3 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium text-aimu-text-primary">{copy.panelTitle}</span>
        <button type="button" data-testid="keyword-close" onClick={review.closePanel} className="text-aimu-text-muted hover:text-aimu-text-primary">{copy.close}</button>
      </div>

      {review.phase === 'idle' && review.activeCount === 0 && (
        <div data-testid="keyword-empty">
          <p className="text-aimu-text-secondary">{copy.empty}</p>
          <p className="mt-1 text-aimu-text-muted">{copy.emptyHint}</p>
        </div>
      )}

      {review.error === 'no-model' && (
        <div data-testid="keyword-no-model" role="alert" className="rounded border border-amber-500/40 bg-amber-500/10 p-2">
          <p className="font-medium text-amber-700 dark:text-amber-200">{copy.noModel}</p>
          <p className="mt-1 text-aimu-text-secondary">{copy.noModelHint}</p>
          <button type="button" data-testid="keyword-open-settings" onClick={() => window.dispatchEvent(new CustomEvent('flycut:open-ai-settings'))}
            className="mt-2 rounded bg-aimu-purple px-2 py-1 text-[11px] text-white">{copy.openSettings}</button>
        </div>
      )}

      {review.phase === 'loading' && <p data-testid="keyword-loading" className="text-aimu-text-secondary">{copy.loading}</p>}

      {review.phase === 'preflight' && review.activeCount > 0 && (
        <div data-testid="keyword-preflight" className="flex flex-col gap-2">
          <div className="rounded border border-aimu-border-light bg-aimu-input/40 p-2">
            <p className="text-aimu-text-primary">{copy.preflightTitle}</p>
            <p data-testid="keyword-model" className="mt-1 text-aimu-text-secondary">
              {copy.modelLabel}: {review.model ? review.model.name + ' / ' + review.model.model : copy.noModel}
            </p>
            <p data-testid="keyword-scope" className="mt-1 text-aimu-text-muted">
              {fill(copy.scopeLabel, { count: review.activeCount, chars: review.totalChars })}
            </p>
          </div>
          {review.error === 'request-failed' && (
            <div data-testid="keyword-error" role="alert" className="rounded border border-red-500/40 bg-red-500/10 p-2 text-red-700 dark:text-red-200">
              <p>{review.errorDetail || 'Request failed'}</p>
              <div className="mt-1 flex gap-2">
                <button type="button" data-testid="keyword-retry" onClick={review.retry} className="rounded bg-aimu-purple px-2 py-0.5 text-white">{copy.retry}</button>
                <button type="button" data-testid="keyword-back" onClick={review.dismissError} className="rounded border border-aimu-border px-2 py-0.5">{copy.back}</button>
              </div>
            </div>
          )}
          <div className="flex items-center gap-2">
            <button type="button" data-testid="keyword-start" onClick={() => { void review.start(); }} disabled={!review.model}
              className="rounded bg-aimu-purple px-2 py-1 text-[11px] text-white disabled:opacity-40">{copy.startRecommend}</button>
            <span className="text-aimu-text-muted">{review.batchCount} 批</span>
          </div>
        </div>
      )}

      {review.phase === 'running' && (
        <div data-testid="keyword-processing">
          <p className="text-aimu-text-secondary">{copy.processing}</p>
          <p data-testid="keyword-progress" className="mt-1 text-aimu-text-muted">
            {fill(copy.progressLabel, { done: review.progress.done, total: review.progress.total })}</p>
          <button type="button" data-testid="keyword-cancel" onClick={review.cancelRun} className="mt-2 rounded border border-aimu-border px-2 py-0.5">{copy.cancel}</button>
          <p className="mt-1 text-[10px] text-aimu-text-muted">{copy.cancelHint}</p>
        </div>
      )}

      {(review.phase === 'review' || review.phase === 'applying') && (
        <div data-testid="keyword-review" className="flex flex-col gap-2">
          {review.staleNow && (
            <div data-testid="keyword-stale" role="alert" className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-amber-700 dark:text-amber-200">
              <p>{copy.stale}</p>
              <button type="button" data-testid="keyword-recheck" onClick={review.acknowledgeStale} className="mt-1 rounded border border-aimu-border px-2 py-0.5">{copy.back}</button>
            </div>
          )}
          <div className="flex items-center gap-2">
            <button type="button" data-testid="keyword-select-all" onClick={review.selectAll} className="rounded border border-aimu-border px-2 py-0.5">{copy.selectAll}</button>
            <button type="button" data-testid="keyword-clear" onClick={review.clearSelection} className="rounded border border-aimu-border px-2 py-0.5">{copy.clearSelection}</button>
          </div>
          {review.candidates.length === 0 && (
            <div data-testid="keyword-no-recommendations">
              <p>{copy.noRecommendations}</p>
              <p className="mt-1 text-aimu-text-muted">{copy.noRecommendationsHint}</p>
            </div>
          )}
          <div className="max-h-56 overflow-y-auto flex flex-col gap-1">
            {review.candidates.map(candidate => (
              <div key={candidate.id} data-testid="keyword-candidate" className="rounded border border-aimu-border-light p-1">
                <p className="text-aimu-text-secondary">{candidate.text}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {candidate.keywords.map((keyword, index) => (
                    <label key={keyword.start + '-' + keyword.end} className="inline-flex items-center gap-1 rounded bg-amber-300/20 px-1.5 py-0.5">
                      <input type="checkbox" data-testid="keyword-candidate-toggle" checked={candidate.enabled[index]}
                        onChange={() => review.toggleCandidate(candidate.id, index)} />
                      {keyword.text}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {review.error === 'apply-failed' && (
            <div data-testid="keyword-error" role="alert" className="rounded border border-red-500/40 bg-red-500/10 p-2 text-red-700 dark:text-red-200">
              <p>{copy.applyFailed}</p>
              <div className="mt-1 flex gap-2">
                <button type="button" data-testid="keyword-retry" onClick={() => { void review.apply(); }} className="rounded bg-aimu-purple px-2 py-0.5 text-white">{copy.retry}</button>
                <button type="button" data-testid="keyword-back" onClick={review.dismissError} className="rounded border border-aimu-border px-2 py-0.5">{copy.back}</button>
              </div>
            </div>
          )}
          <div className="flex items-center gap-2">
            <button type="button" data-testid="keyword-apply" onClick={() => { void review.apply(); }}
              disabled={review.phase === 'applying' || review.staleNow || review.enabledCount === 0}
              className="rounded bg-aimu-purple px-2 py-1 text-[11px] text-white disabled:opacity-40">
              {fill(copy.apply, { count: review.enabledCount })}
            </button>
            <button type="button" data-testid="keyword-cancel" onClick={review.closePanel} className="rounded border border-aimu-border px-2 py-1 text-[11px]">{copy.cancel}</button>
            {review.phase === 'applying' && <span className="text-aimu-text-muted">{copy.processing}</span>}
          </div>
        </div>
      )}

      {review.phase === 'done' && (
        <div data-testid="keyword-done">
          <p className="text-aimu-text-primary">{copy.completed}</p>
          <p className="mt-1 text-aimu-text-muted">
            {fill(copy.completedDetail, { count: review.appliedCount, cues: review.candidates.length })}
          </p>
          <button type="button" data-testid="keyword-close" onClick={review.closePanel} className="mt-2 rounded border border-aimu-border px-2 py-0.5">{copy.close}</button>
        </div>
      )}
    </div>
  );
}


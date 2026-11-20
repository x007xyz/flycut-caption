import { useTranslation } from '@/contexts/LocaleProvider';
import { fillSentenceSplit, sentenceSplitCopy } from '@/locales/sentenceSplits';
import type { SentenceSplitState } from '@/hooks/useSentenceSplits';
import { Button } from '@/components/ui/button';
import { AlertTriangle, Check, Info, Loader2, X } from 'lucide-react';

const timeText = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${rest.toFixed(2).padStart(5, '0')}`;
};

export function SentenceSplitPanel({ state }: { state: SentenceSplitState }) {
  const { language } = useTranslation();
  const c = sentenceSplitCopy(language);
  if (!state.open) return null;
  const skipped = state.analysis
    ? state.analysis.skipped.noWords + state.analysis.skipped.mismatch + state.analysis.skipped.translated + state.analysis.skipped.keyworded + state.analysis.skipped.dubbed
    : 0;
  const busy = state.phase === 'applying';

  return <section data-testid="sentence-split-panel" className="border-b border-aimu-border bg-aimu-panel p-2 text-xs">
    <div className="flex flex-wrap items-center gap-2">
      <strong className="text-aimu-text-primary">{c.title}</strong>
      <label className="flex items-center gap-1 text-aimu-text-muted">
        {c.maxChars}
        <input
          data-testid="sentence-split-max"
          type="number"
          min={8}
          max={60}
          value={state.maxChars}
          disabled={busy}
          onChange={event => state.setMaxChars(Number(event.target.value))}
          className="w-16 rounded border border-aimu-border bg-aimu-input px-1.5 py-0.5 text-aimu-text-primary"
        />
      </label>
      <span className="ml-auto" />
      <Button size="sm" variant="ghost" data-testid="sentence-split-close" disabled={busy} onClick={state.closePanel}>
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>

    {state.phase === 'ready' && <>
      {state.suggestions.length > 0 && <p role="status" className="mt-2 text-aimu-text-secondary">
        {fillSentenceSplit(c.suggestions, { count: state.suggestions.length })}
        <span className="ml-2 text-aimu-text-muted">{fillSentenceSplit(c.affected, { count: state.suggestions.length })}</span>
      </p>}

      {state.suggestions.length === 0 && <div className="mt-2 flex items-start gap-1 text-aimu-text-muted">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span data-testid={!state.hasSubtitles ? 'sentence-split-empty' : state.hasWordTimestamps ? 'sentence-split-none' : 'sentence-split-no-words'}>
          {!state.hasSubtitles ? c.empty : state.hasWordTimestamps ? c.noLong : c.noWords}
        </span>
      </div>}

      {skipped > 0 && <p data-testid="sentence-split-skipped" className="mt-1 text-aimu-text-muted">
        {fillSentenceSplit(c.skipped, { count: skipped })}
      </p>}
      {(state.analysis?.overLimit ?? 0) > 0 && <p data-testid="sentence-split-over-limit" className="mt-1 text-amber-700 dark:text-amber-300">
        {fillSentenceSplit(c.overLimit, { count: state.analysis!.overLimit })}
      </p>}

      {state.suggestions.length > 0 && <div className="mt-2 max-h-56 space-y-2 overflow-y-auto">
        {state.suggestions.map(suggestion => {
          const keep = state.kept.has(suggestion.chunkId);
          const texts = state.pieceTexts(suggestion);
          return <div key={suggestion.chunkId} data-testid="sentence-split-suggestion"
            className="rounded border border-aimu-border bg-background p-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="rounded bg-aimu-purple/10 px-1.5 py-0.5 text-[10px] text-aimu-purple">
                {suggestion.reason === 'length' ? c.reasonLength : c.reasonPunctuation}
              </span>
              <span className="text-[10px] text-aimu-text-muted">{suggestion.chunkId}</span>
              {keep && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-aimu-text-muted">{c.keepOriginalBadge}</span>}
              <label className="ml-auto flex items-center gap-1 text-aimu-text-muted">
                <input type="checkbox" data-testid="sentence-split-keep" checked={keep} disabled={busy}
                  onChange={() => state.toggleKeepOriginal(suggestion.chunkId)} />
                {c.keepOriginal}
              </label>
            </div>
            <p className="mt-1 text-aimu-text-muted">{c.before}：{suggestion.before}</p>
            <div className="mt-1 space-y-1">
              {suggestion.pieces.map((piece, index) => <div key={`${suggestion.chunkId}-${index}`} className="flex items-center gap-1.5">
                <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-aimu-text-muted">
                  {timeText(piece.timestamp[0])}–{timeText(piece.timestamp[1])}
                </span>
                <input
                  data-testid="sentence-split-piece"
                  value={texts[index] ?? ''}
                  disabled={busy || keep}
                  onChange={event => state.updatePiece(suggestion.chunkId, index, event.target.value)}
                  className="min-w-0 flex-1 rounded border border-aimu-border bg-aimu-input px-1.5 py-0.5 text-aimu-text-primary"
                />
              </div>)}
            </div>
            {!keep && state.invalidIds.has(suggestion.chunkId) && <p role="alert" className="mt-1 text-aimu-coral">{c.pieceEmpty}</p>}
          </div>;
        })}
      </div>}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button size="sm" data-testid="sentence-split-apply" disabled={!state.canApply} onClick={() => void state.apply()}>
          {fillSentenceSplit(c.apply, { count: state.applyCount })}
        </Button>
        <Button size="sm" variant="ghost" data-testid="sentence-split-cancel" disabled={busy} onClick={state.closePanel}>{c.cancel}</Button>
      </div>
    </>}

    {state.phase === 'applying' && <p role="status" data-testid="sentence-split-applying" className="mt-2 flex items-center gap-1 text-aimu-text-secondary">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />{c.applying}
    </p>}

    {state.phase === 'completed' && <div className="mt-2 flex items-center gap-2">
      <p role="status" data-testid="sentence-split-completed" className="flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
        <Check className="h-3.5 w-3.5" />{fillSentenceSplit(c.applied, { count: state.appliedCount })}
      </p>
      <Button size="sm" variant="ghost" data-testid="sentence-split-close" onClick={state.closePanel}>{c.close}</Button>
    </div>}

    {state.phase === 'stale' && <div role="alert" data-testid="sentence-split-stale" className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 p-2">
      <p className="flex items-center gap-1 font-medium text-amber-800 dark:text-amber-200">
        <AlertTriangle className="h-3.5 w-3.5" />{c.stale}
      </p>
      <p className="text-aimu-text-muted">{c.staleHint}</p>
      <div className="mt-1 flex gap-1">
        <Button size="sm" variant="outline" data-testid="sentence-split-analyze-again" onClick={state.analyze}>{c.analyzeAgain}</Button>
        <Button size="sm" variant="ghost" onClick={state.closePanel}>{c.cancel}</Button>
      </div>
    </div>}

    {state.phase === 'error' && <div role="alert" data-testid="sentence-split-error" className="mt-2 rounded border border-aimu-coral/40 bg-aimu-red-bg p-2 text-aimu-coral">
      <p>{state.error ?? c.failed}</p>
      <div className="mt-1 flex gap-1">
        <Button size="sm" variant="outline" data-testid="sentence-split-retry" onClick={() => void state.apply()}>{c.retry}</Button>
        <Button size="sm" variant="ghost" data-testid="sentence-split-back" onClick={state.closePanel}>{c.back}</Button>
      </div>
    </div>}
  </section>;
}

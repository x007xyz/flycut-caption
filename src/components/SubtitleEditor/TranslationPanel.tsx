import { COMMON_LANGUAGES } from '@/constants/languages';
import { useTranslation } from '@/contexts/LocaleProvider';
import type { BatchTranslationController, TranslationScope } from '@/hooks/useBatchTranslation';
import { fillTranslation, translationCopy } from '@/locales/translation';
import { useClientRuntime } from '@/runtime/context';
import type { ProjectService } from '@/services/projectService';
import { useAppStore } from '@/stores/appStore';
import { AlertTriangle, Check, Info, Languages, Loader2, RotateCcw, ShieldAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function TranslationPanel({ translation }: { translation: BatchTranslationController }) {
  const runtime = useClientRuntime();
  const projects = (runtime as typeof runtime & { projects?: ProjectService }).projects;
  const { language } = useTranslation();
  const copy = translationCopy(language);
  const aiModels = useAppStore((s) => s.aiModels);
  const selectedAIModelId = useAppStore((s) => s.selectedAIModelId);
  const setSelectedAIModelId = useAppStore((s) => s.setSelectedAIModelId);

  if (!translation.open) return null;

  const doneCount = translation.batches.filter((b) => b.status === 'done' || b.status === 'excluded').length;
  const totalCount = translation.batches.length;
  const progressPct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;
  const isRunning = translation.phase === 'running';
  const isApplying = translation.phase === 'applying';
  const isReviewing = translation.phase === 'review' || translation.phase === 'partial' || isApplying;
  const openSettings = () => window.dispatchEvent(new CustomEvent('flycut:open-ai-settings'));

  return (
    <section
      data-testid="translation-panel"
      aria-label={copy.title}
      className="border-b border-aimu-border bg-aimu-panel p-2.5 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <strong className="flex items-center gap-1 text-aimu-text-primary">
          <Languages className="h-3.5 w-3.5 text-aimu-coral" />
          {copy.title}
        </strong>
        {translation.model && (
          <span className="rounded bg-aimu-purple/10 px-1.5 py-0.5 text-[10px] text-aimu-purple">
            {translation.model.name}
          </span>
        )}
        <span className="ml-auto" />
        <Button
          size="sm"
          variant="ghost"
          data-testid="translation-close"
          disabled={isApplying}
          onClick={translation.closePanel}
          aria-label={copy.close}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Missing AI model */}
      {(!translation.hasModels || !translation.model) && (
        <div role="alert" data-testid="translation-no-model" className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 p-2">
          <p className="flex items-center gap-1 text-amber-800 dark:text-amber-200">
            <AlertTriangle className="h-3.5 w-3.5" />
            {copy.noModel}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {translation.hasModels && (
              <select
                aria-label={copy.selectModel}
                value={selectedAIModelId ?? ''}
                onChange={(e) => setSelectedAIModelId(e.target.value || null)}
                className="h-7 rounded border border-aimu-border bg-aimu-input px-2 text-xs text-aimu-text-primary"
              >
                <option value="">{copy.selectModel}</option>
                {aiModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            )}
            <Button size="sm" variant="outline" data-testid="translation-settings" onClick={openSettings}>
              {copy.openSettings}
            </Button>
          </div>
        </div>
      )}

      {/* Configuration controls */}
      {translation.phase !== 'applied' && (
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-aimu-text-muted">{copy.sourceLang}</span>
            <select
              data-testid="translation-source-lang"
              disabled={isRunning || isApplying}
              value={translation.sourceLang}
              onChange={(e) => translation.setSourceLang(e.target.value)}
              className="h-7 rounded border border-aimu-border bg-aimu-input px-2 text-xs text-aimu-text-primary"
            >
              <option value="auto">{copy.autoLang}</option>
              {COMMON_LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>{lang.name}</option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-aimu-text-muted">{copy.targetLang}</span>
            <select
              data-testid="translation-target-lang"
              disabled={isRunning || isApplying}
              value={translation.targetLang}
              onChange={(e) => translation.setTargetLang(e.target.value)}
              className="h-7 rounded border border-aimu-border bg-aimu-input px-2 text-xs text-aimu-text-primary"
            >
              <option value="">{copy.chooseTarget}</option>
              {COMMON_LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>{lang.name}</option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-aimu-text-muted">{copy.scope}</span>
            <select
              data-testid="translation-scope"
              disabled={isRunning || isApplying}
              value={translation.scope}
              onChange={(e) => translation.setScope(e.target.value as TranslationScope)}
              className="h-7 rounded border border-aimu-border bg-aimu-input px-2 text-xs text-aimu-text-primary"
            >
              <option value="all">{copy.scopeAll}</option>
              <option value="untranslated">{copy.scopeUntranslated}</option>
              <option value="outdated">{copy.scopeOutdated}</option>
              <option value="selected">{copy.scopeSelected}</option>
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-aimu-text-muted">{copy.maxCharsPerLine}</span>
            <input
              type="number"
              min={5}
              max={200}
              data-testid="translation-max-chars"
              value={translation.limits.maxCharsPerLine}
              onChange={(e) => translation.setLimits({ maxCharsPerLine: Number(e.target.value) || 42 })}
              className="h-7 rounded border border-aimu-border bg-aimu-input px-2 text-xs text-aimu-text-primary"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-aimu-text-muted">{copy.maxCps}</span>
            <input
              type="number"
              min={1}
              max={100}
              data-testid="translation-max-cps"
              value={translation.limits.maxCps}
              onChange={(e) => translation.setLimits({ maxCps: Number(e.target.value) || 20 })}
              className="h-7 rounded border border-aimu-border bg-aimu-input px-2 text-xs text-aimu-text-primary"
            />
          </label>
        </div>
      )}

      {/* Outdated selective checklist (AC-4) */}
      {translation.phase === 'idle' && translation.scope === 'outdated' && (
        <div data-testid="translation-outdated-list" className="mt-2 rounded border border-aimu-border bg-background p-2">
          {translation.outdatedCues.length === 0 ? (
            <p className="text-aimu-text-muted">{copy.empty}</p>
          ) : (
            <>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[11px] font-medium text-aimu-text-secondary">{copy.outdatedSelectHint}</span>
                <div className="flex gap-2">
                  <button type="button" className="underline" onClick={translation.selectAllOutdated}>{copy.selectAll}</button>
                  <button type="button" className="underline" onClick={translation.clearOutdatedSelection}>{copy.clearSelection}</button>
                </div>
              </div>
              <div className="max-h-32 space-y-1 overflow-y-auto">
                {translation.outdatedCues.map((item) => (
                  <label key={item.id} className="flex items-start gap-2 rounded p-1 hover:bg-aimu-hover">
                    <input
                      type="checkbox"
                      data-testid={`translation-outdated-item-${item.id}`}
                      checked={translation.selectedOutdatedIds.has(item.id)}
                      onChange={() => translation.toggleOutdatedId(item.id)}
                      className="mt-0.5"
                    />
                    <span className="flex-1 text-[11px]">
                      <span className="font-medium text-aimu-text-primary">{item.sourceText}</span>
                      <span className="block text-aimu-text-muted">({item.oldSourceText} → {item.currentTranslation})</span>
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Idle preflight summary & Start */}
      {translation.phase === 'idle' && translation.model && (
        <div className="mt-2 space-y-1.5">
          {!translation.targetLang ? (
            <p role="alert" className="text-amber-700 dark:text-amber-300">{copy.chooseTarget}</p>
          ) : translation.plannedCueCount === 0 ? (
            <p data-testid="translation-empty-scope" className="text-aimu-text-muted">
              {copy.empty} · {copy.noSubtitles}
            </p>
          ) : (
            <>
              <p className="text-aimu-text-secondary">
                {fillTranslation(copy.sending, {
                  count: translation.plannedCueCount,
                  sentences: translation.plannedSentenceCount,
                  batches: translation.plannedBatches.length,
                  model: translation.model.name,
                })}
              </p>
              <p className="text-[11px] text-aimu-text-muted">
                {fillTranslation(copy.externalNotice, { model: translation.model.name })}
              </p>
            </>
          )}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              data-testid="translation-start"
              disabled={!translation.targetLang || translation.plannedCueCount === 0}
              onClick={translation.start}
            >
              {copy.start}
            </Button>
          </div>
        </div>
      )}

      {/* Running state */}
      {isRunning && (
        <div data-testid="translation-progress" className="mt-2 space-y-1.5">
          <p role="status" className="flex items-center gap-1.5 text-aimu-text-secondary">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span>{copy.processing}</span>
            <span className="text-aimu-text-muted">({fillTranslation(copy.progress, { done: doneCount, total: totalCount })})</span>
          </p>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-aimu-input">
            <div className="h-1.5 rounded-full bg-aimu-purple transition-all" style={{ width: `${progressPct}%` }} />
          </div>
          <Button size="sm" variant="outline" data-testid="translation-cancel" onClick={translation.cancelRun}>
            {copy.cancel}
          </Button>
        </div>
      )}

      {/* Partial cancel notice */}
      {translation.phase === 'partial' && (
        <div role="status" data-testid="translation-partial" className="mt-2 flex items-center gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-amber-800 dark:text-amber-200">
          <Info className="h-3.5 w-3.5 shrink-0" />
          <span>{copy.cancelled} · {copy.partial}</span>
        </div>
      )}

      {/* Batch status & per-batch retry / invalid errors */}
      {isReviewing && translation.batches.some((b) => b.status !== 'done') && (
        <div className="mt-2 space-y-1.5">
          {translation.batches
            .filter((b) => b.status !== 'done' && b.status !== 'excluded')
            .map((batch) => (
              <div
                key={batch.id}
                role={batch.status === 'invalid' || batch.status === 'failed' ? 'alert' : 'status'}
                data-testid={`translation-batch-${batch.id}`}
                className="rounded border border-aimu-coral/40 bg-aimu-red-bg/40 p-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-aimu-text-primary">
                    {fillTranslation(copy.batchLabel, { index: batch.index + 1, count: batch.items.length })}
                    {' · '}
                    {batch.status === 'invalid' ? copy.invalid : batch.status === 'cancelled' ? copy.cancelled : copy.failed}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid={`translation-batch-retry-${batch.id}`}
                      disabled={isApplying || translation.staleNow}
                      onClick={() => translation.retryBatch(batch.id)}
                    >
                      <RotateCcw className="mr-1 h-3 w-3" />
                      {copy.retry}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid={`translation-batch-exclude-${batch.id}`}
                      disabled={isApplying}
                      onClick={() => translation.excludeBatch(batch.id)}
                    >
                      {copy.exclude}
                    </Button>
                  </div>
                </div>
                {batch.error && (
                  <p className="mt-1 break-words text-[11px] text-aimu-coral">{batch.error}</p>
                )}
              </div>
            ))}
          {translation.blockingBatches.length > 1 && (
            <Button
              size="sm"
              variant="outline"
              data-testid="translation-retry-failed"
              disabled={isApplying || translation.staleNow}
              onClick={translation.retryFailedBatches}
            >
              {copy.retryFailed}
            </Button>
          )}
        </div>
      )}

      {/* Stale source / track version alert (AC-3, AC-8) */}
      {(translation.staleNow || translation.applyError?.kind === 'stale' || translation.applyError?.kind === 'conflict') && (
        <div role="alert" data-testid="translation-stale" className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 p-2">
          <p className="flex items-center gap-1 font-medium text-amber-800 dark:text-amber-200">
            <ShieldAlert className="h-3.5 w-3.5" />
            {copy.stale}
          </p>
          <p className="mt-0.5 text-aimu-text-muted">{copy.staleHint}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {translation.applyError?.kind === 'conflict' && projects ? (
              <Button size="sm" variant="outline" onClick={() => projects.openConflict()}>
                {copy.reviewAgain}
              </Button>
            ) : (
              <Button size="sm" variant="outline" data-testid="translation-review-again" onClick={translation.confirmStaleReview}>
                {copy.reviewAgain}
              </Button>
            )}
            <Button size="sm" onClick={translation.retranslateChanged}>
              {copy.retranslateChanged}
            </Button>
          </div>
        </div>
      )}

      {/* Persistence failure (AC-8) */}
      {translation.applyError?.kind === 'failed' && (
        <div role="alert" data-testid="translation-apply-error" className="mt-2 rounded border border-aimu-coral/40 bg-aimu-red-bg p-2 text-aimu-coral">
          <p className="font-medium">
            {copy.applyFailed}
            {translation.applyError.message ? `: ${translation.applyError.message}` : ''}
          </p>
          <div className="mt-1.5 flex gap-1.5">
            <Button size="sm" variant="outline" data-testid="translation-retry-apply" onClick={() => void translation.apply()}>
              {copy.retry}
            </Button>
            <Button size="sm" variant="ghost" data-testid="translation-back" onClick={translation.closePanel}>
              {copy.back}
            </Button>
          </div>
        </div>
      )}

      {/* Editable review list + line/speed warnings */}
      {isReviewing && translation.drafts.length > 0 && (
        <>
          <div className="mt-2 max-h-60 space-y-1.5 overflow-y-auto pr-1">
            {translation.drafts.map((item) => (
              <div
                key={item.id}
                data-testid={`translation-draft-item-${item.id}`}
                className="rounded border border-aimu-border bg-background p-2"
              >
                <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                  <span className="text-aimu-text-muted">{item.id} · {item.batchId}</span>
                  {item.manuallyEdited && (
                    <span className="rounded bg-aimu-purple/10 px-1.5 py-0.5 text-aimu-purple" data-testid={`translation-edited-${item.id}`}>
                      {copy.manuallyEdited}
                    </span>
                  )}
                  {item.constraints.tooLong && (
                    <span
                      role="status"
                      data-testid="translation-too-long"
                      className="rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-800 dark:text-amber-300"
                    >
                      {copy.tooLong} · {fillTranslation(copy.tooLongDetail, {
                        line: item.constraints.maxLineChars,
                        maxLine: translation.limits.maxCharsPerLine,
                        cps: item.constraints.cps.toFixed(1),
                        maxCps: translation.limits.maxCps,
                      })}
                    </span>
                  )}
                  {item.manuallyEdited && (
                    <button
                      type="button"
                      className="ml-auto text-aimu-text-muted underline hover:text-aimu-text-primary"
                      onClick={() => translation.restoreDraftAi(item.id)}
                    >
                      {copy.restoreAi}
                    </button>
                  )}
                </div>
                <p className="mt-1 text-[11px] text-aimu-text-muted">{item.sourceText}</p>
                <textarea
                  rows={2}
                  data-testid={`translation-draft-input-${item.id}`}
                  disabled={isApplying}
                  value={item.translatedText}
                  onChange={(e) => translation.updateDraftText(item.id, e.target.value)}
                  className="mt-1 w-full rounded border border-aimu-border bg-aimu-input px-2 py-1 text-xs text-aimu-text-primary focus:outline-none focus:ring-1 focus:ring-aimu-purple"
                />
              </div>
            ))}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              data-testid="translation-apply"
              disabled={!translation.canApply || isApplying}
              onClick={() => void translation.apply()}
            >
              {isApplying && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              {isApplying
                ? copy.processing
                : fillTranslation(
                    translation.phase === 'partial' ? copy.applyCompleted : copy.apply,
                    { count: translation.drafts.length },
                  )}
            </Button>
            {isApplying && (
              <span className="text-[11px] text-aimu-text-muted">{copy.savingHostNotice}</span>
            )}
          </div>
        </>
      )}

      {/* Completed state (AC-7) */}
      {translation.phase === 'applied' && (
        <div role="status" data-testid="translation-completed" className="mt-2 flex flex-wrap items-center gap-2 rounded border border-emerald-500/40 bg-emerald-500/10 p-2 text-emerald-700 dark:text-emerald-300">
          <Check className="h-3.5 w-3.5" />
          <span className="font-medium">{copy.completed}</span>
          <span>{fillTranslation(copy.appliedSummary, { count: translation.appliedCount, track: translation.appliedTrackName })}</span>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={translation.closePanel}>
            {copy.close}
          </Button>
        </div>
      )}
    </section>
  );
}


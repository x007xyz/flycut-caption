import { useEffect, useRef } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Loader2, Play, RotateCcw, ShieldAlert, Square, Volume2, X, XCircle } from 'lucide-react';
import { ModelOptionsForm } from '@/components/ASR/ModelOptionsForm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/contexts/LocaleProvider';
import { useProjectStore } from '@/stores/projectStore';
import type { CueDubbingController } from '@/hooks/useCueDubbing';
import { dubbingCopy, fillDubbingCopy } from '@/locales/dubbing';
import { modelKey } from '@/stores/appStore';

export function SingleCueDubbingPanel({
  dubbing,
  onOpenSettings,
}: {
  dubbing: CueDubbingController;
  onOpenSettings?: () => void;
}) {
  const { language } = useTranslation();
  const copy = dubbingCopy(language);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const artifactKey = dubbing.currentArtifact ? `${dubbing.currentArtifact.trackId}:${dubbing.currentArtifact.chunkId}` : null;
    if (artifactKey && dubbing.playingCueKey === artifactKey) {
      // External quick-play is handled cleanly without overlapping the embedded element
      if (!el.paused) el.pause();
    }
  }, [dubbing.currentArtifact, dubbing.playingCueKey]);

  const voiceProfiles = useProjectStore(state => state.current?.voiceProfiles) ?? [];
  if (!dubbing.open) return null;

  const activeModel = dubbing.activeEntry?.model;
  const activeProvider = dubbing.activeEntry?.provider;
  const voices = activeModel?.tts?.voices ?? [];
  const languages = activeModel?.languages?.length ? activeModel.languages : ['auto'];
  const artifactKey = dubbing.currentArtifact ? `${dubbing.currentArtifact.trackId}:${dubbing.currentArtifact.chunkId}` : null;
  const isPlaying = Boolean(artifactKey && dubbing.playingCueKey === artifactKey);
  const openModels = () => {
    if (onOpenSettings) onOpenSettings();
    else window.dispatchEvent(new CustomEvent('flycut:open-ai-settings'));
  };

  const outdatedReasons = (dubbing.currentStatus?.reasons ?? []).map(reason => {
    if (reason === 'textChanged') return copy.outdatedTextChanged;
    if (reason === 'modelChanged') return copy.outdatedModelChanged;
    return copy.outdatedVoiceChanged;
  });

  return (
    <section
      data-testid="cue-dubbing-panel"
      aria-label={copy.title}
      className="border-b border-aimu-border bg-aimu-panel p-2.5 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <strong className="flex items-center gap-1 text-aimu-text-primary">
          <Volume2 className="h-3.5 w-3.5 text-aimu-purple" />
          {copy.title}
        </strong>
        {dubbing.selectedChunk && dubbing.selectedChunkIndex >= 0 && (
          <span className="rounded bg-aimu-input px-1.5 py-0.5 font-mono text-[10px] text-aimu-text-secondary">
            #{dubbing.selectedChunkIndex + 1} · {dubbing.cueDurationSeconds.toFixed(2)}s
          </span>
        )}
        {dubbing.activeTrackName && (
          <span className="rounded bg-aimu-purple/10 px-1.5 py-0.5 text-[10px] text-aimu-purple">
            {dubbing.activeTrackName}
          </span>
        )}
        <span className="ml-auto" />
        <Button
          size="sm"
          variant="ghost"
          data-testid="cue-dubbing-close"
          onClick={dubbing.closePanel}
          aria-label={copy.close}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {dubbing.loading && (
        <div
          role="status"
          data-testid="cue-dub-loading"
          className="mt-2 flex items-center gap-2 rounded border border-aimu-border bg-aimu-input/40 px-2.5 py-2 text-aimu-text-secondary"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>{copy.loading}</span>
        </div>
      )}

      {!dubbing.loading && dubbing.ttsGroups.length === 0 && (
        <div data-testid="cue-dubbing-empty-models" className="mt-2 space-y-2 rounded border border-dashed border-aimu-border p-2.5">
          <p className="font-medium text-aimu-text-primary">{copy.empty}</p>
          <p className="text-aimu-text-muted">{copy.noTtsModelHint}</p>
          <Button size="sm" variant="outline" data-testid="cue-dubbing-configure-models" onClick={openModels}>
            {copy.configureModels}
          </Button>
        </div>
      )}

      {!dubbing.loading && dubbing.ttsGroups.length > 0 && (
        <div className="mt-2 space-y-2">
          {/* Model, voice, language, speed selection */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-aimu-text-muted">{copy.selectModelLabel}</span>
              <select
                data-testid="cue-dub-model-select"
                disabled={dubbing.processing}
                value={dubbing.selectedModel ? modelKey(dubbing.selectedModel) : ''}
                onChange={e => dubbing.selectModel(e.target.value)}
                className="h-7 rounded border border-aimu-border bg-aimu-input px-2 text-xs text-aimu-text-primary"
              >
                <option value="">{copy.selectModelPlaceholder}</option>
                {dubbing.ttsGroups.map(group => (
                  <optgroup key={group.provider.id} label={group.provider.name}>
                    {group.models.map(model => (
                      <option
                        key={`${group.provider.id}/${model.id}`}
                        value={modelKey({ providerId: group.provider.id, modelId: model.id })}
                        disabled={model.status === 'unavailable'}
                      >
                        {model.name} ({model.offline ? copy.previewLocalityLocal : copy.previewLocalityRemote})
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-aimu-text-muted">{copy.voiceLabel}</span>
              {voices.length > 0 ? (
                <select
                  data-testid="cue-dub-voice-select"
                  disabled={dubbing.processing || !dubbing.selectedModel}
                  value={dubbing.voiceId ?? ''}
                  onChange={e => dubbing.setVoiceId(e.target.value || null)}
                  className="h-7 rounded border border-aimu-border bg-aimu-input px-2 text-xs text-aimu-text-primary"
                >
                  {voices.map(voice => (
                    <option key={voice.id} value={voice.id}>
                      {voice.name}{voice.languages?.length ? ` (${voice.languages.join('/')})` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="flex h-7 items-center truncate rounded border border-aimu-border bg-aimu-input/40 px-2 text-[11px] text-aimu-text-muted">
                  {copy.noBuiltInVoices}
                </div>
              )}
            </label>

            {voiceProfiles.length > 0 && (
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-aimu-text-muted">项目音色 / Project voice</span>
                <select data-testid="cue-dub-voice-profile" value={dubbing.voiceProfileId ?? ''}
                  disabled={dubbing.processing}
                  onChange={event => dubbing.setVoiceProfileId(event.target.value || null)}
                  className="h-7 rounded border border-aimu-border bg-aimu-input px-2 text-xs text-aimu-text-primary">
                  <option value="">模型自带音色</option>
                  {voiceProfiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                </select>
              </label>
            )}

            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-aimu-text-muted">{copy.languageLabel}</span>
              <select
                data-testid="cue-dub-language-select"
                disabled={dubbing.processing || !dubbing.selectedModel}
                value={dubbing.ttsLanguage}
                onChange={e => dubbing.setTtsLanguage(e.target.value)}
                className="h-7 rounded border border-aimu-border bg-aimu-input px-2 text-xs text-aimu-text-primary"
              >
                {languages.map(code => (
                  <option key={code} value={code}>{code}</option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-aimu-text-muted">{copy.speedLabel}</span>
              <Input
                type="number"
                min={0.25}
                max={4}
                step={0.05}
                data-testid="cue-dub-speed-input"
                disabled={dubbing.processing || !dubbing.selectedModel || activeModel?.tts?.durationControl === false}
                value={dubbing.speed}
                onChange={e => {
                  const next = Number(e.target.value);
                  if (Number.isFinite(next)) dubbing.setSpeed(next);
                }}
                className="h-7 text-xs"
              />
            </label>
          </div>

          {!dubbing.selectedModel && (
            <p className="text-[11px] text-aimu-text-muted" data-testid="cue-dub-no-auto-paid-hint">
              {copy.noAutoPaidHint}
            </p>
          )}

          {activeModel?.options && (
            <div className="rounded border border-aimu-border bg-background/60 p-2">
              <p className="mb-1 text-[11px] font-medium text-aimu-text-muted">{copy.optionsLabel}</p>
              <ModelOptionsForm
                fields={activeModel.options}
                values={dubbing.options}
                disabled={dubbing.processing}
                onChange={dubbing.setOptions}
              />
            </div>
          )}

          {activeModel?.status === 'download' && (
            <div className="flex items-center justify-between gap-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-amber-800 dark:text-amber-200">
              <span>{copy.downloadRequired}</span>
              <Button size="sm" variant="outline" onClick={openModels}>{copy.configureModels}</Button>
            </div>
          )}
          {activeModel?.status === 'unavailable' && (
            <p className="text-aimu-coral">{copy.modelUnavailable}{activeModel.reason ? `: ${activeModel.reason}` : ''}</p>
          )}

          {/* Empty / missing cue or translation */}
          {(!dubbing.selectedChunk || !dubbing.confirmedTranslation) ? (
            <div data-testid="cue-dubbing-empty-translation" className="rounded border border-dashed border-aimu-border p-2.5">
              <p className="font-medium text-aimu-text-primary">{copy.empty}</p>
              <p className="mt-0.5 text-aimu-text-muted">
                {dubbing.cueDeleted ? copy.cueDeletedHint : !dubbing.selectedChunk ? copy.noCueSelected : copy.noTranslationHint}
              </p>
            </div>
          ) : (
            <>
              {!dubbing.hasProject && (
                <p className="text-amber-700 dark:text-amber-300">{copy.noProjectHint}</p>
              )}

              {/* Pre-send disclosure preview (AC-1) */}
              <div data-testid="cue-dubbing-preview" className="space-y-1 rounded border border-aimu-border bg-background/60 p-2 text-[11px]">
                <p className="font-medium text-aimu-text-primary">{copy.previewTitle}</p>
                <p className="text-aimu-text-secondary">
                  <span className="text-aimu-text-muted">{copy.previewTextLabel}: </span>
                  {dubbing.confirmedTranslation}
                </p>
                <p className="text-aimu-text-secondary">
                  <span className="text-aimu-text-muted">{copy.previewProviderLabel}: </span>
                  {activeProvider && activeModel
                    ? `${activeProvider.name} / ${activeModel.name} (${activeModel.offline ? copy.previewLocalityLocal : copy.previewLocalityRemote})`
                    : copy.previewProviderUnselected}
                </p>
                <p className="text-aimu-text-muted">
                  <span>{copy.previewSamplesLabel}: </span>
                  {copy.previewNoSample}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  data-testid="cue-dub-submit"
                  disabled={!dubbing.canSubmit}
                  onClick={() => void dubbing.generate()}
                >
                  {dubbing.processing && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                  {dubbing.currentArtifact ? copy.redoButton : copy.generateButton}
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Processing banner (AC-6) */}
      {dubbing.processing && (
        <div
          role="status"
          data-testid="cue-dub-processing"
          className="mt-2 flex items-center justify-between gap-2 rounded border border-aimu-border bg-aimu-input/40 p-2"
        >
          <div className="min-w-0 space-y-0.5">
            <div className="flex items-center gap-1.5 font-medium text-aimu-text-primary">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>{copy.processing}</span>
              {dubbing.progressText && <span className="text-aimu-text-muted">({dubbing.progressText})</span>}
            </div>
            <p className="text-[11px] text-aimu-text-muted">{copy.cancelHint}</p>
          </div>
          <Button size="sm" variant="outline" data-testid="cue-dub-cancel" onClick={dubbing.cancel}>
            <XCircle className="mr-1 h-3 w-3" />
            {copy.cancel}
          </Button>
        </div>
      )}

      {/* Conflict banner (AC-8) */}
      {dubbing.conflictState && (
        <div role="alert" data-testid="cue-dub-conflict" className="mt-2 space-y-1.5 rounded border border-amber-500/40 bg-amber-500/10 p-2">
          <p className="flex items-center gap-1 font-medium text-amber-800 dark:text-amber-200">
            <ShieldAlert className="h-3.5 w-3.5" />
            {copy.conflict}
          </p>
          <p className="text-[11px] text-aimu-text-muted">{copy.conflictHint}</p>
          <Button size="sm" variant="outline" data-testid="cue-dub-review-latest" onClick={() => void dubbing.reviewLatest()}>
            {copy.reviewLatest}
          </Button>
        </div>
      )}

      {/* Error banner (AC-8) */}
      {dubbing.errorState && (
        <div role="alert" data-testid="cue-dub-error" className="mt-2 space-y-1.5 rounded border border-aimu-coral/40 bg-aimu-red-bg/50 p-2">
          <p className="flex items-center gap-1 font-medium text-aimu-coral">
            <AlertCircle className="h-3.5 w-3.5" />
            {dubbing.errorState.message}
          </p>
          {dubbing.errorState.uncertain && (
            <p className="text-[11px] text-aimu-text-muted">{copy.uncertainHint}</p>
          )}
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="outline" data-testid="cue-dub-retry" onClick={() => void dubbing.retry()}>
              {copy.retry}
            </Button>
            <Button size="sm" variant="ghost" data-testid="cue-dub-back" onClick={dubbing.clearError}>
              {copy.back}
            </Button>
          </div>
        </div>
      )}

      {/* Persisted artifact / Completed result card (AC-2, AC-3, AC-7) */}
      {dubbing.currentArtifact && dubbing.currentStatus && (
        <div
          data-testid="cue-dub-result"
          className="mt-2 space-y-1.5 rounded border border-emerald-500/40 bg-emerald-500/10 p-2"
        >
          <div className="flex flex-wrap items-center gap-2">
            {dubbing.justCompleted && (
              <span data-testid="cue-dub-completed" className="inline-flex items-center gap-1 font-medium text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {copy.completed}
              </span>
            )}
            <span data-testid="cue-dub-duration" className="font-mono text-[11px] text-aimu-text-primary">
              {dubbing.currentArtifact.durationSeconds.toFixed(2)}s / {dubbing.cueDurationSeconds.toFixed(2)}s
            </span>
            <span className="text-[11px] text-aimu-text-muted">
              {dubbing.currentArtifact.model.providerId}/{dubbing.currentArtifact.model.modelId}
              {dubbing.currentArtifact.voiceId ? ` · ${dubbing.currentArtifact.voiceId}` : ''}
            </span>
            <span className="ml-auto" />
            <Button
              size="sm"
              variant="outline"
              data-testid={isPlaying ? 'cue-dub-stop' : 'cue-dub-play'}
              onClick={() => void dubbing.togglePlayArtifact(dubbing.currentArtifact!)}
            >
              {isPlaying ? <Square className="mr-1 h-3 w-3" /> : <Play className="mr-1 h-3 w-3" />}
              {isPlaying ? copy.stop : copy.play}
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="cue-dub-redo"
              disabled={!dubbing.canSubmit}
              onClick={() => void dubbing.generate()}
            >
              <RotateCcw className="mr-1 h-3 w-3" />
              {copy.redoButton}
            </Button>
          </div>

          {dubbing.currentStatus.tooLong && (
            <div
              role="status"
              data-testid="cue-dub-too-long"
              className="flex items-start gap-1 rounded border border-amber-500/40 bg-amber-500/15 px-2 py-1 text-[11px] text-amber-800 dark:text-amber-200"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                <strong>{copy.tooLong}</strong> ·{' '}
                {fillDubbingCopy(copy.tooLongHint, { exceeds: dubbing.currentStatus.exceedsSeconds.toFixed(2) })}
              </span>
            </div>
          )}

          {dubbing.currentStatus.outdated && (
            <div
              role="status"
              data-testid="cue-dub-outdated"
              className="flex items-start gap-1 rounded border border-amber-500/40 bg-amber-500/15 px-2 py-1 text-[11px] text-amber-800 dark:text-amber-200"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                <strong>{copy.outdated}</strong> ·{' '}
                {fillDubbingCopy(copy.outdatedHint, { reasons: outdatedReasons.join(' / ') })}
              </span>
            </div>
          )}

          {dubbing.panelAudioUrl && (
            <audio
              ref={audioRef}
              controls
              src={dubbing.panelAudioUrl}
              data-testid="cue-dub-audio"
              className="h-7 w-full"
            />
          )}

          <p className="text-[11px] text-aimu-text-muted">{copy.originalAudioKept}</p>
        </div>
      )}
    </section>
  );
}

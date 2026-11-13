import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Eye, EyeOff, FolderSearch, Loader2, RefreshCw, RotateCcw, ShieldAlert, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTranslation } from '@/contexts/LocaleProvider';
import { fillPlatformText, platformPresetCopy } from '@/locales/platformPresets';
import { cn } from '@/lib/utils';
import { useClientRuntime } from '@/runtime/context';
import type { ProjectService } from '@/services/projectService';
import { useAppStore } from '@/stores/appStore';
import { useChunks } from '@/stores/historyStore';
import { useProjectStore } from '@/stores/projectStore';
import {
  PLATFORM_PRESETS,
  alignSubtitleAboveSafeZone,
  applyPlatformPreset,
  getFontLanguageCoverage,
  getSubtitleFontState,
  hasUncoveredCjkSubtitles,
  matchActivePlatformPreset,
  resetSafeZoneInsets,
  resolveEffectiveSafeZone,
  selectSafeZonePlatform,
  subscribeSubtitleFontState,
  toggleSafeZoneGuide,
  updateSafeZoneInsets,
  type PlatformAspectPreset,
  type PlatformPresetDefinition,
  type PlatformPresetId,
  type SafeZoneInsets,
  type SubtitleStyle,
} from '@/subtitle';

type AspectFilter = 'all' | PlatformAspectPreset;

interface PlatformPresetsSectionProps {
  primaryStyle: SubtitleStyle;
  onPrimaryStyleChange: (next: SubtitleStyle) => void;
  isPrimaryTab: boolean;
}

function PresetThumbnail({
  preset,
  sampleText,
}: {
  preset: PlatformPresetDefinition;
  sampleText: string;
}) {
  const isPortrait = preset.aspectPreset === 'portrait_9_16';
  const { safeZone, stylePatch } = preset;
  return (
    <div
      data-testid={`platform-thumb-${preset.id}`}
      className="relative mx-auto overflow-hidden rounded border border-aimu-border bg-neutral-900"
      style={{
        width: isPortrait ? 38 : 64,
        height: isPortrait ? 64 : 38,
      }}
    >
      {/* Reference UI occlusion shade */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 bg-amber-400/20"
        style={{ height: `${safeZone.top * 100}%` }}
      />
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 bg-amber-400/25"
        style={{ height: `${safeZone.bottom * 100}%` }}
      />
      <div
        className="pointer-events-none absolute right-0 bg-amber-400/15"
        style={{
          top: `${safeZone.top * 100}%`,
          bottom: `${safeZone.bottom * 100}%`,
          width: `${safeZone.right * 100}%`,
        }}
      />
      {/* Dashed safe zone */}
      <div
        className="pointer-events-none absolute border border-dashed border-sky-400/80"
        style={{
          top: `${safeZone.top * 100}%`,
          bottom: `${safeZone.bottom * 100}%`,
          left: `${safeZone.left * 100}%`,
          right: `${safeZone.right * 100}%`,
        }}
      />
      {/* Miniature subtitle sample */}
      <div
        className="pointer-events-none absolute inset-x-1 flex items-center justify-center text-center leading-none"
        style={{ bottom: `${Math.max(4, stylePatch.bottomOffsetRatio * 100)}%` }}
      >
        <span
          className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[7px] font-bold whitespace-nowrap"
          style={{
            color: stylePatch.color,
            backgroundColor: stylePatch.backgroundOpacity
              ? `rgba(0,0,0,${stylePatch.backgroundOpacity})`
              : 'transparent',
            textShadow: stylePatch.borderWidth ? `0 0 2px ${stylePatch.borderColor}` : undefined,
          }}
        >
          <span>{sampleText.slice(0, 2)}</span>
          <span
            className="rounded-xs px-0.5"
            style={{
              color: stylePatch.keywordColor,
              backgroundColor: stylePatch.keywordBackgroundOpacity
                ? stylePatch.keywordBackgroundColor
                : 'transparent',
            }}
          >
            {sampleText.slice(2, 4) || sampleText.slice(0, 2)}
          </span>
        </span>
      </div>
    </div>
  );
}

export function PlatformPresetsSection({
  primaryStyle,
  onPrimaryStyleChange,
  isPrimaryTab,
}: PlatformPresetsSectionProps) {
  const { language } = useTranslation();
  const copy = platformPresetCopy(language);
  const isZh = language.startsWith('zh');
  const runtime = useClientRuntime() as { projects?: ProjectService };
  const projects = runtime.projects;

  const chunks = useChunks();
  const videoFile = useAppStore(state => state.videoFile);
  const projectCurrent = useProjectStore(state => state.current);
  const saveState = useProjectStore(state => state.save);
  const openingId = useProjectStore(state => state.openingId);
  const switchingVideoId = useProjectStore(state => state.switchingVideoId);
  const recoveryPhase = useProjectStore(state => state.recovery.phase);

  const [fontState, setFontState] = useState(getSubtitleFontState);
  useEffect(() => subscribeSubtitleFontState(() => setFontState(getSubtitleFontState())), []);

  const [aspectFilter, setAspectFilter] = useState<AspectFilter>('all');
  const [submitting, setSubmitting] = useState(false);
  const [cancelledWait, setCancelledWait] = useState(false);
  const [completedVisible, setCompletedVisible] = useState(false);
  const [failedDismissed, setFailedDismissed] = useState(false);
  const [recheckedNote, setRecheckedNote] = useState(false);
  const [rechecking, setRechecking] = useState(false);

  const cancelledRef = useRef(false);
  const previousSaveStatusRef = useRef(saveState.status);
  const projectScope = projectCurrent ? `${projectCurrent.projectId}:${projectCurrent.videoId}` : 'standalone';

  // Reset transient UI banners when switching projects/videos (AC-6 isolation).
  useEffect(() => {
    cancelledRef.current = false;
    setSubmitting(false);
    setCancelledWait(false);
    setCompletedVisible(false);
    setFailedDismissed(false);
    setRecheckedNote(false);
    setRechecking(false);
    previousSaveStatusRef.current = saveState.status;
  }, [projectScope]);

  // Show "Completed" only when Host confirms saving -> saved in project mode.
  useEffect(() => {
    const prev = previousSaveStatusRef.current;
    previousSaveStatusRef.current = saveState.status;
    if (!projectCurrent || !projects) return;
    if (prev === 'saving' && saveState.status === 'saved' && !cancelledRef.current) {
      setCompletedVisible(true);
      setFailedDismissed(false);
    } else if (saveState.status === 'pending' || saveState.status === 'failed' || saveState.status === 'conflict') {
      setCompletedVisible(false);
      if (saveState.status === 'failed') setFailedDismissed(false);
    }
  }, [saveState.status, projectCurrent, projects]);

  const activeSubtitleTexts = useMemo(
    () => chunks.filter(c => !c.deleted && !c.isBlankSpacer && c.text.trim()).map(c => c.text),
    [chunks],
  );
  const hasVisibleSubtitle = activeSubtitleTexts.length > 0;
  const isMissingMedia = Boolean(projectCurrent && (projectCurrent.media.status === 'missing' || !videoFile));
  const isLoading = Boolean(openingId || switchingVideoId || recoveryPhase === 'checking')
    || (hasVisibleSubtitle && fontState.status === 'loading');
  const isProcessing = submitting || saveState.status === 'saving';

  const activePresetId = matchActivePlatformPreset(primaryStyle);
  const effectiveSafeZone = resolveEffectiveSafeZone(primaryStyle);
  const fontLanguages = getFontLanguageCoverage(primaryStyle.fontId);
  const uncoveredCjk = hasVisibleSubtitle && hasUncoveredCjkSubtitles(primaryStyle.fontId, activeSubtitleTexts);

  const filteredPresets = useMemo(
    () => aspectFilter === 'all' ? PLATFORM_PRESETS : PLATFORM_PRESETS.filter(p => p.aspectPreset === aspectFilter),
    [aspectFilter],
  );

  const handleSelectPreset = useCallback((id: PlatformPresetId) => {
    setCompletedVisible(false);
    setCancelledWait(false);
    setFailedDismissed(false);
    onPrimaryStyleChange(applyPlatformPreset(primaryStyle, id));
  }, [primaryStyle, onPrimaryStyleChange]);

  const handleSaveToProject = useCallback(async () => {
    if (!projects || !projectCurrent || submitting || saveState.status === 'saving' || saveState.status === 'conflict') return;
    cancelledRef.current = false;
    setCancelledWait(false);
    setCompletedVisible(false);
    setFailedDismissed(false);
    setRecheckedNote(false);
    setSubmitting(true);
    try {
      const ok = await projects.flush();
      if (!cancelledRef.current && ok) {
        setCompletedVisible(true);
      }
    } finally {
      setSubmitting(false);
    }
  }, [projects, projectCurrent, submitting, saveState.status]);

  const handleCancelSave = useCallback(() => {
    if (!projects) return;
    cancelledRef.current = true;
    if (saveState.status === 'saving' || submitting) {
      setCancelledWait(true);
      setSubmitting(false);
      return;
    }
    projects.revertUnsavedStyle();
    setCancelledWait(true);
    setCompletedVisible(false);
  }, [projects, saveState.status, submitting]);

  const handleRetrySave = useCallback(async () => {
    if (!projects || submitting) return;
    cancelledRef.current = false;
    setCancelledWait(false);
    setFailedDismissed(false);
    setSubmitting(true);
    try {
      const ok = await projects.retryStyleSave();
      if (!cancelledRef.current && ok) setCompletedVisible(true);
    } finally {
      setSubmitting(false);
    }
  }, [projects, submitting]);

  const handleRecheckConflict = useCallback(async () => {
    if (!projects || rechecking) return;
    setRechecking(true);
    try {
      const result = await projects.recheckStyleConflict();
      if (result.status === 'reviewed') {
        setRecheckedNote(true);
      }
    } finally {
      setRechecking(false);
    }
  }, [projects, rechecking]);

  const handleLocateMedia = useCallback(() => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="relink-file-input"]');
    if (input) input.click();
  }, []);

  const updateEdge = (edge: keyof SafeZoneInsets, rawPercent: number) => {
    if (!Number.isFinite(rawPercent)) return;
    const ratio = Math.min(0.45, Math.max(0, rawPercent / 100));
    onPrimaryStyleChange(updateSafeZoneInsets(primaryStyle, { [edge]: ratio }));
  };

  const activePresetDef = effectiveSafeZone.preset;
  const activePlatformLabel = isZh ? activePresetDef.nameZh : activePresetDef.nameEn;
  const verifiedLabel = activePresetDef.verification.verified ? copy.verifiedBadge : copy.unverifiedBadge;
  const referenceSummary = fillPlatformText(copy.referenceMeta, {
    platform: activePlatformLabel,
    aspect: activePresetDef.aspectLabel,
    date: activePresetDef.verification.referenceDate,
    status: verifiedLabel,
  });
  const bottomPercent = Math.round(primaryStyle.bottomOffsetRatio * 100);
  const insetBottomPercent = Math.round(effectiveSafeZone.insets.bottom * 100);

  const filterOptions: Array<{ id: AspectFilter; label: string }> = [
    { id: 'all', label: copy.filterAll },
    { id: 'portrait_9_16', label: copy.filter916 },
    { id: 'landscape', label: copy.filter169 },
    { id: 'square_1_1', label: copy.filter11 },
  ];

  return (
    <div className="space-y-2.5 rounded-md border border-aimu-border bg-aimu-panel/40 p-2.5" data-testid="platform-presets-section">
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <span className="text-xs font-medium text-aimu-text-primary">{copy.sectionTitle}</span>
        <div className="flex items-center gap-1" role="group" aria-label={copy.sectionTitle}>
          {filterOptions.map(opt => (
            <button
              key={opt.id}
              type="button"
              data-testid={`platform-filter-${opt.id}`}
              onClick={() => setAspectFilter(opt.id)}
              className={cn(
                'rounded border px-1.5 py-0.5 text-[10px] transition-colors',
                aspectFilter === opt.id
                  ? 'border-aimu-purple bg-aimu-purple text-white'
                  : 'border-aimu-border bg-aimu-input text-aimu-text-secondary hover:bg-aimu-hover',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading && (
        <div
          role="status"
          data-testid="platform-presets-loading"
          className="flex items-center gap-1.5 rounded border border-aimu-border bg-aimu-input px-2 py-1.5 text-[11px] text-aimu-text-secondary"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin text-aimu-purple" />
          <span>{copy.loading}</span>
        </div>
      )}

      {hasVisibleSubtitle && fontState.status === 'error' && (
        <div
          role="note"
          data-testid="platform-font-error"
          className="rounded border border-aimu-coral/40 bg-aimu-red-bg px-2 py-1.5 text-[11px] text-aimu-coral"
        >
          {copy.fontErrorNotice}
        </div>
      )}

      {isMissingMedia && (
        <div
          role="status"
          data-testid="platform-missing-media"
          className="flex items-center justify-between gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px]"
        >
          <div className="min-w-0">
            <div className="font-medium text-foreground">{copy.missingMediaTitle}</div>
            <div className="text-[10px] text-muted-foreground">{copy.missingMediaHint}</div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="platform-locate-media"
            onClick={handleLocateMedia}
            className="h-6 shrink-0 px-2 text-[10px]"
          >
            <FolderSearch className="mr-1 h-3 w-3" />
            {copy.locateMedia}
          </Button>
        </div>
      )}

      {!hasVisibleSubtitle && (
        <div
          role="status"
          data-testid="platform-empty-subtitles"
          className="rounded border border-aimu-border bg-aimu-input px-2 py-1.5 text-[11px] text-aimu-text-secondary"
        >
          <div className="font-medium text-aimu-text-primary">{copy.emptyTitle}</div>
          <div className="mt-0.5 text-[10px] text-aimu-text-muted">{copy.emptySubtitlesHint}</div>
        </div>
      )}

      {/* Preset grid or empty-filter state */}
      {filteredPresets.length === 0 ? (
        <div
          role="status"
          data-testid="platform-empty-filter"
          className="rounded border border-dashed border-aimu-border bg-aimu-input px-2.5 py-3 text-center text-[11px]"
        >
          <div className="font-medium text-aimu-text-primary">{copy.emptyTitle}</div>
          <div className="mt-0.5 text-[10px] text-aimu-text-muted">{copy.emptyFilterHint}</div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {filteredPresets.map(preset => {
            const selected = activePresetId === preset.id;
            const name = isZh ? preset.nameZh : preset.nameEn;
            const statusLabel = preset.verification.verified ? copy.verifiedBadge : copy.unverifiedBadge;
            return (
              <button
                key={preset.id}
                type="button"
                data-testid={`platform-preset-${preset.id}`}
                aria-pressed={selected}
                disabled={!isPrimaryTab}
                onClick={() => handleSelectPreset(preset.id)}
                title={isZh ? preset.descriptionZh : preset.descriptionEn}
                className={cn(
                  'flex flex-col items-stretch gap-1.5 rounded-md border p-2 text-left transition-colors disabled:opacity-50',
                  selected
                    ? 'border-aimu-purple bg-aimu-purple/10'
                    : 'border-aimu-border bg-aimu-input hover:bg-aimu-hover',
                )}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="truncate text-[11px] font-medium text-aimu-text-primary">{name}</span>
                  <span className="shrink-0 rounded bg-background/80 px-1 py-0.5 text-[9px] font-mono text-aimu-text-secondary">
                    {preset.aspectLabel}
                  </span>
                </div>
                <PresetThumbnail preset={preset} sampleText={copy.previewSampleText} />
                <div
                  data-testid={`platform-verified-${preset.id}`}
                  className="truncate text-[9px] text-amber-600 dark:text-amber-400"
                >
                  {statusLabel}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Font language coverage boundary (AC-1) */}
      <div className="space-y-1 text-[10px]">
        <div data-testid="platform-font-coverage" className="text-aimu-text-muted">
          {fillPlatformText(copy.fontCoverageLabel, { langs: fontLanguages.join(' / ') })}
        </div>
        {uncoveredCjk && (
          <div
            role="note"
            data-testid="platform-font-coverage-warning"
            className="flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-700 dark:text-amber-300"
          >
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>{fillPlatformText(copy.fontCoverageWarning, { langs: fontLanguages.join(' / ') })}</span>
          </div>
        )}
      </div>

      {/* Safe-zone controls (AC-2, AC-4) */}
      <div className="space-y-2 rounded border border-aimu-border bg-aimu-input/60 p-2" data-testid="safe-zone-controls">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={effectiveSafeZone.visible}
            data-testid="safe-zone-toggle"
            onClick={() => onPrimaryStyleChange(toggleSafeZoneGuide(primaryStyle, !effectiveSafeZone.visible))}
            className={cn(
              'inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] font-medium transition-colors',
              effectiveSafeZone.visible
                ? 'border-sky-500/60 bg-sky-500/15 text-sky-700 dark:text-sky-300'
                : 'border-aimu-border bg-aimu-panel text-aimu-text-secondary hover:bg-aimu-hover',
            )}
          >
            {effectiveSafeZone.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
            <span>{copy.safeZoneToggle}</span>
          </button>

          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-aimu-text-muted">{copy.safeZonePlatformLabel}</span>
            <Select
              value={effectiveSafeZone.platformId}
              onValueChange={(value) => onPrimaryStyleChange(selectSafeZonePlatform(primaryStyle, value as PlatformPresetId, true))}
            >
              <SelectTrigger data-testid="safe-zone-platform-select" aria-label={copy.safeZonePlatformLabel} className="h-6 w-28 border-aimu-border bg-aimu-panel px-2 text-[10px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PLATFORM_PRESETS.map(p => (
                  <SelectItem key={p.id} value={p.id} className="text-xs">
                    {isZh ? p.nameZh : p.nameEn}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div data-testid="safe-zone-reference-meta" className="space-y-0.5 text-[10px] text-aimu-text-muted">
          <div className="font-medium text-aimu-text-secondary">{referenceSummary}</div>
          {!activePresetDef.verification.verified && <div>{copy.unverifiedHint}</div>}
          <div>{copy.previewOnlyHint}</div>
        </div>

        <div className="grid grid-cols-4 gap-1.5">
          {([
            ['top', copy.insetTop],
            ['bottom', copy.insetBottom],
            ['left', copy.insetLeft],
            ['right', copy.insetRight],
          ] as const).map(([edge, label]) => (
            <label key={edge} className="flex flex-col gap-0.5 text-[10px] text-aimu-text-muted">
              <span>{label} (%)</span>
              <Input
                type="number"
                min={0}
                max={45}
                data-testid={`safe-zone-inset-${edge}`}
                aria-label={`${copy.safeZoneToggle} ${label}`}
                value={Math.round(effectiveSafeZone.insets[edge] * 100)}
                onChange={(e) => updateEdge(edge, Number(e.target.value))}
                className="h-6 border-aimu-border bg-aimu-panel px-1.5 text-[11px] text-aimu-text-primary"
              />
            </label>
          ))}
        </div>

        {effectiveSafeZone.bottomOccluded && (
          <div
            role="status"
            data-testid="safe-zone-occlusion-warning"
            className="flex items-start gap-1.5 rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[10px] text-rose-700 dark:text-rose-300"
          >
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{fillPlatformText(copy.occlusionWarning, { bottom: bottomPercent, inset: insetBottomPercent })}</span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="safe-zone-align-btn"
            disabled={!isPrimaryTab}
            onClick={() => onPrimaryStyleChange(alignSubtitleAboveSafeZone(primaryStyle))}
            className="h-6 px-2 text-[10px]"
          >
            {copy.alignAboveBottom}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-testid="safe-zone-reset-btn"
            onClick={() => onPrimaryStyleChange(resetSafeZoneInsets(primaryStyle, effectiveSafeZone.platformId))}
            className="h-6 px-2 text-[10px]"
          >
            <RotateCcw className="mr-1 h-3 w-3" />
            {copy.resetSafeZone}
          </Button>
        </div>
      </div>

      {/* Host lifecycle controls (AC-6, AC-7, AC-8) */}
      {projectCurrent && projects ? (
        <div className="space-y-1.5 pt-0.5" data-testid="platform-save-lifecycle">
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              data-testid="platform-save-btn"
              disabled={isProcessing || saveState.status === 'conflict' || !projectCurrent.hasTranscript}
              onClick={() => { void handleSaveToProject(); }}
              className="h-7 bg-aimu-purple px-2.5 text-[11px] text-white hover:bg-aimu-purple/90"
            >
              {isProcessing ? (
                <>
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  {copy.processing}
                </>
              ) : (
                copy.saveToProject
              )}
            </Button>

            {(isProcessing || saveState.status === 'pending') && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid="platform-save-cancel"
                onClick={handleCancelSave}
                className="h-7 px-2 text-[11px]"
              >
                {copy.cancel}
              </Button>
            )}
          </div>

          {isProcessing && (
            <div role="status" data-testid="platform-save-processing" className="text-[10px] text-aimu-text-muted">
              {copy.processing} · {copy.cancelHint}
            </div>
          )}

          {cancelledWait && (
            <div role="status" data-testid="platform-cancel-note" className="text-[10px] text-aimu-text-muted">
              {copy.cancelHint}
            </div>
          )}

          {recheckedNote && saveState.status !== 'conflict' && (
            <div role="status" data-testid="platform-rechecked-note" className="text-[10px] text-sky-700 dark:text-sky-300">
              {copy.recheckedHint}
            </div>
          )}

          {completedVisible && saveState.status === 'saved' && (
            <div
              role="status"
              data-testid="platform-save-completed"
              className="flex items-center gap-1.5 rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1.5 text-[11px] text-emerald-700 dark:text-emerald-300"
            >
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              <div>
                <span className="font-medium">{copy.completed}</span>
                <span className="ml-1.5 text-[10px]">
                  {fillPlatformText(copy.completedSummary, {
                    platform: activePresetId ? activePlatformLabel : copy.noPresetSelected,
                    aspect: activePresetDef.aspectLabel,
                    safeZone: effectiveSafeZone.visible ? copy.safeZoneOn : copy.safeZoneOff,
                  })}
                </span>
              </div>
            </div>
          )}

          {saveState.status === 'failed' && !failedDismissed && (
            <div
              role="alert"
              data-testid="platform-save-failed"
              className="space-y-1.5 rounded border border-aimu-coral/50 bg-aimu-red-bg px-2 py-1.5 text-[11px] text-aimu-coral"
            >
              <div className="flex items-start gap-1.5">
                <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{copy.saveFailedTitle}</div>
                  {saveState.error && <div className="break-words text-[10px]">{saveState.error}</div>}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid="platform-save-retry"
                  disabled={isProcessing}
                  onClick={() => { void handleRetrySave(); }}
                  className="h-6 px-2 text-[10px]"
                >
                  <RefreshCw className="mr-1 h-3 w-3" />
                  {copy.retry}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  data-testid="platform-save-back"
                  onClick={() => setFailedDismissed(true)}
                  className="h-6 px-2 text-[10px]"
                >
                  {copy.back}
                </Button>
              </div>
            </div>
          )}

          {saveState.status === 'conflict' && (
            <div
              role="alert"
              data-testid="platform-save-conflict"
              className="space-y-1.5 rounded border border-amber-500/50 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-800 dark:text-amber-200"
            >
              <div className="font-medium">{copy.conflictNotice}</div>
              <div className="text-[10px]">{copy.conflictHint}</div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid="platform-conflict-recheck"
                disabled={rechecking}
                onClick={() => { void handleRecheckConflict(); }}
                className="h-6 px-2 text-[10px]"
              >
                {rechecking ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}
                {copy.recheck}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div data-testid="platform-standalone-hint" className="text-[10px] text-aimu-text-muted">
          {copy.standaloneHint}
        </div>
      )}
    </div>
  );
}

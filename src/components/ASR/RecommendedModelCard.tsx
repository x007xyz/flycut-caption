import { useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Cpu,
  Download,
  HardDrive,
  Info,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Settings,
  Sparkles,
  WifiOff,
  X,
} from 'lucide-react';
import type { ModelRef, ProviderModels } from '../../../shared/providers';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/contexts/LocaleProvider';
import { asrModelsCopy, formatModelsText } from '@/locales/models';
import { modelKey, useAppStore } from '@/stores/appStore';
import { useRuntimeStoreApi } from '@/stores/runtimeStore';
import { useClientRuntime } from '@/runtime/context';
import { findModel, useModelDownloads } from '@/hooks/useProviderModels';
import { getModelLanguageConfig, resolveLanguageForModel } from '@/utils/modelLanguageConfig';
import {
  findRecommendedAsrModel,
  formatByteSize,
  listReadyAsrModels,
  modelStateSignature,
  shouldPreserveUserSelection,
} from '@/utils/modelRecommendation';
import { cn } from '@/lib/utils';

export interface RecommendedModelCardProps {
  groups: ProviderModels[];
  loading: boolean;
  error?: string;
  compact?: boolean;
  showTranscribeAction?: boolean;
  onRefresh?: () => void;
  onOpenSettings?: () => void;
  onStartASR?: () => void;
  className?: string;
}

export function RecommendedModelCard({
  groups,
  loading,
  error,
  compact = false,
  showTranscribeAction = false,
  onRefresh,
  onOpenSettings,
  onStartASR,
  className,
}: RecommendedModelCardProps) {
  const { language } = useTranslation();
  const mc = asrModelsCopy(language);
  const { asr } = useClientRuntime();
  const app = useRuntimeStoreApi('app');
  const asrModel = useAppStore(state => state.asrModel);
  const isASRLoading = useAppStore(state => state.isLoading);
  const downloads = useModelDownloads();
  const [submitting, setSubmitting] = useState(false);

  if (loading && !groups.length) {
    return (
      <div
        data-testid="recommended-model-loading"
        className={cn('flex items-center gap-2 rounded-lg border border-aimu-border bg-card p-3 text-xs text-muted-foreground', className)}
      >
        <Loader2 className="h-4 w-4 animate-spin text-aimu-coral" />
        <span>{mc.loading}</span>
      </div>
    );
  }

  const recommended = findRecommendedAsrModel(groups);
  const readyModels = listReadyAsrModels(groups);
  const activeSelection = findModel(groups, asrModel);

  const selectModel = (ref: ModelRef) => {
    const state = app.getState();
    state.setASRModel(ref);
    const next = findModel(groups, ref);
    if (next) {
      state.setLanguage(resolveLanguageForModel(getModelLanguageConfig(next.model), state.language));
    }
  };

  if (!recommended) {
    return (
      <div
        data-testid="recommended-model-missing"
        className={cn('space-y-2 rounded-lg border border-aimu-border bg-card p-3.5 text-xs', className)}
      >
        <div className="flex items-start gap-2">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-aimu-coral" />
          <div className="space-y-1">
            <p className="font-medium text-foreground">{mc.noRecommended}</p>
            {error && <p className="text-[11px] text-destructive">{error}</p>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onRefresh && (
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onRefresh}>
              <RefreshCw className="mr-1 h-3 w-3" />
              {mc.retry}
            </Button>
          )}
          {onOpenSettings && (
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onOpenSettings}>
              <Settings className="mr-1 h-3 w-3" />
              {mc.manageModels}
            </Button>
          )}
          {showTranscribeAction && (
            <Button size="sm" className="h-7 text-xs" disabled>
              <Play className="mr-1 h-3 w-3" />
              {mc.startAsr}
            </Button>
          )}
        </div>
      </div>
    );
  }

  const { provider, model } = recommended;
  const ref: ModelRef = { providerId: provider.id, modelId: model.id };
  const key = modelKey(ref);
  const dl = downloads[key];
  const isBusy = submitting || dl?.status === 'downloading' || dl?.status === 'verifying';
  const isVerifying = dl?.status === 'verifying' || dl?.phase === 'verifying';
  const isCompleted = dl?.status === 'completed' && model.status === 'ready';
  const isSelected = asrModel?.providerId === provider.id && asrModel.modelId === model.id;
  const activeReady = activeSelection?.model.status === 'ready';
  const alternatives = readyModels.filter(item => !(item.provider.id === provider.id && item.model.id === model.id));

  const timestampText =
    model.timestampLevel === 'word'
      ? mc.timestampWord
      : model.timestampLevel === 'none'
        ? mc.timestampNone
        : mc.timestampSegment;

  const benchmarkText = model.recommendation
    ? formatModelsText(mc.benchmarkNote, {
        cer: model.recommendation.cer ?? '—',
        recall: model.recommendation.fillerRecall ?? '—',
        samples: model.recommendation.sampleCount ?? 2,
        sentences: model.recommendation.sentenceCount ?? 1028,
      })
    : mc.benchmarkNoteFallback;

  const progressText = (() => {
    if (!dl || (dl.status !== 'downloading' && dl.status !== 'verifying')) return '';
    const bytesPart = dl.downloadedBytes !== undefined
      ? (dl.totalBytes
        ? `${formatByteSize(dl.downloadedBytes)} / ${formatByteSize(dl.totalBytes)}`
        : formatByteSize(dl.downloadedBytes))
      : '';
    const pctPart = dl.progress !== undefined ? `${Math.round(dl.progress)}%` : '';
    return [bytesPart, pctPart].filter(Boolean).join(' · ');
  })();

  const handleDownload = async () => {
    if (isBusy) return;
    setSubmitting(true);
    try {
      await asr.prepareModel(ref, { expectedSignature: modelStateSignature(model) });
      // Only auto-select if the user does not already have a valid ready choice (AC-3)
      const current = app.getState().asrModel;
      const currentInfo = findModel(groups, current);
      if (!current || !shouldPreserveUserSelection(groups, current) || currentInfo?.model.status !== 'ready') {
        selectModel(ref);
      }
    } catch {
      // Error state is recorded in ASRService download state and displayed inline
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section
      data-testid="recommended-model-card"
      data-model-status={model.status}
      data-download-status={dl?.status ?? 'idle'}
      className={cn(
        'rounded-lg border border-aimu-coral/35 bg-card p-3.5 shadow-xs space-y-2.5',
        compact && 'p-3 space-y-2',
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1 rounded bg-aimu-red-bg px-1.5 py-0.5 text-[10px] font-medium text-aimu-coral">
              <Sparkles className="h-3 w-3" />
              {mc.recommendedBadge}
            </span>
            {isCompleted && (
              <span data-testid="recommended-model-completed" className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-3 w-3" />
                {mc.completed}
              </span>
            )}
            {model.status === 'ready' && isSelected && (
              <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                {mc.inUse}
              </span>
            )}
          </div>
          <h3 className="text-sm font-semibold text-foreground">{model.name}</h3>
        </div>
        <span className="text-[11px] font-medium text-muted-foreground">{mc.recommendedSectionTitle}</span>
      </div>

      {/* Metadata pills (AC-1) */}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-md bg-muted/40 p-2 text-[11px] sm:grid-cols-4">
        <div>
          <dt className="text-muted-foreground">{mc.providerLabel}</dt>
          <dd className="mt-0.5 flex items-center gap-1 font-medium text-foreground truncate" title={`${provider.name} (${provider.id})`}>
            <Cpu className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="truncate">{provider.name}</span>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{mc.sizeLabel}</dt>
          <dd className="mt-0.5 flex items-center gap-1 font-medium text-foreground">
            <HardDrive className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span>{model.size ?? '—'}</span>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{mc.offlineLabel}</dt>
          <dd className="mt-0.5 flex items-center gap-1 font-medium text-foreground">
            <WifiOff className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span>{model.offline ? mc.offlineYes : mc.offlineNo}</span>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{mc.timestampLabel}</dt>
          <dd className="mt-0.5 font-medium text-foreground truncate" title={timestampText}>{timestampText}</dd>
        </div>
      </dl>

      {/* F-0001 measured reference & scope disclaimer (AC-1) */}
      <div className="flex items-start gap-1.5 rounded bg-muted/30 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
        <p>{benchmarkText}</p>
      </div>

      {/* Active download / verifying progress (AC-2, AC-6) */}
      {isBusy && (
        <div data-testid="recommended-download-progress" className="space-y-1.5 rounded-md border border-aimu-border bg-muted/20 p-2.5 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-aimu-coral" />
              <span>{mc.processing}</span>
              <span className="font-normal text-muted-foreground">
                {isVerifying
                  ? mc.phaseVerifying
                  : dl?.phase === 'extracting'
                    ? mc.phaseExtracting
                    : mc.phaseDownloading}
              </span>
            </span>
            {progressText && <span className="font-mono text-[11px] text-muted-foreground">{progressText}</span>}
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-aimu-input">
            <div
              className="h-full rounded-full bg-aimu-coral transition-all duration-200"
              style={{ width: `${Math.max(2, Math.min(100, dl?.progress ?? 0))}%` }}
            />
          </div>
        </div>
      )}

      {/* Stale conflict / failure message (AC-2, AC-8) */}
      {dl?.status === 'error' && (
        <div data-testid="recommended-download-error" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="font-medium">{dl.staleConflict ? mc.staleConflict : dl.error}</p>
            {dl.staleConflict && <p className="text-[11px] opacity-90">{mc.staleConflictHint}</p>}
          </div>
        </div>
      )}

      {/* Cancelled notice */}
      {dl?.status === 'cancelled' && model.status === 'download' && (
        <p className="text-[11px] text-muted-foreground">{mc.cancelledNotice}</p>
      )}

      {/* Unavailable reason (AC-3, AC-5) */}
      {model.status === 'unavailable' && model.reason && (
        <p className="flex items-start gap-1.5 text-[11px] text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{model.reason}</span>
        </p>
      )}

      {/* Action buttons */}
      <div className="flex flex-wrap items-center gap-2">
        {model.status === 'download' && !isBusy && dl?.status !== 'error' && (
          <Button size="sm" className="h-8 text-xs" onClick={() => void handleDownload()}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            {mc.downloadRecommended}
          </Button>
        )}

        {isBusy && (
          <>
            <Button size="sm" className="h-8 text-xs" disabled>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              {mc.processing}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              disabled={isVerifying}
              title={isVerifying ? mc.phaseVerifying : undefined}
              onClick={() => asr.cancelPrepare(ref)}
            >
              <X className="mr-1 h-3.5 w-3.5" />
              {mc.cancel}
            </Button>
          </>
        )}

        {dl?.status === 'error' && !isBusy && (
          <>
            <Button
              size="sm"
              className="h-8 text-xs"
              onClick={() => {
                if (dl.staleConflict && onRefresh) onRefresh();
                else void handleDownload();
              }}
            >
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              {mc.retry}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => asr.resetDownloadState(ref)}
            >
              {mc.back}
            </Button>
          </>
        )}

        {model.status === 'ready' && !isSelected && (
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => selectModel(ref)}>
            {mc.useThisModel}
          </Button>
        )}

        {showTranscribeAction && onStartASR && (
          <Button
            size="sm"
            variant={activeReady ? 'default' : 'secondary'}
            className="h-8 text-xs"
            disabled={!activeReady || isBusy || isASRLoading}
            onClick={onStartASR}
          >
            <Play className="mr-1.5 h-3.5 w-3.5" />
            {mc.startAsr}
          </Button>
        )}

        {onOpenSettings && (
          <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={onOpenSettings}>
            <Settings className="mr-1.5 h-3.5 w-3.5" />
            {mc.manageModels}
          </Button>
        )}
      </div>

      {/* Verification guard notice when user cannot transcribe yet (AC-2) */}
      {showTranscribeAction && !activeReady && (
        <p className="text-[11px] text-muted-foreground">{mc.cannotTranscribeBeforeVerify}</p>
      )}

      {/* Alternative ready models when recommended cannot be used/downloaded (AC-3) */}
      {(model.status === 'unavailable' || dl?.status === 'error' || (showTranscribeAction && model.status !== 'ready')) && alternatives.length > 0 && (
        <div className="space-y-1.5 border-t border-aimu-border pt-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">{mc.chooseExistingModel}</span>
            <span>{mc.noPaidFallbackHint}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {alternatives.map(item => {
              const altRef = { providerId: item.provider.id, modelId: item.model.id };
              const altSelected = asrModel?.providerId === altRef.providerId && asrModel.modelId === altRef.modelId;
              return (
                <Button
                  key={modelKey(altRef)}
                  variant={altSelected ? 'default' : 'outline'}
                  size="sm"
                  className="h-7 text-[11px]"
                  onClick={() => selectModel(altRef)}
                >
                  {item.model.name} · {item.provider.name}
                </Button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

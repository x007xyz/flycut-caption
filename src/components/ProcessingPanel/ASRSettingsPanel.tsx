// ASR 识别设置面板 - 放在播放器下方"选项"标签页
// 模型、语言、选项都来自 Host 的 providers.models；下载和添加服务在设置弹窗的「模型」里。

import { useEffect } from 'react';
import { AlertCircle, BrainCircuit, Download, Globe, Loader2, RotateCcw, Settings, Sparkles, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { modelKey, useAppStore } from '@/stores/appStore';
import { useProjectStore } from '@/stores/projectStore';
import { useRuntimeStoreApi } from '@/stores/runtimeStore';
import { ASRLanguageSelector, ModelOptionsForm, RecommendedModelCard } from '@/components/ASR';
import { inferHotwordCapabilities } from '../../../shared/providers';
import { selectActiveHotwords } from '../../../shared/terminology';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { findModel, useModelDownloads, useProviderModels } from '@/hooks/useProviderModels';
import { getModelLanguageConfig, resolveLanguageForModel } from '@/utils/modelLanguageConfig';
import { useClientRuntime } from '@/runtime/context';
import { useTranslation } from '@/contexts/LocaleProvider';
import { asrModelsCopy } from '@/locales/models';
import {
  formatByteSize,
  modelStateSignature,
  pickDefaultOfflineAsrModel,
  shouldPreserveUserSelection,
} from '@/utils/modelRecommendation';
import type { ModelInfo, ModelRef } from '../../../shared/providers';

interface ASRSettingsPanelProps {
  className?: string;
  onOpenSettings?: () => void;
}

const parseKey = (key: string): ModelRef => { const index = key.lastIndexOf('/'); return { providerId: key.slice(0, index), modelId: key.slice(index + 1) }; };

export function ASRSettingsPanel({ className, onOpenSettings }: ASRSettingsPanelProps) {
  const { asr, projects } = useClientRuntime();
  const { t, language: uiLanguage } = useTranslation();
  const mc = asrModelsCopy(uiLanguage);
  const app = useRuntimeStoreApi('app');
  const currentProject = useProjectStore((s) => s.current);
  const language = useAppStore((s) => s.language);
  const asrModel = useAppStore((s) => s.asrModel);
  const asrOptions = useAppStore((s) => s.asrOptions);
  const isLoading = useAppStore((s) => s.isLoading);
  const { groups, loading, error, refresh } = useProviderModels();
  const downloads = useModelDownloads();

  const asrGroups = groups.map(group => ({ ...group, models: group.models.filter(model => model.role === 'asr') })).filter(group => group.models.length);
  const active = findModel(groups, asrModel);
  const languageConfig = getModelLanguageConfig(active?.model);

  const STATUS_SUFFIX: Record<ModelInfo['status'], string> = {
    ready: '',
    download: mc.statusDownload,
    unavailable: mc.statusUnavailable,
  };

  const selectModel = (ref: ModelRef) => {
    const state = app.getState();
    state.setASRModel(ref);
    const next = findModel(groups, ref);
    if (next) state.setLanguage(resolveLanguageForModel(getModelLanguageConfig(next.model), state.language));
  };

  // First run (or the saved model disappeared): pick a ready offline built-in model, never cloud/paid.
  useEffect(() => {
    if (loading || !groups.length) return;
    if (shouldPreserveUserSelection(groups, asrModel)) return;
    const pick = pickDefaultOfflineAsrModel(groups);
    if (pick) selectModel({ providerId: pick.provider.id, modelId: pick.model.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, groups]);

  const activeDownload = asrModel ? downloads[modelKey(asrModel)] : undefined;
  const activeBusy = activeDownload?.status === 'downloading' || activeDownload?.status === 'verifying';
  const activeVerifying = activeDownload?.status === 'verifying' || activeDownload?.phase === 'verifying';

  const startDownload = async () => {
    if (!asrModel || !active || activeBusy) return;
    try {
      await asr.prepareModel(asrModel, { expectedSignature: modelStateSignature(active.model) });
    } catch {
      // Error state is recorded in ASRService
    }
  };

  const providerError = asrModel && groups.find(group => group.provider.id === asrModel.providerId)?.error;
  const showRecommendedGuide = !loading && (!active || active.model.status !== 'ready');
  const hotwordCaps = active ? inferHotwordCapabilities(active.model) : undefined;
  const activeHotwords = selectActiveHotwords(currentProject?.terminology ?? [], hotwordCaps);

  return (
    <div className={cn('space-y-3', className)}>
      {showRecommendedGuide && (
        <RecommendedModelCard
          compact
          groups={groups}
          loading={loading}
          error={error}
          onRefresh={() => void refresh()}
          onOpenSettings={onOpenSettings}
        />
      )}

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <label className="flex items-center space-x-1.5 text-xs font-medium text-muted-foreground">
            <BrainCircuit className="h-3.5 w-3.5" />
            <span>{mc.modelLabel}</span>
          </label>
          {onOpenSettings && (
            <button type="button" onClick={onOpenSettings} className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline">
              <Settings className="h-3 w-3" />
              {mc.manageModels}
            </button>
          )}
        </div>
        {loading && !groups.length ? (
          <div className="flex h-8 items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span>{mc.loading}</span>
          </div>
        ) : asrGroups.length ? (
          <Select value={asrModel ? modelKey(asrModel) : undefined} onValueChange={(value) => selectModel(parseKey(value))} disabled={isLoading}>
            <SelectTrigger size="sm" className="h-8 w-full text-xs"><SelectValue placeholder={mc.selectModelPlaceholder} /></SelectTrigger>
            <SelectContent>
              {asrGroups.map(group => (
                <SelectGroup key={group.provider.id}>
                  <SelectLabel className="text-[11px]">{group.provider.name}</SelectLabel>
                  {group.models.map(model => (
                    <SelectItem key={model.id} value={modelKey({ providerId: group.provider.id, modelId: model.id })} disabled={model.status === 'unavailable'}>
                      {model.name}{STATUS_SUFFIX[model.status]}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <p className="text-xs text-muted-foreground">{mc.noModelAvailable} {error ?? mc.noModelAvailableHint}</p>
        )}
        {providerError && <p className="flex items-start gap-1 text-[11px] text-destructive"><AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />{providerError}</p>}
        {active?.model.status === 'download' && (
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            {!activeBusy && activeDownload?.status !== 'error' && (
              <button type="button" onClick={() => void startDownload()} className="inline-flex items-center gap-1 text-primary hover:underline">
                <Download className="h-3 w-3" />
                {mc.downloadThisModel}{active.model.size ? `（${active.model.size}）` : ''}
              </button>
            )}
            {activeBusy && (
              <>
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {mc.processing}
                  {activeDownload?.downloadedBytes !== undefined ? ` · ${formatByteSize(activeDownload.downloadedBytes)}` : ''}
                  {activeDownload?.progress !== undefined ? ` · ${Math.round(activeDownload.progress)}%` : ''}
                </span>
                <button
                  type="button"
                  disabled={activeVerifying}
                  onClick={() => asrModel && asr.cancelPrepare(asrModel)}
                  className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  <X className="h-3 w-3" />
                  {mc.cancel}
                </button>
              </>
            )}
            {activeDownload?.status === 'error' && (
              <>
                <span className="text-destructive">{activeDownload.staleConflict ? mc.staleConflict : activeDownload.error}</span>
                <button
                  type="button"
                  onClick={() => activeDownload.staleConflict ? void refresh() : void startDownload()}
                  className="inline-flex items-center gap-0.5 text-primary hover:underline"
                >
                  <RotateCcw className="h-3 w-3" />
                  {mc.retry}
                </button>
              </>
            )}
          </div>
        )}
        {active?.model.status === 'unavailable' && active.model.reason && <p className="text-[11px] text-destructive">{active.model.reason}</p>}
        {active?.model.description && <p className="text-[11px] text-muted-foreground">{active.model.description}</p>}
        {active?.model.timestampLevel === 'word' && (
          <p className="text-[11px] text-muted-foreground">{mc.wordTimestampHint}</p>
        )}
      </div>

      <div className="space-y-1">
        <label className="flex items-center space-x-1.5 text-xs font-medium text-muted-foreground">
          <Globe className="h-3.5 w-3.5" />
          <span>{mc.languageLabel}</span>
        </label>
        <ASRLanguageSelector language={language} onLanguageChange={(value) => app.getState().setLanguage(value)} disabled={isLoading}
          mode={languageConfig.mode} options={languageConfig.options} placeholder={mc.searchLanguage} />
      </div>

      {asrModel && active?.model.options && (
        <ModelOptionsForm fields={active.model.options} values={asrOptions[modelKey(asrModel)] ?? {}} disabled={isLoading}
          onChange={(values) => app.getState().setASROptions(asrModel, values)} />
      )}

      <div className="space-y-1.5 rounded-md border border-border/70 bg-muted/30 p-2.5 text-xs" data-testid="asr-hotwords-summary">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 font-medium text-foreground">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            {t('components.project.hotwordsTitle')}
          </span>
          {currentProject ? (
            <button
              type="button"
              disabled={isLoading}
              onClick={() => { void projects.openHotwordsDialog(currentProject.projectId, currentProject.name); }}
              className="text-[11px] font-medium text-primary hover:underline disabled:opacity-50"
            >
              {t('components.project.hotwordsManage')}
            </button>
          ) : null}
        </div>
        {!currentProject ? (
          <p className="text-[11px] text-muted-foreground">{t('components.project.hotwordsNoProject')}</p>
        ) : active && !hotwordCaps?.supported ? (
          <div className="space-y-1 text-[11px]">
            <p className="text-amber-600 dark:text-amber-400">{t('components.project.hotwordsUnsupported')}</p>
            <p className="text-muted-foreground">{t('components.project.hotwordsContinuePlain')}</p>
            {onOpenSettings && (
              <button type="button" onClick={onOpenSettings} className="text-primary hover:underline">
                {t('components.project.hotwordsChangeModel')}
              </button>
            )}
          </div>
        ) : active ? (
          <p className="text-[11px] text-muted-foreground">
            {activeHotwords.length > 0
              ? t('components.project.hotwordsSummaryActive')
                  .replace('{count}', String(activeHotwords.length))
                  .replace('{model}', active.model.name)
              : t('components.project.hotwordsSummaryNone').replace('{model}', active.model.name)}
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground">{t('components.project.hotwordsEmpty')}</p>
        )}
      </div>
    </div>
  );
}

// ASR 识别设置面板 - 放在播放器下方"选项"标签页
// 模型、语言、选项都来自 Host 的 providers.models；下载和添加服务在设置弹窗的「模型」里。

import { useEffect, useState } from 'react';
import { AlertCircle, BrainCircuit, Download, Globe, Loader2, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';
import { modelKey, useAppStore } from '@/stores/appStore';
import { useRuntimeStoreApi } from '@/stores/runtimeStore';
import { ASRLanguageSelector, ModelOptionsForm } from '@/components/ASR';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { findModel, notifyProviderModelsChanged, useProviderModels } from '@/hooks/useProviderModels';
import { getModelLanguageConfig, resolveLanguageForModel } from '@/utils/modelLanguageConfig';
import { useClientRuntime } from '@/runtime/context';
import type { ModelInfo, ModelRef } from '../../../shared/providers';

interface ASRSettingsPanelProps {
  className?: string;
  onOpenSettings?: () => void;
}

const STATUS_SUFFIX: Record<ModelInfo['status'], string> = { ready: '', download: '（需下载）', unavailable: '（不可用）' };
const parseKey = (key: string): ModelRef => { const index = key.lastIndexOf('/'); return { providerId: key.slice(0, index), modelId: key.slice(index + 1) }; };

export function ASRSettingsPanel({ className, onOpenSettings }: ASRSettingsPanelProps) {
  const { asr } = useClientRuntime();
  const app = useRuntimeStoreApi('app');
  const language = useAppStore((s) => s.language);
  const asrModel = useAppStore((s) => s.asrModel);
  const asrOptions = useAppStore((s) => s.asrOptions);
  const isLoading = useAppStore((s) => s.isLoading);
  const { groups, loading, error } = useProviderModels();
  const [download, setDownload] = useState<{ busy: boolean; message?: string }>({ busy: false });

  const asrGroups = groups.map(group => ({ ...group, models: group.models.filter(model => model.role === 'asr') })).filter(group => group.models.length);
  const active = findModel(groups, asrModel);
  const languageConfig = getModelLanguageConfig(active?.model);

  const selectModel = (ref: ModelRef) => {
    const state = app.getState();
    state.setASRModel(ref);
    const next = findModel(groups, ref);
    if (next) state.setLanguage(resolveLanguageForModel(getModelLanguageConfig(next.model), state.language));
  };

  // First run (or the saved model disappeared): pick a ready model, recommended first.
  useEffect(() => {
    if (loading || active) return;
    const ready = asrGroups.flatMap(group => group.models.filter(model => model.status === 'ready').map(model => ({ group, model })));
    const pick = ready.find(item => item.model.recommended) ?? ready[0];
    if (pick && (!asrModel || !groups.some(group => group.provider.id === asrModel.providerId && !group.error))) {
      selectModel({ providerId: pick.group.provider.id, modelId: pick.model.id });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, groups]);

  const startDownload = async () => {
    if (!asrModel) return;
    setDownload({ busy: true, message: '准备下载...' });
    try {
      await asr.prepareModel(asrModel, progress => setDownload({ busy: true,
        message: [progress.data, progress.progress !== undefined ? `${Math.round(progress.progress)}%` : ''].filter(Boolean).join(' ') }));
      setDownload({ busy: false }); notifyProviderModelsChanged();
    } catch (reason) {
      setDownload({ busy: false, message: reason instanceof Error ? reason.message : String(reason) });
    }
  };

  const providerError = asrModel && groups.find(group => group.provider.id === asrModel.providerId)?.error;

  return (
    <div className={cn('space-y-3', className)}>
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <label className="flex items-center space-x-1.5 text-xs font-medium text-muted-foreground">
            <BrainCircuit className="h-3.5 w-3.5" />
            <span>识别模型</span>
          </label>
          {onOpenSettings && (
            <button type="button" onClick={onOpenSettings} className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline">
              <Settings className="h-3 w-3" />管理模型
            </button>
          )}
        </div>
        {loading && !groups.length ? (
          <div className="flex h-8 items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />读取模型列表...</div>
        ) : asrGroups.length ? (
          <Select value={asrModel ? modelKey(asrModel) : undefined} onValueChange={(value) => selectModel(parseKey(value))} disabled={isLoading}>
            <SelectTrigger size="sm" className="h-8 w-full text-xs"><SelectValue placeholder="选择识别模型" /></SelectTrigger>
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
          <p className="text-xs text-muted-foreground">没有可用的识别模型。{error ?? '请在「设置 → 模型」中下载模型或添加服务。'}</p>
        )}
        {providerError && <p className="flex items-start gap-1 text-[11px] text-destructive"><AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />{providerError}</p>}
        {active?.model.status === 'download' && (
          <div className="flex items-center gap-2 text-[11px]">
            <button type="button" disabled={download.busy} onClick={startDownload} className="inline-flex items-center gap-1 text-primary hover:underline disabled:opacity-60">
              {download.busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}下载此模型{active.model.size ? `（${active.model.size}）` : ''}
            </button>
            {download.message && <span className="truncate text-muted-foreground">{download.message}</span>}
          </div>
        )}
        {active?.model.status === 'unavailable' && active.model.reason && <p className="text-[11px] text-destructive">{active.model.reason}</p>}
        {active?.model.description && <p className="text-[11px] text-muted-foreground">{active.model.description}</p>}
        {active?.model.timestampLevel === 'word' && (
          <p className="text-[11px] text-muted-foreground">该模型通常输出字词级时间戳，识别后可按字词删除并精剪（以实际识别结果为准）。</p>
        )}
      </div>

      <div className="space-y-1">
        <label className="flex items-center space-x-1.5 text-xs font-medium text-muted-foreground">
          <Globe className="h-3.5 w-3.5" />
          <span>识别语言</span>
        </label>
        <ASRLanguageSelector language={language} onLanguageChange={(value) => app.getState().setLanguage(value)} disabled={isLoading}
          mode={languageConfig.mode} options={languageConfig.options} placeholder="搜索语言..." />
      </div>

      {asrModel && active?.model.options && (
        <ModelOptionsForm fields={active.model.options} values={asrOptions[modelKey(asrModel)] ?? {}} disabled={isLoading}
          onChange={(values) => app.getState().setASROptions(asrModel, values)} />
      )}
    </div>
  );
}

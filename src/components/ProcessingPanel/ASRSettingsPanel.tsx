import { ASRSourceSelector } from '@/components/ASR/ASRSourceSelector';
import { PythonRuntimePanel } from '@/components/ASR/PythonRuntimePanel';
import { MODEL_CATALOG_CHANGED_EVENT } from '@/services/customModelCatalog';
// ASR 识别设置面板 - 放在播放器下方"选项"标签页
// 浏览器端仅展示 Web 模型；Tauri 桌面端仅展示 FunASR 模型。下载请到设置弹窗。

import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/appStore';
import { useShowInfo } from '@/stores/messageStore';
import { ASRLanguageSelector, ModelSelectItems, WebModelSelectItems } from '@/components/ASR';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BrainCircuit, Globe, Cpu, AlertCircle, Settings } from 'lucide-react';
import type { AvailableModel } from '@/types/model';
import { getWebAsrModel } from '../../../shared/asr/webModels';
import { getRuntimeAsrEngineType, isTauriRuntime } from '@/utils/runtime';
import { useActiveModelTimestamp } from '@/hooks/useActiveModelTimestamp';
import { useActiveModelLanguageConfig } from '@/hooks/useActiveModelLanguageConfig';
import { shouldAdvertiseWordLevelDelete } from '@/utils/wordLevelEdit';
import { WEB_MODELS_DOWNLOADED_EVENT } from '@/services/webModelCache';
import { useClientRuntime } from '@/runtime/context';

interface ASRSettingsPanelProps {
  className?: string;
  onOpenSettings?: () => void;
}

export function ASRSettingsPanel({ className, onOpenSettings }: ASRSettingsPanelProps) {
  const { connection, asr: asrService } = useClientRuntime();
  const language = useAppStore((s) => s.language);
  const asrEngineType = useAppStore((s) => s.asrEngineType);
  const asrModelId = useAppStore((s) => s.asrModelId);
  const webModelId = useAppStore((s) => s.webModelId);
  const isLoading = useAppStore((s) => s.isLoading);

  const setLanguage = useAppStore((s) => s.setLanguage);
  const setASREngineType = useAppStore((s) => s.setASREngineType);
  const setASRModelId = useAppStore((s) => s.setASRModelId);
  const setWebModelId = useAppStore((s) => s.setWebModelId);

  const showInfo = useShowInfo();

  const [isTauri, setIsTauri] = useState(false);
  const [downloadedModels, setDownloadedModels] = useState<string[]>([]);
  const [downloadedWebModels, setDownloadedWebModels] = useState<string[]>([]);
  const [allModels, setAllModels] = useState<AvailableModel[]>([]);
  const activeModelTimestamp = useActiveModelTimestamp();
  const languageConfig = useActiveModelLanguageConfig();
  const supportsWordLevelDelete = shouldAdvertiseWordLevelDelete(activeModelTimestamp);

  useEffect(() => {
    const tauri = isTauriRuntime();
    setIsTauri(tauri);

    const expectedEngine = asrEngineType === 'api' || asrEngineType === 'python-runtime' ? asrEngineType : getRuntimeAsrEngineType();
    if (asrEngineType !== expectedEngine) {
      setASREngineType(expectedEngine);
    }

    if (!tauri) {
      asrService.checkAllWebModelsDownloaded()
        .then(setDownloadedWebModels)
        .catch((err) => console.error('Failed to check web models:', err));
      return;
    }

    connection.call('models.status')
      .then((status) => setDownloadedModels(status.downloaded_model_ids))
      .catch((err) => console.error('Failed to check models:', err));
    connection.call('models.list')
      .then((list) => setAllModels(list))
      .catch((err) => console.error('Failed to list available models:', err));
  }, [asrEngineType, setASREngineType, webModelId, asrService, connection]);

  useEffect(() => {
    if (isTauri) return;
    const refresh = () => {
      asrService.checkAllWebModelsDownloaded()
        .then(setDownloadedWebModels)
        .catch(() => {});
    };
    refresh();
    window.addEventListener(WEB_MODELS_DOWNLOADED_EVENT, refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener(WEB_MODELS_DOWNLOADED_EVENT, refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [isTauri, asrService]);

  useEffect(() => {
    if (!isTauri) return;
    const handler = () => {
      connection.call('models.status')
        .then((status) => setDownloadedModels(status.downloaded_model_ids))
        .catch(() => {});
      connection.call('models.list')
        .then((list) => setAllModels(list))
        .catch(() => {});
    };
    window.addEventListener('focus', handler);
    window.addEventListener(MODEL_CATALOG_CHANGED_EVENT, handler);
    return () => {
      window.removeEventListener('focus', handler);
      window.removeEventListener(MODEL_CATALOG_CHANGED_EVENT, handler);
    };
  }, [isTauri, connection]);

  const changeLanguage = useCallback(
    (newLanguage: string) => {
      setLanguage(newLanguage);
    },
    [setLanguage],
  );

  const changeFunasrModel = useCallback(
    (modelId: string) => {
      setASRModelId(modelId);
      const modelName = allModels.find((m) => m.id === modelId)?.name || modelId;
      showInfo('模型切换成功', `已切换到 ${modelName}`);
    },
    [setASRModelId, showInfo, allModels],
  );

  const changeWebModel = useCallback(
    (modelId: string) => {
      setWebModelId(modelId);
      asrService.setWebModel(modelId);
      const meta = getWebAsrModel(modelId);
      showInfo('模型切换成功', `已切换到 ${meta?.name || modelId}`);
    },
    [setWebModelId, showInfo, asrService],
  );

  const currentModelDownloaded = downloadedModels.includes(asrModelId);
  const currentWebModelDownloaded = downloadedWebModels.includes(webModelId);

  const downloadHint = (label: string) => (
    <div className="flex items-center gap-2 p-1.5 border rounded-md bg-amber-50 dark:bg-amber-950/20 text-xs">
      <AlertCircle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
      <span className="text-amber-700 dark:text-amber-400 flex-1">{label}</span>
      {onOpenSettings && (
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex items-center gap-1 text-amber-600 dark:text-amber-400 hover:underline font-medium shrink-0"
        >
          <Settings className="h-3 w-3" />
          <span>去下载</span>
        </button>
      )}
    </div>
  );

  const sourceSelector = <ASRSourceSelector onOpenSettings={onOpenSettings} />;
  if (asrEngineType === 'api') return <div className={cn('space-y-3', className)}>
    {sourceSelector}
    <ASRLanguageSelector language={language} onLanguageChange={changeLanguage} disabled={isLoading} mode="selectable" />
    <p className="text-xs text-muted-foreground">音频将发送至所选 API 服务。时间戳和按词精剪能力以实际返回结果为准。</p>
  </div>;
  if (asrEngineType === 'python-runtime') return <div className={cn('space-y-3', className)}>
    {sourceSelector}
    <PythonRuntimePanel />
    <ASRLanguageSelector language={language} onLanguageChange={changeLanguage} disabled={isLoading} mode="selectable" />
    <p className="text-xs text-muted-foreground">音频通过 FlyCut Host 交给 Python worker，模型与推理保留在本机。</p>
  </div>;
  // —— 浏览器端：仅 Web 模型 ——
  if (!isTauri) {
    return (
      <div className={cn('space-y-3', className)}>
        {sourceSelector}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="flex items-center space-x-1.5 text-xs font-medium text-muted-foreground">
              <Globe className="h-3.5 w-3.5" />
              <span>识别语言</span>
            </label>
            <ASRLanguageSelector
              language={language}
              onLanguageChange={changeLanguage}
              disabled={isLoading}
              mode={languageConfig.mode}
              placeholder="搜索语言..."
            />
          </div>

          <div className="space-y-1">
            <label className="flex items-center space-x-1.5 text-xs font-medium text-muted-foreground">
              <Cpu className="h-3.5 w-3.5" />
              <span>计算设备</span>
            </label>
            <div className="h-8 rounded-md border px-3 py-1.5 text-xs">CPU · FlyCut Host</div>
          </div>
        </div>

        <div className="space-y-1">
          <label className="flex items-center space-x-1.5 text-xs font-medium text-muted-foreground">
            <BrainCircuit className="h-3.5 w-3.5" />
            <span>Transformers 识别模型</span>
          </label>
          {downloadedWebModels.length > 0 ? (
            <Select
              value={
                currentWebModelDownloaded
                  ? webModelId
                  : (downloadedWebModels[0] ?? webModelId)
              }
              onValueChange={(v) => changeWebModel(v)}
              disabled={isLoading}
            >
              <SelectTrigger size="sm" className="w-full text-xs h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <WebModelSelectItems downloadedModelIds={downloadedWebModels} />
              </SelectContent>
            </Select>
          ) : (
            downloadHint('Host 尚未下载模型')
          )}
          {downloadedWebModels.length > 0 && !currentWebModelDownloaded
            && downloadHint('当前模型尚未下载，识别前需先下载')}
          {supportsWordLevelDelete && (
            <p className="text-[11px] text-muted-foreground">
              该模型支持字词级时间戳，识别后可按字词删除并精剪视频。
            </p>
          )}
        </div>
      </div>
    );
  }

  // —— Tauri 桌面端：仅 FunASR 模型 ——
  return (
    <div className={cn('space-y-3', className)}>
      {sourceSelector}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="flex items-center space-x-1.5 text-xs font-medium text-muted-foreground">
            <Globe className="h-3.5 w-3.5" />
            <span>识别语言</span>
          </label>
          <ASRLanguageSelector
            language={language}
            onLanguageChange={changeLanguage}
            disabled={isLoading}
            mode={languageConfig.mode}
            placeholder="搜索语言..."
          />
        </div>

        <div className="space-y-1">
          <label className="flex items-center space-x-1.5 text-xs font-medium text-muted-foreground">
            <BrainCircuit className="h-3.5 w-3.5" />
            <span>桌面端识别模型</span>
          </label>
          {downloadedModels.length > 0 ? (
            <Select
              value={asrModelId}
              onValueChange={(v) => changeFunasrModel(v)}
              disabled={isLoading}
            >
              <SelectTrigger size="sm" className="w-full text-xs h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <ModelSelectItems
                  allModels={allModels}
                  downloadedModelIds={downloadedModels}
                />
                {!currentModelDownloaded && <SelectItem value={asrModelId} disabled>当前模型尚未下载</SelectItem>}
              </SelectContent>
            </Select>
          ) : (
            downloadHint('未下载桌面端模型')
          )}
          {supportsWordLevelDelete && (
            <p className="text-[11px] text-muted-foreground">
              该模型已验证字词级时间戳（token_timestamp_verified），识别后可按字词删除。
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

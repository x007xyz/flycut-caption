import { useState } from 'react';
import { CircleDot, Pencil, Server, SlidersHorizontal } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { providerModelsByRole } from '../../../shared/providerCatalog';
import { useHostQuery } from '@/runtime/hooks';
import { useProviderConfigStore } from '@/stores/providerConfigStore';
import type { AppState, AppActions } from '@/stores/appStore';
import { useRuntimeStoreApi } from '@/stores/runtimeStore';
import { useASRApiStore } from '@/stores/asrApiStore';
import type { ProviderFeatureConfig, ProviderFeatureKey, ProviderModel, ProviderPackage } from '@/types/provider';

export function ProviderSettingsPanel() {
  const configs = useProviderConfigStore((state) => state.configs);
  const setSource = useProviderConfigStore((state) => state.setSource);
  const setModel = useProviderConfigStore((state) => state.setModel);
  const setFeature = useProviderConfigStore((state) => state.setFeature);
  const update = useProviderConfigStore((state) => state.update);
  const saveApi = useASRApiStore((state) => state.save);
  const [editing, setEditing] = useState<string | null>('funasr-local');
  const { data: providers = [], error } = useHostQuery('providers.catalog');
  const appStore = useRuntimeStoreApi('app');

  return <div className="space-y-3 pt-4">
    <div><h2 className="text-sm font-semibold text-aimu-text-primary">Provider 配置</h2><p className="mt-1 text-xs text-muted-foreground">每个 Provider 对应一组模型能力，可选择本地运行或 API 服务。</p>{error && <p role="alert" className="mt-1 text-xs text-destructive">无法读取 Host Provider 目录：{error}</p>}</div>
    {providers.map((provider) => {
      const config = configs.find((item) => item.providerId === provider.id);
      if (!config) return null;
      const asr = provider.models?.find((model) => model.role === 'asr' && model.id === config.modelIds.asr);
      return <div key={provider.id} className="rounded-lg border border-aimu-border bg-card shadow-sm">
        <div className="flex items-center justify-between gap-3 p-3">
          <div className="min-w-0"><div className="flex items-center gap-2 text-sm font-medium"><span className="truncate">{provider.name}</span><CircleDot className={`h-3 w-3 ${provider.status === 'available' ? 'text-emerald-500' : 'text-amber-500'}`} /></div><p className="mt-0.5 truncate text-xs text-muted-foreground">{provider.description}</p></div>
          <button type="button" className="inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted" onClick={() => setEditing(editing === provider.id ? null : provider.id)}><Pencil className="h-3 w-3" />{editing === provider.id ? '收起' : '编辑'}</button>
        </div>
        <div className="mx-3 mb-3 rounded-md bg-muted/40 p-3 text-xs">
          <div className="flex items-center justify-between gap-2"><span className="font-medium">{asr?.name ?? '未选择识别模型'}</span><span className="text-muted-foreground">{config.source === 'local' ? '本地模型' : 'API 服务'}</span></div>
          <div className="mt-2 flex flex-wrap gap-1.5">{provider.capabilities.map((capability) => <span key={capability.id} className={`rounded-full border px-2 py-0.5 ${capability.status === 'planned' ? 'text-amber-600' : 'text-muted-foreground'}`}>{capability.name}</span>)}</div>
        </div>
        {editing === provider.id && <div className="border-t border-aimu-border p-3 space-y-3">
          <div className="grid gap-3 lg:grid-cols-2">
            <label className="space-y-1 text-xs"><span className="text-muted-foreground">运行方式</span><Select value={config.source} onValueChange={(value) => { const source = value as 'local' | 'api'; setSource(provider.id, source); applyRuntime(appStore.getState(), provider.id, source, config.modelIds.asr); if (source === 'api') saveApi({ id: provider.id, name: provider.name, baseUrl: config.baseUrl, model: config.modelIds.asr ?? 'whisper-1', timestamps: 'word', timeoutSeconds: 120, apiKey: config.apiKey }); }}><SelectTrigger size="sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="local">本地模型</SelectItem><SelectItem value="api">API 服务</SelectItem></SelectContent></Select></label>
            {config.source === 'api' ? <label className="space-y-1 text-xs"><span className="text-muted-foreground">Base URL</span><Input value={config.baseUrl} placeholder="https://api.example.com/v1" onChange={(event) => { const baseUrl = event.target.value; update(provider.id, { baseUrl }); saveApi({ id: provider.id, name: provider.name, baseUrl, model: config.modelIds.asr ?? 'whisper-1', timestamps: 'word', timeoutSeconds: 120, apiKey: config.apiKey }); }} /></label> : <div className="flex items-end text-xs text-muted-foreground"><Server className="mr-1 h-3.5 w-3.5" />模型文件保存在本机</div>}
          </div>
          {config.source === 'api' && <label className="block space-y-1 text-xs"><span className="text-muted-foreground">API Key</span><Input type="password" autoComplete="off" value={config.apiKey ?? ''} placeholder="仅保存在当前会话" onChange={(event) => { const apiKey = event.target.value; update(provider.id, { apiKey }); saveApi({ id: provider.id, name: provider.name, baseUrl: config.baseUrl, model: config.modelIds.asr ?? 'whisper-1', timestamps: 'word', timeoutSeconds: 120, apiKey }); }} /></label>}
          <div className="grid gap-3 lg:grid-cols-2">{(['asr', 'align', 'separator'] as ProviderModel['role'][]).map((role) => {
            const models = provider.models?.filter((model) => model.role === role) ?? [];
            if (models.length === 0) return null;
            return <ModelChoice key={role} role={role} models={models} value={config.modelIds[role]} onChange={(modelId) => { setModel(provider.id, role, modelId); if (role === 'asr') { applyRuntime(appStore.getState(), provider.id, config.source, modelId); if (config.source === 'api') saveApi({ id: provider.id, name: provider.name, baseUrl: config.baseUrl, model: modelId, timestamps: 'word', timeoutSeconds: 120, apiKey: config.apiKey }); } }} />;
          })}</div>
          {asr && <ModelFeatureConfigPanel catalog={providers} asr={asr} features={config.features ?? {}} onChange={(feature, patch) => setFeature(provider.id, feature, patch)} />}
        </div>}
      </div>;
    })}
  </div>;
}

function ModelFeatureConfigPanel({ asr, features, onChange, catalog }: { catalog: ProviderPackage[]; asr: ProviderModel; features: Partial<Record<ProviderFeatureKey, ProviderFeatureConfig>>; onChange: (feature: ProviderFeatureKey, patch: Partial<ProviderFeatureConfig>) => void }) {
  const definitions: Array<{ key: ProviderFeatureKey; label: string; description: string; nativeSupported: boolean; externalRole?: ProviderModel['role'] }> = [
    { key: 'vad', label: 'VAD / 语音活动检测', description: '判断音频中哪里有人声。', nativeSupported: Boolean(asr.supportsVad), externalRole: 'vad' },
    { key: 'timestamps', label: '时间戳', description: '输出句段或字词级时间戳。', nativeSupported: asr.timestampLevel !== 'none', externalRole: 'align' },
    { key: 'diarization', label: '说话人识别', description: '区分不同说话人。', nativeSupported: false },
  ];
  return <div className="rounded-md border border-dashed p-3 text-xs"><div className="mb-3 flex items-center gap-1 font-medium"><SlidersHorizontal className="h-3.5 w-3.5" />模型能力配置</div><div className="space-y-3">{definitions.map((definition) => {
    const state = features[definition.key] ?? { useNative: false };
    const externalModels = definition.externalRole ? providerModelsByRole(catalog, definition.externalRole) : [];
    const nativeDisabled = !definition.nativeSupported;
    const mode = nativeDisabled ? (state.externalModelId ? 'external' : 'none') : state.useNative ? 'native' : state.externalModelId ? 'external' : 'none';
    const chooseMode = (next: 'native' | 'external' | 'none') => {
      if (next === 'native') onChange(definition.key, { useNative: true, externalModelId: undefined });
      else if (next === 'external') onChange(definition.key, { useNative: false, externalModelId: state.externalModelId ?? externalModels[0]?.model.id });
      else onChange(definition.key, { useNative: false, externalModelId: undefined });
    };
    return <div key={definition.key} className="space-y-2 rounded-md bg-muted/30 p-2.5">
      <div className="font-medium">{definition.label}<span className="ml-1 font-normal text-muted-foreground">{definition.description}</span></div>
      <div className="space-y-2 pl-1">
        <label className={`flex items-center gap-2 ${nativeDisabled ? 'text-muted-foreground/60' : ''}`}><input type="radio" name={`${definition.key}-mode`} checked={mode === 'native'} disabled={nativeDisabled} onChange={() => chooseMode('native')} /><span>使用模型内置能力</span>{nativeDisabled && <span className="text-muted-foreground">（模型不支持）</span>}</label>
        <div className="flex items-center gap-2"><label className="flex shrink-0 items-center gap-2"><input type="radio" name={`${definition.key}-mode`} checked={mode === 'external'} disabled={externalModels.length === 0} onChange={() => chooseMode('external')} /><span>使用外部模型</span></label><Select value={state.externalModelId ?? externalModels[0]?.model.id ?? '__none__'} disabled={mode !== 'external' || externalModels.length === 0} onValueChange={(value) => onChange(definition.key, { useNative: false, externalModelId: value === '__none__' ? undefined : value })}><SelectTrigger size="sm" className="min-w-0 flex-1 text-xs"><SelectValue placeholder={externalModels.length === 0 ? '暂无可用模型' : '选择外部模型'} /></SelectTrigger><SelectContent>{externalModels.length === 0 ? <SelectItem value="__none__">暂无可用模型</SelectItem> : externalModels.map(({ providerId, providerName, model }) => <SelectItem key={`${providerId}:${model.id}`} value={model.id}>{providerName} · {model.name}</SelectItem>)}</SelectContent></Select></div>
        <label className="flex items-center gap-2"><input type="radio" name={`${definition.key}-mode`} checked={mode === 'none'} onChange={() => chooseMode('none')} /><span>不使用此能力</span></label>
      </div>
    </div>;
  })}</div><div className="mt-3 grid gap-2 text-muted-foreground sm:grid-cols-3"><span>{asr.supportsVad ? '✓ ASR 原生支持 VAD' : '○ ASR 不支持 VAD'}</span><span>{asr.supportsWordTimestamps ? '✓ 原生字级时间戳' : `○ 原生${asr.timestampLevel === 'segment' ? '句段级' : '无'}时间戳`}</span><span>{asr.size ? `大小：${asr.size}` : '大小：未知'}</span></div></div>;
}

function applyRuntime(app: AppState & AppActions, providerId: string, source: 'local' | 'api', modelId?: string) {
  if (source === 'api') {
    app.setASREngineType('api');
    return;
  }
  if (providerId === 'transformers-web') {
    app.setASREngineType('transformers');
    if (modelId) app.setWebModelId(modelId);
    return;
  }
  app.setASREngineType('python-runtime');
  if (modelId) app.setASRModelId(modelId);
}

function ModelChoice({ role, models, value, onChange }: { role: ProviderModel['role']; models: ProviderModel[]; value?: string; onChange: (value: string) => void }) {
  const labels: Record<ProviderModel['role'], string> = { asr: 'ASR 模型', vad: 'VAD 模型', align: '对齐模型', separator: '分离模型', text: '文本模型' };
  return <label className="space-y-1 text-xs"><span className="text-muted-foreground">{labels[role]}</span><Select value={value ?? models[0]?.id} onValueChange={onChange}><SelectTrigger size="sm"><SelectValue /></SelectTrigger><SelectContent>{models.map((model) => <SelectItem key={model.id} value={model.id}>{model.name}{model.size ? ` · ${model.size}` : ''}</SelectItem>)}</SelectContent></Select></label>;
}

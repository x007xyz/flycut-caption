// 设置 → 模型：按 Provider 列出模型、下载、选用，以及添加 / 删除 HTTP 服务
import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Download, Loader2, Plus, RefreshCw, Server, Trash2 } from 'lucide-react';
import type { EndpointInfo, EndpointInput } from '../../../shared/protocol';
import type { ModelInfo, ModelRef } from '../../../shared/providers';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { modelKey, useAppStore } from '@/stores/appStore';
import { useRuntimeStoreApi } from '@/stores/runtimeStore';
import { notifyProviderModelsChanged, useProviderModels } from '@/hooks/useProviderModels';
import { useClientRuntime } from '@/runtime/context';

const ROLE_LABELS: Record<ModelInfo['role'], string> = { asr: '识别', vad: 'VAD', punc: '标点', speaker: '说话人', align: '对齐', tts: '语音合成' };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function ModelsPanel() {
  const { asr } = useClientRuntime();
  const app = useRuntimeStoreApi('app');
  const asrModel = useAppStore(state => state.asrModel);
  const { groups, loading, error, refresh } = useProviderModels();
  const [downloads, setDownloads] = useState<Record<string, { busy: boolean; message?: string; failed?: boolean }>>({});

  const download = async (ref: ModelRef) => {
    const key = modelKey(ref);
    setDownloads(state => ({ ...state, [key]: { busy: true, message: '准备下载...' } }));
    try {
      await asr.prepareModel(ref, progress => setDownloads(state => ({ ...state, [key]: { busy: true,
        message: [progress.data, progress.progress !== undefined ? `${Math.round(progress.progress)}%` : ''].filter(Boolean).join(' ') } })));
      setDownloads(state => ({ ...state, [key]: { busy: false } }));
      notifyProviderModelsChanged();
    } catch (reason) {
      setDownloads(state => ({ ...state, [key]: { busy: false, failed: true, message: errorText(reason) } }));
    }
  };

  return (
    <div className="space-y-4 pt-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">每个 Provider 自带模型清单；下载、选用都在这里完成。</p>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={`mr-1 h-3 w-3 ${loading ? 'animate-spin' : ''}`} />刷新
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {groups.map(group => (
        <section key={group.provider.id} className="rounded-md border border-aimu-border">
          <header className="flex items-center justify-between gap-2 border-b border-aimu-border px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{group.provider.name}</span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{group.provider.kind === 'builtin' ? '内置' : '服务'}</span>
              <code className="text-[10px] text-muted-foreground">{group.provider.id}</code>
            </div>
          </header>
          {group.error && <p className="flex items-start gap-1 px-3 py-2 text-xs text-destructive"><AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />{group.error}</p>}
          <ul className="divide-y divide-aimu-border">
            {group.models.map(model => {
              const ref = { providerId: group.provider.id, modelId: model.id };
              const state = downloads[modelKey(ref)];
              const selected = asrModel?.providerId === ref.providerId && asrModel.modelId === ref.modelId;
              return (
                <li key={model.id} className="flex items-start justify-between gap-3 px-3 py-2">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="font-medium">{model.name}</span>
                      <span className="rounded border px-1 text-[10px] text-muted-foreground">{ROLE_LABELS[model.role]}</span>
                      {model.size && <span className="text-[10px] text-muted-foreground">{model.size}</span>}
                      {model.timestampLevel === 'word' && <span className="text-[10px] text-muted-foreground">字级时间戳</span>}
                      {model.recommended && <span className="text-[10px] text-aimu-coral">推荐</span>}
                    </div>
                    {model.description && <p className="text-[11px] text-muted-foreground">{model.description}</p>}
                    {model.status === 'unavailable' && model.reason && <p className="text-[11px] text-destructive">{model.reason}</p>}
                    {state?.message && <p className={`truncate text-[11px] ${state.failed ? 'text-destructive' : 'text-muted-foreground'}`}>{state.message}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {model.status === 'download' && (
                      <Button variant="outline" size="sm" className="h-7 text-xs" disabled={state?.busy} onClick={() => void download(ref)}>
                        {state?.busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Download className="mr-1 h-3 w-3" />}下载
                      </Button>
                    )}
                    {model.role === 'asr' && model.status === 'ready' && (selected
                      ? <span className="inline-flex items-center gap-1 text-[11px] text-primary"><CheckCircle2 className="h-3 w-3" />使用中</span>
                      : <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => app.getState().setASRModel(ref)}>使用</Button>)}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <EndpointsSection />
    </div>
  );
}

const EMPTY_FORM = { label: '', name: '', protocol: 'flycut' as EndpointInput['protocol'], baseUrl: '', apiKey: '', models: '', timestamps: 'segment' as 'none' | 'segment' | 'word' };

function EndpointsSection() {
  const { connection } = useClientRuntime();
  const [endpoints, setEndpoints] = useState<EndpointInfo[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [message, setMessage] = useState<{ text: string; failed?: boolean }>();
  const [saving, setSaving] = useState(false);
  const load = () => connection.call('endpoints.list').then(setEndpoints, reason => setMessage({ text: errorText(reason), failed: true }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [connection]);
  const update = (patch: Partial<typeof form>) => setForm(state => ({ ...state, ...patch }));

  const save = async () => {
    setSaving(true); setMessage(undefined);
    try {
      const input: EndpointInput = { name: form.name.trim(), label: form.label.trim(), protocol: form.protocol, baseUrl: form.baseUrl.trim(),
        ...(form.apiKey ? { apiKey: form.apiKey } : {}),
        ...(form.protocol === 'openai' ? { models: form.models.split(/[,，\s]+/).filter(Boolean).map(id => ({ id, timestamps: form.timestamps })) } : {}) };
      const saved = await connection.call('endpoints.save', input);
      setForm(EMPTY_FORM); setMessage({ text: `已保存 ${saved.label}（${saved.providerId}）` });
      await load(); notifyProviderModelsChanged();
    } catch (reason) { setMessage({ text: errorText(reason), failed: true }); }
    finally { setSaving(false); }
  };
  const remove = async (name: string) => {
    try { await connection.call('endpoints.remove', { name }); await load(); notifyProviderModelsChanged(); }
    catch (reason) { setMessage({ text: errorText(reason), failed: true }); }
  };
  const edit = (endpoint: EndpointInfo) => setForm({ ...EMPTY_FORM, label: endpoint.label, name: endpoint.name, protocol: endpoint.protocol, baseUrl: endpoint.baseUrl,
    models: endpoint.models?.map(model => model.id).join(', ') ?? '', timestamps: endpoint.models?.[0]?.timestamps ?? 'segment' });

  return (
    <section className="space-y-3 rounded-md border border-dashed border-aimu-border p-3">
      <div className="flex items-center gap-2">
        <Server className="h-4 w-4 text-aimu-coral" />
        <div>
          <h3 className="text-sm font-medium">添加服务</h3>
          <p className="text-[11px] text-muted-foreground">接入自己的模型：运行一个实现 FlyCut Provider 协议的服务，或填写 OpenAI 兼容的转写接口。API Key 只保存在 Host 内存中，重启后需要重填。</p>
        </div>
      </div>
      {endpoints.length > 0 && (
        <ul className="space-y-1">
          {endpoints.map(endpoint => (
            <li key={endpoint.name} className="flex items-center justify-between gap-2 rounded bg-muted/40 px-2 py-1 text-xs">
              <button type="button" className="min-w-0 truncate text-left hover:underline" onClick={() => edit(endpoint)} title="编辑">
                {endpoint.label} · <code className="text-[10px]">{endpoint.providerId}</code> · {endpoint.baseUrl}{endpoint.hasApiKey ? '' : ' · 未设置 Key'}
              </button>
              <button type="button" aria-label="删除服务" className="text-muted-foreground hover:text-destructive" onClick={() => void remove(endpoint.name)}><Trash2 className="h-3.5 w-3.5" /></button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <label className="space-y-1"><span className="text-muted-foreground">显示名称</span><Input className="h-8 text-xs" value={form.label} placeholder="GPU 服务器" onChange={e => update({ label: e.target.value })} /></label>
        <label className="space-y-1"><span className="text-muted-foreground">ID（小写字母、数字、-）</span><Input className="h-8 text-xs" value={form.name} placeholder="gpu-box" onChange={e => update({ name: e.target.value })} /></label>
        <label className="space-y-1"><span className="text-muted-foreground">协议</span>
          <Select value={form.protocol} onValueChange={value => update({ protocol: value as EndpointInput['protocol'] })}>
            <SelectTrigger size="sm" className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="flycut">FlyCut Provider</SelectItem><SelectItem value="openai">OpenAI 兼容</SelectItem></SelectContent>
          </Select>
        </label>
        <label className="space-y-1"><span className="text-muted-foreground">地址</span><Input className="h-8 text-xs" value={form.baseUrl} placeholder={form.protocol === 'openai' ? 'https://api.example.com/v1' : 'http://192.168.1.20:9000'} onChange={e => update({ baseUrl: e.target.value })} /></label>
        <label className="col-span-2 space-y-1"><span className="text-muted-foreground">API Key（可选）</span><Input className="h-8 text-xs" type="password" autoComplete="off" value={form.apiKey} onChange={e => update({ apiKey: e.target.value })} /></label>
        {form.protocol === 'openai' && <>
          <label className="space-y-1"><span className="text-muted-foreground">模型名（逗号分隔）</span><Input className="h-8 text-xs" value={form.models} placeholder="whisper-1" onChange={e => update({ models: e.target.value })} /></label>
          <label className="space-y-1"><span className="text-muted-foreground">时间戳</span>
            <Select value={form.timestamps} onValueChange={value => update({ timestamps: value as typeof form.timestamps })}>
              <SelectTrigger size="sm" className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="word">字词</SelectItem><SelectItem value="segment">句段</SelectItem><SelectItem value="none">无</SelectItem></SelectContent>
            </Select>
          </label>
        </>}
      </div>
      <div className="flex items-center gap-3">
        <Button size="sm" className="h-8 text-xs" disabled={saving || !form.label || !form.name || !form.baseUrl} onClick={() => void save()}>
          {saving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Plus className="mr-1 h-3 w-3" />}保存服务
        </Button>
        {message && <span className={`text-[11px] ${message.failed ? 'text-destructive' : 'text-muted-foreground'}`}>{message.text}</span>}
      </div>
    </section>
  );
}

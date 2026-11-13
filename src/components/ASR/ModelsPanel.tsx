// 设置 → 模型：推荐默认模型、按 Provider 列出模型、下载、选用，填写 FlyCut Cloud 的 API Key，以及添加 / 删除 HTTP 服务
import { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  Download,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Server,
  Trash2,
  X,
} from 'lucide-react';
import type { CloudStatus, EndpointInfo, EndpointInput } from '../../../shared/protocol';
import type { ModelInfo, ModelRef } from '../../../shared/providers';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { modelKey, useAppStore } from '@/stores/appStore';
import { useRuntimeStoreApi } from '@/stores/runtimeStore';
import { notifyProviderModelsChanged, useModelDownloads, useProviderModels } from '@/hooks/useProviderModels';
import { useClientRuntime } from '@/runtime/context';
import { useTranslation } from '@/contexts/LocaleProvider';
import { asrModelsCopy, formatModelsText } from '@/locales/models';
import { formatByteSize, modelStateSignature, pickDefaultOfflineAsrModel, shouldPreserveUserSelection } from '@/utils/modelRecommendation';
import { RecommendedModelCard } from './RecommendedModelCard';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function ModelsPanel() {
  const { asr } = useClientRuntime();
  const { language } = useTranslation();
  const mc = asrModelsCopy(language);
  const app = useRuntimeStoreApi('app');
  const asrModel = useAppStore(state => state.asrModel);
  const { groups, loading, error, refresh } = useProviderModels();
  const downloads = useModelDownloads();

  useEffect(() => {
    if (loading || !groups.length) return;
    const current = app.getState().asrModel;
    if (shouldPreserveUserSelection(groups, current)) return;
    const pick = pickDefaultOfflineAsrModel(groups);
    if (pick) app.getState().setASRModel({ providerId: pick.provider.id, modelId: pick.model.id });
  }, [loading, groups, app]);

  const download = async (ref: ModelRef, model: ModelInfo) => {
    try {
      await asr.prepareModel(ref, { expectedSignature: modelStateSignature(model) });
      const current = app.getState().asrModel;
      if (!current || !shouldPreserveUserSelection(groups, current)) {
        app.getState().setASRModel(ref);
      }
    } catch {
      // Download error state is persisted on ASRService and rendered inline
    }
  };

  return (
    <div className="space-y-4 pt-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{mc.panelHint}</p>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={`mr-1 h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
          {mc.refresh}
        </Button>
      </div>

      <RecommendedModelCard groups={groups} loading={loading} error={error} onRefresh={() => void refresh()} />

      {error && <p className="text-xs text-destructive">{error}</p>}

      {loading && !groups.length && (
        <div className="flex items-center gap-2 rounded-md border border-aimu-border p-4 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{mc.loading}</span>
        </div>
      )}

      {!loading && groups.length === 0 && (
        <div data-testid="models-empty" className="rounded-md border border-aimu-border p-6 text-center text-xs text-muted-foreground">
          {mc.nothingHere}
        </div>
      )}

      {groups.map(group => (
        <section key={group.provider.id} className="rounded-md border border-aimu-border">
          <header className="flex items-center justify-between gap-2 border-b border-aimu-border px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{group.provider.name}</span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {group.provider.kind === 'builtin' ? mc.builtinBadge : mc.endpointBadge}
              </span>
              <code className="text-[10px] text-muted-foreground">{group.provider.id}</code>
            </div>
          </header>
          {group.error && (
            <p className="flex items-start gap-1 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
              {group.error}
            </p>
          )}
          <ul className="divide-y divide-aimu-border">
            {group.models.map(model => {
              const ref = { providerId: group.provider.id, modelId: model.id };
              const dl = downloads[modelKey(ref)];
              const busy = dl?.status === 'downloading' || dl?.status === 'verifying';
              const verifying = dl?.status === 'verifying' || dl?.phase === 'verifying';
              const selected = asrModel?.providerId === ref.providerId && asrModel.modelId === ref.modelId;
              const byteText = busy && dl?.downloadedBytes !== undefined
                ? `${formatByteSize(dl.downloadedBytes)}${dl.totalBytes ? ` / ${formatByteSize(dl.totalBytes)}` : ''}`
                : '';
              const statusLine = busy
                ? [mc.processing, dl?.message, byteText, dl?.progress !== undefined ? `${Math.round(dl.progress)}%` : ''].filter(Boolean).join(' · ')
                : dl?.status === 'error'
                  ? (dl.staleConflict ? `${mc.staleConflict} — ${mc.staleConflictHint}` : dl.error)
                  : dl?.status === 'completed' && model.status === 'ready'
                    ? mc.completed
                    : undefined;

              return (
                <li key={model.id} className="flex items-start justify-between gap-3 px-3 py-2">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="font-medium">{model.name}</span>
                      <span className="rounded border px-1 text-[10px] text-muted-foreground">{mc.roles[model.role]}</span>
                      {model.size && <span className="text-[10px] text-muted-foreground">{model.size}</span>}
                      {model.offline && <span className="text-[10px] text-muted-foreground">{mc.offlineYes}</span>}
                      {model.timestampLevel === 'word' && <span className="text-[10px] text-muted-foreground">{mc.wordTimestampTag}</span>}
                      {model.recommended && <span className="text-[10px] text-aimu-coral">{mc.recommendedTag}</span>}
                    </div>
                    {model.description && <p className="text-[11px] text-muted-foreground">{model.description}</p>}
                    {model.status === 'unavailable' && model.reason && <p className="text-[11px] text-destructive">{model.reason}</p>}
                    {statusLine && (
                      <p className={`truncate text-[11px] ${dl?.status === 'error' ? 'text-destructive' : dl?.status === 'completed' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>
                        {statusLine}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {model.status === 'download' && !busy && dl?.status !== 'error' && (
                      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => void download(ref, model)}>
                        <Download className="mr-1 h-3 w-3" />
                        {mc.download}
                      </Button>
                    )}
                    {busy && (
                      <>
                        <Button variant="outline" size="sm" className="h-7 text-xs" disabled>
                          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                          {mc.processing}
                        </Button>
                        <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={verifying} onClick={() => asr.cancelPrepare(ref)}>
                          <X className="mr-1 h-3 w-3" />
                          {mc.cancel}
                        </Button>
                      </>
                    )}
                    {dl?.status === 'error' && !busy && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => {
                            if (dl.staleConflict) void refresh();
                            else void download(ref, model);
                          }}
                        >
                          <RotateCcw className="mr-1 h-3 w-3" />
                          {mc.retry}
                        </Button>
                        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => asr.resetDownloadState(ref)}>
                          {mc.back}
                        </Button>
                      </>
                    )}
                    {model.role === 'asr' && model.status === 'ready' && (selected
                      ? <span className="inline-flex items-center gap-1 text-[11px] text-primary"><CheckCircle2 className="h-3 w-3" />{mc.inUse}</span>
                      : <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => app.getState().setASRModel(ref)}>{mc.use}</Button>)}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <CloudSection />
      <EndpointsSection />
    </div>
  );
}

/** Shown only when the release configures FlyCut Cloud; the key stays in Host memory. */
function CloudSection() {
  const { connection } = useClientRuntime();
  const { language } = useTranslation();
  const mc = asrModelsCopy(language);
  const [status, setStatus] = useState<CloudStatus>();
  const [apiKey, setApiKey] = useState('');
  const [message, setMessage] = useState<{ text: string; failed?: boolean }>();
  useEffect(() => { connection.call('cloud.status').then(setStatus, () => setStatus(undefined)); }, [connection]);
  if (!status?.available) return null;

  const save = async (value: string) => {
    setMessage(undefined);
    try {
      setStatus(await connection.call('cloud.setApiKey', { apiKey: value }));
      setApiKey('');
      setMessage({ text: value ? mc.cloudSaved : mc.cloudCleared });
      notifyProviderModelsChanged();
    } catch (reason) {
      setMessage({ text: errorText(reason), failed: true });
    }
  };

  return (
    <section className="space-y-2 rounded-md border border-aimu-border p-3">
      <div className="flex items-center gap-2">
        <Cloud className="h-4 w-4 text-aimu-coral" />
        <div>
          <h3 className="text-sm font-medium">{mc.cloudTitle}</h3>
          <p className="text-[11px] text-muted-foreground">{mc.cloudDesc}</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Input
          className="h-8 text-xs"
          type="password"
          autoComplete="off"
          value={apiKey}
          placeholder={status.hasApiKey ? mc.apiKeyReplacePlaceholder : mc.apiKeyPlaceholder}
          onChange={e => setApiKey(e.target.value)}
        />
        <Button size="sm" className="h-8 text-xs" disabled={!apiKey} onClick={() => void save(apiKey)}>
          <KeyRound className="mr-1 h-3 w-3" />
          {mc.save}
        </Button>
        {status.hasApiKey && <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => void save('')}>{mc.clear}</Button>}
      </div>
      {message && <p className={`text-[11px] ${message.failed ? 'text-destructive' : 'text-muted-foreground'}`}>{message.text}</p>}
    </section>
  );
}

const EMPTY_FORM = { label: '', name: '', protocol: 'flycut' as EndpointInput['protocol'], baseUrl: '', apiKey: '', models: '', timestamps: 'segment' as 'none' | 'segment' | 'word' };

function EndpointsSection() {
  const { connection } = useClientRuntime();
  const { language } = useTranslation();
  const mc = asrModelsCopy(language);
  const [endpoints, setEndpoints] = useState<EndpointInfo[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [message, setMessage] = useState<{ text: string; failed?: boolean }>();
  const [saving, setSaving] = useState(false);
  const load = () => connection.call('endpoints.list').then(setEndpoints, reason => setMessage({ text: errorText(reason), failed: true }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [connection]);
  const update = (patch: Partial<typeof form>) => setForm(state => ({ ...state, ...patch }));

  const save = async () => {
    setSaving(true);
    setMessage(undefined);
    try {
      const input: EndpointInput = {
        name: form.name.trim(),
        label: form.label.trim(),
        protocol: form.protocol,
        baseUrl: form.baseUrl.trim(),
        ...(form.apiKey ? { apiKey: form.apiKey } : {}),
        ...(form.protocol === 'openai' ? { models: form.models.split(/[,，\s]+/).filter(Boolean).map(id => ({ id, timestamps: form.timestamps })) } : {}),
      };
      const saved = await connection.call('endpoints.save', input);
      setForm(EMPTY_FORM);
      setMessage({ text: formatModelsText(mc.serviceSaved, { label: saved.label, providerId: saved.providerId }) });
      await load();
      notifyProviderModelsChanged();
    } catch (reason) {
      setMessage({ text: errorText(reason), failed: true });
    } finally {
      setSaving(false);
    }
  };
  const remove = async (name: string) => {
    try {
      await connection.call('endpoints.remove', { name });
      await load();
      notifyProviderModelsChanged();
    } catch (reason) {
      setMessage({ text: errorText(reason), failed: true });
    }
  };
  const edit = (endpoint: EndpointInfo) => setForm({
    ...EMPTY_FORM,
    label: endpoint.label,
    name: endpoint.name,
    protocol: endpoint.protocol,
    baseUrl: endpoint.baseUrl,
    models: endpoint.models?.map(model => model.id).join(', ') ?? '',
    timestamps: endpoint.models?.[0]?.timestamps ?? 'segment',
  });

  return (
    <section className="space-y-3 rounded-md border border-dashed border-aimu-border p-3">
      <div className="flex items-center gap-2">
        <Server className="h-4 w-4 text-aimu-coral" />
        <div>
          <h3 className="text-sm font-medium">{mc.addServiceTitle}</h3>
          <p className="text-[11px] text-muted-foreground">{mc.addServiceDesc}</p>
        </div>
      </div>
      {endpoints.length > 0 ? (
        <ul className="space-y-1">
          {endpoints.map(endpoint => (
            <li key={endpoint.name} className="flex items-center justify-between gap-2 rounded bg-muted/40 px-2 py-1 text-xs">
              <button type="button" className="min-w-0 truncate text-left hover:underline" onClick={() => edit(endpoint)} title={mc.editTitle}>
                {endpoint.label} · <code className="text-[10px]">{endpoint.providerId}</code> · {endpoint.baseUrl}{endpoint.hasApiKey ? '' : ` · ${mc.noKeySet}`}
              </button>
              <button type="button" aria-label={mc.deleteServiceLabel} className="text-muted-foreground hover:text-destructive" onClick={() => void remove(endpoint.name)}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[11px] text-muted-foreground">{mc.noEndpoints}</p>
      )}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <label className="space-y-1"><span className="text-muted-foreground">{mc.displayNameLabel}</span><Input className="h-8 text-xs" value={form.label} placeholder={mc.displayNamePlaceholder} onChange={e => update({ label: e.target.value })} /></label>
        <label className="space-y-1"><span className="text-muted-foreground">{mc.serviceIdLabel}</span><Input className="h-8 text-xs" value={form.name} placeholder={mc.serviceIdPlaceholder} onChange={e => update({ name: e.target.value })} /></label>
        <label className="space-y-1"><span className="text-muted-foreground">{mc.protocolLabel}</span>
          <Select value={form.protocol} onValueChange={value => update({ protocol: value as EndpointInput['protocol'] })}>
            <SelectTrigger size="sm" className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="flycut">{mc.flycutProtocol}</SelectItem><SelectItem value="openai">{mc.openaiProtocol}</SelectItem></SelectContent>
          </Select>
        </label>
        <label className="space-y-1"><span className="text-muted-foreground">{mc.baseUrlLabel}</span><Input className="h-8 text-xs" value={form.baseUrl} placeholder={form.protocol === 'openai' ? 'https://api.example.com/v1' : 'http://192.168.1.20:9000'} onChange={e => update({ baseUrl: e.target.value })} /></label>
        <label className="col-span-2 space-y-1"><span className="text-muted-foreground">{mc.apiKeyOptionalLabel}</span><Input className="h-8 text-xs" type="password" autoComplete="off" value={form.apiKey} onChange={e => update({ apiKey: e.target.value })} /></label>
        {form.protocol === 'openai' && <>
          <label className="space-y-1"><span className="text-muted-foreground">{mc.modelNamesLabel}</span><Input className="h-8 text-xs" value={form.models} placeholder={mc.modelNamesPlaceholder} onChange={e => update({ models: e.target.value })} /></label>
          <label className="space-y-1"><span className="text-muted-foreground">{mc.timestampsLabel}</span>
            <Select value={form.timestamps} onValueChange={value => update({ timestamps: value as typeof form.timestamps })}>
              <SelectTrigger size="sm" className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="word">{mc.tsWord}</SelectItem><SelectItem value="segment">{mc.tsSegment}</SelectItem><SelectItem value="none">{mc.tsNone}</SelectItem></SelectContent>
            </Select>
          </label>
        </>}
      </div>
      <div className="flex items-center gap-3">
        <Button size="sm" className="h-8 text-xs" disabled={saving || !form.label || !form.name || !form.baseUrl} onClick={() => void save()}>
          {saving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Plus className="mr-1 h-3 w-3" />}
          {mc.saveService}
        </Button>
        {message && <span className={`text-[11px] ${message.failed ? 'text-destructive' : 'text-muted-foreground'}`}>{message.text}</span>}
      </div>
    </section>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { Button } from '@/components/ui/button';
import { useClientRuntime } from '@/runtime/context';

interface RuntimeModel { id: string; name?: string; provider?: string; family?: string }
interface RuntimeConfig { catalog?: string; roots?: string[] }

/** Browser-side model view. Filesystem configuration belongs to the Runtime. */
export function PythonRuntimePanel() {
  const { connection } = useClientRuntime();
  const setModel = useAppStore(s => s.setASRModelId);
  const setEngine = useAppStore(s => s.setASREngineType);
  const activeModelId = useAppStore(s => s.asrModelId);
  const busy = useAppStore(s => s.isLoading);
  const [models, setModels] = useState<RuntimeModel[]>([]);
  const [config, setConfig] = useState<RuntimeConfig>({});
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [data, runtimeConfig] = await Promise.all([
        connection.call('python.request', { path: '/v1/models' }) as Promise<{ models?: RuntimeModel[] }>,
        connection.call('python.request', { path: '/v1/runtime/config' }) as Promise<RuntimeConfig>,
      ]);
      setModels(data.models ?? []);
      setConfig(runtimeConfig);
      setMessage('Python Runtime 已连接');
    } catch {
      setMessage('无法读取模型。请检查 FlyCut Host 和 Python 运行环境。');
    }
  }, [connection]);

  useEffect(() => { void refresh(); }, [refresh]);

  return <details className="rounded-md border p-3 space-y-3">
    <summary className="text-sm font-medium cursor-pointer">Python Runtime 模型</summary>
    <p className="text-xs text-muted-foreground">Web 端只读取本机 Python Runtime 的默认模型清单，不访问本机路径，也不上传模型文件。要添加模型，请编辑 Runtime 默认目录中的 JSON 配置后刷新。</p>
    <p className="text-xs text-muted-foreground">支持 Qwen ASR、FunASR 和 sherpa-onnx。FunASR 可登记不同主模型，并在配置中搭配 VAD、标点恢复和 CAM++ 说话人模型。</p>
    {config.catalog && <p className="text-[11px] text-muted-foreground">模型配置文件：{config.catalog}</p>}
    {config.roots?.length ? <p className="text-[11px] text-muted-foreground">模型根目录：{config.roots.join('、')}</p> : null}
    <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => void refresh()}>刷新模型清单</Button></div>
    {models.length > 0 ? <div className="space-y-1 text-xs">{models.map(model => <button key={model.id} type="button" disabled={busy} aria-pressed={activeModelId === model.id} className="block w-full rounded border px-2 py-1 text-left hover:bg-muted aria-pressed:border-primary aria-pressed:bg-muted disabled:opacity-50" onClick={() => { setModel(model.id); setEngine('python-runtime'); }}>{model.name || model.id} · {model.provider || 'qwen-asr'} · {model.id}</button>)}</div> : <p className="text-xs text-muted-foreground">Runtime 当前没有已登记模型。</p>}
    {message && <p role="status" className="text-xs whitespace-pre-wrap break-all text-muted-foreground">{message}</p>}
  </details>;
}

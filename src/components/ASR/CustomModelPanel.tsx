import { useState } from 'react';
import { pickDirectory } from '@/utils/nativeDialogs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { AvailableModel } from '@/types/model';
import { createQwenModelPreset, notifyModelCatalogChanged } from '@/services/customModelCatalog';
import { useAppStore } from '@/stores/appStore';
import { useClientRuntime } from '@/runtime/context';

export function CustomModelPanel({ models, disabled }: { models: AvailableModel[]; disabled: boolean }) {
  const { connection, stores } = useClientRuntime();
  const [definition, setDefinition] = useState(() => JSON.stringify(createQwenModelPreset(), null, 2));
  const [localPath, setLocalPath] = useState('');
  const [python, setPython] = useState('');
  const [aligner, setAligner] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const isLoading = useAppStore(s => s.isLoading);
  const selected = useAppStore(s => s.asrModelId);
  const setSelected = useAppStore(s => s.setASRModelId);
  const locked = disabled || busy || isLoading;

  async function action(run: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try { await run(); } catch (error) { setMessage(String(error)); } finally { setBusy(false); }
  }

  return <details className="rounded-md border p-3 space-y-3">
    <summary className="text-sm font-medium cursor-pointer">自定义模型 / Provider</summary>
    <p className="text-xs text-muted-foreground">选择已下载的模型目录，或添加下载配置后在模型列表中下载。Qwen 需要独立 Python 环境：在该环境运行 pip install -U qwen-asr。</p>
    <fieldset disabled={locked} className="space-y-3 disabled:opacity-60">
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => setDefinition(JSON.stringify(createQwenModelPreset('0.6B'), null, 2))}>Qwen 0.6B 模板</Button>
        <Button size="sm" variant="outline" onClick={() => setDefinition(JSON.stringify(createQwenModelPreset('1.7B'), null, 2))}>Qwen 1.7B 模板</Button>
      </div>
      <label className="block text-xs space-y-1">
        <span>本地模型目录（留空则使用清单中的下载源）</span>
        <div className="flex gap-2">
          <Input value={localPath} onChange={e => setLocalPath(e.target.value)} placeholder="/path/to/Qwen3-ASR-0.6B" />
          <Button variant="outline" size="sm" onClick={() => void action(async () => {
            const path = await pickDirectory();
            if (path) setLocalPath(path);
          })}>选择目录</Button>
        </div>
      </label>
      <label className="block text-xs space-y-1">
        <span>Qwen Python 可执行文件（可选，留空使用 python3 / python）</span>
        <Input value={python} onChange={e => setPython(e.target.value)} placeholder="/path/to/venv/bin/python" />
      </label>
      <label className="block text-xs space-y-1">
        <span>Qwen ForcedAligner 本地目录（可选，用于字词时间戳）</span>
        <Input value={aligner} onChange={e => setAligner(e.target.value)} placeholder="/path/to/Qwen3-ForcedAligner-0.6B" />
      </label>
      <details>
        <summary className="text-xs cursor-pointer">模型清单 JSON（修改名称、ID、下载镜像、Provider 或设备）</summary>
        <div className="mt-2 flex items-center gap-2">
          <label className="inline-flex cursor-pointer items-center rounded border px-2 py-1 text-xs hover:bg-muted">
            导入 JSON
            <input
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={e => {
                const file = e.target.files?.[0];
                if (!file) return;
                void file.text().then(setDefinition).catch(error => setMessage(`读取清单失败：${String(error)}`));
                e.currentTarget.value = '';
              }}
            />
          </label>
          <Button type="button" size="sm" variant="ghost" onClick={() => {
            const blob = new Blob([definition], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = 'flycut-model.json';
            link.click();
            URL.revokeObjectURL(url);
          }}>导出 JSON</Button>
        </div>
        <textarea aria-label="自定义模型清单 JSON" className="mt-2 w-full h-64 rounded border p-2 font-mono text-xs bg-background" value={definition} onChange={e => setDefinition(e.target.value)} />
      </details>
      <p className="text-xs text-muted-foreground">支持 qwen-asr 与 sherpa-onnx。模型格式必须匹配 Provider；Qwen 的 *-hf 格式不适用此模板。未配置对齐模型时仅支持分段剪切。</p>
      <Button size="sm" onClick={() => void action(async () => {
        const model: AvailableModel = JSON.parse(definition);
        delete model.custom;
        model.local_path = localPath.trim() || null;
        if (model.provider === 'qwen-asr') {
          if (python.trim()) model.recognizer_config.python_path = python.trim();
          if (aligner.trim()) model.recognizer_config.forced_aligner = aligner.trim();
        }
        await connection.call('models.registerCustom', { model });
        if (model.local_path) { setSelected(model.id); stores.app.getState().setASREngineType('python-runtime'); }
        notifyModelCatalogChanged();
        setMessage(model.local_path ? '本地模型已添加并选中，可检查运行环境后开始识别。' : '模型配置已添加，请在列表中下载。');
      })}>{busy ? '处理中…' : '添加模型'}</Button>
      {models.filter(m => m.custom).map(model => <div key={model.id} className="border-t pt-2 space-y-2">
        <p className="text-xs break-all">{model.name} · {model.provider} {model.local_path && `· ${model.local_path}`}</p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void action(async () => {
            const status = await connection.call('models.environment', { modelId: model.id });
            setMessage(status.modelReady && status.sidecarReady ? `${model.name}：模型和运行环境可用` : [status.modelError, status.sidecarError, ...status.missingModelFiles].filter(Boolean).join('；'));
          })}>检查运行环境</Button>
          <Button size="sm" variant="ghost" onClick={() => void action(async () => {
            await connection.call('models.removeCustom', { modelId: model.id });
            if (selected === model.id) {
              setSelected(models.find(m => !m.custom)?.id ?? 'sensevoice-small-int8-zh-en-ja-ko-yue-2024-07-17');
            }
            notifyModelCatalogChanged();
            setMessage('已移除配置，模型文件仍保留。');
          })}>移除配置</Button>
        </div>
      </div>)}
    </fieldset>
    {message && <p role="status" className="text-xs whitespace-pre-wrap break-all">{message}</p>}
  </details>;
}

import { useEffect, useState } from 'react';
import { pickDirectory } from '@/utils/nativeDialogs';
import type { ModelScanResult } from '../../../shared/protocol';
import { notifyModelCatalogChanged } from '@/services/customModelCatalog';
import { useAppStore } from '@/stores/appStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useClientRuntime } from '@/runtime/context';


export function ModelLibraryPanel({ disabled }: { disabled: boolean }) {
  const { connection } = useClientRuntime();
  const [root, setRoot] = useState('');
  const [result, setResult] = useState<ModelScanResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [python, setPython] = useState('');
  const [aligner, setAligner] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const asrBusy = useAppStore(s => s.isLoading);
  const locked = disabled || busy || asrBusy;
  useEffect(() => { connection.call('models.libraryRoot').then(path => { if (path) setRoot(path); }).catch(error => setMessage(String(error))); }, [connection]);
  const scan = async (path: string) => {
    setBusy(true); setMessage(''); setResult(null); setSelected(new Set());
    try {
      const next = await connection.call('models.scan', { root: path.trim() });
      setRoot(next.root); setResult(next);
      setSelected(new Set(next.entries.filter(entry => entry.model && !entry.registered).map(entry => entry.path)));
      setMessage(`发现 ${next.entries.filter(entry => entry.model).length} 个可登记的 ASR 模型。请选择后添加。`);
    } catch (error) { setMessage(String(error)); } finally { setBusy(false); }
  };
  return <details className="rounded-md border p-3 space-y-3">
    <summary className="text-sm font-medium cursor-pointer">本地模型文件夹</summary>
    <p className="text-xs text-muted-foreground">指定模型根目录，扫描其中的模型并统一加入列表。文件保留在原位置，识别时只加载当前选中的模型。支持根目录及最多 6 层子目录。</p>
    <fieldset disabled={locked} className="space-y-3 disabled:opacity-60">
      <label className="block text-xs space-y-1"><span>模型根目录</span><Input value={root} onChange={e => { setRoot(e.target.value); setResult(null); }} placeholder="/path/to/models" /></label>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => void (async () => {
          setBusy(true);
          try { const path = await pickDirectory(); if (path) await scan(path); }
          catch (error) { setMessage(String(error)); } finally { setBusy(false); }
        })()}>选择文件夹并扫描</Button>
        <Button size="sm" variant="outline" disabled={!root.trim()} onClick={() => void scan(root)}>重新扫描</Button>
      </div>
      <label className="block text-xs space-y-1"><span>Qwen Python 路径（可选）</span><Input value={python} onChange={e => setPython(e.target.value)} placeholder="/path/to/venv/bin/python" /></label>
      <label className="block text-xs space-y-1"><span>Qwen 对齐模型目录（可选，扫描到后可选择）</span>
        <Input list="scan-aligners" value={aligner} onChange={e => setAligner(e.target.value)} placeholder="/path/to/Qwen3-ForcedAligner-0.6B" />
        <datalist id="scan-aligners">{result?.entries.filter(e => e.kind === 'aligner').map(e => <option key={e.path} value={e.path} />)}</datalist>
      </label>
      {result && <div className="space-y-2 max-h-80 overflow-y-auto">
        {result.entries.map(entry => <div key={entry.path} className="border rounded p-2 space-y-1">
          <label className="flex items-start gap-2 text-xs">
            <input type="checkbox" disabled={!entry.model || entry.registered} checked={selected.has(entry.path)} onChange={e => setSelected(previous => { const next = new Set(previous); if (e.target.checked) next.add(entry.path); else next.delete(entry.path); return next; })} />
            <span>{entry.name} · {entry.registered ? '已添加' : entry.kind === 'asr' ? '可添加（待运行验证）' : entry.kind === 'aligner' ? '时间戳对齐模型' : entry.kind === 'vad' ? 'VAD 资源' : '不支持或文件不完整'}</span>
          </label>
          <p className="text-[11px] text-muted-foreground break-all">{entry.path}</p>
          {entry.warnings.map(warning => <p key={warning} className="text-[11px] text-amber-700 dark:text-amber-400 break-all">{warning}</p>)}
        </div>)}
        {!result.entries.length && <p className="text-xs text-muted-foreground">未找到模型。请先下载并解压完整模型，或添加 flycut-model.json 描述文件。</p>}
        {result.warnings.map(warning => <p key={warning} className="text-xs text-amber-700">{warning}</p>)}
      </div>}
      <Button size="sm" disabled={!result || !selected.size} onClick={() => void (async () => {
        setBusy(true); const errors: string[] = []; let added = 0;
        const imported = new Set<string>();
        for (const entry of result?.entries ?? []) {
          if (!entry.model || !selected.has(entry.path)) continue;
          const model = structuredClone(entry.model);
          if (model.provider === 'qwen-asr') {
            if (python.trim()) model.recognizer_config.python_path = python.trim();
            if (aligner.trim()) model.recognizer_config.forced_aligner = aligner.trim();
          }
          try { await connection.call('models.registerCustom', { model }); added++; imported.add(entry.path); }
          catch (error) { errors.push(`${entry.name}：${String(error)}`); }
        }
        if (added) notifyModelCatalogChanged();
        setResult(previous => previous ? { ...previous, entries: previous.entries.map(entry => imported.has(entry.path) ? { ...entry, registered: true } : entry) } : previous);
        setSelected(previous => new Set([...previous].filter(path => !imported.has(path))));
        setMessage(`已添加 ${added} 个模型。可在模型列表点击“使用此模型”。${errors.length ? '\n' + errors.join('\n') : ''}`);
        setBusy(false);
      })()}>添加所选模型（{selected.size}）</Button>
    </fieldset>
    {message && <p role="status" className="text-xs whitespace-pre-wrap break-all">{message}</p>}
  </details>;
}

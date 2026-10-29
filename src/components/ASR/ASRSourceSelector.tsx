import { useASRApiStore } from '@/stores/asrApiStore';
import { useAppStore } from '@/stores/appStore';
import { getRuntimeAsrEngineType } from '@/utils/runtime';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { isTauriRuntime } from '@/utils/runtime';

export function ASRSourceSelector({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const engine = useAppStore(s => s.asrEngineType);
  const setEngine = useAppStore(s => s.setASREngineType);
  const busy = useAppStore(s => s.isLoading);
  const configs = useASRApiStore(s => s.configs);
  const selected = useASRApiStore(s => s.selectedId);
  const select = useASRApiStore(s => s.select);
  const pythonValue = 'python-runtime';
  return <div className="space-y-1">
    <label className="text-xs text-muted-foreground">识别来源</label>
    <Select value={engine === 'api' ? selected ? `api:${selected}` : 'api:missing' : engine === pythonValue ? pythonValue : 'local'} disabled={busy} onValueChange={value => {
      if (value === 'local') setEngine(getRuntimeAsrEngineType());
      else if (value === pythonValue) setEngine('python-runtime');
      else { select(value.slice(4)); setEngine('api'); }
    }}>
      <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="local">本地模型</SelectItem>
        {!isTauriRuntime() && <SelectItem value={pythonValue}>Python 本地服务</SelectItem>}
        {configs.map(config => <SelectItem key={config.id} value={`api:${config.id}`}>API · {config.name} / {config.model}</SelectItem>)}
        {engine === 'api' && !configs.some(c => c.id === selected) && <SelectItem value="api:missing" disabled>请添加或选择 ASR API</SelectItem>}
      </SelectContent>
    </Select>
    {onOpenSettings && <button type="button" disabled={busy} className="text-xs text-primary hover:underline" onClick={onOpenSettings}>管理本地模型与 ASR API</button>}
  </div>;
}

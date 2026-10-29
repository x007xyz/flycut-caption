import { Puzzle } from 'lucide-react';
import { useHostQuery } from '@/runtime/hooks';

export function PluginRegistryPanel() {
  const { data: plugins = [], error } = useHostQuery('editing.list');
  return (
    <section className="pt-4 mt-4 border-t border-aimu-border space-y-3">
      <div className="flex items-center gap-2">
        <Puzzle className="h-4 w-4 text-aimu-coral" />
        <div>
          <h3 className="text-sm font-medium text-aimu-text-primary">编辑插件</h3>
          <p className="text-xs text-aimu-text-muted">插件负责分析内容并返回可撤销的编辑操作。</p>
        </div>
      </div>
      {error && <p role="alert" className="text-xs text-destructive">无法读取 Host 编辑插件：{error}</p>}
      <div className="space-y-2">
        {plugins.map((plugin) => (
          <div key={plugin.id} className="rounded-md border border-aimu-border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium">{plugin.name}</span>
              <span className={`text-[10px] ${plugin.status === 'available' ? 'text-emerald-600' : 'text-amber-600'}`}>{plugin.status === 'available' ? '可用' : '待接入'}</span>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">{plugin.description}</p>
            <p className="mt-1 text-[10px] text-muted-foreground">输入：{plugin.input.join('、')} · 输出：{plugin.output.join('、')}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

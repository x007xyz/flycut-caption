import { Check, Loader2, Music, Play, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { SeparationController } from '@/hooks/useSeparation';

export function SeparationPanel({ state }: { state: SeparationController }) {
  if (!state.open) return null;
  return <section data-testid="separation-panel" data-phase={state.phase} className="border-b border-aimu-border bg-aimu-panel p-2 text-xs">
    <div className="flex items-center gap-2">
      <strong className="flex items-center gap-1 text-aimu-text-primary"><Music className="h-3.5 w-3.5" />人声分离 / Separation</strong>
      {state.modelName && <span className="rounded bg-aimu-purple/10 px-1.5 py-0.5 text-[10px] text-aimu-purple">{state.modelName}</span>}
      <span className="ml-auto" />
      <Button size="sm" variant="ghost" onClick={state.closePanel} disabled={state.phase === 'running'}><X className="h-3.5 w-3.5" /></Button>
    </div>
    {state.phase === 'running' && <div className="mt-2 space-y-1">
      <p role="status" data-testid="separation-progress" className="flex items-center gap-1 text-aimu-text-secondary"><Loader2 className="h-3 w-3 animate-spin" />正在处理… {state.progress}%</p>
      <Button size="sm" variant="outline" data-testid="separation-cancel" onClick={state.cancel}>取消 / Cancel</Button>
    </div>}
    {(state.phase === 'ready' || state.phase === 'idle' || state.phase === 'completed') && <>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button size="sm" data-testid="separation-analyze" disabled={!state.modelName} onClick={() => void state.analyze()}>
          {state.record ? '重新生成 / Regenerate' : '开始分离 / Separate'}
        </Button>
        {state.record && <>
          <span data-testid="separation-completed" className="flex items-center gap-1 text-emerald-700 dark:text-emerald-300"><Check className="h-3 w-3" />已完成 / Completed · {state.record.durationSeconds.toFixed(1)}s · {state.record.sampleRate}Hz</span>
          <Button size="sm" variant="outline" data-testid="separation-play-vocals" onClick={() => void state.play('vocals')}><Play className="h-3 w-3" />人声</Button>
          <Button size="sm" variant="outline" data-testid="separation-play-background" onClick={() => void state.play('background')}><Play className="h-3 w-3" />背景</Button>
        </>}
      </div>
      {state.phase === 'completed' && <p className="mt-1 text-[10px] text-aimu-text-muted">产物已缓存到项目；原音频未修改。播放器暂用原音轨，混音导出见 F-0037。</p>}
    </>}
    {state.phase === 'error' && <div role="alert" data-testid="separation-error" className="mt-2 rounded border border-aimu-coral/40 bg-aimu-red-bg p-2 text-aimu-coral">
      <p>{state.error ?? '人声分离失败'}</p>
      <Button size="sm" variant="outline" onClick={() => void state.analyze()}>重试 / Retry</Button>
    </div>}
  </section>;
}

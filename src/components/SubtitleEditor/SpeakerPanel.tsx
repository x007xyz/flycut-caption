import { AlertTriangle, Check, Loader2, Users, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { SpeakerController } from '@/hooks/useSpeakers';

export function SpeakerPanel({ state }: { state: SpeakerController }) {
  if (!state.open) return null;
  return <section data-testid="speaker-panel" className="border-b border-aimu-border bg-aimu-panel p-2 text-xs">
    <div className="flex flex-wrap items-center gap-2">
      <strong className="flex items-center gap-1 text-aimu-text-primary"><Users className="h-3.5 w-3.5" />说话人 / Speakers</strong>
      {state.modelName && <span className="rounded bg-aimu-purple/10 px-1.5 py-0.5 text-[10px] text-aimu-purple">{state.modelName}</span>}
      <span className="ml-auto" />
      <Button size="sm" variant="ghost" onClick={state.closePanel} disabled={state.phase === 'running'}><X className="h-3.5 w-3.5" /></Button>
    </div>
    {!state.modelName && <p data-testid="speaker-no-model" className="mt-2 text-aimu-text-muted">暂无内容 / Nothing here yet：缺少说话人模型。</p>}
    {state.phase === 'running' && <div className="mt-2 space-y-1">
      <p role="status" data-testid="speaker-progress" className="flex items-center gap-1 text-aimu-text-secondary"><Loader2 className="h-3 w-3 animate-spin" />正在处理… {state.progress}%</p>
      <Button size="sm" variant="outline" data-testid="speaker-cancel" onClick={state.cancel}>取消 / Cancel</Button>
    </div>}
    {(state.phase === 'ready' || state.phase === 'idle' || state.phase === 'completed') && <>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button size="sm" data-testid="speaker-analyze" disabled={!state.modelName} onClick={() => void state.analyze()}>
          {state.phase === 'completed' ? '重新分析 / Analyze again' : '分析说话人 / Analyze'}
        </Button>
        <Button size="sm" variant="outline" data-testid="speaker-save-names" disabled={!state.speakers.length} onClick={() => void state.saveNames()}>保存名称 / Save names</Button>
        <Button size="sm" variant="outline" data-testid="speaker-save-voices" disabled={!state.speakers.length} onClick={() => void state.saveVoices()}>保存音色映射 / Save voices</Button>
        <Button size="sm" variant="ghost" data-testid="speaker-show-all" onClick={() => state.setFilter(null)}>显示全部 / Show all</Button>
      </div>
      {state.phase === 'completed' && state.speakers.length === 0 && <p className="mt-2 text-aimu-text-muted">没有识别到说话人区间。</p>}
      {state.speakers.length > 0 && <div data-testid="speaker-list" className="mt-2 space-y-1">
        {state.speakers.map(speaker => <div key={speaker.id} data-testid={`speaker-${speaker.id}`} className="flex items-center gap-1.5 rounded border border-aimu-border bg-background p-1.5">
          <span className="font-mono text-[10px] text-aimu-text-muted">{speaker.id}</span>
          <input data-testid={`speaker-name-${speaker.id}`} value={speaker.name} onChange={event => state.rename(speaker.id, event.target.value)}
            className="h-6 min-w-0 flex-1 rounded border border-aimu-border bg-aimu-input px-1.5 text-[11px]" />
          <span className="text-[10px] text-aimu-text-muted">{speaker.cueCount} 条</span>
          <select data-testid={`speaker-voice-${speaker.id}`} value={state.voices[speaker.id] ?? ''}
            onChange={event => state.setVoice(speaker.id, event.target.value)}
            className="h-6 max-w-[150px] rounded border border-aimu-border bg-aimu-input px-1 text-[10px]">
            <option value="">请指定音色</option>
            {state.voiceOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <Button size="sm" variant={state.filter === speaker.id ? 'secondary' : 'ghost'} data-testid={`speaker-filter-${speaker.id}`}
            onClick={() => state.setFilter(state.filter === speaker.id ? null : speaker.id)}>
            {state.filter === speaker.id ? <Check className="mr-1 h-3 w-3" /> : null}只看
          </Button>
        </div>)}
      </div>}
      {state.filter && <p className="mt-1 text-[10px] text-aimu-text-muted">当前只显示说话人 {state.filter}；过滤不会删除字幕或改变导出。</p>}
    </>}
    {state.phase === 'error' && <div role="alert" data-testid="speaker-error" className="mt-2 rounded border border-aimu-coral/40 bg-aimu-red-bg p-2 text-aimu-coral">
      <p><AlertTriangle className="mr-1 inline h-3 w-3" />{state.error ?? '说话人分析失败'}</p>
      <Button size="sm" variant="outline" onClick={() => void state.analyze()}>重试 / Retry</Button>
    </div>}
  </section>;
}

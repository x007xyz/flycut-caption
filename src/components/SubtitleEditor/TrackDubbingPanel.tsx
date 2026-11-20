import { AlertTriangle, Check, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { TrackDubbingState } from '@/hooks/useTrackDubbing';

export function TrackDubbingPanel({ state }: { state: TrackDubbingState }) {
  if (!state.open) return null;
  return <section data-testid="track-dubbing-panel" data-phase={state.phase} className="border-b border-aimu-border bg-aimu-panel p-2 text-xs">
    <div className="flex flex-wrap items-center gap-2">
      <strong className="text-aimu-text-primary">整段配音 / Dub track</strong>
      {state.modelName && <span className="rounded bg-aimu-purple/10 px-1.5 py-0.5 text-[10px] text-aimu-purple">{state.modelName}</span>}
      {state.voiceProfiles.length > 0 && <select data-testid="track-dubbing-voice" value={state.voiceProfileId ?? ''}
        onChange={event => state.setVoiceProfileId(event.target.value || undefined)}
        className="h-6 rounded border border-aimu-border bg-aimu-input px-1 text-[10px]">
        {state.voiceProfiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
      </select>}
      <span className="text-aimu-text-muted">{state.cueCount} 条已确认译文</span>
      <span className="ml-auto" />
      <Button size="sm" variant="ghost" data-testid="track-dubbing-close" disabled={state.phase === 'running'} onClick={state.closePanel}>
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>

    {state.phase === 'loading' && <p role="status" className="mt-2 flex items-center gap-1 text-aimu-text-muted"><Loader2 className="h-3 w-3 animate-spin" />正在加载…</p>}

    {(state.phase === 'idle' || state.phase === 'ready') && <>
      {state.cueCount === 0 && <p className="mt-2 text-aimu-text-muted">暂无内容 / Nothing here yet：请先确认译文并选择 TTS 模型。</p>}
      <div className="mt-2 flex gap-1.5">
        <Button size="sm" data-testid="track-dubbing-start" disabled={!state.modelName || state.cueCount === 0} onClick={() => void state.start()}>
          开始整段配音 / Start
        </Button>
      </div>
    </>}

    {state.phase === 'running' && <div className="mt-2 space-y-1">
      <p role="status" data-testid="track-dubbing-progress" className="flex items-center gap-1 text-aimu-text-secondary">
        <Loader2 className="h-3 w-3 animate-spin" />正在处理… {state.progress}%
      </p>
      {state.statusText && <p className="text-aimu-text-muted">{state.statusText}</p>}
      <Button size="sm" variant="outline" data-testid="track-dubbing-cancel" onClick={state.cancel}>取消 / Cancel</Button>
    </div>}

    {state.phase === 'completed' && <div className="mt-2 space-y-1">
      <p role="status" data-testid="track-dubbing-completed" className="flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
        <Check className="h-3.5 w-3.5" />已完成 / Completed：{state.savedCount} 条
      </p>
      {state.unresolved.length > 0 && <div role="alert" data-testid="track-dubbing-unresolved" className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-amber-800 dark:text-amber-200">
        <p className="flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5" />{state.unresolved.length} 条未解决（超长或失败），未被截断或顺延。</p>
        <p className="mt-0.5 text-[11px] text-aimu-text-muted">{state.unresolved.map(item => `${item.chunkId}: ${item.reason}${item.message ? ` (${item.message})` : ''}`).join(' · ')}</p>
      </div>}
    </div>}

    {state.cues.length > 0 && (state.phase === 'ready' || state.phase === 'completed' || state.phase === 'idle') && <div data-testid="track-dubbing-cues" className="mt-2 max-h-48 space-y-1 overflow-y-auto">
      {state.cues.map(cue => <div key={cue.id} data-testid={`track-dubbing-cue-${cue.id}`} className="rounded border border-aimu-border bg-background p-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-aimu-text-muted">{cue.id}</span>
          <span className="min-w-0 flex-1 truncate text-aimu-text-primary">{cue.text}</span>
          <span className="text-[10px] text-aimu-text-muted">{cue.artifact ? `${cue.artifact.durationSeconds.toFixed(2)}s / ${cue.targetSeconds.toFixed(2)}s` : `目标 ${cue.targetSeconds.toFixed(2)}s`}</span>
          {cue.artifact?.alignmentMode && <span className="rounded bg-aimu-purple/10 px-1 py-0.5 text-[10px] text-aimu-purple">{cue.artifact.alignmentMode}{cue.artifact.speed ? ` ${cue.artifact.speed}×` : ''}</span>}
          {cue.outdated && <span className="rounded bg-amber-400/20 px-1 py-0.5 text-[10px] text-amber-700">已过期</span>}
          {cue.unresolvedReason && <span className="rounded bg-aimu-coral/10 px-1 py-0.5 text-[10px] text-aimu-coral">未解决: {cue.unresolvedReason}</span>}
          <Button size="sm" variant="ghost" data-testid={`track-dubbing-redo-${cue.id}`} onClick={() => void state.redo(cue.id)}>重做</Button>
          {(cue.unresolvedReason || cue.outdated) && <Button size="sm" variant="outline" data-testid={`track-dubbing-shorten-${cue.id}`} onClick={() => void state.shorten(cue.id)}>AI 缩短</Button>}
        </div>
        {state.suggestions[cue.id] && <div className="mt-1 rounded bg-aimu-input p-1.5">
          <p className="text-[11px] text-aimu-text-secondary">建议：{state.suggestions[cue.id]}</p>
          <div className="mt-1 flex gap-1">
            <Button size="sm" data-testid={`track-dubbing-apply-${cue.id}`} onClick={() => void state.applyShorten(cue.id)}>确认并重做</Button>
          </div>
        </div>}
      </div>)}
    </div>}

    {(state.phase === 'error' || state.phase === 'conflict') && <div role="alert" data-testid="track-dubbing-error" className="mt-2 rounded border border-aimu-coral/40 bg-aimu-red-bg p-2 text-aimu-coral">
      <p>{state.error ?? '整段配音失败'}</p>
      <div className="mt-1 flex gap-1">
        <Button size="sm" variant="outline" data-testid="track-dubbing-retry" onClick={() => void state.retry()}>重试 / Retry</Button>
        <Button size="sm" variant="ghost" onClick={state.closePanel}>返回 / Back</Button>
      </div>
    </div>}
  </section>;
}

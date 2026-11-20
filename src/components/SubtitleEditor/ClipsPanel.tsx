import { Check, Film, Loader2, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ClipsController } from '@/hooks/useClips';

export function ClipsPanel({ state, onExport, exportPhase, exportProgress, exportError, onBatch, batch, onBatchCancel, hasReframe, followSubject, setFollowSubject }: { state: ClipsController; onExport?: (clip: { id: string; start: number; end: number }) => void; exportPhase?: string; exportProgress?: number; exportError?: string; onBatch?: (clips: Array<{ id: string; name: string; start: number; end: number }>) => void; batch?: { requestId: string; status: string; items: Array<{ name: string; status: string; error?: string }> }; onBatchCancel?: () => void; hasReframe?: boolean; followSubject?: boolean; setFollowSubject?: (value: boolean) => void }) {
  if (!state.open) return null;
  return <section data-testid="clips-panel" data-phase={state.phase} className="border-b border-aimu-border bg-aimu-panel p-2 text-xs">
    <div className="flex items-center gap-2">
      <strong className="flex items-center gap-1 text-aimu-text-primary"><Film className="h-3.5 w-3.5" />短片推荐 / Clip suggestions</strong>
      <span className="ml-auto" />
      <Button size="sm" variant="ghost" onClick={state.closePanel}><X className="h-3.5 w-3.5" /></Button>
    </div>
    {state.phase === 'running' && <p role="status" data-testid="clips-running" className="mt-2 flex items-center gap-1 text-aimu-text-secondary"><Loader2 className="h-3 w-3 animate-spin" />正在处理…</p>}
    {state.phase !== 'running' && <div className="mt-2 flex flex-wrap gap-1.5">
      <Button size="sm" data-testid="clips-suggest" onClick={() => void state.analyze()}>分析候选 / Analyze</Button>
      {hasReframe && setFollowSubject && <label className="flex items-center gap-1 text-[11px] text-aimu-text-muted"><input data-testid="clip-follow-subject" type="checkbox" checked={followSubject} onChange={event => setFollowSubject(event.target.checked)} />主体跟随</label>}
      {onBatch && <Button size="sm" variant="outline" data-testid="clips-batch" disabled={batch?.status === 'running' || batch?.status === 'queued'} onClick={() => onBatch(state.saved)}>批量导出 / Batch export</Button>}
      {state.saved.length > 0 && <span className="text-[10px] text-aimu-text-muted">已确认 {state.saved.length} 个短片</span>}
    </div>}
    {state.phase === 'completed' && state.candidates.length === 0 && <p data-testid="clips-empty" className="mt-2 text-aimu-text-muted">未找到合适片段 / No suitable clips found</p>}
    {state.candidates.length > 0 && <div data-testid="clips-candidates" className="mt-2 max-h-40 space-y-1 overflow-y-auto">
      {state.candidates.map(candidate => <div key={candidate.id} data-testid="clips-candidate" className="rounded border border-aimu-border bg-background p-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded bg-aimu-purple/10 px-1 py-0.5 text-[10px] text-aimu-purple">评分 {candidate.score}</span>
          <span className="text-[10px] text-aimu-text-muted">{candidate.start.toFixed(1)}–{candidate.end.toFixed(1)}s · {candidate.reasons.join(' · ')}</span>
          <Button size="sm" variant="ghost" className="ml-auto" data-testid="clips-select" onClick={() => state.select(candidate)}>选择</Button>
        </div>
        <p className="mt-0.5 line-clamp-2 text-aimu-text-secondary">{candidate.text}</p>
      </div>)}
    </div>}
    <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
      <label className="flex flex-col gap-1"><span className="text-[10px] text-aimu-text-muted">名称</span><input data-testid="clip-name" value={state.name} onChange={event => state.setName(event.target.value)} className="h-6 rounded border border-aimu-border bg-aimu-input px-1.5" /></label>
      <label className="flex flex-col gap-1"><span className="text-[10px] text-aimu-text-muted">开始(s)</span><input data-testid="clip-start" type="number" step={0.1} value={state.start} onChange={event => state.setStart(event.target.value)} className="h-6 rounded border border-aimu-border bg-aimu-input px-1.5" /></label>
      <label className="flex flex-col gap-1"><span className="text-[10px] text-aimu-text-muted">结束(s)</span><input data-testid="clip-end" type="number" step={0.1} value={state.end} onChange={event => state.setEnd(event.target.value)} className="h-6 rounded border border-aimu-border bg-aimu-input px-1.5" /></label>
      <div className="flex items-end gap-1">
        <Button size="sm" variant="outline" data-testid="clip-snap" onClick={state.snap}>吸附句子</Button>
        <Button size="sm" variant="ghost" data-testid="clip-preview" onClick={state.preview}>预览</Button>
      </div>
    </div>
    <div className="mt-1.5 flex gap-1.5">
      <Button size="sm" data-testid="clip-create" onClick={() => void state.create()}>确认创建短片 / Create clip</Button>
      {state.phase === 'completed' && <span data-testid="clips-completed" className="flex items-center gap-1 text-emerald-700 dark:text-emerald-300"><Check className="h-3 w-3" />已完成 / Completed</span>}
    </div>
    {state.saved.length > 0 && <div data-testid="clips-saved" className="mt-2 space-y-1">
      {state.saved.map(clip => <div key={clip.id} className="flex items-center gap-1.5 rounded border border-aimu-border bg-background p-1.5">
        <span className="min-w-0 flex-1 truncate">{clip.name}</span>
        <span className="text-[10px] text-aimu-text-muted">{clip.start.toFixed(1)}–{clip.end.toFixed(1)}s</span>
        {onExport && <Button size="sm" variant="outline" data-testid={`clip-export-${clip.id}`} disabled={exportPhase === 'running'} onClick={() => onExport(clip)}>导出竖屏</Button>}
        <Button size="sm" variant="outline" data-testid={`clip-copy-${clip.id}`} disabled={state.copyBusy} onClick={() => void state.generateCopy(clip.id)}>AI文案</Button>
        <Button size="sm" variant="ghost" data-testid={`clip-delete-${clip.id}`} onClick={() => void state.remove(clip.id)}><Trash2 className="h-3 w-3" /></Button>
      </div>)}
    </div>}
    {batch && <div data-testid="clips-batch-status" className="mt-2 rounded border border-aimu-border bg-background p-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-[11px]">批次：{batch.status}</span>
        {['queued', 'running'].includes(batch.status) && onBatchCancel && <Button size="sm" variant="ghost" data-testid="clips-batch-cancel" onClick={onBatchCancel}>取消</Button>}
      </div>
      <div className="mt-0.5 flex flex-wrap gap-1">
        {batch.items.map((item, index) => <span key={index} data-testid={`clips-batch-item-${index}`}
          className={item.status === 'saved' ? 'text-emerald-700 dark:text-emerald-300' : item.status === 'failed' ? 'text-aimu-coral' : 'text-aimu-text-muted'}>
          {item.name}: {item.status}
        </span>)}
      </div>
    </div>}

    {exportPhase === 'running' && <p role="status" data-testid="clip-export-progress" className="mt-2 text-aimu-text-secondary">正在导出… {exportProgress ?? 0}%</p>}
    {exportPhase === 'completed' && <p role="status" data-testid="clip-export-completed" className="mt-2 text-emerald-700 dark:text-emerald-300">已完成 / Completed</p>}
    {exportPhase === 'error' && <p role="alert" data-testid="clip-export-error" className="mt-2 text-aimu-coral">{exportError}</p>}

    {state.copy && <div data-testid="clip-copy-review" className="mt-2 space-y-1 rounded border border-aimu-border bg-background p-2">
      <p className="text-[10px] text-amber-700 dark:text-amber-300">AI建议，请核对 / AI suggestions. Review before use</p>
      <label className="flex flex-col gap-0.5"><span className="text-[10px] text-aimu-text-muted">标题</span>
        <input data-testid="clip-copy-title" value={state.copy.title} onChange={event => state.updateCopy({ title: event.target.value })} className="h-6 rounded border border-aimu-border bg-aimu-input px-1.5" /></label>
      <label className="flex flex-col gap-0.5"><span className="text-[10px] text-aimu-text-muted">简介</span>
        <textarea data-testid="clip-copy-description" value={state.copy.description} onChange={event => state.updateCopy({ description: event.target.value })} rows={2} className="rounded border border-aimu-border bg-aimu-input px-1.5 py-1" /></label>
      <label className="flex flex-col gap-0.5"><span className="text-[10px] text-aimu-text-muted">话题（逗号分隔）</span>
        <input data-testid="clip-copy-hashtags" value={state.copy.hashtags.join(', ')} onChange={event => state.updateCopy({ hashtags: event.target.value.split(',').map(item => item.trim()).filter(Boolean) })} className="h-6 rounded border border-aimu-border bg-aimu-input px-1.5" /></label>
      <div className="flex gap-1"><Button size="sm" data-testid="clip-copy-save" onClick={() => void state.saveCopy()}>保存文案</Button>
        <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(`${state.copy!.title}\n\n${state.copy!.description}\n\n${state.copy!.hashtags.map(tag => '#' + tag).join(' ')}`)}>复制</Button></div>
    </div>}

    {state.phase === 'stale' && <p role="alert" data-testid="clips-stale" className="mt-2 text-amber-700 dark:text-amber-300">字幕已更新，请重新检查 / Subtitles changed. Review again.</p>}
    {state.phase === 'error' && <p role="alert" data-testid="clips-error" className="mt-2 text-aimu-coral">{state.error ?? '短片推荐失败'}</p>}
  </section>;
}

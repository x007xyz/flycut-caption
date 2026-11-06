// 字幕样式面板里的样式来源（F-0003 AC-31）：跟随项目样式，或这个视频单独设置。只负责展示。
import { Info, Link2, Unlink, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useProjectText } from './useProjectText';

export function StyleSourceBar({ source, onCustomize, onFollow }: { source: 'project' | 'custom'; onCustomize: () => void; onFollow: () => void }) {
  const { tp } = useProjectText();
  return (
    <div className="mb-3 flex items-center gap-2 rounded-md border border-border bg-aimu-input px-3 py-2 text-xs" data-testid="style-source">
      {source === 'project'
        ? <><Link2 className="h-3.5 w-3.5 flex-shrink-0 text-primary" /><span className="flex-1 text-foreground">{tp('styleFollowing')}</span>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onCustomize}>{tp('styleCustomize')}</Button></>
        : <><Unlink className="h-3.5 w-3.5 flex-shrink-0 text-amber-500" /><span className="flex-1 text-foreground">{tp('styleCustom')}</span>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onFollow}>{tp('styleFollow')}</Button></>}
    </div>
  );
}

/** 跟随项目时第一次改样式后显示，关闭后同一项目不再显示。 */
export function SharedStyleHint({ onDismiss }: { onDismiss: () => void }) {
  const { tp } = useProjectText();
  return (
    <div role="note" className="mt-3 flex items-start gap-2 rounded-md bg-primary/10 px-3 py-2 text-xs text-primary">
      <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
      <span className="flex-1">{tp('styleSharedHint')}</span>
      <button type="button" onClick={onDismiss} aria-label={tp('dismiss')} title={tp('dismiss')} className="rounded p-0.5 hover:bg-primary/10"><X className="h-3.5 w-3.5" /></button>
    </div>
  );
}

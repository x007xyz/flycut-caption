// 顶栏的保存状态（F-0002 AC-3、AC-4、AC-9）。只负责展示。
import { useEffect, useState } from 'react';
import { AlertTriangle, Check, CircleDot, Loader2, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SaveStatus } from './types';
import { fill, formatRelativeTime } from './format';
import { useProjectText } from './useProjectText';

export interface SaveStatusIndicatorProps {
  status: SaveStatus;
  /** 最后一次成功保存的时间，ISO 8601 */
  savedAt?: string;
  now?: number;
  /** 立即保存的快捷键文字，例如 ⌘S 或 Ctrl+S */
  shortcut?: string;
  onSaveNow: () => void;
  onRetry: () => void;
  onResolveConflict: () => void;
  /** 「已保存」显示多久后淡出（AC-19）；不传则一直显示。其他状态始终显示 */
  fadeAfterMs?: number;
  className?: string;
}

export function SaveStatusIndicator({ status, savedAt, now, shortcut = '⌘S', onSaveNow, onRetry, onResolveConflict, fadeAfterMs, className }: SaveStatusIndicatorProps) {
  const { tp, language } = useProjectText();
  // 每次保存成功（savedAt 变化）重新显示，到时间后淡出
  const [faded, setFaded] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (status !== 'saved' || fadeAfterMs === undefined) return;
    const timer = setTimeout(() => setFaded(savedAt ?? ''), fadeAfterMs);
    return () => clearTimeout(timer);
  }, [status, savedAt, fadeAfterMs]);
  const hidden = status === 'saved' && fadeAfterMs !== undefined && faded === (savedAt ?? '');
  const base = 'inline-flex h-7 flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-2 text-xs transition-colors';

  if (status === 'failed') {
    return (
      <button type="button" onClick={onRetry} className={cn(base, 'bg-aimu-red-bg text-aimu-coral hover:opacity-90', className)} role="status">
        <RefreshCw className="h-3.5 w-3.5" />{tp('saveFailed')}
      </button>
    );
  }
  if (status === 'conflict') {
    return (
      <span className={cn(base, 'flex-shrink-0 whitespace-nowrap bg-aimu-red-bg text-aimu-coral', className)} role="status" title={tp('saveConflictHint')}>
        <AlertTriangle className="h-3.5 w-3.5" />{tp('saveConflict')}
        <button type="button" onClick={onResolveConflict} className="ml-1 font-medium underline underline-offset-2">{tp('resolveConflict')}</button>
      </span>
    );
  }
  if (status === 'saving') {
    return <span className={cn(base, 'text-muted-foreground', className)} role="status"><Loader2 className="h-3.5 w-3.5 animate-spin" />{tp('saving')}</span>;
  }
  if (status === 'pending') {
    return (
      <button type="button" onClick={onSaveNow} title={fill(tp('saveNow'), { shortcut })} className={cn(base, 'text-muted-foreground hover:bg-aimu-hover', className)} role="status">
        <CircleDot className="h-3.5 w-3.5 text-amber-500" />{tp('pending')}
      </button>
    );
  }
  return (
    <span className={cn(base, 'text-muted-foreground duration-500', hidden && 'opacity-0', className)} role="status" aria-hidden={hidden || undefined}>
      <Check className="h-3.5 w-3.5 text-emerald-500" />
      {savedAt ? fill(tp('savedAt'), { time: formatRelativeTime(savedAt, language, tp('justNow'), now) }) : tp('saved')}
    </span>
  );
}

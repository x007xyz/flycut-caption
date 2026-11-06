// 回收站（F-0003 AC-23 到 AC-25）：列出删除的项目，恢复、彻底删除、清空。只负责展示。
import { AlertTriangle, Loader2, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { LoadStatus } from './types';
import { Thumbnail } from './Thumbnail';
import { daysUntilPurge, formatRelativeTime } from './format';
import { useProjectText } from './useProjectText';

export interface TrashRow {
  id: string;
  name: string;
  videoCount: number;
  durationSeconds: number;
  thumbnailUrl?: string;
  /** ISO 8601 */
  deletedAt: string;
  /** ISO 8601，到这个时间 Host 彻底删除 */
  purgeAfter: string;
}

export interface TrashPageProps {
  status: LoadStatus;
  items: TrashRow[];
  /** 正在恢复的项目（该行转圈） */
  restoringId?: string | null;
  now?: number;
  onRetry: () => void;
  onRestore: (id: string) => void;
  onPurge: (id: string) => void;
  onEmptyTrash: () => void;
}

export function TrashPage({ status, items, restoringId, now, onRetry, onRestore, onPurge, onEmptyTrash }: TrashPageProps) {
  const { t, tp, language } = useProjectText();
  return (
    <div className="mx-auto w-full max-w-6xl px-8 pt-8 pb-12">
      <div className="flex items-start gap-3">
        <div>
          <h1 className="text-lg font-semibold text-foreground">{tp('trashTitle')}</h1>
          <p className="mt-1 text-xs text-muted-foreground">{tp('trashHint')}</p>
        </div>
        {status === 'ready' && items.length > 0 && (
          <Button variant="outline" size="sm" className="ml-auto text-aimu-coral" onClick={onEmptyTrash}><Trash2 className="h-3.5 w-3.5" />{tp('emptyTrash')}</Button>
        )}
      </div>

      <div className="mt-6">
        {status === 'loading' && (
          <div className="space-y-2" aria-busy="true" aria-label={tp('loading')}>
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="flex items-center gap-4 rounded-lg border border-border p-3">
                <div className="aspect-video w-28 animate-pulse rounded-md bg-muted" />
                <div className="flex-1 space-y-2"><div className="h-3.5 w-1/3 animate-pulse rounded bg-muted" /><div className="h-3 w-1/5 animate-pulse rounded bg-muted" /></div>
              </div>
            ))}
          </div>
        )}
        {status === 'error' && (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-16 text-center">
            <AlertTriangle className="h-6 w-6 text-aimu-coral" />
            <div>
              <p className="text-sm font-medium text-foreground">{tp('loadError')}</p>
              <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">{tp('loadErrorHint')}</p>
            </div>
            <Button variant="outline" size="sm" onClick={onRetry}><RefreshCw className="h-3.5 w-3.5" />{t('common.retry')}</Button>
          </div>
        )}
        {status === 'ready' && items.length === 0 && (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-16 text-center">
            <Trash2 className="h-7 w-7 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">{tp('trashEmpty')}</p>
          </div>
        )}
        {status === 'ready' && items.length > 0 && (
          <ul className="space-y-2">
            {items.map(item => {
              const restoring = restoringId === item.id;
              const days = daysUntilPurge(item.purgeAfter, now);
              return (
                <li key={item.id} className={cn('flex items-center gap-4 rounded-lg border border-border bg-card p-3', restoring && 'opacity-70')} aria-busy={restoring}>
                  <Thumbnail url={item.thumbnailUrl} durationSeconds={item.videoCount === 0 ? null : item.durationSeconds} className="w-28 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground" title={item.name}>{item.name}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                      <span>{tp('videoCount', { count: item.videoCount })}</span>
                      <span>{tp('deletedAt', { time: formatRelativeTime(item.deletedAt, language, tp('justNow'), now) })}</span>
                      <span className={cn(days === 0 && 'text-aimu-coral')}>{days === 0 ? tp('purgeToday') : tp('purgeIn', { days })}</span>
                    </p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => onRestore(item.id)} disabled={restoring || Boolean(restoringId)}>
                    {restoring ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}{tp('restore')}
                  </Button>
                  <Button variant="ghost" size="sm" className="text-aimu-coral" onClick={() => onPurge(item.id)} disabled={restoring}>{tp('purge')}</Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

// 项目详情：一个项目里的多个视频（F-0003 AC-26 到 AC-29）。只有一个视频的项目从首页直接进入编辑器，不经过这一页。
import { useRef, useState } from 'react';
import { AlertTriangle, Archive, ChevronLeft, Film, Loader2, MoreHorizontal, Pencil, Plus, RefreshCw, Sparkles, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { LoadStatus, ProjectVideoItem } from './types';
import { Thumbnail } from './Thumbnail';
import { formatRelativeTime } from './format';
import { useProjectText } from './useProjectText';

/** 正在添加或添加失败的文件（AC-27） */
export interface AddingVideoRow { key: string; name: string; status: 'adding' | 'failed' }

export interface ProjectDetailProps {
  status?: LoadStatus;
  name: string;
  videos: ProjectVideoItem[];
  adding?: AddingVideoRow[];
  openingVideoId?: string | null;
  now?: number;
  /** 强制显示拖入时的遮罩（桌面端由外壳报告拖入） */
  dragActive?: boolean;
  onBack: () => void;
  onRetry?: () => void;
  onOpenVideo: (id: string) => void;
  onAddVideo: () => void;
  onFilesDropped?: (files: File[]) => void;
  onRename?: () => void;
  onBackup?: () => void;
  onManageHotwords?: () => void;
  onRemoveVideo?: (id: string) => void;
  onDismissFailed?: (key: string) => void;
}

export function ProjectDetail({ status = 'ready', name, videos, adding = [], openingVideoId, now, dragActive, onBack, onRetry, onOpenVideo, onAddVideo,
  onFilesDropped, onRename, onBackup, onManageHotwords, onRemoveVideo, onDismissFailed }: ProjectDetailProps) {
  const { t, tp, language } = useProjectText();
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const busyAdding = adding.some(row => row.status === 'adding');
  const empty = status === 'ready' && videos.length === 0 && adding.length === 0;
  return (
    <div className="relative min-h-full"
      onDragEnter={e => { if (!onFilesDropped || status !== 'ready') return; e.preventDefault(); depth.current += 1; setDragging(true); }}
      onDragOver={e => { if (onFilesDropped && status === 'ready') e.preventDefault(); }}
      onDragLeave={() => { depth.current -= 1; if (depth.current <= 0) setDragging(false); }}
      onDrop={e => { if (!onFilesDropped || status !== 'ready') return; e.preventDefault(); depth.current = 0; setDragging(false); onFilesDropped([...e.dataTransfer.files]); }}>
      <div className="mx-auto w-full max-w-6xl px-8 pt-6 pb-12">
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-3.5 w-3.5" />{tp('backToProjects')}
        </button>
        <div className="mt-2 flex items-center gap-2">
          <h1 className="truncate text-lg font-semibold text-foreground">{name}</h1>
          {onRename && status === 'ready' && (
            <button type="button" onClick={onRename} aria-label={tp('rename')} title={tp('rename')} className="rounded p-1 text-muted-foreground hover:bg-aimu-hover hover:text-foreground">
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          {status === 'ready' && (
            <div className="ml-auto flex items-center gap-2">
              {onBackup && (
                <Button variant="outline" size="sm" onClick={onBackup}>
                  <Archive className="h-3.5 w-3.5" />{tp('backupMenu')}
                </Button>
              )}
              {onManageHotwords && (
                <Button variant="outline" size="sm" onClick={onManageHotwords}>
                  <Sparkles className="h-3.5 w-3.5" />{tp('hotwordsManage')}
                </Button>
              )}
              <Button size="sm" onClick={onAddVideo} disabled={busyAdding}><Plus className="h-3.5 w-3.5" />{tp('addVideo')}</Button>
            </div>
          )}
        </div>
        {status === 'ready' && <p className="mt-1 text-xs text-muted-foreground">{tp('videoCount', { count: videos.length })}</p>}

        <div className="mt-6">
          {status === 'loading' && (
            <div className="space-y-2" aria-busy="true" aria-label={tp('loading')}>
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="flex items-center gap-4 rounded-lg border border-border p-3">
                  <div className="aspect-video w-40 animate-pulse rounded-md bg-muted" />
                  <div className="flex-1 space-y-2"><div className="h-3.5 w-1/3 animate-pulse rounded bg-muted" /><div className="h-3 w-1/5 animate-pulse rounded bg-muted" /></div>
                </div>
              ))}
            </div>
          )}
          {status === 'error' && (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-16 text-center">
              <AlertTriangle className="h-6 w-6 text-aimu-coral" />
              <p className="text-sm font-medium text-foreground">{tp('detailLoadError')}</p>
              {onRetry && <Button variant="outline" size="sm" onClick={onRetry}><RefreshCw className="h-3.5 w-3.5" />{t('common.retry')}</Button>}
            </div>
          )}
          {empty && (
            <button type="button" onClick={onAddVideo} className="flex w-full flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-16 text-center hover:border-primary/50">
              <Upload className="h-7 w-7 text-muted-foreground" />
              <span>
                <span className="block text-sm font-medium text-foreground">{tp('detailEmptyTitle')}</span>
                <span className="mx-auto mt-1 block max-w-sm text-xs text-muted-foreground">{tp('detailEmptyHint')}</span>
              </span>
            </button>
          )}
          {status === 'ready' && (videos.length > 0 || adding.length > 0) && (
            <ul className="space-y-2">
              {videos.map(video => {
                const opening = openingVideoId === video.id;
                const disabled = Boolean(openingVideoId) && !opening;
                return (
                  <li key={video.id} className={cn('group flex items-center gap-4 rounded-lg border border-border bg-card p-3 transition-colors hover:border-primary/40',
                    opening && 'border-primary/60', disabled && 'pointer-events-none opacity-50')} aria-busy={opening} aria-disabled={disabled || undefined}>
                    <button type="button" onClick={() => onOpenVideo(video.id)} disabled={disabled || opening} className="w-40 flex-shrink-0" tabIndex={-1}>
                      <Thumbnail url={video.thumbnailUrl} durationSeconds={video.durationSeconds} />
                    </button>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground" title={video.name}>{video.name}</p>
                      <p className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                        <span>{formatRelativeTime(video.updatedAt, language, tp('justNow'), now)}</span>
                        {video.mediaMissing
                          ? <span className="inline-flex items-center gap-1 text-aimu-coral"><AlertTriangle className="h-3 w-3" />{tp('mediaMissing')}</span>
                          : video.status.kind === 'ready' ? <span>{tp('ready')}{video.subtitleCount ? ` · ${video.subtitleCount}` : ''}</span>
                          : video.status.kind === 'not-transcribed' ? <span>{tp('notTranscribed')}</span> : null}
                      </p>
                      {video.status.kind === 'transcribing' && (
                        <div className="mt-2 flex items-center gap-2 text-xs text-primary">
                          <div className="h-1 w-48 overflow-hidden rounded bg-muted"><div className="h-full bg-primary" style={{ width: `${video.status.progress}%` }} /></div>
                          {tp('transcribing', { progress: video.status.progress })}
                        </div>
                      )}
                    </div>
                    <Button variant="outline" size="sm" onClick={() => onOpenVideo(video.id)} disabled={disabled || opening}>
                      {opening && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{opening ? tp('opening') : tp('openVideo')}
                    </Button>
                    {onRemoveVideo && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button type="button" aria-label={tp('more')} disabled={disabled || opening}
                            className="rounded p-1 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 hover:bg-aimu-hover">
                            <MoreHorizontal className="h-4 w-4" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => onRemoveVideo(video.id)} className="text-aimu-coral focus:text-aimu-coral"><Trash2 className="h-4 w-4" />{tp('remove')}</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </li>
                );
              })}
              {adding.map(row => (
                <li key={row.key} className="flex items-center gap-4 rounded-lg border border-dashed border-border bg-card p-3" aria-busy={row.status === 'adding'}>
                  <div className="flex aspect-video w-40 flex-shrink-0 items-center justify-center rounded-md bg-muted"><Film className="h-6 w-6 text-muted-foreground/60" /></div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground" title={row.name}>{row.name}</p>
                    {row.status === 'adding'
                      ? <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />{tp('adding')}</p>
                      : <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-aimu-coral"><AlertTriangle className="h-3 w-3" />{tp('addFailed')}</p>}
                  </div>
                  {row.status === 'failed' && onDismissFailed && <Button variant="ghost" size="sm" onClick={() => onDismissFailed(row.key)}>{tp('remove')}</Button>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {(dragging || dragActive) && status === 'ready' && (
        <div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary/5 backdrop-blur-[1px]">
          <p className="flex items-center gap-2 text-base font-medium text-primary"><Upload className="h-5 w-5" />{tp('detailDropActive')}</p>
        </div>
      )}
    </div>
  );
}

// 项目详情：一个项目里的多个视频（E-02/6）。F-0002 里单视频项目直接进入编辑器，不经过这一页。
import { AlertTriangle, ChevronLeft, Loader2, MoreHorizontal, Pencil, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ProjectVideoItem } from './types';
import { Thumbnail } from './Thumbnail';
import { formatRelativeTime } from './format';
import { useProjectText } from './useProjectText';

export interface ProjectDetailProps {
  name: string;
  videos: ProjectVideoItem[];
  openingVideoId?: string | null;
  now?: number;
  onBack: () => void;
  onOpenVideo: (id: string) => void;
  onAddVideo: () => void;
  onRename?: () => void;
  onVideoMenu?: (id: string) => void;
}

export function ProjectDetail({ name, videos, openingVideoId, now, onBack, onOpenVideo, onAddVideo, onRename, onVideoMenu }: ProjectDetailProps) {
  const { tp, language } = useProjectText();
  return (
    <div className="mx-auto w-full max-w-6xl px-8 pt-6 pb-12">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ChevronLeft className="h-3.5 w-3.5" />{tp('backToProjects')}
      </button>
      <div className="mt-2 flex items-center gap-2">
        <h1 className="truncate text-lg font-semibold text-foreground">{name}</h1>
        {onRename && <button type="button" onClick={onRename} aria-label={tp('rename')} className="rounded p-1 text-muted-foreground hover:bg-aimu-hover hover:text-foreground"><Pencil className="h-3.5 w-3.5" /></button>}
        <Button size="sm" className="ml-auto" onClick={onAddVideo}><Plus className="h-3.5 w-3.5" />{tp('addVideo')}</Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{tp('videoCount', { count: videos.length })}</p>

      <div className="mt-6 space-y-2">
        {videos.map(video => {
          const opening = openingVideoId === video.id;
          return (
            <div key={video.id} className={cn('group flex items-center gap-4 rounded-lg border border-border bg-card p-3 transition-colors hover:border-primary/40', opening && 'border-primary/60')}>
              <button type="button" onClick={() => onOpenVideo(video.id)} className="w-40 flex-shrink-0"><Thumbnail url={video.thumbnailUrl} durationSeconds={video.durationSeconds} /></button>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{video.name}</p>
                <p className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                  <span>{formatRelativeTime(video.updatedAt, language, tp('justNow'), now)}</span>
                  {video.status.kind === 'ready' && <span>{tp('ready')}{video.subtitleCount ? ` · ${video.subtitleCount}` : ''}</span>}
                  {video.status.kind === 'not-transcribed' && <span>{tp('notTranscribed')}</span>}
                  {video.mediaMissing && <span className="inline-flex items-center gap-1 text-aimu-coral"><AlertTriangle className="h-3 w-3" />{tp('mediaMissing')}</span>}
                </p>
                {video.status.kind === 'transcribing' && (
                  <div className="mt-2 flex items-center gap-2 text-xs text-primary">
                    <div className="h-1 w-48 overflow-hidden rounded bg-muted"><div className="h-full bg-primary" style={{ width: `${video.status.progress}%` }} /></div>
                    {tp('transcribing', { progress: video.status.progress })}
                  </div>
                )}
              </div>
              <Button variant="outline" size="sm" onClick={() => onOpenVideo(video.id)} disabled={opening}>
                {opening && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{opening ? tp('opening') : tp('openVideo')}
              </Button>
              {onVideoMenu && <button type="button" aria-label={tp('more')} onClick={() => onVideoMenu(video.id)} className="rounded p-1 text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-aimu-hover"><MoreHorizontal className="h-4 w-4" /></button>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

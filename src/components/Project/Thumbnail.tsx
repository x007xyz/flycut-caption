// 视频缩略图：16:9，右下角时长；没有缩略图时显示占位
import { Film } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDuration } from './format';

export function Thumbnail({ url, durationSeconds, className, children }: {
  url?: string; durationSeconds: number; className?: string; children?: React.ReactNode;
}) {
  return (
    <div className={cn('relative aspect-video w-full overflow-hidden rounded-md bg-muted', className)}>
      {url
        ? <img src={url} alt="" className="h-full w-full object-cover" draggable={false} />
        : <div className="flex h-full w-full items-center justify-center"><Film className="h-6 w-6 text-muted-foreground/60" /></div>}
      <span className="absolute right-1.5 bottom-1.5 rounded bg-black/75 px-1.5 py-0.5 font-mono text-[11px] leading-none text-white">
        {formatDuration(durationSeconds)}
      </span>
      {children}
    </div>
  );
}

// 项目首页的网格卡片
import { AlertTriangle, Layers, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ProjectSummary } from './types';
import { Thumbnail } from './Thumbnail';
import { ProjectActionsMenu } from './ProjectActionsMenu';
import { formatRelativeTime } from './format';
import { useProjectText } from './useProjectText';

export interface ProjectCardProps {
  project: ProjectSummary;
  opening?: boolean;
  disabled?: boolean;
  now?: number;
  onOpen: () => void;
  onRename?: () => void;
  onBackup?: () => void;
  onDelete?: () => void;
}

export function ProjectCard({ project, opening, disabled, now, onOpen, onRename, onBackup, onDelete }: ProjectCardProps) {
  const { tp, language } = useProjectText();
  return (
    <div className={cn('group relative rounded-lg p-2 transition-colors hover:bg-aimu-hover', opening && 'bg-aimu-active', disabled && 'pointer-events-none opacity-50')}>
      <button type="button" onClick={onOpen} disabled={disabled || opening} aria-busy={opening}
        className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md">
        <Thumbnail url={project.thumbnailUrl} durationSeconds={project.videoCount === 0 ? null : project.durationSeconds}>
          {project.videoCount !== 1 && (
            <span className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 rounded bg-black/75 px-1.5 py-0.5 text-[11px] leading-none text-white">
              <Layers className="h-3 w-3" />{tp('videoCount', { count: project.videoCount })}
            </span>
          )}
          {opening && (
            <span className="absolute inset-0 flex items-center justify-center gap-2 bg-black/50 text-sm text-white">
              <Loader2 className="h-4 w-4 animate-spin" />{tp('opening')}
            </span>
          )}
          {!opening && project.transcribing && (
            <span className="absolute inset-x-0 bottom-0 h-1 bg-black/40"><span className="block h-full bg-primary" style={{ width: `${project.transcribing.progress}%` }} /></span>
          )}
        </Thumbnail>
        <p className="mt-2 line-clamp-2 pr-6 text-sm leading-5 font-medium text-foreground" title={project.name}>{project.name}</p>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span>{formatRelativeTime(project.updatedAt, language, tp('justNow'), now)}</span>
          {project.transcribing && <span className="text-primary">{tp('transcribing', { progress: project.transcribing.progress })}</span>}
          {project.mediaMissing && <span className="inline-flex items-center gap-1 text-aimu-coral"><AlertTriangle className="h-3 w-3" />{tp('mediaMissing')}</span>}
        </p>
      </button>
      <div className="absolute right-2 bottom-[30px] opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100">
        <ProjectActionsMenu onOpen={onOpen} onRename={onRename} onBackup={onBackup} onDelete={onDelete} />
      </div>
    </div>
  );
}

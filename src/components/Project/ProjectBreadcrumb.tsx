// 编辑器顶栏里的项目面包屑 + 保存状态，通过 FlyCutCaption 的 headerSlot 放进 WorkstationHeader。
// 多视频项目显示「‹ 我的项目 / 项目名 / 视频名 ▾」，从下拉列表切换视频（F-0003 AC-30）。
import { Check, ChevronDown, ChevronLeft, Loader2 } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { SaveStatusIndicator, type SaveStatusIndicatorProps } from './SaveStatusIndicator';
import type { VideoTranscriptStatus } from './types';
import { useProjectText } from './useProjectText';
import { useHostReady } from '@/runtime/connectionHooks';

export interface BreadcrumbVideo { id: string; name: string; status: VideoTranscriptStatus; mediaMissing?: boolean }

export interface ProjectBreadcrumbProps extends SaveStatusIndicatorProps {
  projectName: string;
  /** 多视频项目里当前视频的名称；单视频项目不传 */
  videoName?: string;
  onBack: () => void;
  /** 点击项目名进入项目详情页（F-0003 AC-30） */
  onOpenProject?: () => void;
  /** 同一项目的全部视频；超过一个时显示视频切换 */
  videos?: BreadcrumbVideo[];
  currentVideoId?: string;
  /** 正在切换到的视频：顶栏显示「正在打开…」 */
  switchingVideoId?: string | null;
  /** 当前视频正在转写：其他视频不可选择 */
  transcribing?: boolean;
  onSwitchVideo?: (id: string) => void;
}

export function ProjectBreadcrumb({ projectName, videoName, onBack, onOpenProject, videos = [], currentVideoId, switchingVideoId, transcribing, onSwitchVideo, ...save }: ProjectBreadcrumbProps) {
  const { tp } = useProjectText();
  const hostReady = useHostReady();
  const current = videos.find(video => video.id === currentVideoId);
  const multi = videos.length > 1;
  const statusText = (video: BreadcrumbVideo) => video.mediaMissing ? tp('mediaMissing')
    : video.status.kind === 'ready' ? tp('ready') : video.status.kind === 'transcribing' ? tp('transcribing', { progress: video.status.progress }) : tp('notTranscribed');
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <button type="button" onClick={onBack} className="inline-flex flex-shrink-0 items-center gap-0.5 text-muted-foreground hover:text-foreground">
        <ChevronLeft className="h-4 w-4" />{tp('backToProjects')}
      </button>
      <span className="text-muted-foreground/60">/</span>
      {onOpenProject
        ? <button type="button" onClick={onOpenProject} className="max-w-[200px] truncate font-medium text-foreground hover:underline" title={projectName}>{projectName}</button>
        : <span className="max-w-[200px] truncate font-medium text-foreground" title={projectName}>{projectName}</span>}
      {multi && onSwitchVideo ? (
        <>
          <span className="text-muted-foreground/60">/</span>
          {switchingVideoId
            ? <span className="inline-flex items-center gap-1 text-muted-foreground" role="status"><Loader2 className="h-3.5 w-3.5 animate-spin" />{tp('opening')}</span>
            : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label={tp('switchVideo')} className="inline-flex max-w-[200px] items-center gap-1 rounded px-1 text-muted-foreground hover:bg-aimu-hover hover:text-foreground">
                    <span className="truncate" title={current?.name ?? videoName}>{current?.name ?? videoName}</span><ChevronDown className="h-3.5 w-3.5 flex-shrink-0" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-64">
                  {videos.map(video => {
                    const selected = video.id === currentVideoId;
                    const blocked = !selected && (!!transcribing || !hostReady);
                    return (
                      <DropdownMenuItem key={video.id} disabled={blocked} title={blocked ? tp('switchBlocked') : undefined}
                        onSelect={() => { if (!selected && !blocked) onSwitchVideo(video.id); }} className="flex items-start gap-2 data-[disabled]:pointer-events-auto">
                        <Check className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 ${selected ? 'opacity-100' : 'opacity-0'}`} aria-hidden={!selected} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{video.name}</span>
                          <span className="block text-xs text-muted-foreground">{blocked ? (hostReady ? tp('switchBlocked') : tp('offlineAction')) : statusText(video)}</span>
                        </span>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
        </>
      ) : videoName && !onSwitchVideo ? (
        <><span className="text-muted-foreground/60">/</span><span className="max-w-[160px] truncate text-muted-foreground" title={videoName}>{videoName}</span></>
      ) : null}
      <SaveStatusIndicator {...save} />
    </div>
  );
}

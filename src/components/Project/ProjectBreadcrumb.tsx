// 编辑器顶栏里的项目面包屑 + 保存状态，通过 FlyCutCaption 的 headerSlot 放进 WorkstationHeader
import { ChevronLeft } from 'lucide-react';
import { SaveStatusIndicator, type SaveStatusIndicatorProps } from './SaveStatusIndicator';
import { useProjectText } from './useProjectText';

export interface ProjectBreadcrumbProps extends SaveStatusIndicatorProps {
  projectName: string;
  /** 多视频项目里当前视频的名称（E-02/6），单视频项目不传 */
  videoName?: string;
  onBack: () => void;
}

export function ProjectBreadcrumb({ projectName, videoName, onBack, ...save }: ProjectBreadcrumbProps) {
  const { tp } = useProjectText();
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <button type="button" onClick={onBack} className="inline-flex flex-shrink-0 items-center gap-0.5 text-muted-foreground hover:text-foreground">
        <ChevronLeft className="h-4 w-4" />{tp('backToProjects')}
      </button>
      <span className="text-muted-foreground/60">/</span>
      <span className="max-w-[200px] truncate font-medium text-foreground" title={projectName}>{projectName}</span>
      {videoName && (<><span className="text-muted-foreground/60">/</span><span className="max-w-[160px] truncate text-muted-foreground" title={videoName}>{videoName}</span></>)}
      <SaveStatusIndicator {...save} />
    </div>
  );
}

// 项目卡片和列表行的「更多」菜单。重命名、删除属于 E-02/6，没传对应回调就不显示。
import { FolderOpen, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useProjectText } from './useProjectText';

export function ProjectActionsMenu({ onOpen, onRename, onDelete, className }: {
  onOpen: () => void; onRename?: () => void; onDelete?: () => void; className?: string;
}) {
  const { tp } = useProjectText();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={tp('more')} onClick={e => e.stopPropagation()}
          className={className ?? 'rounded p-1 text-muted-foreground hover:bg-aimu-hover hover:text-foreground'}>
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={e => e.stopPropagation()}>
        <DropdownMenuItem onClick={onOpen}><FolderOpen className="h-4 w-4" />{tp('open')}</DropdownMenuItem>
        {onRename && <DropdownMenuItem onClick={onRename}><Pencil className="h-4 w-4" />{tp('rename')}</DropdownMenuItem>}
        {onDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onDelete} className="text-aimu-coral focus:text-aimu-coral"><Trash2 className="h-4 w-4" />{tp('delete')}</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

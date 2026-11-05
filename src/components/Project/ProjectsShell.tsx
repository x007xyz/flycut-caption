// 项目页面的外框：左侧导航 + 内容区。编辑器页面不用这个外框（编辑器自带顶栏）。
import { FolderKanban, HelpCircle, Settings } from 'lucide-react';
import { BrandLogo } from '@/components/BrandLogo';
import { cn } from '@/lib/utils';
import { useProjectText } from './useProjectText';

export interface ProjectsShellProps {
  version: string;
  /** 顶部右侧，例如主题、语言切换 */
  toolbar?: React.ReactNode;
  onOpenSettings: () => void;
  onOpenHelp?: () => void;
  children: React.ReactNode;
}

export function ProjectsShell({ version, toolbar, onOpenSettings, onOpenHelp, children }: ProjectsShellProps) {
  const { t, tp } = useProjectText();
  const item = (active: boolean) => cn('flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
    active ? 'bg-aimu-active font-medium text-foreground' : 'text-muted-foreground hover:bg-aimu-hover hover:text-foreground');
  return (
    <div className="flex h-full bg-background">
      <aside className="flex w-60 flex-shrink-0 flex-col border-r border-border bg-card">
        <div className="flex h-14 items-center gap-2 px-4">
          <BrandLogo className="whitespace-nowrap" label={t('components.workstation.appName')} />
          <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary">v{version}</span>
        </div>
        <nav className="flex-1 space-y-0.5 px-2 pt-2">
          <button type="button" className={item(true)} aria-current="page"><FolderKanban className="h-4 w-4" />{tp('navProjects')}</button>
        </nav>
        <div className="space-y-0.5 border-t border-border px-2 py-2">
          {onOpenHelp && <button type="button" className={item(false)} onClick={onOpenHelp}><HelpCircle className="h-4 w-4" />{tp('navHelp')}</button>}
          <button type="button" className={item(false)} onClick={onOpenSettings}><Settings className="h-4 w-4" />{tp('navSettings')}</button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {toolbar && <div className="flex h-14 flex-shrink-0 items-center justify-end gap-3 border-b border-border px-6">{toolbar}</div>}
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

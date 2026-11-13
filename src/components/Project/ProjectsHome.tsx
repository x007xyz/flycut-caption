// 项目首页（F-0002 AC-5；排序、列表视图、重命名、删除等属于 E-02/6 的部分由参数开关）
import { useRef, useState } from 'react';
import { AlertTriangle, FileArchive, FolderOpen, FolderPlus, LayoutGrid, List, Loader2, Play, RefreshCw, Search, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { LoadStatus, ProjectSummary, ProjectsSort, ProjectsView } from './types';
import { ProjectCard } from './ProjectCard';
import { ProjectActionsMenu } from './ProjectActionsMenu';
import { Thumbnail } from './Thumbnail';
import { formatDuration, formatRelativeTime } from './format';
import { useProjectText } from './useProjectText';
import { languageTrackCopy } from '@/locales/languageTracks';
import { useHostReady } from '@/runtime/connectionHooks';

export interface ProjectsHomeProps {
  status: LoadStatus;
  /** 已按 sort 排好序、按 query 过滤后的项目 */
  projects: ProjectSummary[];
  totalCount: number;
  query: string;
  onQueryChange: (query: string) => void;
  view: ProjectsView;
  onViewChange: (view: ProjectsView) => void;
  /** 不传则不显示排序（E-02/6） */
  sort?: ProjectsSort;
  onSortChange?: (sort: ProjectsSort) => void;
  openingId?: string | null;
  /** 正在创建的项目（拖入文件后，等待 Host 创建） */
  creating?: boolean;
  now?: number;
  onOpen: (id: string) => void;
  onFilesDropped: (files: File[]) => void;
  onChooseFile: () => void;
  onUseSample: () => void;
  /** 新建空项目（F-0003 AC-18）；不传则不显示 */
  onCreateEmpty?: () => void;
  onRetry: () => void;
  onRename?: (id: string) => void;
  onBackup?: (id: string) => void;
  onDelete?: (id: string) => void;
  onImportBackup?: () => void;
  /** 强制显示拖入时的遮罩（原型和截图用） */
  dragActive?: boolean;
}

export function ProjectsHome(props: ProjectsHomeProps) {
  const { status, projects, totalCount, query, onQueryChange, view, onViewChange, sort, onSortChange, openingId, creating, now, onOpen, onFilesDropped, onChooseFile, onUseSample, onCreateEmpty, onRetry, onRename, onBackup, onDelete, onImportBackup, dragActive } = props;
  const { t, tp } = useProjectText();
  const [dragging, setDragging] = useState(false);
  const hostReady = useHostReady();
  const depth = useRef(0);

  return (
    <div
      className="relative flex min-h-full flex-col"
      onDragEnter={e => { e.preventDefault(); depth.current += 1; setDragging(true); }}
      onDragOver={e => e.preventDefault()}
      onDragLeave={() => { depth.current -= 1; if (depth.current <= 0) setDragging(false); }}
      onDrop={e => { e.preventDefault(); depth.current = 0; setDragging(false); onFilesDropped([...e.dataTransfer.files]); }}
    >
      <div className="mx-auto w-full max-w-6xl px-8 pt-8 pb-12">
        {/* 新建项目 */}
        <section className="flex items-center gap-6 rounded-xl border border-dashed border-border bg-card px-8 py-7">
          <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            {creating ? <Loader2 className="h-5 w-5 animate-spin" /> : <Upload className="h-5 w-5" />}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-foreground">{tp('dropTitle')}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{tp('dropHint')}</p>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onUseSample} disabled={creating || !hostReady}><Play className="h-3.5 w-3.5" />{tp('useSample')}</Button>
            {onImportBackup && <Button variant="outline" size="sm" onClick={onImportBackup} disabled={creating || !hostReady}><FileArchive className="h-3.5 w-3.5" />{tp('importBackupMenu')}</Button>}
            {onCreateEmpty && <Button variant="outline" size="sm" onClick={onCreateEmpty} disabled={creating || !hostReady}><FolderPlus className="h-3.5 w-3.5" />{tp('newEmpty')}</Button>}
            <Button size="sm" onClick={onChooseFile} disabled={creating || !hostReady}><Upload className="h-3.5 w-3.5" />{tp('chooseFile')}</Button>
          </div>
        </section>

        {/* 标题与工具栏 */}
        <div className="mt-10 flex items-center gap-3">
          <h1 className="text-lg font-semibold text-foreground">{tp('homeTitle')}</h1>
          {status === 'ready' && <span className="text-xs text-muted-foreground">{tp('projectCount', { count: totalCount })}</span>}
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={e => onQueryChange(e.target.value)} placeholder={tp('searchPlaceholder')} className="h-8 w-56 pl-8 text-sm" />
            </div>
            {sort && onSortChange && (
              <Select value={sort} onValueChange={v => onSortChange(v as ProjectsSort)}>
                <SelectTrigger size="sm" className="h-8 w-32 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="updated">{tp('sortUpdated')}</SelectItem>
                  <SelectItem value="created">{tp('sortCreated')}</SelectItem>
                  <SelectItem value="name">{tp('sortName')}</SelectItem>
                </SelectContent>
              </Select>
            )}
            <div className="flex rounded-md border border-border p-0.5">
              {([['grid', LayoutGrid, tp('viewGrid')], ['list', List, tp('viewList')]] as const).map(([value, Icon, label]) => (
                <button key={value} type="button" aria-label={label} title={label} onClick={() => onViewChange(value)}
                  className={cn('rounded p-1.5', view === value ? 'bg-aimu-active text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                  <Icon className="h-3.5 w-3.5" />
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-4">
          {status === 'loading' && <SkeletonGrid />}
          {status === 'error' && (
            <Empty icon={<AlertTriangle className="h-6 w-6 text-aimu-coral" />} title={tp('loadError')} hint={tp('loadErrorHint')}
              action={<Button variant="outline" size="sm" onClick={onRetry}><RefreshCw className="h-3.5 w-3.5" />{t('common.retry')}</Button>} />
          )}
          {status === 'ready' && totalCount === 0 && (
            <Empty icon={<FolderOpen className="h-7 w-7 text-muted-foreground" />} title={tp('emptyTitle')} hint={tp('emptyHint')} />
          )}
          {status === 'ready' && totalCount > 0 && projects.length === 0 && (
            <Empty icon={<Search className="h-6 w-6 text-muted-foreground" />} title={tp('noResults', { query })} />
          )}
          {status === 'ready' && projects.length > 0 && view === 'grid' && (
            <div className="-mx-2 grid grid-cols-2 gap-x-2 gap-y-4 md:grid-cols-3 xl:grid-cols-4">
              {projects.map(p => (
                <ProjectCard key={p.id} project={p} now={now} opening={openingId === p.id} disabled={Boolean(openingId) && openingId !== p.id}
                  onOpen={() => onOpen(p.id)} onRename={onRename && (() => onRename(p.id))} onBackup={onBackup && (() => onBackup(p.id))} onDelete={onDelete && (() => onDelete(p.id))} />
              ))}
            </div>
          )}
          {status === 'ready' && projects.length > 0 && view === 'list' && (
            <ProjectsTable projects={projects} now={now} openingId={openingId} onOpen={onOpen} onRename={onRename} onBackup={onBackup} onDelete={onDelete} />
          )}
        </div>
      </div>

      {(dragging || dragActive) && (
        <div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary/5 backdrop-blur-[1px]">
          <p className="flex items-center gap-2 text-base font-medium text-primary"><Upload className="h-5 w-5" />{tp('dropActive')}</p>
        </div>
      )}
    </div>
  );
}

function Empty({ icon, title, hint, action }: { icon: React.ReactNode; title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-16 text-center">
      {icon}
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        {hint && <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

function SkeletonGrid() {
  const { tp, language } = useProjectText();
  return (
    <div aria-busy="true" aria-label={tp('loading')}>
      <p role="status" className="mb-3 text-center text-xs text-muted-foreground">{languageTrackCopy(language).loading}</p>
      <div className="-mx-2 grid grid-cols-2 gap-x-2 gap-y-4 md:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="p-2">
            <div className="aspect-video animate-pulse rounded-md bg-muted" />
            <div className="mt-2 h-3.5 w-4/5 animate-pulse rounded bg-muted" />
            <div className="mt-2 h-3 w-1/3 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}

function ProjectsTable({ projects, now, openingId, onOpen, onRename, onBackup, onDelete }: Pick<ProjectsHomeProps, 'projects' | 'now' | 'openingId' | 'onOpen' | 'onRename' | 'onBackup' | 'onDelete'>) {
  const { tp, language } = useProjectText();
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border text-left text-xs text-muted-foreground">
          <th className="py-2 pl-2 font-normal">{tp('colName')}</th>
          <th className="w-20 py-2 font-normal">{tp('colVideos')}</th>
          <th className="w-24 py-2 font-normal">{tp('colDuration')}</th>
          <th className="w-32 py-2 font-normal">{tp('colUpdated')}</th>
          <th className="w-32 py-2 font-normal">{tp('colStatus')}</th>
          <th className="w-10" />
        </tr>
      </thead>
      <tbody>
        {projects.map(p => (
          <tr key={p.id} onClick={() => onOpen(p.id)} className={cn('group cursor-pointer border-b border-border/60 hover:bg-aimu-hover', openingId === p.id && 'bg-aimu-active')}>
            <td className="py-2 pl-2">
              <div className="flex items-center gap-3">
                <Thumbnail url={p.thumbnailUrl} durationSeconds={p.videoCount === 0 ? null : p.durationSeconds} className="w-20 flex-shrink-0 [&>span]:hidden" />
                <span className="line-clamp-1 font-medium text-foreground">{p.name}</span>
              </div>
            </td>
            <td className="text-muted-foreground">{p.videoCount}</td>
            <td className="font-mono text-xs text-muted-foreground">{p.videoCount === 0 ? '—' : formatDuration(p.durationSeconds)}</td>
            <td className="text-muted-foreground">{formatRelativeTime(p.updatedAt, language, tp('justNow'), now)}</td>
            <td className="text-xs">
              {openingId === p.id ? <span className="inline-flex items-center gap-1 text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />{tp('opening')}</span>
                : p.mediaMissing ? <span className="inline-flex items-center gap-1 text-aimu-coral"><AlertTriangle className="h-3 w-3" />{tp('mediaMissing')}</span>
                : p.transcribing ? <span className="text-primary">{tp('transcribing', { progress: p.transcribing.progress })}</span>
                : <span className="text-muted-foreground">{p.videoCount === 0 ? '—' : tp('ready')}</span>}
            </td>
            <td><div className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100"><ProjectActionsMenu onOpen={() => onOpen(p.id)} onRename={onRename && (() => onRename(p.id))} onBackup={onBackup && (() => onBackup(p.id))} onDelete={onDelete && (() => onDelete(p.id))} /></div></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

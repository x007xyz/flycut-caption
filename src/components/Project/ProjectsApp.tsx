// 项目模式的应用（F-0002）：同一个前端 Runtime 里，按地址栏在「我的项目」和编辑器之间切换。
// 展示组件在同目录；这里只负责接 `ctx.projects` 和 `stores.project`。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { LocaleProvider } from '@/contexts/LocaleProvider';
import { ClientRuntime, PluginSlot } from '@/runtime/ui';
import { useClientRuntime } from '@/runtime/context';
import { ThemeInitializer } from '@/components/ThemeInitializer';
import { ToastContainer } from '@/components/MessageCenter';
import { SettingsDialog } from '@/components/ProcessingPanel/SettingsDialog';
import { FlyCutCaptionContent } from '@/FlyCutCaption';
import { useMediaLoader } from '@/hooks/useMediaLoader';
import { useProjectStore } from '@/stores/projectStore';
import { useThemeStore } from '@/stores/themeStore';
import { projectsClientPlugin } from '@/services/projectService';
import { isTauriRuntime } from '@/utils/runtime';
import type { FlyCutCaptionProps } from '@/types';
import type { VideoFile } from '@/types/video';
import { ProjectsShell } from './ProjectsShell';
import { ProjectsHome } from './ProjectsHome';
import { ProjectBreadcrumb } from './ProjectBreadcrumb';
import { ProjectOpenErrorDialog } from './ProjectDialogs';
import type { ProjectSummary, ProjectsView } from './types';
import { fill, saveShortcutLabel } from './format';
import { useProjectText } from './useProjectText';

const CLIENT_PLUGINS = [projectsClientPlugin];
const VIEW_KEY = 'flycut.projects.view';
const readView = (): ProjectsView => { try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid'; } catch { return 'grid'; } };

/** 新建项目，成功后提示「已创建项目」（AC-17）。 */
function useCreateProject() {
  const { projects } = useClientRuntime();
  const { tp } = useProjectText();
  return useCallback(async (videoFile: VideoFile) => {
    const created = await projects.createFromMedia(videoFile);
    if (created) toast.success(fill(tp('created'), { name: created.name }));
  }, [projects, tp]);
}

function ProjectsHomePage({ version }: { version: string }) {
  const { projects } = useClientRuntime();
  const listStatus = useProjectStore(state => state.listStatus);
  const items = useProjectStore(state => state.projects);
  const openingId = useProjectStore(state => state.openingId);
  const creating = useProjectStore(state => state.creating);
  const transcribing = useProjectStore(state => state.transcribing);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<ProjectsView>(readView);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [desktopDrag, setDesktopDrag] = useState(false);
  const create = useCreateProject();
  const media = useMediaLoader({ onMedia: create });
  const { handlePaths } = media;

  // 桌面端拖入由 Tauri 处理，网页的 drop 事件拿不到本地路径
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | undefined; let disposed = false;
    void import('@tauri-apps/api/webview').then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent(event => {
      if (event.payload.type === 'enter' || event.payload.type === 'over') setDesktopDrag(true);
      else if (event.payload.type === 'leave') setDesktopDrag(false);
      else { setDesktopDrag(false); handlePaths(event.payload.paths); }
    })).then(off => { if (disposed) off(); else unlisten = off; });
    return () => { disposed = true; unlisten?.(); };
  }, [handlePaths]);

  const changeView = (next: ProjectsView) => { setView(next); try { localStorage.setItem(VIEW_KEY, next); } catch { /* 只是界面偏好 */ } };
  const summaries = useMemo<ProjectSummary[]>(() => {
    const needle = query.trim().toLowerCase();
    return items.filter(item => !needle || item.name.toLowerCase().includes(needle)).map(item => ({
      id: item.id, name: item.name, durationSeconds: item.durationSeconds, createdAt: item.createdAt, updatedAt: item.updatedAt,
      videoCount: item.videoCount, mediaMissing: item.mediaMissing || undefined,
      transcribing: transcribing?.projectId === item.id ? { progress: Math.round(transcribing.progress) } : undefined,
    }));
  }, [items, query, transcribing]);

  return (
    <ProjectsShell version={version} onOpenSettings={() => setSettingsOpen(true)}>
      <input ref={media.uploadInputRef} type="file" className="hidden" data-testid="project-file-input"
        accept="video/mp4,video/webm,video/quicktime,video/ogg,audio/mp3,audio/mpeg,audio/wav,audio/ogg,audio/m4a" onChange={media.handleNativeFileSelect} />
      <ProjectsHome status={listStatus} projects={summaries} totalCount={items.length} query={query} onQueryChange={setQuery}
        view={view} onViewChange={changeView} openingId={openingId} creating={creating || media.isMediaLoading}
        onOpen={id => { void projects.open(id).catch(error => toast.error(error instanceof Error ? error.message : String(error))); }}
        onFilesDropped={files => { void media.handleFiles(files); }} onChooseFile={media.handleUploadClick}
        onUseSample={() => { void media.handleLoadSampleVideo(); }} onRetry={() => { void projects.retryList(); }} dragActive={desktopDrag} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </ProjectsShell>
  );
}

function EditorBreadcrumb() {
  const { projects } = useClientRuntime();
  const current = useProjectStore(state => state.current);
  const save = useProjectStore(state => state.save);
  if (!current) return null;
  return (
    <ProjectBreadcrumb projectName={current.name} status={save.status} savedAt={save.savedAt} shortcut={saveShortcutLabel}
      onBack={() => projects.goHome()} onSaveNow={() => projects.saveNow()} onRetry={() => projects.saveNow()}
      onResolveConflict={() => projects.openConflict()} />
  );
}

function ProjectsRoot(props: FlyCutCaptionProps) {
  const { projects } = useClientRuntime();
  const route = useProjectStore(state => state.route);
  const newerVersion = useProjectStore(state => state.newerVersion);
  const setProject = useProjectStore(state => state.set);
  const create = useCreateProject();
  const { resolvedTheme } = useThemeStore();
  const theme = props.config?.theme === 'light' || props.config?.theme === 'dark' ? props.config.theme : resolvedTheme;

  useEffect(() => {
    const sync = () => { void projects.applyHash(window.location.hash); };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [projects]);

  return (
    <div className={`flycut-caption-wrapper ${theme} h-screen`}>
      {route.name === 'editor'
        ? <FlyCutCaptionContent {...props} headerSlot={<EditorBreadcrumb />} onMedia={create} />
        : <ProjectsHomePage version={__FLYCUT_VERSION__} />}
      <ProjectOpenErrorDialog open={!!newerVersion} projectName={newerVersion?.name ?? ''} onClose={() => setProject({ newerVersion: null })} />
    </div>
  );
}

/** 带「我的项目」首页和自动保存的 FlyCut（桌面端和 Web 端的应用入口）。参数与 `FlyCutCaption` 相同。 */
export function ProjectsApp(props: FlyCutCaptionProps) {
  return (
    <LocaleProvider language={props.config?.language || 'en'} locale={props.locale} onLanguageChange={props.onLanguageChange}>
      <ThemeInitializer />
      <ClientRuntime shell={ProjectsRoot} plugins={CLIENT_PLUGINS}><PluginSlot id="shell" {...props} /></ClientRuntime>
      <ToastContainer />
    </LocaleProvider>
  );
}

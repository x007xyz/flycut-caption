// 项目模式的应用（F-0002）：同一个前端 Runtime 里，按地址栏在「我的项目」和编辑器之间切换。
// 展示组件在同目录；这里只负责接 `ctx.projects` 和 `stores.project`。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { LocaleProvider } from '@/contexts/LocaleProvider';
import { ClientRuntime, PluginSlot } from '@/runtime/ui';
import { useClientRuntime } from '@/runtime/context';
import { ThemeInitializer } from '@/components/ThemeInitializer';
import { ToastContainer } from '@/components/MessageCenter';
import { SettingsDialog } from '@/components/ProcessingPanel/SettingsDialog';
import { FlyCutCaptionContent } from '@/FlyCutCaption';
import { useMediaLoader, videoFileFromFile } from '@/hooks/useMediaLoader';
import { useProjectStore } from '@/stores/projectStore';
import { useThemeStore } from '@/stores/themeStore';
import { projectsClientPlugin } from '@/services/projectService';
import { isTauriRuntime } from '@/utils/runtime';
import type { FlyCutCaptionProps } from '@/types';
import type { VideoFile } from '@/types/video';
import { ProjectsShell } from './ProjectsShell';
import { ProjectsHome } from './ProjectsHome';
import { ProjectBreadcrumb } from './ProjectBreadcrumb';
import { MediaMissingBanner, ProjectOpenErrorDialog, SaveConflictDialog, UnsavedChangesDialog } from './ProjectDialogs';
import type { ProjectSummary, ProjectsView } from './types';
import { fill, isMacPlatform, saveShortcutLabel } from './format';
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

/** 「已保存」显示多久后淡出（AC-19，维护者 2026-11-05 选定约 3 秒） */
const SAVED_FADE_MS = 3000;

function EditorBreadcrumb() {
  const { projects } = useClientRuntime();
  const current = useProjectStore(state => state.current);
  const save = useProjectStore(state => state.save);
  if (!current) return null;
  return (
    <ProjectBreadcrumb projectName={current.name} status={save.status} savedAt={save.savedAt} shortcut={saveShortcutLabel} fadeAfterMs={SAVED_FADE_MS}
      onBack={() => { void projects.goHome(); }} onSaveNow={() => { void projects.flush(); }} onRetry={() => { void projects.flush(); }}
      onResolveConflict={() => projects.openConflict()} />
  );
}

/** 媒体丢失（AC-27）：播放器区域的横幅，重新选择文件后恢复播放。 */
function MediaMissingPlaceholder() {
  const { projects } = useClientRuntime();
  const current = useProjectStore(state => state.current);
  const input = useRef<HTMLInputElement>(null);
  const relink = useCallback(async (videoFile: VideoFile | null) => {
    if (!videoFile) return;
    try { await projects.relinkMedia(videoFile); }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
  }, [projects]);
  const choose = useCallback(async () => {
    if (!isTauriRuntime()) { input.current?.click(); return; }
    const { invoke } = await import('@tauri-apps/api/core');
    const path = await invoke<string | null>('pick_media_file');
    if (!path) return;
    const name = path.split(/[/\\]/).pop() || 'video';
    await relink({ file: new File([], name), url: '', duration: 0, size: 0, type: '', name, path });
  }, [relink]);
  if (current?.media.status !== 'missing') return null;
  return (
    <>
      <input ref={input} type="file" className="hidden" data-testid="relink-file-input" accept="video/*,audio/*"
        onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void videoFileFromFile(file).then(relink); }} />
      <MediaMissingBanner fileName={current.media.name} onRelocate={() => { void choose(); }} />
    </>
  );
}

/** 编辑器里的对话框和快捷键（AC-3 ⌘S、AC-24、AC-25），以及关闭窗口前的保护（AC-4）。 */
function EditorGuards() {
  const { projects } = useClientRuntime();
  const current = useProjectStore(state => state.current);
  const save = useProjectStore(state => state.save);
  const conflictDialog = useProjectStore(state => state.conflictDialog);
  const unsavedDialog = useProjectStore(state => state.unsavedDialog);
  const { language, tp } = useProjectText();
  const conflictTime = save.conflictAt ? new Date(save.conflictAt).toLocaleString(language, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 's' || event.shiftKey || event.altKey || !(isMacPlatform ? event.metaKey : event.ctrlKey)) return;
      event.preventDefault();
      void projects.flush();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [projects]);

  // 关闭窗口：桌面端拦截后先保存，失败弹 AC-24 对话框；Web 端只能用浏览器自带的离开确认
  useEffect(() => {
    if (isTauriRuntime()) {
      let unlisten: (() => void) | undefined; let disposed = false;
      void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
        const appWindow = getCurrentWindow();
        return appWindow.onCloseRequested(async event => {
          if (!projects.hasUnsavedChanges()) return;
          event.preventDefault();
          if (await projects.confirmLeave()) await appWindow.destroy();
        });
      }).then(off => { if (disposed) off(); else unlisten = off; });
      return () => { disposed = true; unlisten?.(); };
    }
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!projects.hasUnsavedChanges()) return;
      void projects.flush();
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [projects]);

  return (
    <>
      <SaveConflictDialog open={conflictDialog && !!current} projectName={current?.name ?? ''} otherSavedAt={conflictTime}
        onOverwrite={() => { void projects.resolveConflict('overwrite'); }}
        onSaveAsNew={() => { void projects.resolveConflict('save-as-new', fill(tp('copyName'), { name: current?.name ?? '' })).catch(error => toast.error(error instanceof Error ? error.message : String(error))); }}
        onCancel={() => { void projects.resolveConflict('cancel'); }} />
      <UnsavedChangesDialog open={!!unsavedDialog} retrying={unsavedDialog?.retrying}
        onRetry={() => { void projects.resolveUnsaved('retry'); }} onDiscard={() => { void projects.resolveUnsaved('discard'); }}
        onCancel={() => { void projects.resolveUnsaved('cancel'); }} />
    </>
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
        ? <>
          <FlyCutCaptionContent {...props} headerSlot={<EditorBreadcrumb />} playerPlaceholder={<MediaMissingPlaceholder />} onMedia={create} />
          <EditorGuards />
        </>
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

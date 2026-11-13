// 项目模式的应用（F-0002、F-0003）：同一个前端 Runtime 里，按地址栏在「我的项目」、项目详情、回收站和编辑器之间切换。
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
import { projectsClientPlugin, sortProjects } from '@/services/projectService';
import { useAppStore } from '@/stores/appStore';
import { isTauriRuntime } from '@/utils/runtime';
import type { FlyCutCaptionProps } from '@/types';
import type { VideoFile } from '@/types/video';
import { ProjectsShell } from './ProjectsShell';
import { ProjectsHome } from './ProjectsHome';
import { ProjectBreadcrumb } from './ProjectBreadcrumb';
import { ProjectDetail } from './ProjectDetail';
import { TrashPage } from './TrashPage';
import { SharedStyleHint, StyleSourceBar } from './StyleSource';
import { ConfirmDialog, DeleteProjectDialog, MediaMissingBanner, ProjectDeletedDialog, ProjectOpenErrorDialog, RenameProjectDialog, SaveConflictDialog,
  UnsavedChangesDialog } from './ProjectDialogs';
import { HotwordsDialog } from './HotwordsDialog';
import { RecoveryCheckingDialog, RecoveryChooseDialog, RecoveryConflictDialog, RecoveryDiscardDialog, RecoveryFailedDialog,
  RecoveryUnavailableBanner } from './RecoveryDialogs';
import { MediaUploadPanel } from './MediaUploadPanel';
import type { ProjectSummary, ProjectVideoItem, ProjectsView } from './types';
import type { ProjectVideoSummary } from '../../../shared/projects';
import { fill, isMacPlatform, saveShortcutLabel } from './format';
import { useProjectText } from './useProjectText';

const CLIENT_PLUGINS = [projectsClientPlugin];
const VIEW_KEY = 'flycut.projects.view';
const readView = (): ProjectsView => { try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid'; } catch { return 'grid'; } };

const HINT_KEY = 'flycut.projects.styleHintDismissed';
const hintDismissed = (projectId: string) => { try { return (JSON.parse(localStorage.getItem(HINT_KEY) ?? '[]') as string[]).includes(projectId); } catch { return false; } };
const dismissHint = (projectId: string) => {
  try { const ids = JSON.parse(localStorage.getItem(HINT_KEY) ?? '[]') as string[]; localStorage.setItem(HINT_KEY, JSON.stringify([...new Set([...ids, projectId])].slice(-500))); }
  catch { /* 只是界面偏好 */ }
};
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const MEDIA_ACCEPT = 'video/mp4,video/webm,video/quicktime,video/ogg,audio/mp3,audio/mpeg,audio/wav,audio/ogg,audio/m4a';
/** 桌面端拖入或原生对话框选中的本地文件（路径只交给外壳登记，ADR-0002）。 */
const desktopVideoFile = (path: string): VideoFile => { const name = path.split(/[/\\]/).pop() || 'video'; return { file: new File([], name), url: '', duration: 0, size: 0, type: '', name, path }; };

/** 桌面端拖入由 Tauri 处理，网页的 drop 事件拿不到本地路径。 */
function useDesktopDrop(onPaths: ((paths: string[]) => void) | null) {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!isTauriRuntime() || !onPaths) return;
    let unlisten: (() => void) | undefined; let disposed = false;
    void import('@tauri-apps/api/webview').then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent(event => {
      if (event.payload.type === 'enter' || event.payload.type === 'over') setDragging(true);
      else if (event.payload.type === 'leave') setDragging(false);
      else { setDragging(false); onPaths(event.payload.paths); }
    })).then(off => { if (disposed) off(); else unlisten = off; });
    return () => { disposed = true; unlisten?.(); };
  }, [onPaths]);
  return dragging;
}

/** 封面按需读取（F-0002 AC-14）；读不到就保持占位图。 */
function useCovers(entries: Array<{ key: string; projectId: string; videoId?: string; revision: number; hasThumbnail: boolean }>) {
  const { projects } = useClientRuntime();
  const [covers, setCovers] = useState<Record<string, string>>({});
  const signature = entries.map(entry => `${entry.key}:${entry.videoId}:${entry.revision}:${entry.hasThumbnail}`).join('|');
  useEffect(() => {
    let cancelled = false;
    for (const entry of entries) {
      if (!entry.hasThumbnail || !entry.videoId) continue;
      void projects.thumbnail(entry.projectId, entry.videoId, entry.revision).then(url => {
        if (!cancelled && url) setCovers(previous => previous[entry.key] === url ? previous : { ...previous, [entry.key]: url });
      });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- entries 每次渲染都是新数组，按内容签名比较
  }, [signature, projects]);
  return covers;
}

/** 重命名对话框（F-0003 AC-21），首页、列表视图和详情页共用。 */
function useRenameDialog() {
  const { projects } = useClientRuntime();
  const { tp } = useProjectText();
  const [target, setTarget] = useState<{ id: string; name: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const open = useCallback((id: string, name: string) => { setTarget({ id, name }); setError(undefined); }, []);
  const element = (
    <RenameProjectDialog open={!!target} initialName={target?.name ?? ''} saving={saving} error={error}
      onCancel={() => { if (!saving) setTarget(null); }}
      onSubmit={name => {
        if (!target) return;
        setSaving(true); setError(undefined);
        void projects.rename(target.id, name).then(() => setTarget(null), () => setError(tp('renameFailed'))).finally(() => setSaving(false));
      }} />
  );
  return { open, element };
}

function useShellNavigation() {
  const { projects } = useClientRuntime();
  return useCallback((page: 'projects' | 'trash') => {
    if (page === 'trash') void projects.openTrash();
    else void projects.goHome();
  }, [projects]);
}

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
  const sort = useProjectStore(state => state.sort);
  const { tp, language } = useProjectText();
  const [query, setQuery] = useState('');
  const [view, setView] = useState<ProjectsView>(readView);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleting, setDeleting] = useState<{ id: string; name: string; busy: boolean } | null>(null);
  const rename = useRenameDialog();
  const navigate = useShellNavigation();
  const create = useCreateProject();
  const media = useMediaLoader({ onMedia: create });
  const { handlePaths } = media;
  const desktopDrag = useDesktopDrop(handlePaths);

  const covers = useCovers(items.map(item => ({ key: item.id, projectId: item.id, videoId: item.videoId, revision: item.revision, hasThumbnail: item.hasThumbnail })));

  const changeView = (next: ProjectsView) => { setView(next); try { localStorage.setItem(VIEW_KEY, next); } catch { /* 只是界面偏好 */ } };
  const summaries = useMemo<ProjectSummary[]>(() => {
    const needle = query.trim().toLowerCase();
    return sortProjects(items.filter(item => !needle || item.name.toLowerCase().includes(needle)), sort, language).map(item => ({
      id: item.id, name: item.name, durationSeconds: item.durationSeconds, createdAt: item.createdAt, updatedAt: item.updatedAt,
      videoCount: item.videoCount, mediaMissing: item.mediaMissing || undefined, thumbnailUrl: covers[item.id],
      transcribing: transcribing?.projectId === item.id ? { progress: Math.round(transcribing.progress) } : undefined,
    }));
  }, [items, query, transcribing, covers, sort, language]);
  const nameOf = (id: string) => items.find(item => item.id === id)?.name ?? '';

  const confirmDelete = () => {
    if (!deleting) return;
    const { id, name } = deleting;
    setDeleting({ ...deleting, busy: true });
    void projects.trashProject(id).then(() => {
      setDeleting(null);
      // AC-22：提示里带「撤销」，等同于从回收站恢复
      toast.success(tp('movedToTrash'), { action: { label: tp('undo'), onClick: () => {
        void projects.restore(id).then(() => toast.success(tp('restored', { name })), () => toast.error(tp('restoreFailed')));
      } } });
    }, error => { setDeleting(null); toast.error(errorText(error)); });
  };

  return (
    <ProjectsShell version={version} onOpenSettings={() => setSettingsOpen(true)} active="projects" onNavigate={navigate}>
      <input ref={media.uploadInputRef} type="file" className="hidden" data-testid="project-file-input" accept={MEDIA_ACCEPT} onChange={media.handleNativeFileSelect} />
      <div className="mx-auto w-full max-w-6xl px-8"><MediaUploadPanel kind="create" /></div>
      <ProjectsHome status={listStatus} projects={summaries} totalCount={items.length} query={query} onQueryChange={setQuery}
        view={view} onViewChange={changeView} sort={sort} onSortChange={next => projects.setSort(next)} openingId={openingId} creating={creating || media.isMediaLoading}
        onOpen={id => { void projects.openFromHome(id).catch(error => toast.error(errorText(error))); }}
        onFilesDropped={files => { void media.handleFiles(files); }} onChooseFile={media.handleUploadClick}
        onUseSample={() => { void media.handleLoadSampleVideo(); }}
        onCreateEmpty={() => { void projects.createEmpty(tp('untitled')).catch(error => toast.error(errorText(error))); }}
        onRetry={() => { void projects.retryList(); }} dragActive={desktopDrag}
        onRename={id => rename.open(id, nameOf(id))} onDelete={id => setDeleting({ id, name: nameOf(id), busy: false })} />
      {rename.element}
      <DeleteProjectDialog open={!!deleting} projectName={deleting?.name ?? ''} busy={deleting?.busy} onConfirm={confirmDelete}
        onCancel={() => { if (!deleting?.busy) setDeleting(null); }} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </ProjectsShell>
  );
}

/** 项目详情页（F-0003 AC-26 到 AC-29）。 */
function ProjectDetailPage({ version }: { version: string }) {
  const { projects } = useClientRuntime();
  const detail = useProjectStore(state => state.detail);
  const transcribing = useProjectStore(state => state.transcribing);
  const { tp } = useProjectText();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [removing, setRemoving] = useState<{ id: string; name: string; busy: boolean; error?: string } | null>(null);
  const rename = useRenameDialog();
  const navigate = useShellNavigation();
  const input = useRef<HTMLInputElement>(null);
  const addFiles = useCallback((files: VideoFile[]) => { if (files.length) void projects.addVideos(files); }, [projects]);
  const onPaths = useCallback((paths: string[]) => addFiles(paths.map(desktopVideoFile)), [addFiles]);
  const desktopDrag = useDesktopDrop(detail?.status === 'ready' ? onPaths : null);
  const projectId = detail?.projectId ?? '';
  const covers = useCovers((detail?.videos ?? []).map(video => ({ key: video.id, projectId, videoId: video.id, revision: video.revision, hasThumbnail: video.hasThumbnail })));

  const chooseFiles = useCallback(async () => {
    if (!isTauriRuntime()) { input.current?.click(); return; }
    const { invoke } = await import('@tauri-apps/api/core');
    addFiles((await invoke<string[]>('pick_media_files')).map(desktopVideoFile));
  }, [addFiles]);

  if (!detail) return null;
  const videos: ProjectVideoItem[] = detail.videos.map(video => ({ id: video.id, name: video.name, durationSeconds: video.durationSeconds, updatedAt: video.updatedAt,
    thumbnailUrl: covers[video.id], mediaMissing: video.mediaMissing || undefined,
    status: transcribing?.projectId === projectId && transcribing.videoId === video.id ? { kind: 'transcribing', progress: Math.round(transcribing.progress) }
      : video.hasTranscript ? { kind: 'ready' } : { kind: 'not-transcribed' } }));

  const confirmRemove = () => {
    if (!removing) return;
    setRemoving({ ...removing, busy: true, error: undefined });
    void projects.removeVideo(projectId, removing.id).then(() => setRemoving(null), () => setRemoving(previous => previous && { ...previous, busy: false, error: tp('removeFailed') }));
  };

  return (
    <ProjectsShell version={version} onOpenSettings={() => setSettingsOpen(true)} active="projects" onNavigate={navigate}>
      <input ref={input} type="file" multiple className="hidden" data-testid="project-add-input" accept={MEDIA_ACCEPT}
        onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void Promise.all(files.map(videoFileFromFile)).then(addFiles); }} />
      <div className="mx-auto w-full max-w-6xl px-8"><MediaUploadPanel kind="add" projectId={projectId} /></div>
      <ProjectDetail status={detail.status} name={detail.name} videos={videos} adding={detail.adding} openingVideoId={detail.openingVideoId} dragActive={desktopDrag}
        onBack={() => { void projects.goHome(); }} onRetry={() => { void projects.loadDetail(projectId); }}
        onOpenVideo={id => { void projects.openVideo(id).catch(error => toast.error(errorText(error))); }}
        onAddVideo={() => { void chooseFiles(); }}
        onFilesDropped={files => { void Promise.all(files.map(videoFileFromFile)).then(addFiles); }}
        onRename={() => rename.open(projectId, detail.name)}
        onManageHotwords={() => { void projects.openHotwordsDialog(projectId, detail.name); }}
        onRemoveVideo={id => setRemoving({ id, name: detail.videos.find(video => video.id === id)?.name ?? '', busy: false })}
        onDismissFailed={key => projects.dismissFailedAdd(key)} />
      {rename.element}
      <ConfirmDialog open={!!removing} title={tp('removeTitle', { name: removing?.name ?? '' })} description={tp('removeDescription')} confirmLabel={tp('remove')}
        destructive busy={removing?.busy} error={removing?.error} onConfirm={confirmRemove} onCancel={() => { if (!removing?.busy) setRemoving(null); }} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </ProjectsShell>
  );
}

/** 回收站（F-0003 AC-23 到 AC-25）。 */
function TrashPageContainer({ version }: { version: string }) {
  const { projects } = useClientRuntime();
  const trash = useProjectStore(state => state.trash);
  const { tp } = useProjectText();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: 'one'; id: string; name: string; count: number } | { kind: 'all'; count: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const navigate = useShellNavigation();
  const covers = useCovers(trash.items.map(item => ({ key: item.id, projectId: item.id, videoId: item.videoId, revision: item.revision, hasThumbnail: item.hasThumbnail })));

  const restore = (id: string) => {
    const name = trash.items.find(item => item.id === id)?.name ?? '';
    void projects.restore(id).then(() => toast.success(tp('restored', { name })), () => toast.error(tp('restoreFailed')));
  };
  const run = () => {
    if (!confirm) return;
    setBusy(true); setError(undefined);
    const task = confirm.kind === 'one' ? projects.purge(confirm.id) : projects.emptyTrash();
    void task.then(() => setConfirm(null), () => setError(tp('purgeFailed'))).finally(() => setBusy(false));
  };
  const open = (next: typeof confirm) => { setError(undefined); setConfirm(next); };

  return (
    <ProjectsShell version={version} onOpenSettings={() => setSettingsOpen(true)} active="trash" onNavigate={navigate}>
      <TrashPage status={trash.status} restoringId={trash.restoringId}
        items={trash.items.map(item => ({ id: item.id, name: item.name, videoCount: item.videoCount, durationSeconds: item.durationSeconds,
          thumbnailUrl: covers[item.id], deletedAt: item.deletedAt, purgeAfter: item.purgeAfter }))}
        onRetry={() => { void projects.refreshTrash(true); }} onRestore={restore}
        onPurge={id => { const item = trash.items.find(entry => entry.id === id); if (item) open({ kind: 'one', id, name: item.name, count: item.videoCount }); }}
        onEmptyTrash={() => open({ kind: 'all', count: trash.items.length })} />
      <ConfirmDialog open={!!confirm} destructive busy={busy} error={error} onConfirm={run} onCancel={() => { if (!busy) setConfirm(null); }}
        title={confirm?.kind === 'one' ? tp('purgeTitle', { name: confirm.name }) : tp('emptyTrashTitle')}
        description={confirm?.kind === 'one' ? tp('purgeDescription', { count: confirm.count }) : tp('emptyTrashDescription', { count: confirm?.count ?? 0 })}
        confirmLabel={confirm?.kind === 'one' ? tp('purge') : tp('emptyTrash')} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </ProjectsShell>
  );
}

/** 「已保存」显示多久后淡出（AC-19，维护者 2026-11-05 选定约 3 秒） */
const SAVED_FADE_MS = 3000;

const videoStatus = (video: ProjectVideoSummary, transcribing: { videoId: string; progress: number } | null): ProjectVideoItem['status'] =>
  transcribing?.videoId === video.id ? { kind: 'transcribing', progress: Math.round(transcribing.progress) } : video.hasTranscript ? { kind: 'ready' } : { kind: 'not-transcribed' };

function EditorBreadcrumb() {
  const { projects } = useClientRuntime();
  const current = useProjectStore(state => state.current);
  const save = useProjectStore(state => state.save);
  const switchingVideoId = useProjectStore(state => state.switchingVideoId);
  const transcribingState = useProjectStore(state => state.transcribing);
  const projectDeleted = useProjectStore(state => state.projectDeleted);
  const transcribing = useAppStore(state => state.isLoading);
  const setProject = useProjectStore(state => state.set);
  if (!current) return null;
  const tracked = transcribingState?.projectId === current.projectId ? transcribingState : null;
  return (
    <ProjectBreadcrumb projectName={current.name} status={save.status} savedAt={save.savedAt} shortcut={saveShortcutLabel} fadeAfterMs={SAVED_FADE_MS}
      onBack={() => { void projects.goHome(); }} onSaveNow={() => { void projects.flush(); }} onRetry={() => { void projects.flush(); }}
      onResolveConflict={() => { if (projectDeleted) setProject({ projectDeleted: { ...projectDeleted } }); else projects.openConflict(); }}
      onOpenProject={() => { void projects.openDetail(current.projectId); }}
      videos={current.videos.map(video => ({ id: video.id, name: video.name, mediaMissing: video.mediaMissing, status: videoStatus(video, tracked) }))}
      currentVideoId={current.videoId} videoName={current.videoName} switchingVideoId={switchingVideoId} transcribing={transcribing}
      onSwitchVideo={id => { void projects.switchVideo(id).catch(error => toast.error(errorText(error))); }} />
  );
}

/** 字幕样式面板顶部的样式来源（F-0003 AC-13、AC-31）。 */
function StyleSourceSlot() {
  const { projects } = useClientRuntime();
  const source = useProjectStore(state => state.current?.styleSource);
  const { tp } = useProjectText();
  const [confirming, setConfirming] = useState(false);
  if (!source) return null;
  return (
    <>
      <StyleSourceBar source={source} onCustomize={() => projects.customizeStyle()} onFollow={() => setConfirming(true)} />
      <ConfirmDialog open={confirming} title={tp('styleFollow')} description={tp('styleFollowConfirm')} confirmLabel={tp('styleFollowConfirmButton')}
        onConfirm={() => { setConfirming(false); projects.followProjectStyle(); }} onCancel={() => setConfirming(false)} />
    </>
  );
}

/** 跟随项目时第一次改样式后的提示，关闭后同一项目不再显示（AC-31）。 */
function SharedStyleHintSlot() {
  const current = useProjectStore(state => state.current);
  const [dismissed, setDismissed] = useState<string[]>([]);
  if (!current || current.styleSource !== 'project' || !current.styleTouched) return null;
  if (dismissed.includes(current.projectId) || hintDismissed(current.projectId)) return null;
  return <SharedStyleHint onDismiss={() => { dismissHint(current.projectId); setDismissed(previous => [...previous, current.projectId]); }} />;
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
  const projectDeleted = useProjectStore(state => state.projectDeleted);
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
      <ProjectDeletedDialog open={!!projectDeleted && !!current} projectName={current?.name ?? ''} state={projectDeleted?.state ?? 'deleted'}
        busy={projectDeleted?.busy} error={projectDeleted?.error}
        onRestore={() => { void projects.resolveDeleted('restore', ''); }}
        onSaveAsNew={() => { void projects.resolveDeleted('save-as-new', fill(tp('copyName'), { name: current?.name ?? '' })); }}
        onDiscard={() => { void projects.resolveDeleted('discard', ''); }} />
      <UnsavedChangesDialog open={!!unsavedDialog} retrying={unsavedDialog?.retrying}
        onRetry={() => { void projects.resolveUnsaved('retry'); }} onDiscard={() => { void projects.resolveUnsaved('discard'); }}
        keepLabel={unsavedDialog?.keep ? tp('unsavedKeep') : undefined} onKeep={unsavedDialog?.keep ? () => { void projects.resolveUnsaved('keep'); } : undefined}
        onCancel={() => { void projects.resolveUnsaved('cancel'); }} />
    </>
  );
}

const CHECKING_DELAY_MS = 300;

/** 崩溃恢复（F-0004 AC-2 到 AC-9）：打开项目时的检查、选择、恢复、冲突和放弃。 */
function RecoveryGate() {
  const { projects } = useClientRuntime();
  const recovery = useProjectStore(state => state.recovery);
  const current = useProjectStore(state => state.current);
  const { tp, language } = useProjectText();
  const time = (iso?: string) => iso ? new Date(iso).toLocaleString(language, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  const { phase, candidates, selectedKey } = recovery;
  const selected = candidates.find(candidate => candidate.key === selectedKey);
  const showError = (error: unknown) => toast.error(errorText(error));
  // 检查通常只要几十毫秒：超过 300ms 才显示，避免每次打开都闪一下（检查期间编辑器始终被挡住）
  const [checkingVisible, setCheckingVisible] = useState(false);
  useEffect(() => {
    if (phase !== 'checking') { setCheckingVisible(false); return; }
    const timer = setTimeout(() => setCheckingVisible(true), CHECKING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [phase]);
  const recover = () => { void projects.recover().then(ok => { if (ok) toast.success(tp('recoveryRecovered')); }, showError); };
  return (
    <>
      <RecoveryCheckingDialog open={checkingVisible} onBack={() => { void projects.leaveRecovery(); }} />
      <RecoveryChooseDialog open={phase === 'choose' || phase === 'applying'} applying={phase === 'applying'} selectedKey={selectedKey}
        recordedAt={time(selected?.recordedAt)} hostSavedAt={time(recovery.hostSavedAt)}
        choices={candidates.map((candidate, index) => ({ key: candidate.key, recordedAt: candidate.recordedAt,
          label: tp('recoverySession', { n: index + 1, time: time(candidate.recordedAt) }) }))}
        onSelect={key => projects.selectRecovery(key)} onRecover={recover} onDiscard={() => projects.askDiscardRecovery()}
        onLater={() => { void projects.leaveRecovery(); }} />
      <RecoveryConflictDialog open={phase === 'conflict' || phase === 'conflict-busy'} busy={phase === 'conflict-busy'}
        onOverwrite={() => { void projects.resolveRecoveryConflict('overwrite').then(result => { if (result === 'recovered') toast.success(tp('recoveryRecovered')); }, showError); }}
        onSaveAsNew={() => { void projects.resolveRecoveryConflict('save-as-new', fill(tp('copyName'), { name: current?.name ?? '' }))
          .then(result => { if (result === 'saved-as-new') toast.success(tp('recoveryRecovered')); }, showError); }}
        onCancel={() => { void projects.resolveRecoveryConflict('cancel'); }} />
      <RecoveryDiscardDialog open={phase === 'discard' || phase === 'discarding'} busy={phase === 'discarding'} failed={recovery.discardFailed}
        onConfirm={() => { void projects.discardRecovery().then(ok => { if (ok) toast.success(tp('recoveryDiscarded')); }, showError); }}
        onCancel={() => projects.cancelDiscardRecovery()} />
      <RecoveryFailedDialog open={phase === 'failed'} missing={recovery.failure?.missing} uncertain={recovery.failure?.uncertain}
        onRetry={() => { void projects.retryRecovery().then(ok => { if (ok) toast.success(tp('recoveryRecovered')); }, showError); }}
        onBack={() => { void projects.leaveRecovery(); }} />
    </>
  );
}

/** AC-10：本地恢复记录失败时的提示条。 */
function RecoveryHealthBanner() {
  const { projects } = useClientRuntime();
  const health = useProjectStore(state => state.recoveryHealth);
  const [retrying, setRetrying] = useState(false);
  if (health !== 'unavailable') return null;
  return <RecoveryUnavailableBanner retrying={retrying}
    onRetry={() => { setRetrying(true); void projects.retryRecoveryRecord().finally(() => setRetrying(false)); }}
    onSaveNow={() => { void projects.flush(); }} />;
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
          <FlyCutCaptionContent {...props} headerSlot={<EditorBreadcrumb />} playerPlaceholder={<MediaMissingPlaceholder />} onMedia={create}
            styleHeaderSlot={<StyleSourceSlot />} styleFooterSlot={<SharedStyleHintSlot />} />
          <EditorGuards />
          <RecoveryHealthBanner />
        </>
        : route.name === 'project' ? <ProjectDetailPage version={__FLYCUT_VERSION__} />
        : route.name === 'trash' ? <TrashPageContainer version={__FLYCUT_VERSION__} />
        : <ProjectsHomePage version={__FLYCUT_VERSION__} />}
      <RecoveryGate />
      <HotwordsDialog />
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

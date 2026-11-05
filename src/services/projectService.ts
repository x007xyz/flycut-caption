// 项目服务（F-0002）：前端 Cordis 插件，提供 `ctx.projects`。负责项目的新建、打开、路由，以及把转写结果写回 Host。
// 只通过 Host RPC 读写项目数据；界面状态放在 `stores.project`。
import type { Context } from '@deepseek-ai/cordis';
import type { ModelRef } from '../../shared/providers';
import type { ProjectEdits, ProjectOpenResult, ProjectPlayback } from '../../shared/projects';
import type { SubtitleTranscript } from '@/types/subtitle';
import type { VideoFile } from '@/types/video';
import type { RemoteConnection } from '@/runtime/connection';
import type { RuntimeStores } from '@/stores/runtimeStore';
import type { CurrentProject, ProjectRoute } from '@/stores/projectStore';
import { isTauriRuntime } from '@/utils/runtime';

declare module '@deepseek-ai/cordis' {
  interface Context { projects: ProjectService }
  interface Events {
    /** 识别完成（`useASR`）。项目模式下由项目服务写进对应项目。 */
    'flycut/transcribed'(payload: { videoFile: VideoFile; transcript: SubtitleTranscript; model: ModelRef | null }): void;
  }
}

const HOME_HASH = '#/projects';
const EDITOR_HASH = /^#\/projects\/([0-9a-f-]{36})\/videos\/([0-9a-f-]{36})$/i;

export const routeToHash = (route: ProjectRoute) => route.name === 'home' ? HOME_HASH : `#/projects/${route.projectId}/videos/${route.videoId}`;
export function hashToRoute(hash: string): ProjectRoute {
  const match = EDITOR_HASH.exec(hash);
  return match ? { name: 'editor', projectId: match[1], videoId: match[2] } : { name: 'home' };
}

const baseName = (name: string) => name.replace(/\.[^./\\]+$/, '') || name;

/** 已保存的修改叠加在转写结果上：句级字幕以 edits 为准，字词只恢复删除标记。 */
export function mergeEdits(transcript: SubtitleTranscript, edits?: ProjectEdits): SubtitleTranscript {
  if (!edits) return transcript;
  const deleted = new Set(edits.deletedWordIds);
  return { ...transcript, chunks: edits.chunks as unknown as SubtitleTranscript['chunks'],
    wordChunks: transcript.wordChunks?.map(word => ({ ...word, deleted: deleted.has(word.id) })) };
}

export class ProjectService {
  private ctx: Context;
  private connection: RemoteConnection;
  private stores: RuntimeStores;
  /** 每个视频对象属于哪个项目：识别完成时据此写回，即使用户已经离开了这个项目。 */
  private owners = new WeakMap<VideoFile, { projectId: string; videoId: string }>();

  constructor(ctx: Context) { this.ctx = ctx; this.connection = ctx.connection; this.stores = ctx.stores; }

  private get state() { return this.stores.project.getState(); }

  /** 读取项目列表（AC-11、AC-12、AC-14）。 */
  async refresh() {
    const { set } = this.state;
    set({ listStatus: this.state.projects.length ? 'ready' : 'loading' });
    try { set({ projects: await this.connection.call('projects.list'), listStatus: 'ready' }); }
    catch (error) { console.error('读取项目失败', error); set({ listStatus: 'error' }); }
  }

  retryList() { this.state.set({ listStatus: 'loading', projects: [] }); return this.refresh(); }

  /** 拖入、选择文件或示例视频：在 Host 上建项目并进入编辑器（AC-1、AC-17）。 */
  async createFromMedia(videoFile: VideoFile): Promise<{ projectId: string; videoId: string; name: string } | null> {
    const { set } = this.state;
    if (this.state.creating) return null;
    set({ creating: true });
    try {
      const name = baseName(videoFile.name);
      let media: { assetId: string; mimeType: string } | { mediaRef: string };
      if (videoFile.path && isTauriRuntime()) {
        const { invoke } = await import('@tauri-apps/api/core');
        media = { mediaRef: (await invoke<{ mediaRef: string }>('link_project_media', { path: videoFile.path })).mediaRef };
      } else {
        media = { assetId: await this.connection.upload(videoFile.file), mimeType: videoFile.type };
      }
      const created = await this.connection.call('projects.create', { name, videoName: videoFile.name,
        durationSeconds: Number.isFinite(videoFile.duration) ? videoFile.duration : 0, media });
      this.owners.set(videoFile, { projectId: created.projectId, videoId: created.videoId });
      this.loadEditor({ projectId: created.projectId, videoId: created.videoId, name, revision: created.revision, hasTranscript: false,
        media: { status: 'ok', name: videoFile.name } }, videoFile);
      // 新视频照常开始识别（appStore.setVideoFile 已切到 transcribe）
      return { projectId: created.projectId, videoId: created.videoId, name };
    } finally { set({ creating: false }); }
  }

  /** 打开项目（AC-5、AC-18）：载入保存的字幕和样式，不重新识别；格式过新时停在首页（AC-26）。 */
  async open(projectId: string, videoId?: string) {
    const { set } = this.state;
    if (this.state.openingId) return;
    set({ openingId: projectId });
    try {
      const result: ProjectOpenResult = await this.connection.call('projects.open', { projectId, videoId });
      if (result.status === 'newer-version') { set({ newerVersion: { name: result.name } }); this.navigate({ name: 'home' }); return; }
      const { project, video, transcript, edits, media } = result;
      const videoFile = media.status === 'ok' && media.playback ? this.playbackFile(media.playback, media.name, video.durationSeconds) : null;
      if (videoFile) this.owners.set(videoFile, { projectId, videoId: video.id });
      this.loadEditor({ projectId, videoId: video.id, name: project.name, revision: project.revision, hasTranscript: video.hasTranscript,
        media: { status: media.status, name: media.name } }, videoFile, transcript ? mergeEdits(transcript as unknown as SubtitleTranscript, edits) : undefined);
    } finally { set({ openingId: null }); }
  }

  /** 回到首页。 */
  goHome() {
    this.state.set({ current: null, save: { status: 'saved' } });
    this.stores.history.getState().reset();
    this.stores.app.getState().setVideoFile(null);
    this.navigate({ name: 'home' });
    void this.refresh();
  }

  /** 切换路由并同步地址栏；`fromHash` 表示是地址栏变化引起的，不再回写。 */
  navigate(route: ProjectRoute, fromHash = false) {
    this.state.set({ route });
    if (!fromHash && typeof window !== 'undefined' && window.location.hash !== routeToHash(route)) window.location.hash = routeToHash(route);
  }

  /** 地址栏指向的页面（刷新、前进后退）。 */
  async applyHash(hash: string) {
    const route = hashToRoute(hash);
    const current = this.state.current;
    if (route.name === 'editor') {
      if (current?.projectId === route.projectId && current.videoId === route.videoId) return;
      try { await this.open(route.projectId, route.videoId); }
      catch (error) { console.error('打开项目失败', error); this.navigate({ name: 'home' }); void this.refresh(); }
      return;
    }
    if (current) this.goHome(); else { this.navigate(route, true); void this.refresh(); }
  }

  /** 立即保存（⌘S / Ctrl+S、点击保存状态）。自动保存见清单第 2 项。 */
  saveNow() { /* 第 2 项实现 */ }

  /** 打开冲突对话框（AC-23 → AC-25）。见清单第 4 项。 */
  openConflict() { /* 第 4 项实现 */ }

  ownerOf(videoFile: VideoFile | null) { return videoFile ? this.owners.get(videoFile) : undefined; }

  /** 识别结果写回项目（AC-2）。 */
  async saveTranscript(videoFile: VideoFile, transcript: SubtitleTranscript, model: ModelRef | null) {
    const owner = this.owners.get(videoFile); if (!owner) return;
    const record = { text: transcript.text, chunks: transcript.chunks, wordChunks: transcript.wordChunks, hasWordTimestamps: transcript.hasWordTimestamps,
      language: transcript.language, duration: transcript.duration };
    const result = await this.connection.call('projects.saveTranscript', { ...owner, transcript: record as never, model: model ?? undefined,
      durationSeconds: videoFile.duration || undefined });
    const current = this.state.current;
    if (current?.projectId === owner.projectId) {
      this.state.set({ current: { ...current, revision: result.revision, hasTranscript: true } });
      this.state.setSave({ status: 'saved', savedAt: result.updatedAt });
    }
  }

  private playbackFile(playback: ProjectPlayback, name: string, duration: number): VideoFile {
    const type = mimeFromName(name);
    if (playback.kind === 'path') {
      return { file: new File([], name, { type }), url: tauriFileUrl(playback.path), duration, size: 0, type, name, path: playback.path };
    }
    return { file: new File([], name, { type }), url: this.connection.resourceUrl(playback.path), duration, size: 0, type, name, remotePath: playback.path };
  }

  private loadEditor(current: CurrentProject, videoFile: VideoFile | null, transcript?: SubtitleTranscript) {
    const history = this.stores.history.getState(); const app = this.stores.app.getState();
    history.reset(); app.clearASRProgress();
    app.setVideoFile(videoFile);
    if (transcript) {
      history.setTranscript(transcript);
      // 重新打开后从保存时的状态开始，撤销栈为空
      this.stores.history.setState({ undoStack: [], redoStack: [], canUndo: false, canRedo: false });
    }
    // 已有转写结果，或媒体丢失无法识别：直接进入编辑
    if (transcript || !videoFile) app.setStage('edit');
    this.state.set({ current, save: { status: 'saved' } });
    this.navigate({ name: 'editor', projectId: current.projectId, videoId: current.videoId });
  }
}

const MIME: Record<string, string> = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', avi: 'video/x-msvideo', mkv: 'video/x-matroska',
  ogg: 'video/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac' };
export const mimeFromName = (name: string) => MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? '';

/** Tauri 资产协议地址（与 `convertFileSrc` 相同，同步计算，避免为打开项目再动态导入）。 */
function tauriFileUrl(path: string) {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { convertFileSrc?: (path: string, protocol?: string) => string } }).__TAURI_INTERNALS__;
  return internals?.convertFileSrc ? internals.convertFileSrc(path, 'asset') : path;
}

/** 项目服务插件：只在项目模式（`ProjectsApp`）里加载，单独使用 `FlyCutCaption` 时不存在。 */
export const projectsClientPlugin = { name: 'flycut-projects-client', inject: ['connection', 'stores'], apply(ctx: Context) {
  const service = new ProjectService(ctx);
  ctx.provide('projects', service);
  // 首页卡片上的转写进度（AC-14）：识别开始时记下它属于哪个项目，离开编辑器后也能继续显示
  ctx.effect(() => ctx.stores.app.subscribe((app, previous) => {
    const project = ctx.stores.project.getState();
    if (app.isLoading && !previous.isLoading) {
      const owner = service.ownerOf(app.videoFile);
      if (owner) project.set({ transcribing: { projectId: owner.projectId, progress: 0 } });
    } else if (!app.isLoading && previous.isLoading && project.transcribing) {
      project.set({ transcribing: null });
      if (project.route.name === 'home') void service.refresh();
    } else if (project.transcribing && app.asrProgress !== previous.asrProgress && typeof app.asrProgress?.progress === 'number') {
      project.set({ transcribing: { ...project.transcribing, progress: app.asrProgress.progress } });
    }
  }));
  ctx.effect(() => ctx.on('flycut/transcribed', ({ videoFile, transcript, model }) => {
    service.saveTranscript(videoFile, transcript, model).catch(error => {
      console.error('保存转写结果失败', error);
      ctx.stores.project.getState().setSave({ status: 'failed', error: error instanceof Error ? error.message : String(error) });
    });
  }));
} };

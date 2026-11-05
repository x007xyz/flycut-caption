// 项目服务（F-0002）：前端 Cordis 插件，提供 `ctx.projects`。负责项目的新建、打开、路由、自动保存，以及把转写结果写回 Host。
// 只通过 Host RPC 读写项目数据；界面状态放在 `stores.project`。
import type { Context } from '@deepseek-ai/cordis';
import type { ModelRef } from '../../shared/providers';
import type { ProjectEdits, ProjectOpenResult, ProjectPlayback, SaveResult } from '../../shared/projects';
import type { SubtitleChunk, SubtitleTranscript } from '@/types/subtitle';
import type { VideoFile } from '@/types/video';
import type { RemoteConnection } from '@/runtime/connection';
import type { RuntimeStores } from '@/stores/runtimeStore';
import type { CurrentProject, ProjectRoute } from '@/stores/projectStore';
import type { SubtitleStylePair } from '@/subtitle';
import { defaultSubtitleStylePair } from '@/subtitle';
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

/** 停止操作多久后自动保存（AC-3 要求 3 秒内） */
export const AUTOSAVE_DELAY_MS = 1500;
/** 保存失败后的重试间隔（AC-4），之后一直按最后一档重试 */
export const RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 30000];

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

/** 自动保存写入的内容：字幕修改、删除标记、译文、样式和画幅（不重发转写结果）。 */
export function buildEdits(chunks: SubtitleChunk[], wordChunks: SubtitleChunk[], stylePair: SubtitleStylePair): ProjectEdits {
  return { chunks: chunks as unknown as ProjectEdits['chunks'], deletedWordIds: wordChunks.filter(word => word.deleted).map(word => word.id),
    stylePair: stylePair as unknown as ProjectEdits['stylePair'] };
}

interface Snapshot { chunks: SubtitleChunk[]; wordChunks: SubtitleChunk[]; style: SubtitleStylePair }
/** 离开编辑器的动作（回首页、打开别的项目、关闭窗口），在 AC-24 的对话框后继续执行。 */
export type LeaveAction = () => void | Promise<void>;

export class ProjectService {
  private ctx: Context;
  private connection: RemoteConnection;
  private stores: RuntimeStores;
  /** 每个视频对象属于哪个项目：识别完成时据此写回，即使用户已经离开了这个项目。 */
  private owners = new WeakMap<VideoFile, { projectId: string; videoId: string }>();
  /** 最后一次写到 Host（或刚载入）的内容；字幕和样式数组按引用比较，不做深比较。 */
  private baseline: Snapshot | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  /** 进行中的保存。同一时间最多一个请求；进行中又有修改，结束后再存一次。 */
  private inFlight: Promise<boolean> | null = null;
  /** 同一项目的所有写入（转写、修改）排队，修订号才不会互相打架 */
  private queue: Promise<unknown> = Promise.resolve();
  /** 写入失败的转写结果：随自动保存一起重试，避免识别结果丢失 */
  private pendingTranscript: { videoFile: VideoFile; transcript: SubtitleTranscript; model: ModelRef | null } | null = null;

  constructor(ctx: Context) { this.ctx = ctx; this.connection = ctx.connection; this.stores = ctx.stores; }

  private get state() { return this.stores.project.getState(); }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(task);
    this.queue = next;
    return next;
  }

  // ---------- 首页 ----------

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
    if (!(await this.confirmLeave())) return null;
    set({ creating: true });
    try {
      const name = baseName(videoFile.name);
      const media = await this.mediaSource(videoFile);
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
    if (!(await this.confirmLeave())) return;
    set({ openingId: projectId });
    try {
      const result: ProjectOpenResult = await this.connection.call('projects.open', { projectId, videoId });
      if (result.status === 'newer-version') { set({ newerVersion: { name: result.name } }); this.navigate({ name: 'home' }); return; }
      const { project, video, transcript, edits, media } = result;
      const videoFile = media.status === 'ok' && media.playback ? this.playbackFile(media.playback, media.name, video.durationSeconds) : null;
      if (videoFile) this.owners.set(videoFile, { projectId, videoId: video.id });
      this.loadEditor({ projectId, videoId: video.id, name: project.name, revision: project.revision, hasTranscript: video.hasTranscript,
        media: { status: media.status, name: media.name } }, videoFile, transcript ? mergeEdits(transcript as unknown as SubtitleTranscript, edits) : undefined,
      edits?.stylePair as unknown as SubtitleStylePair | undefined);
    } finally { set({ openingId: null }); }
  }

  /** 回到首页（AC-19）。有没写入的修改时先保存，仍失败则弹 AC-24 的对话框。 */
  async goHome() {
    if (!(await this.confirmLeave())) return;
    this.leaveEditor();
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
      // 用户在对话框里取消了离开：地址栏改回当前项目
      if (this.state.current && this.state.current.projectId !== route.projectId) this.navigate(this.state.route);
      return;
    }
    if (current) {
      await this.goHome();
      if (this.state.current) this.navigate(this.state.route);
    } else { this.navigate(route, true); void this.refresh(); }
  }

  ownerOf(videoFile: VideoFile | null) { return videoFile ? this.owners.get(videoFile) : undefined; }

  // ---------- 自动保存（AC-3、AC-4、AC-9） ----------

  private snapshot(): Snapshot {
    const history = this.stores.history.getState();
    return { chunks: history.chunks, wordChunks: history.wordChunks, style: this.stores.app.getState().subtitleStylePair };
  }

  private isDirty() {
    const now = this.snapshot(); const base = this.baseline;
    return !!base && (now.chunks !== base.chunks || now.wordChunks !== base.wordChunks || now.style !== base.style);
  }

  /** 有没写入 Host 的修改（离开前要处理）。 */
  hasUnsavedChanges() {
    const current = this.state.current;
    if (this.pendingTranscript && this.ownerOf(this.pendingTranscript.videoFile)?.projectId === current?.projectId) return true;
    return !!current?.hasTranscript && (this.isDirty() || this.state.save.status === 'failed' || this.state.save.status === 'conflict');
  }

  /** 字幕或样式变化时调用（store 订阅）。 */
  onEdit() {
    const current = this.state.current;
    // 转写结果还没写进项目时没有可以叠加的修改：等转写保存完再看（saveTranscript 之后会再检查一次）
    if (!current?.hasTranscript || !this.isDirty()) return;
    const status = this.state.save.status;
    if (status === 'conflict') return;
    if (status !== 'failed' && status !== 'saving') this.state.setSave({ status: 'pending' });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, AUTOSAVE_DELAY_MS);
  }

  /**
   * 立即保存（⌘S / Ctrl+S、点击保存状态、离开前）。返回 Host 上是否已经是最新内容。
   * 冲突时不写，返回 false（AC-9）；`force` 只由「用我的版本覆盖」使用。
   */
  async flush(force = false): Promise<boolean> {
    clearTimeout(this.timer);
    if (this.inFlight) { await this.inFlight; return this.flush(force); }
    if (this.pendingTranscript && !(await this.retryTranscript())) return false;
    const current = this.state.current;
    if (!current?.hasTranscript) return true;
    if (this.state.save.status === 'conflict' && !force) return false;
    if (!this.isDirty() && !force && this.state.save.status !== 'failed') return true;
    clearTimeout(this.retryTimer);
    const snap = this.snapshot();
    const edits = buildEdits(snap.chunks, snap.wordChunks, snap.style);
    this.state.setSave({ status: 'saving' });
    const run = async (): Promise<boolean> => {
      let result: SaveResult;
      try {
        result = await this.enqueue(() => this.connection.call('projects.saveEdits', { projectId: current.projectId, videoId: current.videoId,
          edits, baseRevision: this.state.current?.revision ?? current.revision, force }));
      } catch (error) {
        if (this.state.current?.projectId !== current.projectId) return false;
        this.state.setSave({ status: 'failed', error: error instanceof Error ? error.message : String(error) });
        this.scheduleRetry();
        return false;
      }
      if (this.state.current?.projectId !== current.projectId) return result.status === 'saved';
      if (result.status === 'conflict') {
        this.state.setSave({ status: 'conflict', conflictAt: result.updatedAt });
        return false;
      }
      this.failures = 0;
      this.baseline = snap;
      this.state.set({ current: { ...this.state.current!, revision: result.revision } });
      const dirty = this.isDirty();
      this.state.setSave({ status: dirty ? 'pending' : 'saved', savedAt: result.updatedAt, error: undefined, conflictAt: undefined });
      if (dirty) this.onEdit();
      return !dirty;
    };
    this.inFlight = run().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  /** 退避重试：2、4、8、16、30 秒，之后每 30 秒一次，直到成功。 */
  private scheduleRetry() {
    clearTimeout(this.retryTimer);
    const delay = RETRY_DELAYS_MS[Math.min(this.failures, RETRY_DELAYS_MS.length - 1)];
    this.failures += 1;
    this.retryTimer = setTimeout(() => { if (this.state.save.status === 'failed') void this.flush(); }, delay);
  }

  /** 冲突对话框（AC-25）：覆盖后恢复自动保存；另存为新项目进入新项目；取消保持暂停。 */
  async resolveConflict(choice: 'overwrite' | 'save-as-new' | 'cancel', copyName?: string) {
    this.state.set({ conflictDialog: false });
    if (choice === 'cancel') return;
    const current = this.state.current; if (!current) return;
    if (choice === 'overwrite') { await this.flush(true); return; }
    const snap = this.snapshot();
    const copy = await this.connection.call('projects.duplicate', { projectId: current.projectId, videoId: current.videoId,
      name: copyName ?? current.name, edits: buildEdits(snap.chunks, snap.wordChunks, snap.style) });
    // 新项目已带着我的修改：直接打开它（原项目保持对方的版本，不再写）
    this.baseline = null; this.state.setSave({ status: 'saved' });
    this.leaveEditor();
    await this.open(copy.projectId, copy.videoId);
  }

  openConflict() { this.state.set({ conflictDialog: true }); }

  // ---------- 离开保护（AC-4、AC-24） ----------

  private leaveResolver: ((leave: boolean) => void) | null = null;

  /**
   * 离开编辑器之前调用：先尝试保存；还有没写入的修改就弹对话框，等用户选择。
   * 返回 true 表示可以离开（已保存或用户选择放弃修改）。
   */
  async confirmLeave(): Promise<boolean> {
    if (!this.state.current || !this.hasUnsavedChanges()) return true;
    if (this.state.save.status !== 'conflict' && await this.flush()) return true;
    if (!this.hasUnsavedChanges()) return true;
    this.state.set({ unsavedDialog: { retrying: false } });
    return new Promise<boolean>(resolve => { this.leaveResolver = resolve; });
  }

  /** AC-24 对话框的按钮。 */
  async resolveUnsaved(choice: 'retry' | 'discard' | 'cancel') {
    const finish = (leave: boolean) => { this.state.set({ unsavedDialog: null }); const resolve = this.leaveResolver; this.leaveResolver = null; resolve?.(leave); };
    if (choice === 'cancel') { finish(false); return; }
    if (choice === 'discard') { this.pendingTranscript = null; this.baseline = this.snapshot(); clearTimeout(this.retryTimer); this.state.setSave({ status: 'saved' }); finish(true); return; }
    this.state.set({ unsavedDialog: { retrying: true } });
    const saved = this.state.save.status === 'conflict' ? false : await this.flush();
    if (saved) finish(true); else this.state.set({ unsavedDialog: { retrying: false } });
  }

  // ---------- 媒体丢失（AC-7、AC-27） ----------

  /** 重新选择文件：登记新文件，成功后横幅消失、视频可以播放。 */
  async relinkMedia(videoFile: VideoFile) {
    const current = this.state.current; if (!current) return;
    const media = await this.mediaSource(videoFile);
    const result = await this.enqueue(() => this.connection.call('projects.relinkMedia', { projectId: current.projectId, videoId: current.videoId, media }));
    const opened = await this.connection.call('projects.open', { projectId: current.projectId, videoId: current.videoId });
    if (opened.status !== 'ok' || opened.media.status !== 'ok' || !opened.media.playback) throw new Error('重新选择的文件仍无法使用');
    const playable = this.playbackFile(opened.media.playback, opened.media.name, opened.video.durationSeconds);
    this.owners.set(playable, { projectId: current.projectId, videoId: current.videoId });
    this.state.set({ current: { ...this.state.current!, revision: result.revision, media: { status: 'ok', name: opened.media.name } } });
    // 只换媒体，不动字幕和阶段
    this.stores.app.setState({ videoFile: playable });
  }

  // ---------- 转写结果（AC-2） ----------

  /** 识别完成：写回项目，失败时保留结果并按保存失败处理（AC-4）。 */
  async handleTranscribed(videoFile: VideoFile, transcript: SubtitleTranscript, model: ModelRef | null) {
    try { await this.saveTranscript(videoFile, transcript, model); this.pendingTranscript = null; }
    catch (error) {
      console.error('保存转写结果失败', error);
      this.pendingTranscript = { videoFile, transcript, model };
      if (this.ownerOf(videoFile)?.projectId === this.state.current?.projectId) {
        this.state.setSave({ status: 'failed', error: error instanceof Error ? error.message : String(error) });
        this.scheduleRetry();
      }
    }
  }

  private async retryTranscript() {
    const pending = this.pendingTranscript; if (!pending) return true;
    this.state.setSave({ status: 'saving' });
    try { await this.saveTranscript(pending.videoFile, pending.transcript, pending.model); this.pendingTranscript = null; this.failures = 0; return true; }
    catch (error) {
      this.state.setSave({ status: 'failed', error: error instanceof Error ? error.message : String(error) });
      this.scheduleRetry();
      return false;
    }
  }

  /** 识别结果写回项目（AC-2）。 */
  async saveTranscript(videoFile: VideoFile, transcript: SubtitleTranscript, model: ModelRef | null) {
    const owner = this.owners.get(videoFile); if (!owner) return;
    const record = { text: transcript.text, chunks: transcript.chunks, wordChunks: transcript.wordChunks, hasWordTimestamps: transcript.hasWordTimestamps,
      language: transcript.language, duration: transcript.duration };
    const result = await this.enqueue(() => this.connection.call('projects.saveTranscript', { ...owner, transcript: record as never, model: model ?? undefined,
      durationSeconds: videoFile.duration || undefined }));
    const current = this.state.current;
    if (current?.projectId === owner.projectId) {
      this.state.set({ current: { ...current, revision: result.revision, hasTranscript: true } });
      this.state.setSave({ status: 'saved', savedAt: result.updatedAt });
      // 转写期间改过样式：现在可以保存了
      this.onEdit();
    }
  }

  /** 转写结果刚写进字幕编辑器：它就是保存的起点，不算用户修改。 */
  transcriptApplied(videoFile: VideoFile) {
    if (this.stores.app.getState().videoFile !== videoFile || !this.baseline) return;
    const history = this.stores.history.getState();
    this.baseline = { ...this.baseline, chunks: history.chunks, wordChunks: history.wordChunks };
  }

  // ---------- 内部 ----------

  private async mediaSource(videoFile: VideoFile): Promise<{ assetId: string; mimeType: string } | { mediaRef: string }> {
    if (videoFile.path && isTauriRuntime()) {
      const { invoke } = await import('@tauri-apps/api/core');
      return { mediaRef: (await invoke<{ mediaRef: string }>('link_project_media', { path: videoFile.path })).mediaRef };
    }
    return { assetId: await this.connection.upload(videoFile.file), mimeType: videoFile.type };
  }

  private playbackFile(playback: ProjectPlayback, name: string, duration: number): VideoFile {
    const type = mimeFromName(name);
    if (playback.kind === 'path') {
      return { file: new File([], name, { type }), url: tauriFileUrl(playback.path), duration, size: 0, type, name, path: playback.path };
    }
    return { file: new File([], name, { type }), url: this.connection.resourceUrl(playback.path), duration, size: 0, type, name, remotePath: playback.path };
  }

  private leaveEditor() {
    clearTimeout(this.timer); clearTimeout(this.retryTimer); this.failures = 0; this.baseline = null;
    this.state.set({ current: null, save: { status: 'saved' }, conflictDialog: false });
    this.stores.history.getState().reset();
    this.stores.app.getState().setVideoFile(null);
  }

  private loadEditor(current: CurrentProject, videoFile: VideoFile | null, transcript?: SubtitleTranscript, stylePair?: SubtitleStylePair) {
    clearTimeout(this.timer); clearTimeout(this.retryTimer); this.failures = 0;
    const history = this.stores.history.getState(); const app = this.stores.app.getState();
    history.reset(); app.clearASRProgress();
    app.setSubtitleStylePair(stylePair ?? defaultSubtitleStylePair, !!stylePair);
    app.setVideoFile(videoFile);
    if (transcript) {
      history.setTranscript(transcript);
      // 重新打开后从保存时的状态开始，撤销栈为空
      this.stores.history.setState({ undoStack: [], redoStack: [], canUndo: false, canRedo: false });
    }
    // 已有转写结果，或媒体丢失无法识别：直接进入编辑
    if (transcript || !videoFile) app.setStage('edit');
    this.state.set({ current, save: { status: 'saved' }, conflictDialog: false });
    this.baseline = this.snapshot();
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
    if (app.subtitleStylePair !== previous.subtitleStylePair) service.onEdit();
  }));
  // 自动保存（AC-3）：字幕文本、删除 / 恢复、译文的变化
  ctx.effect(() => ctx.stores.history.subscribe((history, previous) => {
    if (history.chunks !== previous.chunks || history.wordChunks !== previous.wordChunks) service.onEdit();
  }));
  ctx.effect(() => ctx.on('flycut/transcribed', ({ videoFile, transcript, model }) => {
    // useASR 在发出事件后同步写入字幕编辑器；等它写完再记下保存起点
    queueMicrotask(() => service.transcriptApplied(videoFile));
    void service.handleTranscribed(videoFile, transcript, model);
  }));
} };

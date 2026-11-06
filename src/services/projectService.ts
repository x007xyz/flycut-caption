// 项目服务（F-0002、F-0003）：前端 Cordis 插件，提供 `ctx.projects`。负责项目的新建、打开、路由、自动保存，以及把转写结果写回 Host；
// F-0003 加上项目管理（重命名、回收站）、项目详情页、一个项目多个视频和项目级字幕样式。
// 只通过 Host RPC 读写项目数据；界面状态放在 `stores.project`。
import type { Context } from '@deepseek-ai/cordis';
import type { ModelRef } from '../../shared/providers';
import type { ProjectEdits, ProjectOpenResult, ProjectPlayback, ProjectStyle, SaveResultV2 } from '../../shared/projects';
import type { ProjectsSort } from '@/components/Project/types';
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
const TRASH_HASH = '#/trash';
const PROJECT_HASH = /^#\/projects\/([0-9a-f-]{36})$/i;
const EDITOR_HASH = /^#\/projects\/([0-9a-f-]{36})\/videos\/([0-9a-f-]{36})$/i;
const SORT_KEY = 'flycut.projects.sort';

/** 停止操作多久后自动保存（AC-3 要求 3 秒内） */
export const AUTOSAVE_DELAY_MS = 1500;
/** 保存失败后的重试间隔（AC-4），之后一直按最后一档重试 */
export const RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 30000];

export function routeToHash(route: ProjectRoute) {
  switch (route.name) {
    case 'home': return HOME_HASH;
    case 'trash': return TRASH_HASH;
    case 'project': return `#/projects/${route.projectId}`;
    default: return `#/projects/${route.projectId}/videos/${route.videoId}`;
  }
}
export function hashToRoute(hash: string): ProjectRoute {
  const editor = EDITOR_HASH.exec(hash);
  if (editor) return { name: 'editor', projectId: editor[1], videoId: editor[2] };
  const project = PROJECT_HASH.exec(hash);
  if (project) return { name: 'project', projectId: project[1] };
  return hash === TRASH_HASH ? { name: 'trash' } : { name: 'home' };
}

const readSort = (): ProjectsSort => {
  try { const value = localStorage.getItem(SORT_KEY); return value === 'created' || value === 'name' ? value : 'updated'; } catch { return 'updated'; }
};

/** 首页排序（F-0003 AC-6）：最近修改、创建时间从新到旧；名称按界面语言的字母顺序。 */
export function sortProjects<T extends { name: string; createdAt: string; updatedAt: string }>(items: T[], sort: ProjectsSort, language: string): T[] {
  const collator = new Intl.Collator(language, { numeric: true, sensitivity: 'base' });
  return [...items].sort((a, b) => sort === 'name' ? collator.compare(a.name, b.name)
    : sort === 'created' ? b.createdAt.localeCompare(a.createdAt) : b.updatedAt.localeCompare(a.updatedAt));
}

// ---------- 样式（F-0003 AC-12、AC-13） ----------

/** 画幅按视频保存，其余（主、副字幕样式）跟随项目或视频自己。 */
const aspectOf = (pair: SubtitleStylePair) => pair.primary.aspectPreset;
/** 比较样式是否变了：不看画幅。样式对象很小，序列化比较足够。 */
const styleKey = (pair: SubtitleStylePair) => JSON.stringify({ primary: { ...pair.primary, aspectPreset: undefined }, secondary: { ...pair.secondary, aspectPreset: undefined } });
const withAspect = (pair: SubtitleStylePair, aspect: SubtitleStylePair['primary']['aspectPreset']): SubtitleStylePair =>
  pair.primary.aspectPreset === aspect ? pair : { ...pair, primary: { ...pair.primary, aspectPreset: aspect } };
const toProjectStyle = (pair: SubtitleStylePair): ProjectStyle => ({ primary: { ...pair.primary }, secondary: { ...pair.secondary } } as unknown as ProjectStyle);
/** Host 上的样式是不透明的：缺的字段用默认值补上（旧版本保存的样式也能用）。 */
const fromProjectStyle = (style: ProjectStyle | Record<string, unknown> | undefined): SubtitleStylePair | undefined => {
  const value = style as Partial<Record<'primary' | 'secondary', Record<string, unknown>>> | undefined;
  if (!value?.primary || !value.secondary) return undefined;
  return { primary: { ...defaultSubtitleStylePair.primary, ...value.primary }, secondary: { ...defaultSubtitleStylePair.secondary, ...value.secondary } } as SubtitleStylePair;
};

/**
 * 打开视频时生效的样式：单独设置的视频用它自己的，否则用项目样式；画幅始终取这个视频保存的。
 * 返回 `restored`：这个视频保存过画幅，不再按画面尺寸重新推断。
 */
export function effectiveStyle(styleSource: 'project' | 'custom', edits: ProjectEdits | undefined, projectStyle: SubtitleStylePair | undefined) {
  const own = styleSource === 'custom' ? fromProjectStyle(edits?.stylePair) : undefined;
  const base = own ?? projectStyle ?? defaultSubtitleStylePair;
  const savedAspect = (edits?.aspectPreset ?? (edits?.stylePair as { primary?: { aspectPreset?: string } } | undefined)?.primary?.aspectPreset) as
    SubtitleStylePair['primary']['aspectPreset'] | undefined;
  return { pair: withAspect(base, savedAspect ?? aspectOf(base)), restored: !!savedAspect || !!own || !!projectStyle };
}

const baseName = (name: string) => name.replace(/\.[^./\\]+$/, '') || name;

/** 已保存的修改叠加在转写结果上：句级字幕以 edits 为准，字词只恢复删除标记。 */
export function mergeEdits(transcript: SubtitleTranscript, edits?: ProjectEdits): SubtitleTranscript {
  if (!edits) return transcript;
  const deleted = new Set(edits.deletedWordIds);
  return { ...transcript, chunks: edits.chunks as unknown as SubtitleTranscript['chunks'],
    wordChunks: transcript.wordChunks?.map(word => ({ ...word, deleted: deleted.has(word.id) })) };
}

/** 自动保存写入的内容：字幕修改、删除标记、译文、画幅，以及（单独设置样式时）这个视频的样式。不重发转写结果。 */
export function buildEdits(chunks: SubtitleChunk[], wordChunks: SubtitleChunk[], stylePair: SubtitleStylePair, custom = true): ProjectEdits {
  return { chunks: chunks as unknown as ProjectEdits['chunks'], deletedWordIds: wordChunks.filter(word => word.deleted).map(word => word.id),
    stylePair: custom ? stylePair as unknown as ProjectEdits['stylePair'] : undefined, aspectPreset: aspectOf(stylePair) };
}

interface Snapshot { chunks: SubtitleChunk[]; wordChunks: SubtitleChunk[]; style: SubtitleStylePair; styleSource: 'project' | 'custom' }
/** 最后一次写进 Host（或刚载入）的内容。按视频保存的部分和项目样式分开记，各自保存成功后各自更新。 */
interface Baseline { chunks: SubtitleChunk[]; wordChunks: SubtitleChunk[]; aspect: string; styleSource: 'project' | 'custom';
  /** 单独设置的样式（styleSource 为 custom 时有意义） */ customKey: string;
  /** 项目样式 */ projectKey: string }
type TranscriptRecord = { text: string; chunks: unknown[]; wordChunks?: unknown[]; hasWordTimestamps?: boolean; language: string; duration: number };
/** 离开编辑器的动作（回首页、打开别的项目、关闭窗口），在 AC-24 的对话框后继续执行。 */
export type LeaveAction = () => void | Promise<void>;

export class ProjectService {
  private ctx: Context;
  private connection: RemoteConnection;
  private stores: RuntimeStores;
  /** 每个视频对象属于哪个项目：识别完成时据此写回，即使用户已经离开了这个项目。 */
  private owners = new WeakMap<VideoFile, { projectId: string; videoId: string }>();
  /** 最后一次写到 Host（或刚载入）的内容；字幕数组按引用比较，样式按内容比较。 */
  private baseline: Baseline | null = null;
  /** 当前视频的转写结果（另存为新项目时带上，F-0003 AC-32） */
  private transcriptRecord: TranscriptRecord | undefined;
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
    if (this.state.sort !== readSort()) this.state.set({ sort: readSort() });
    const { set } = this.state;
    set({ listStatus: this.state.projects.length ? 'ready' : 'loading' });
    try { set({ projects: await this.connection.call('projects.list'), listStatus: 'ready' }); }
    catch (error) { console.error('读取项目失败', error); set({ listStatus: 'error' }); }
  }

  retryList() { this.state.set({ listStatus: 'loading', projects: [] }); return this.refresh(); }

  /** 封面（AC-14）：按 `projectId + videoId + revision` 缓存，改过之后重新取。没有封面时返回 null，卡片显示占位图。 */
  private thumbnails = new Map<string, Promise<string | null>>();
  thumbnail(projectId: string, videoId: string, revision: number): Promise<string | null> {
    const key = `${projectId}:${videoId}:${revision}`;
    let cached = this.thumbnails.get(key);
    if (!cached) {
      cached = this.connection.call('projects.thumbnail', { projectId, videoId }).then(result => result.dataUrl, () => null);
      this.thumbnails.set(key, cached);
    }
    return cached;
  }

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
      const video = created.project.videos[0];
      this.loadEditor({ projectId: created.projectId, videoId: created.videoId, name, revision: created.revision, hasTranscript: false,
        media: { status: 'ok', name: videoFile.name }, videoName: videoFile.name, videoRevision: 0, styleRevision: 0, styleSource: 'project',
        projectStyle: defaultSubtitleStylePair, videos: [{ id: video.id, name: video.name, durationSeconds: video.durationSeconds, createdAt: video.createdAt,
          updatedAt: video.createdAt, hasTranscript: false, mediaMissing: false, hasThumbnail: false, styleSource: 'project', revision: 0 }] }, videoFile);
      // 新视频照常开始识别（appStore.setVideoFile 已切到 transcribe）
      return { projectId: created.projectId, videoId: created.videoId, name };
    } finally { set({ creating: false }); }
  }

  /** 首页排序（F-0003 AC-6），重新打开应用后保持。 */
  setSort(sort: ProjectsSort) {
    this.state.set({ sort });
    try { localStorage.setItem(SORT_KEY, sort); } catch { /* 只是界面偏好 */ }
  }

  /** 首页点击项目（F-0003 AC-7）：只有一个视频直接进编辑器，多个视频或没有视频进项目详情页。 */
  async openFromHome(projectId: string) {
    const item = this.state.projects.find(entry => entry.id === projectId);
    if (item && item.videoCount !== 1) { await this.openDetail(projectId); return; }
    await this.open(projectId);
  }

  /** 新建空项目（F-0003 AC-1），建好后进入它的详情页。 */
  async createEmpty(name: string) {
    const { set } = this.state;
    if (this.state.creating) return null;
    set({ creating: true });
    try {
      const created = await this.connection.call('projects.createEmpty', { name });
      await this.openDetail(created.projectId, name);
      return created;
    } finally { set({ creating: false }); }
  }

  /** 重命名（F-0003 AC-2）。失败时抛出，由对话框显示错误。 */
  async rename(projectId: string, name: string) {
    await this.connection.call('projects.rename', { projectId, name });
    const state = this.state;
    state.set({ projects: state.projects.map(item => item.id === projectId ? { ...item, name, updatedAt: new Date().toISOString() } : item) });
    if (state.detail?.projectId === projectId) state.set({ detail: { ...state.detail, name } });
    if (state.current?.projectId === projectId) state.set({ current: { ...state.current, name } });
    if (state.route.name === 'home') void this.refresh();
  }

  /** 移到回收站（F-0003 AC-3）。 */
  async trashProject(projectId: string) {
    await this.connection.call('projects.trash', { projectId });
    this.thumbnails.clear();
    this.state.set({ projects: this.state.projects.filter(item => item.id !== projectId) });
    void this.refresh();
  }

  /** 恢复（F-0003 AC-4、AC-25）；回收站页和首页的「撤销」都用它。 */
  async restore(projectId: string) {
    const { set } = this.state;
    set({ trash: { ...this.state.trash, restoringId: projectId } });
    try {
      await this.connection.call('projects.restore', { projectId });
      set({ trash: { ...this.state.trash, items: this.state.trash.items.filter(item => item.id !== projectId) } });
      if (this.state.route.name === 'home') void this.refresh();
    } finally { set({ trash: { ...this.state.trash, restoringId: null } }); }
  }

  // ---------- 回收站（F-0003 AC-23、AC-24） ----------

  async openTrash() {
    if (!(await this.confirmLeave())) return;
    if (this.state.current) this.leaveEditor();
    this.navigate({ name: 'trash' });
    await this.refreshTrash();
  }

  async refreshTrash(showLoading = !this.state.trash.items.length) {
    const { set } = this.state;
    if (showLoading) set({ trash: { status: 'loading', items: [], restoringId: null } });
    try { set({ trash: { ...this.state.trash, status: 'ready', items: await this.connection.call('projects.trashList') } }); }
    catch (error) { console.error('读取回收站失败', error); set({ trash: { ...this.state.trash, status: 'error' } }); }
  }

  /** 彻底删除一个项目。失败时抛出，由对话框显示错误。 */
  async purge(projectId: string) {
    await this.connection.call('projects.purge', { projectId });
    this.state.set({ trash: { ...this.state.trash, items: this.state.trash.items.filter(item => item.id !== projectId) } });
  }

  /** 清空回收站：只删除用户看到的这些行；有失败时抛出，列表重新读取（失败的行留下）。 */
  async emptyTrash() {
    const projectIds = this.state.trash.items.map(item => item.id);
    let result: { purged: string[]; failed: string[] };
    try { result = await this.connection.call('projects.emptyTrash', { projectIds }); }
    finally { await this.refreshTrash(false); }
    if (result.failed.length) throw new Error(`${result.failed.length} 个项目没有删除`);
  }

  // ---------- 项目详情（F-0003 AC-7、AC-8、AC-11、AC-26 到 AC-29） ----------

  /** 进入项目详情页（离开编辑器时按 F-0002 的离开保护处理）。 */
  async openDetail(projectId: string, name?: string) {
    if (!(await this.confirmLeave())) return;
    if (this.state.current) this.leaveEditor();
    this.navigate({ name: 'project', projectId });
    await this.loadDetail(projectId, name);
  }

  async loadDetail(projectId: string, name?: string) {
    const { set } = this.state;
    const previous = this.state.detail?.projectId === projectId ? this.state.detail : null;
    const fallbackName = name ?? previous?.name ?? this.state.projects.find(item => item.id === projectId)?.name ?? '';
    set({ detail: { projectId, status: 'loading', name: fallbackName, videos: [], adding: previous?.adding ?? [], openingVideoId: null } });
    await this.reloadDetail(projectId);
  }

  /** 重新读取详情，不回到加载中（添加、移除视频之后）。 */
  private async reloadDetail(projectId: string) {
    const { set } = this.state;
    try {
      const result = await this.connection.call('projects.detail', { projectId });
      const detail = this.state.detail; if (detail?.projectId !== projectId) return;
      if (result.status === 'newer-version') { set({ newerVersion: { name: result.name }, detail: null }); this.navigate({ name: 'home' }); void this.refresh(); return; }
      if (result.status === 'trashed') { set({ detail: null }); this.navigate({ name: 'home' }); void this.refresh(); return; }
      set({ detail: { ...detail, status: 'ready', name: result.project.name, videos: result.videos } });
    } catch (error) {
      console.error('读取项目失败', error);
      const detail = this.state.detail;
      if (detail?.projectId === projectId && detail.status === 'loading') set({ detail: { ...detail, status: 'error' } });
      else throw error;
    }
  }

  /** 往当前详情页的项目添加视频：一个文件一个视频，逐个添加，某个失败不影响其他（AC-8、AC-27）。 */
  async addVideos(videoFiles: VideoFile[]) {
    const detail = this.state.detail; if (!detail) return;
    const { projectId } = detail;
    const rows = videoFiles.map(file => ({ key: crypto.randomUUID(), name: file.name, status: 'adding' as const }));
    const patchAdding = (update: (adding: NonNullable<typeof this.state.detail>['adding']) => NonNullable<typeof this.state.detail>['adding']) => {
      const latest = this.state.detail; if (latest?.projectId === projectId) this.state.set({ detail: { ...latest, adding: update(latest.adding) } });
    };
    patchAdding(adding => [...adding, ...rows]);
    for (const [index, videoFile] of videoFiles.entries()) {
      const key = rows[index].key;
      try {
        const media = await this.mediaSource(videoFile);
        await this.connection.call('projects.addVideo', { projectId, videoName: videoFile.name,
          durationSeconds: Number.isFinite(videoFile.duration) ? videoFile.duration : 0, media });
        await this.reloadDetail(projectId).catch(() => undefined);
        patchAdding(adding => adding.filter(row => row.key !== key));
      } catch (error) {
        console.error('添加视频失败', error);
        patchAdding(adding => adding.map(row => row.key === key ? { ...row, status: 'failed' } : row));
      }
    }
    this.thumbnails.clear();
    // Host 在添加后才截取封面、读出真实时长：稍后再读一次详情
    setTimeout(() => { if (this.state.detail?.projectId === projectId) void this.reloadDetail(projectId).catch(() => undefined); }, 3000);
  }

  dismissFailedAdd(key: string) {
    const detail = this.state.detail;
    if (detail) this.state.set({ detail: { ...detail, adding: detail.adding.filter(row => row.key !== key) } });
  }

  /** 移除视频（AC-11）：直接删除，不进回收站。失败时抛出，由对话框显示错误。 */
  async removeVideo(projectId: string, videoId: string) {
    await this.connection.call('projects.removeVideo', { projectId, videoId });
    this.thumbnails.clear();
    const current = this.state.current;
    if (current?.projectId === projectId && current.videoId === videoId) {
      // 正在编辑的视频被移除：它的修改随视频一起删除，回到详情页
      this.baseline = null; this.pendingTranscript = null;
      this.leaveEditor();
      await this.openDetail(projectId);
      return;
    }
    if (this.state.detail?.projectId === projectId) await this.reloadDetail(projectId);
    if (current?.projectId === projectId) this.state.set({ current: { ...current, videos: current.videos.filter(video => video.id !== videoId) } });
  }

  /** 详情页「打开编辑」（AC-9、AC-29）。 */
  async openVideo(videoId: string) {
    const detail = this.state.detail; if (!detail || detail.openingVideoId) return;
    this.state.set({ detail: { ...detail, openingVideoId: videoId } });
    try { await this.open(detail.projectId, videoId); }
    finally { const latest = this.state.detail; if (latest) this.state.set({ detail: { ...latest, openingVideoId: null } }); }
  }

  /** 编辑器顶栏切换视频（AC-10、AC-30）：先保存当前视频，再载入目标视频；转写进行中不能切换。 */
  async switchVideo(videoId: string) {
    const current = this.state.current;
    if (!current || current.videoId === videoId || this.state.switchingVideoId || this.stores.app.getState().isLoading) return;
    this.state.set({ switchingVideoId: videoId });
    try { await this.open(current.projectId, videoId); }
    finally { this.state.set({ switchingVideoId: null }); }
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
      if (result.status === 'trashed') { if (this.state.current) this.leaveEditor(); this.navigate({ name: 'home' }); void this.refresh(); return; }
      const { project, video, transcript, edits, media, videos } = result;
      const videoFile = media.status === 'ok' && media.playback ? this.playbackFile(media.playback, media.name, video.durationSeconds, video.media.size) : null;
      if (videoFile) this.owners.set(videoFile, { projectId, videoId: video.id });
      const projectStyle = fromProjectStyle(result.projectStyle);
      const style = effectiveStyle(video.styleSource, edits, projectStyle);
      this.transcriptRecord = transcript as TranscriptRecord | undefined;
      this.loadEditor({ projectId, videoId: video.id, name: project.name, revision: project.revision, hasTranscript: video.hasTranscript,
        media: { status: media.status, name: media.name }, videoName: video.name, videoRevision: video.revision, styleRevision: project.styleRevision,
        styleSource: video.styleSource, projectStyle: projectStyle ?? withAspect(defaultSubtitleStylePair, aspectOf(style.pair)), videos },
      videoFile, transcript ? mergeEdits(transcript as unknown as SubtitleTranscript, edits) : undefined, style.pair, style.restored);
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
    if (route.name === 'project' || route.name === 'trash') {
      const same = route.name === 'trash' ? this.state.route.name === 'trash'
        : this.state.route.name === 'project' && this.state.route.projectId === route.projectId;
      if (same && !current) return;
      if (route.name === 'trash') await this.openTrash(); else await this.openDetail(route.projectId);
      // 用户在离开对话框里取消：地址栏改回当前页面
      if (this.state.current) this.navigate(this.state.route);
      return;
    }
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
    return { chunks: history.chunks, wordChunks: history.wordChunks, style: this.stores.app.getState().subtitleStylePair,
      styleSource: this.state.current?.styleSource ?? 'project' };
  }

  private baselineOf(snap: Snapshot, projectStyle: SubtitleStylePair): Baseline {
    return { chunks: snap.chunks, wordChunks: snap.wordChunks, aspect: aspectOf(snap.style), styleSource: snap.styleSource,
      customKey: styleKey(snap.style), projectKey: styleKey(projectStyle) };
  }

  /** 这个视频有没写入的修改：字幕、删除标记、译文、画幅、样式来源，以及单独设置的样式（AC-14）。 */
  private videoDirty(now = this.snapshot()) {
    const base = this.baseline; if (!base) return false;
    return now.chunks !== base.chunks || now.wordChunks !== base.wordChunks || aspectOf(now.style) !== base.aspect || now.styleSource !== base.styleSource
      || (now.styleSource === 'custom' && styleKey(now.style) !== base.customKey);
  }

  /** 跟随项目的视频改了样式：要写进项目样式（AC-12）。 */
  private styleDirty(now = this.snapshot()) {
    const base = this.baseline;
    return !!base && now.styleSource === 'project' && styleKey(now.style) !== base.projectKey;
  }

  private isDirty() { const now = this.snapshot(); return this.videoDirty(now) || this.styleDirty(now); }

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
    // AC-31：跟随项目时改了样式，样式面板下方显示一次提示
    if (current.styleSource === 'project' && !current.styleTouched && this.styleDirty()) this.state.set({ current: { ...current, styleTouched: true } });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, AUTOSAVE_DELAY_MS);
  }

  /**
   * 立即保存（⌘S / Ctrl+S、点击保存状态、离开前）。返回 Host 上是否已经是最新内容。
   * 这个视频的修改和项目样式分开保存、分开比较修订号（F-0003 AC-14）；冲突时不写，返回 false（AC-9）；
   * `force` 只由「用我的版本覆盖」使用。项目在别处被删除时暂停保存（F-0003 AC-15）。
   */
  async flush(force = false): Promise<boolean> {
    clearTimeout(this.timer);
    if (this.inFlight) { await this.inFlight; return this.flush(force); }
    if (this.pendingTranscript && !(await this.retryTranscript())) return false;
    const current = this.state.current;
    if (!current?.hasTranscript) return true;
    if (this.state.projectDeleted) return false;
    if (this.state.save.status === 'conflict' && !force) return false;
    if (!this.isDirty() && !force && this.state.save.status !== 'failed') return true;
    clearTimeout(this.retryTimer);
    const snap = this.snapshot();
    const saveVideo = this.videoDirty(snap) || (force && this.state.save.status === 'conflict');
    const saveStyle = this.styleDirty(snap);
    this.state.setSave({ status: 'saving' });
    const sameVideo = () => this.state.current?.projectId === current.projectId && this.state.current.videoId === current.videoId;
    const run = async (): Promise<boolean> => {
      const results: Array<['video' | 'style', SaveResultV2]> = [];
      try {
        if (saveVideo) results.push(['video', await this.enqueue(() => this.connection.call('projects.saveVideoEdits', { projectId: current.projectId,
          videoId: current.videoId, edits: buildEdits(snap.chunks, snap.wordChunks, snap.style, snap.styleSource === 'custom'), styleSource: snap.styleSource,
          baseRevision: this.state.current?.videoRevision ?? current.videoRevision, force }))]);
        if (saveStyle) results.push(['style', await this.enqueue(() => this.connection.call('projects.saveProjectStyle', { projectId: current.projectId,
          style: toProjectStyle(snap.style), baseRevision: this.state.current?.styleRevision ?? current.styleRevision, force }))]);
      } catch (error) {
        if (!sameVideo()) return false;
        this.applySaved(results, snap);
        this.state.setSave({ status: 'failed', error: error instanceof Error ? error.message : String(error) });
        this.scheduleRetry();
        return false;
      }
      if (!sameVideo()) return results.every(([, result]) => result.status === 'saved');
      const savedAt = this.applySaved(results, snap);
      const lifecycle = results.find(([, result]) => result.status === 'trashed' || result.status === 'deleted')?.[1];
      if (lifecycle) {
        this.state.set({ projectDeleted: { state: lifecycle.status === 'trashed' ? 'trashed' : 'deleted', busy: false } });
        this.state.setSave({ status: 'conflict', conflictAt: undefined });
        return false;
      }
      if (results.some(([, result]) => result.status === 'video-missing')) {
        this.state.setSave({ status: 'failed', error: '视频已从项目中移除' });
        return false;
      }
      const conflict = results.find(([, result]) => result.status === 'conflict')?.[1];
      if (conflict?.status === 'conflict') {
        this.state.setSave({ status: 'conflict', conflictAt: conflict.updatedAt });
        return false;
      }
      this.failures = 0;
      const dirty = this.isDirty();
      this.state.setSave({ status: dirty ? 'pending' : 'saved', savedAt: savedAt ?? this.state.save.savedAt, error: undefined, conflictAt: undefined });
      if (dirty) this.onEdit();
      return !dirty;
    };
    this.inFlight = run().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  /** 把保存成功的部分记进修订号和保存起点；返回最后一次保存时间。 */
  private applySaved(results: Array<['video' | 'style', SaveResultV2]>, snap: Snapshot) {
    let savedAt: string | undefined;
    for (const [part, result] of results) {
      if (result.status !== 'saved' || !this.baseline) continue;
      const current = this.state.current!;
      savedAt = result.updatedAt;
      if (part === 'video') {
        this.baseline = { ...this.baseline, chunks: snap.chunks, wordChunks: snap.wordChunks, aspect: aspectOf(snap.style), styleSource: snap.styleSource,
          customKey: styleKey(snap.style) };
        this.state.set({ current: { ...current, revision: result.projectRevision, videoRevision: result.revision } });
      } else {
        this.baseline = { ...this.baseline, projectKey: styleKey(snap.style) };
        this.state.set({ current: { ...current, revision: result.projectRevision, styleRevision: result.revision, projectStyle: snap.style } });
      }
    }
    return savedAt;
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
    await this.saveAsNew(copyName ?? current.name);
  }

  /** 另存为新项目：复制项目，写入这个窗口的修改和样式，然后打开副本（原项目保持对方的版本，不再写）。 */
  private async saveAsNew(name: string) {
    const current = this.state.current; if (!current) return;
    const snap = this.snapshot();
    const custom = snap.styleSource === 'custom';
    const copy = await this.connection.call('projects.duplicate', { projectId: current.projectId, videoId: current.videoId, name,
      edits: buildEdits(snap.chunks, snap.wordChunks, snap.style, custom) });
    if (!custom) await this.connection.call('projects.saveProjectStyle', { projectId: copy.projectId, style: toProjectStyle(snap.style), baseRevision: 0, force: true });
    this.baseline = null; this.state.setSave({ status: 'saved' }); this.state.set({ projectDeleted: null });
    this.leaveEditor();
    await this.open(copy.projectId, copy.videoId);
  }

  /**
   * 项目在别处被删除（F-0003 AC-32）：恢复项目并保存、另存为新项目、放弃修改。
   * 已彻底删除时，另存为新项目只带字幕、修改和样式，媒体按 F-0002 的媒体丢失流程重新选择。
   */
  async resolveDeleted(choice: 'restore' | 'save-as-new' | 'discard', copyName: string) {
    const deleted = this.state.projectDeleted; const current = this.state.current;
    if (!deleted || !current || deleted.busy) return;
    if (choice === 'discard') {
      this.pendingTranscript = null; this.baseline = null; clearTimeout(this.retryTimer);
      this.state.set({ projectDeleted: null }); this.state.setSave({ status: 'saved' });
      this.leaveEditor(); this.navigate({ name: 'home' }); void this.refresh();
      return;
    }
    this.state.set({ projectDeleted: { ...deleted, busy: true, error: undefined } });
    try {
      if (choice === 'restore') {
        await this.connection.call('projects.restore', { projectId: current.projectId });
        this.state.set({ projectDeleted: null }); this.state.setSave({ status: 'pending', conflictAt: undefined });
        await this.flush();
        return;
      }
      if (deleted.state === 'trashed') { await this.saveAsNew(copyName); return; }
      const snap = this.snapshot();
      const custom = snap.styleSource === 'custom';
      const created = await this.connection.call('projects.createFromSnapshot', { name: copyName, videoName: current.videoName,
        durationSeconds: this.stores.app.getState().videoFile?.duration || 0, transcript: this.transcriptRecord as never,
        edits: buildEdits(snap.chunks, snap.wordChunks, snap.style, custom), styleSource: snap.styleSource, style: custom ? undefined : toProjectStyle(snap.style) });
      this.baseline = null; this.state.set({ projectDeleted: null }); this.state.setSave({ status: 'saved' });
      this.leaveEditor();
      await this.open(created.projectId, created.videoId);
    } catch (error) {
      const latest = this.state.projectDeleted;
      if (latest) this.state.set({ projectDeleted: { ...latest, busy: false, error: error instanceof Error ? error.message : String(error) } });
    }
  }

  // ---------- 样式来源（F-0003 AC-13、AC-31） ----------

  /** 为这个视频单独设置：沿用当前生效的样式，之后的修改只属于这个视频。 */
  customizeStyle() {
    const current = this.state.current; if (!current || current.styleSource === 'custom') return;
    this.state.set({ current: { ...current, styleSource: 'custom' } });
    this.onEdit();
  }

  /** 恢复跟随项目（已确认）：丢弃单独样式，改用当前项目样式；画幅不变。 */
  followProjectStyle() {
    const current = this.state.current; if (!current || current.styleSource === 'project') return;
    const app = this.stores.app.getState();
    this.state.set({ current: { ...current, styleSource: 'project' } });
    app.setSubtitleStylePair(withAspect(current.projectStyle, aspectOf(app.subtitleStylePair)), true);
    this.onEdit();
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
    if (choice === 'discard') {
      this.pendingTranscript = null; this.baseline = this.baselineOf(this.snapshot(), this.state.current?.projectStyle ?? defaultSubtitleStylePair);
      clearTimeout(this.retryTimer); this.state.setSave({ status: 'saved' }); finish(true); return;
    }
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
    const playable = this.playbackFile(opened.media.playback, opened.media.name, opened.video.durationSeconds, opened.video.media.size);
    this.owners.set(playable, { projectId: current.projectId, videoId: current.videoId });
    this.state.set({ current: { ...this.state.current!, revision: result.revision, media: { status: 'ok', name: opened.media.name },
      videos: opened.videos } });
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
    if (current?.projectId === owner.projectId && current.videoId === owner.videoId) this.transcriptRecord = record as TranscriptRecord;
    if (current?.projectId === owner.projectId) {
      this.state.set({ current: { ...current, revision: result.revision, hasTranscript: current.videoId === owner.videoId || current.hasTranscript,
        videos: current.videos.map(video => video.id === owner.videoId ? { ...video, hasTranscript: true } : video) } });
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

  /** `size` 来自项目记录：波形等功能据此决定要不要整份读取媒体。 */
  private playbackFile(playback: ProjectPlayback, name: string, duration: number, size: number): VideoFile {
    const type = mimeFromName(name);
    if (playback.kind === 'path') {
      return { file: new File([], name, { type }), url: tauriFileUrl(playback.path), duration, size, type, name, path: playback.path };
    }
    return { file: new File([], name, { type }), url: this.connection.resourceUrl(playback.path), duration, size, type, name, remotePath: playback.path };
  }

  private leaveEditor() {
    clearTimeout(this.timer); clearTimeout(this.retryTimer); this.failures = 0; this.baseline = null;
    this.transcriptRecord = undefined;
    this.state.set({ current: null, save: { status: 'saved' }, conflictDialog: false, projectDeleted: null });
    this.stores.history.getState().reset();
    this.stores.app.getState().setVideoFile(null);
  }

  private loadEditor(current: CurrentProject, videoFile: VideoFile | null, transcript?: SubtitleTranscript, stylePair?: SubtitleStylePair, restored = !!stylePair) {
    clearTimeout(this.timer); clearTimeout(this.retryTimer); this.failures = 0;
    const history = this.stores.history.getState(); const app = this.stores.app.getState();
    history.reset(); app.clearASRProgress();
    // 切换视频：先把当前项目设为目标视频，样式的变化才不会被当成上一个视频的修改
    this.baseline = null;
    this.state.set({ current, projectDeleted: null });
    app.setSubtitleStylePair(stylePair ?? defaultSubtitleStylePair, restored);
    app.setVideoFile(videoFile);
    if (transcript) {
      history.setTranscript(transcript);
      // 重新打开后从保存时的状态开始，撤销栈为空
      this.stores.history.setState({ undoStack: [], redoStack: [], canUndo: false, canRedo: false });
    }
    // 已有转写结果，或媒体丢失无法识别：直接进入编辑
    if (transcript || !videoFile) app.setStage('edit');
    this.state.set({ current, save: { status: 'saved' }, conflictDialog: false, detail: null });
    this.baseline = this.baselineOf(this.snapshot(), current.projectStyle);
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
      if (owner) project.set({ transcribing: { projectId: owner.projectId, videoId: owner.videoId, progress: 0 } });
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

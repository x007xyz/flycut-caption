// 项目状态（F-0002、F-0003）：路由、项目列表、项目详情、回收站、当前项目和保存状态。每个前端 Context 一份，读写都经 `ctx.projects`。
import { createStore } from 'zustand/vanilla';
import type { ProjectListItem, ProjectVideoSummary, TrashItem } from '../../shared/projects';
import type { BackupExportResult, BackupImportResult, BackupInspectionResult, BackupPreviewResult } from '../../shared/backup';
import type { LoadStatus, ProjectsSort, SaveStatus } from '@/components/Project/types';
import type { SubtitleStylePair } from '@/subtitle';
import { bindRuntimeStore } from './runtimeStore';

export type ProjectRoute = { name: 'home' } | { name: 'trash' } | { name: 'project'; projectId: string }
  | { name: 'editor'; projectId: string; videoId: string };

export type MediaUploadPhase = 'checking' | 'unsupported' | 'rejected' | 'hashing' | 'uploading' | 'paused' | 'interrupted'
  | 'needs-file' | 'mismatch' | 'verifying' | 'failed' | 'expired' | 'complete';

/** F-0015: view state only. The source File stays in ProjectService, never in localStorage. */
export interface MediaUploadView {
  key: string;
  kind: 'create' | 'add';
  projectId?: string;
  operationId: string;
  sessionId?: string;
  fileName: string;
  size: number;
  mimeType: string;
  target: string;
  phase: MediaUploadPhase;
  uploadedBytes: number;
  sha256?: string;
  error?: string;
  attempts: number;
}

/** 往项目详情页添加中的文件（F-0003 AC-27）：成功后由 Host 返回的视频行取代 */
export interface AddingVideo { key: string; name: string; status: 'adding' | 'failed' }

/** 项目详情页（F-0003 AC-26） */
export interface ProjectDetailState {
  projectId: string;
  status: LoadStatus;
  name: string;
  videos: ProjectVideoSummary[];
  adding: AddingVideo[];
  /** 正在打开的视频（AC-29） */
  openingVideoId: string | null;
}

export interface CurrentProject {
  projectId: string;
  videoId: string;
  name: string;
  /** 最后一次成功写入后的修订号，保存时作为 baseRevision */
  revision: number;
  hasTranscript: boolean;
  media: { status: 'ok' | 'missing'; name: string };
  /** 以下为 F-0003（格式 2）：当前视频的名称、修订号和样式来源，项目样式的修订号，同一项目的全部视频（顶栏切换用） */
  videoName: string;
  videoRevision: number;
  styleRevision: number;
  styleSource: 'project' | 'custom';
  /** 最后一次读到或写入的项目样式；恢复跟随项目时用它（AC-13） */
  projectStyle: SubtitleStylePair;
  videos: ProjectVideoSummary[];
  /** 跟随项目时改过样式：显示一次「样式修改会应用到……」（AC-31） */
  styleTouched?: boolean;
}

export interface SaveState {
  status: SaveStatus;
  /** ISO 8601，最后一次成功保存 */
  savedAt?: string;
  error?: string;
  /** 冲突时对方保存的时间 */
  conflictAt?: string;
}

/** 打开项目时发现的一份恢复副本（F-0004 AC-3）。副本内容在 `ctx.projects` 里，store 只放展示用的信息 */
export interface RecoveryCandidate {
  key: string;
  sessionId: string;
  sequence: number;
  /** ISO 8601 */
  recordedAt: string;
}

/**
 * 崩溃恢复（F-0004 AC-2 到 AC-9）。`phase` 不是 idle 时编辑器被对话框挡住，自动保存和副本记录暂停。
 * - checking：正在检查恢复内容；choose：选择恢复 / 放弃 / 稍后；applying：正在恢复；conflict：版本冲突（AC-7）；
 * - discard：放弃确认；discarding：正在移除副本；failed：检查或恢复失败（AC-6）
 */
export interface RecoveryState {
  phase: 'idle' | 'checking' | 'choose' | 'applying' | 'conflict' | 'conflict-busy' | 'discard' | 'discarding' | 'failed';
  candidates: RecoveryCandidate[];
  selectedKey: string | null;
  /** Host 上这个视频最后一次保存的时间（ISO 8601） */
  hostSavedAt?: string;
  /** failed 时：失败的步骤；`missing` 原项目或视频已不存在；`uncertain` 保存结果暂时无法确认 */
  failure?: { stage: 'check' | 'apply'; missing?: boolean; uncertain?: boolean };
  /** 放弃确认框里的错误（AC-9） */
  discardFailed?: boolean;
}

/** F-0023: 备份导出对话框非持久化界面状态 */
export interface BackupExportState {
  phase: 'idle' | 'loading' | 'ready' | 'missing-resource' | 'stale' | 'processing' | 'completed' | 'error';
  projectId?: string;
  projectName?: string;
  preview?: BackupPreviewResult;
  includeMissingMedia: boolean;
  progress: number;
  statusText?: string;
  savingToDisk?: boolean;
  result?: BackupExportResult;
  savedPath?: string;
  error?: string;
  uncertain?: boolean;
  requestSeq: number;
}

/** F-0023: 备份导入对话框非持久化界面状态 */
export interface BackupImportState {
  phase: 'idle' | 'empty' | 'uploading' | 'inspecting' | 'rejected' | 'ready' | 'stale' | 'importing' | 'completed' | 'error';
  fileName?: string;
  stagingId?: string;
  inspection?: BackupInspectionResult;
  projectName: string;
  progress: number;
  statusText?: string;
  result?: BackupImportResult;
  error?: string;
  uncertain?: boolean;
  requestSeq: number;
}

export interface ProjectState {
  route: ProjectRoute;
  listStatus: LoadStatus;
  projects: ProjectListItem[];
  /** 正在打开的项目（首页卡片转圈） */
  openingId: string | null;
  /** 正在创建项目（新建区转圈） */
  creating: boolean;
  current: CurrentProject | null;
  save: SaveState;
  /** 本窗口里正在转写的项目和进度（首页卡片的进度条） */
  transcribing: { projectId: string; videoId: string; progress: number } | null;
  /** 打开时发现格式版本过新（AC-26） */
  newerVersion: { name: string } | null;
  /** 版本冲突对话框是否打开（AC-25） */
  conflictDialog: boolean;
  /** 未保存离开的对话框（AC-24）；`retrying` 时三个按钮都不可点 */
  unsavedDialog: { retrying: boolean; keep?: boolean } | null;
  /** 首页排序（F-0003 AC-6），界面偏好，存在本机 */
  sort: ProjectsSort;
  detail: ProjectDetailState | null;
  trash: { status: LoadStatus; items: TrashItem[]; restoringId: string | null };
  /** 编辑器里正在切换到的视频（F-0003 AC-30） */
  switchingVideoId: string | null;
  /** 当前项目在别处被移到回收站或彻底删除（F-0003 AC-15、AC-32）；`busy` 时按钮不可点 */
  projectDeleted: { state: 'trashed' | 'deleted'; busy: boolean; error?: string } | null;
  /** 崩溃恢复的检查与选择（F-0004） */
  recovery: RecoveryState;
  /** F-0015: resumable media transfers (home create or project add). */
  uploads: MediaUploadView[];
  /** 本地恢复副本最近一次是否记录成功（F-0004 AC-10） */
  recoveryHealth: 'ok' | 'unavailable';
  /** F-0023: 备份导出与导入状态 */
  backupExport: BackupExportState;
  backupImport: BackupImportState;
}

export interface ProjectActions {
  set: (patch: Partial<ProjectState>) => void;
  setSave: (patch: Partial<SaveState>) => void;
}

const initialState: ProjectState = {
  route: { name: 'home' },
  listStatus: 'loading',
  projects: [],
  openingId: null,
  creating: false,
  current: null,
  save: { status: 'saved' },
  transcribing: null,
  newerVersion: null,
  conflictDialog: false,
  unsavedDialog: null,
  sort: 'updated',
  detail: null,
  trash: { status: 'loading', items: [], restoringId: null },
  switchingVideoId: null,
  projectDeleted: null,
  recovery: { phase: 'idle', candidates: [], selectedKey: null },
  recoveryHealth: 'ok',
  uploads: [],
  backupExport: { phase: 'idle', includeMissingMedia: false, progress: 0, requestSeq: 0 },
  backupImport: { phase: 'idle', projectName: '', progress: 0, requestSeq: 0 },
};

export const createProjectStore = () => createStore<ProjectState & ProjectActions>()((set) => ({
  ...initialState,
  set: (patch) => set(patch),
  setSave: (patch) => set(state => ({ save: { ...state.save, ...patch } })),
}));

export const useProjectStore = bindRuntimeStore('project');

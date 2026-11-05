// 项目状态（F-0002）：路由、项目列表、当前项目和保存状态。每个前端 Context 一份，读写都经 `ctx.projects`。
import { createStore } from 'zustand/vanilla';
import type { ProjectListItem } from '../../shared/projects';
import type { LoadStatus, SaveStatus } from '@/components/Project/types';
import { bindRuntimeStore } from './runtimeStore';

export type ProjectRoute = { name: 'home' } | { name: 'editor'; projectId: string; videoId: string };

export interface CurrentProject {
  projectId: string;
  videoId: string;
  name: string;
  /** 最后一次成功写入后的修订号，保存时作为 baseRevision */
  revision: number;
  hasTranscript: boolean;
  media: { status: 'ok' | 'missing'; name: string };
}

export interface SaveState {
  status: SaveStatus;
  /** ISO 8601，最后一次成功保存 */
  savedAt?: string;
  error?: string;
  /** 冲突时对方保存的时间 */
  conflictAt?: string;
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
  transcribing: { projectId: string; progress: number } | null;
  /** 打开时发现格式版本过新（AC-26） */
  newerVersion: { name: string } | null;
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
};

export const createProjectStore = () => createStore<ProjectState & ProjectActions>()((set) => ({
  ...initialState,
  set: (patch) => set(patch),
  setSave: (patch) => set(state => ({ save: { ...state.save, ...patch } })),
}));

export const useProjectStore = bindRuntimeStore('project');

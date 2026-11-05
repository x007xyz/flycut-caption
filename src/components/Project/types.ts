// 项目相关展示组件的数据类型（F-0002、E-02/6）。组件只接收这些数据，不读写 Host / stores。

export type VideoTranscriptStatus =
  | { kind: 'ready' }
  | { kind: 'transcribing'; progress: number }
  | { kind: 'not-transcribed' };

export interface ProjectSummary {
  id: string;
  name: string;
  /** 项目内全部视频的总时长（秒） */
  durationSeconds: number;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601，最后修改时间 */
  updatedAt: string;
  videoCount: number;
  thumbnailUrl?: string;
  /** 项目里有视频的媒体文件找不到了 */
  mediaMissing?: boolean;
  /** 项目里正在转写的视频（取进度最慢的一个），没有则不传 */
  transcribing?: { progress: number };
}

export interface ProjectVideoItem {
  id: string;
  name: string;
  durationSeconds: number;
  updatedAt: string;
  thumbnailUrl?: string;
  status: VideoTranscriptStatus;
  mediaMissing?: boolean;
  subtitleCount?: number;
}

export type LoadStatus = 'loading' | 'ready' | 'error';
export type ProjectsView = 'grid' | 'list';
export type ProjectsSort = 'updated' | 'created' | 'name';

/**
 * 编辑时的保存状态：
 * - saved：全部写入 Host
 * - pending：有修改，等待自动保存
 * - saving：正在写入
 * - failed：写入失败，自动重试中
 * - conflict：版本冲突，自动保存已暂停
 */
export type SaveStatus = 'saved' | 'pending' | 'saving' | 'failed' | 'conflict';

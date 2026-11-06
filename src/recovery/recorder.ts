// 崩溃恢复副本的记录调度（F-0004 AC-1、AC-10）。一个编辑会话一个记录器。
// 停止编辑 250ms 后记录；连续编辑时最多等 1 秒（需求说明的边界是停止后 1 秒内、连续编辑每 2 秒至少一次，留出写入时间）。
// 写入串行，每次都取当时最新的完整状态整份替换；写入失败保留上一份完整副本并报告，不影响 Host 的自动保存。
import type { RecoveryCopy } from './copy';
import type { RecoveryStorage } from './storage';

export const RECORD_IDLE_MS = 250;
export const RECORD_MAX_WAIT_MS = 1000;

/** 记录器要写的内容；返回 null 表示没有需要保护的修改（都已保存），这时删掉这个会话的副本 */
export type Capture = () => Omit<RecoveryCopy, 'sequence' | 'recordedAt'> | null;

export interface RecorderOptions {
  storage: RecoveryStorage;
  capture: Capture;
  /** 最近一次写入是否成功（AC-10）；error 是失败原因 */
  onHealth?: (healthy: boolean, error?: unknown) => void;
  /** 每次成功写入后调用（测试和性能记录用），`ms` 是从发起写入到事务完成的耗时 */
  onRecorded?: (copy: RecoveryCopy, ms: number) => void;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export class RecoveryRecorder {
  private options: RecorderOptions;
  private sequence = 0;
  /** 这个会话已经写入过副本（需要删除时才去删） */
  private stored: { key: string } | null = null;
  private timer: unknown = null;
  /** 第一次未记录的修改发生的时间（连续编辑的最长等待从这里算） */
  private firstPendingAt: number | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(options: RecorderOptions) { this.options = options; }

  private now() { return this.options.now ? this.options.now() : Date.now(); }
  private set(callback: () => void, ms: number) { return this.options.setTimer ? this.options.setTimer(callback, ms) : setTimeout(callback, ms); }
  private clear() { if (this.timer !== null) { if (this.options.clearTimer) this.options.clearTimer(this.timer); else clearTimeout(this.timer as ReturnType<typeof setTimeout>); } this.timer = null; }

  /** 编辑状态变了（或保存成功了）：安排一次记录。`immediate` 时马上记录，例如保存成功后更新基准修订号 */
  changed(immediate = false) {
    if (this.closed) return;
    this.sequence += 1;
    const now = this.now();
    this.firstPendingAt ??= now;
    this.clear();
    const wait = immediate ? 0 : Math.max(0, Math.min(RECORD_IDLE_MS, this.firstPendingAt + RECORD_MAX_WAIT_MS - now));
    this.timer = this.set(() => { this.timer = null; void this.record(); }, wait);
  }

  /** 马上记录当前状态（AC-10 的「重试」）。返回是否成功 */
  record(): Promise<boolean> {
    this.clear();
    this.firstPendingAt = null;
    const run = async () => {
      if (this.closed) return true;
      const started = this.now();
      try {
        // capture 可能抛错（例如还没拿到 Host 身份）：同样算记录失败
        const draft = this.options.capture();
        if (!draft) {
          if (this.stored) { await this.options.storage.delete(this.stored.key); this.stored = null; }
          this.options.onHealth?.(true);
          return true;
        }
        const copy: RecoveryCopy = { ...draft, sequence: this.sequence, recordedAt: new Date().toISOString() };
        await this.options.storage.put(copy);
        this.stored = { key: copy.key };
        this.options.onHealth?.(true);
        this.options.onRecorded?.(copy, this.now() - started);
        return true;
      } catch (error) {
        this.options.onHealth?.(false, error);
        return false;
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next;
    return next;
  }

  /**
   * 会话结束（离开编辑器、切换视频）：不再记录。`discard` 时删除这个会话的副本——离开前修改已经保存，
   * 或者用户选择了放弃修改。等前面排队的写入完成后再删，不会删了又被旧写入写回来。
   */
  async close(discard: boolean) {
    this.clear();
    this.closed = true;
    const stored = this.stored;
    await this.queue.catch(() => undefined);
    if (discard && (stored ?? this.stored)) {
      const key = (stored ?? this.stored)!.key;
      await this.options.storage.delete(key).catch(() => undefined);
      this.stored = null;
    }
  }
}

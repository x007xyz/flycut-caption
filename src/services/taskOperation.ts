import type { JobSnapshot } from '../../shared/protocol';
import {
  ConnectionUnavailableError,
  HostRequestError,
  SessionClosedError,
  type RemoteConnection,
} from '@/runtime/connection';

export type TaskOperationKind = 'asr' | 'export';

interface TaskOperationRecord {
  version: 1;
  hostId: string;
  kind: TaskOperationKind;
  key: string;
  operationId: string;
  jobId?: string;
  createdAt: string;
  updatedAt: string;
}

interface TaskOperationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

class MemoryTaskOperationStorage implements TaskOperationStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function defaultStorage(): TaskOperationStorage {
  if (typeof localStorage !== 'undefined') return localStorage;
  return new MemoryTaskOperationStorage();
}

/** Non-sensitive retry metadata. Source media, task input, credentials and results stay in memory or on the Host. */
export class TaskOperationStore {
  private storage: TaskOperationStorage;
  constructor(storage: TaskOperationStorage = defaultStorage()) { this.storage = storage; }

  private storageKey(hostId: string) { return `flycut.task.operations.${hostId}`; }

  read(hostId: string): TaskOperationRecord[] {
    try {
      const parsed = JSON.parse(this.storage.getItem(this.storageKey(hostId)) ?? '[]') as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is TaskOperationRecord => !!item && typeof item === 'object'
        && (item as TaskOperationRecord).version === 1 && (item as TaskOperationRecord).hostId === hostId
        && typeof (item as TaskOperationRecord).kind === 'string' && typeof (item as TaskOperationRecord).key === 'string'
        && typeof (item as TaskOperationRecord).operationId === 'string');
    } catch { return []; }
  }

  find(hostId: string, kind: TaskOperationKind, key: string) {
    return this.read(hostId).find(item => item.kind === kind && item.key === key);
  }

  save(record: TaskOperationRecord) {
    const items = this.read(record.hostId).filter(item => !(item.kind === record.kind && item.key === record.key));
    items.push(record);
    try { this.storage.setItem(this.storageKey(record.hostId), JSON.stringify(items.slice(-100))); }
    catch { /* Local retry metadata is best-effort; the Host remains authoritative. */ }
  }

  remove(hostId: string, kind: TaskOperationKind, key: string) {
    try {
      this.storage.setItem(this.storageKey(hostId), JSON.stringify(this.read(hostId)
        .filter(item => !(item.kind === kind && item.key === key))));
    } catch { /* Local retry metadata is best-effort. */ }
  }
}

export interface TaskRunOptions {
  kind: TaskOperationKind;
  /** Stable identity for this user action, such as project/video and export settings. */
  key: string;
  start(operationId: string): Promise<JobSnapshot>;
  progress?(job: JobSnapshot): void;
  /** Called before a stored task is queried or an uncertain start is checked. */
  verifying?(): void;
  signal?: AbortSignal;
  /** How long to wait for the connection before reporting that the result still needs verification. */
  reconnectTimeoutMs?: number;
}

export interface TaskRunResult<T> {
  hostId: string;
  job: JobSnapshot;
  result: T;
  operationId: string;
}

export class TaskVerificationPendingError extends Error {
  readonly operationId: string;
  constructor(operationId: string) {
    super('Task result could not be verified. Reconnect and retry the same operation.');
    this.name = 'TaskVerificationPendingError';
    this.operationId = operationId;
  }
}

function taskStartMayHaveBeenAccepted(error: unknown) {
  if (error instanceof ConnectionUnavailableError) return true;
  if (error instanceof HostRequestError) return error.status >= 500 || error.code === 'server-error';
  if (error instanceof TypeError) return true;
  return error instanceof DOMException && ['AbortError', 'TimeoutError', 'NetworkError'].includes(error.name);
}

function terminal(job: JobSnapshot) { return job.status === 'error' || job.status === 'cancelled'; }

export class TaskOperationRunner {
  private inFlight = new Map<string, Promise<TaskRunResult<unknown>>>();
  private connection: RemoteConnection;
  private store: TaskOperationStore;

  constructor(connection: RemoteConnection, store = new TaskOperationStore()) {
    this.connection = connection;
    this.store = store;
  }

  /** Identity is read for every action. The same address can restart or switch to another Host. */
  private async hostId() {
    return (await this.connection.call('projects.identity')).hostId;
  }

  private waitUntilConnected(signal: AbortSignal | undefined, timeoutMs: number) {
    if (this.connection.isReady()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const lifecycle: { timer?: ReturnType<typeof setTimeout>; unsubscribe?: () => void } = {};
      const finish = (error?: Error) => {
        clearTimeout(lifecycle.timer); lifecycle.unsubscribe?.(); signal?.removeEventListener('abort', aborted);
        if (error) reject(error); else resolve();
      };
      const aborted = () => finish(signal?.reason instanceof Error ? signal.reason : new Error('Cancelled'));
      lifecycle.unsubscribe = this.connection.subscribe(() => { if (this.connection.isReady()) finish(); });
      signal?.addEventListener('abort', aborted, { once: true });
      lifecycle.timer = setTimeout(() => finish(new ConnectionUnavailableError()), timeoutMs);
      if (this.connection.isReady()) finish();
      if (signal?.aborted) aborted();
    });
  }

  private record(hostId: string, kind: TaskOperationKind, key: string, operationId: string, jobId?: string,
    previous?: TaskOperationRecord): TaskOperationRecord {
    const now = new Date().toISOString();
    return { version: 1, hostId, kind, key, operationId, jobId, createdAt: previous?.createdAt ?? now, updatedAt: now };
  }

  private async locateJob(record: TaskOperationRecord, signal: AbortSignal | undefined, timeoutMs: number) {
    if (record.jobId) {
      try {
        const job = await this.connection.call('jobs.get', { id: record.jobId });
        if (!job.operationId || job.operationId === record.operationId) return job;
      } catch (error) {
        if (signal?.aborted || error instanceof SessionClosedError) throw error;
      }
    }
    await this.waitUntilConnected(signal, timeoutMs);
    const jobs = await this.connection.call('jobs.list');
    return jobs.find(job => job.operationId === record.operationId);
  }

  private async waitForResult<T>(job: JobSnapshot, options: TaskRunOptions, hostId: string) {
    const result = await this.connection.waitJob<T>(job.id, snapshot => options.progress?.(snapshot), options.signal);
    return { hostId, job, result, operationId: job.operationId! };
  }

  async run<T>(options: TaskRunOptions): Promise<TaskRunResult<T>> {
    const hostId = await this.hostId();
    const flightKey = `${hostId}\0${options.kind}\0${options.key}`;
    const active = this.inFlight.get(flightKey);
    if (active) return active as Promise<TaskRunResult<T>>;
    const task = this.runOnce<T>(options, hostId).finally(() => { if (this.inFlight.get(flightKey) === task) this.inFlight.delete(flightKey); });
    this.inFlight.set(flightKey, task as Promise<TaskRunResult<unknown>>);
    return task as Promise<TaskRunResult<T>>;
  }

  private async runOnce<T>(options: TaskRunOptions, hostId: string): Promise<TaskRunResult<T>> {
    const timeoutMs = options.reconnectTimeoutMs ?? 30_000;
    let stored = this.store.find(hostId, options.kind, options.key);
    if (stored) {
      options.verifying?.();
      const existing = await this.locateJob(stored, options.signal, timeoutMs);
      if (existing) {
        stored = this.record(hostId, options.kind, options.key, stored.operationId, existing.id, stored);
        this.store.save(stored);
        if (terminal(existing)) {
          this.store.remove(hostId, options.kind, options.key);
          throw new Error(existing.error || existing.status);
        }
        return this.waitForResult<T>(existing, options, hostId);
      }
    } else {
      stored = this.record(hostId, options.kind, options.key, crypto.randomUUID());
      this.store.save(stored);
    }

    const operationId = stored.operationId;
    let job: JobSnapshot | undefined;
    try {
      job = await options.start(operationId);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (!taskStartMayHaveBeenAccepted(error)) throw error;
      options.verifying?.();
      job = await this.locateJob(stored, options.signal, timeoutMs).catch(() => undefined);
      if (!job) {
        // The Host maps an operation id to one job. Repeating the same id closes the
        // response-loss window without creating a second project/ASR/export task.
        await this.waitUntilConnected(options.signal, timeoutMs);
        try { job = await options.start(operationId); }
        catch (retryError) {
          if (!taskStartMayHaveBeenAccepted(retryError)) throw retryError;
          job = await this.locateJob(stored, options.signal, timeoutMs).catch(() => undefined);
          if (!job) throw new TaskVerificationPendingError(operationId);
        }
      }
    }

    if (!job?.operationId || job.operationId !== operationId) throw new Error('Host returned a task with a different operation id');
    stored = this.record(hostId, options.kind, options.key, operationId, job.id, stored);
    this.store.save(stored);
    try { return await this.waitForResult<T>(job, options, hostId); }
    catch (error) {
      if (error instanceof SessionClosedError) throw error;
      // waitJob also rejects for transport failures. Only a Host-confirmed terminal
      // snapshot proves that retrying must create a new operation. Unknown outcomes
      // keep the locator so a retry can find the same job instead of charging twice.
      const settled = await this.connection.call('jobs.get', { id: job.id }).catch(() => undefined);
      if (settled && terminal(settled)) {
        this.store.remove(hostId, options.kind, options.key);
        throw new Error(settled.error || settled.status);
      }
      throw error;
    }
  }

  /** Called only after the result has been applied or delivered, so refresh before that point can still recover it. */
  async complete(kind: TaskOperationKind, key: string, knownHostId?: string) {
    const hostId = knownHostId ?? await this.hostId();
    this.store.remove(hostId, kind, key);
  }
}

/** Stable local identity for one operation; does not include media bytes or credentials. */
export function taskOperationKey(kind: TaskOperationKind, ...parts: Array<string | number | undefined>) {
  const value = JSON.stringify([kind, ...parts.map(part => part ?? '')]);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${kind}:${(first >>> 0).toString(36)}:${(second >>> 0).toString(36)}`;
}

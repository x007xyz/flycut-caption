import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JobSnapshot } from '../../shared/protocol.ts';
import {
  ConnectionUnavailableError,
  SessionClosedError,
  type RemoteConnection,
} from '../../src/runtime/connection.ts';
import {
  TaskOperationRunner,
  TaskOperationStore,
  TaskVerificationPendingError,
  taskOperationKey,
} from '../../src/services/taskOperation.ts';
import { ASRService } from '../../src/services/asrService.ts';

const HOST_ID = '00000000-0000-4000-8000-0000000000f1';

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function snapshot(id: string, operationId: string, status: JobSnapshot['status'] = 'complete'): JobSnapshot {
  const now = new Date().toISOString();
  return { id, operationId, status, createdAt: now, updatedAt: now,
    ...(status === 'complete' ? { result: { text: 'recovered' } } : {}),
    ...(status === 'error' ? { error: 'fixture failed' } : {}) };
}

interface FakeState {
  jobs: Map<string, JobSnapshot>;
  ready?: boolean;
  identities?: string[];
  wait?: (job: JobSnapshot) => Promise<unknown>;
  calls: Array<{ method: string; payload?: unknown }>;
}

function fakeConnection(state: FakeState): RemoteConnection {
  const connection = {
    isReady: () => state.ready ?? true,
    subscribe: () => () => undefined,
    call: async (method: string, payload?: unknown) => {
      state.calls.push({ method, payload });
      if (method === 'projects.identity') {
        const hostId = state.identities?.length ? state.identities.shift()! : HOST_ID;
        return { hostId, recovery: 1 };
      }
      if (method === 'jobs.list') return [...state.jobs.values()];
      if (method === 'jobs.get') {
        const id = (payload as { id: string }).id;
        const job = state.jobs.get(id);
        if (!job) throw new Error('missing fixture job');
        return job;
      }
      throw new Error(`unexpected call: ${method}`);
    },
    waitJob: async (id: string) => {
      const job = state.jobs.get(id);
      if (!job) throw new Error('missing fixture job');
      if (state.wait) return state.wait(job);
      return job.result;
    },
  };
  return connection as unknown as RemoteConnection;
}

function callsOf(state: FakeState, method: string) {
  return state.calls.filter(call => call.method === method);
}

test('F-0015/AC-9 accepted ASR start with a lost receipt locates the same operation', async () => {
  const state: FakeState = { jobs: new Map(), calls: [] };
  const connection = fakeConnection(state);
  const store = new TaskOperationStore(new MemoryStorage());
  const runner = new TaskOperationRunner(connection, store);
  let startCalls = 0;
  let startOperationId = '';
  let verifying = 0;

  const result = await runner.run<{ text: string }>({
    kind: 'asr', key: 'asr:accepted-receipt-lost', reconnectTimeoutMs: 20,
    verifying: () => { verifying += 1; },
    start: async operationId => {
      startCalls += 1; startOperationId = operationId;
      state.jobs.set('job-accepted', snapshot('job-accepted', operationId));
      throw new ConnectionUnavailableError();
    },
  });

  assert.equal(startCalls, 1, 'an accepted start is not submitted twice');
  assert.equal(callsOf(state, 'jobs.list').length, 1, 'the uncertain receipt is verified against Host jobs');
  assert.equal(result.operationId, startOperationId);
  assert.equal(result.result.text, 'recovered');
  assert.equal(verifying, 1, 'the UI is told to verify before querying Host state');
  assert.equal(store.find(HOST_ID, 'asr', 'asr:accepted-receipt-lost')?.jobId, 'job-accepted');

  await runner.complete('asr', 'asr:accepted-receipt-lost');
  assert.equal(store.find(HOST_ID, 'asr', 'asr:accepted-receipt-lost'), undefined);
});

test('F-0015/AC-9 a refreshed client recovers a stored job without starting a second task', async () => {
  const storage = new MemoryStorage();
  const firstState: FakeState = {
    jobs: new Map(), calls: [],
    wait: async () => { throw new SessionClosedError(); },
  };
  const first = new TaskOperationRunner(fakeConnection(firstState), new TaskOperationStore(storage));
  let firstOperationId = '';

  await assert.rejects(first.run({
    kind: 'export', key: 'export:refresh',
    start: async operationId => {
      firstOperationId = operationId;
      const job = snapshot('job-refresh', operationId, 'running');
      firstState.jobs.set(job.id, job);
      return job;
    },
  }), SessionClosedError);

  const stored = new TaskOperationStore(storage).find(HOST_ID, 'export', 'export:refresh');
  assert.equal(stored?.jobId, 'job-refresh');
  assert.equal(stored?.operationId, firstOperationId);

  const refreshedState: FakeState = { jobs: new Map([['job-refresh', snapshot('job-refresh', firstOperationId)]]), calls: [] };
  let refreshedStarts = 0;
  let refreshedVerifying = 0;
  const refreshed = new TaskOperationRunner(fakeConnection(refreshedState), new TaskOperationStore(storage));
  const result = await refreshed.run<{ text: string }>({
    kind: 'export', key: 'export:refresh', verifying: () => { refreshedVerifying += 1; },
    start: async () => { refreshedStarts += 1; throw new Error('must not start after refresh'); },
  });

  assert.equal(refreshedStarts, 0, 'refresh recovery reuses the persisted job');
  assert.equal(refreshedVerifying, 1, 'the recovered operation is visibly verified');
  assert.equal(callsOf(refreshedState, 'jobs.get').length, 1);
  assert.equal(result.operationId, firstOperationId);
  assert.equal(result.result.text, 'recovered');
});

test('F-0015/AC-9 repeated clicks share one in-flight operation', async () => {
  const state: FakeState = { jobs: new Map(), calls: [] };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let startCalls = 0;
  let waitCalls = 0;
  state.wait = async job => { waitCalls += 1; await gate; return job.result; };
  const runner = new TaskOperationRunner(fakeConnection(state), new TaskOperationStore(new MemoryStorage()));
  const run = () => runner.run<{ text: string }>({
    kind: 'asr', key: 'asr:double-click',
    start: async operationId => {
      startCalls += 1;
      const job = snapshot('job-click', operationId);
      state.jobs.set(job.id, job);
      return job;
    },
  });

  const [first, second] = [run(), run()];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(startCalls, 1, 'two clicks during one request cannot create two jobs');
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(waitCalls, 1, 'both clicks observe the same task result');
  assert.equal(a.operationId, b.operationId);
  assert.equal(a.job.id, b.job.id);
});

test('F-0015/AC-9 uncertain starts retry with the same operationId and reject a different Host task', async () => {
  const state: FakeState = { jobs: new Map(), calls: [] };
  const runner = new TaskOperationRunner(fakeConnection(state), new TaskOperationStore(new MemoryStorage()));
  const observed: string[] = [];
  const recovered = await runner.run<{ text: string }>({
    kind: 'asr', key: 'asr:same-id', reconnectTimeoutMs: 20,
    start: async operationId => {
      observed.push(operationId);
      if (observed.length === 1) throw new ConnectionUnavailableError();
      const job = snapshot('job-same-id', operationId);
      state.jobs.set(job.id, job);
      return job;
    },
  });
  assert.deepEqual(observed, [recovered.operationId, recovered.operationId]);

  const mismatchRunner = new TaskOperationRunner(fakeConnection({ jobs: new Map(), calls: [] }), new TaskOperationStore(new MemoryStorage()));
  await assert.rejects(mismatchRunner.run({
    kind: 'export', key: 'export:mismatch',
    start: async () => snapshot('job-wrong', crypto.randomUUID()),
  }), /different operation id/);
});

test('F-0015/AC-9 two uncertain starts with no Host job remain retryable instead of declaring failure', async () => {
  const state: FakeState = { jobs: new Map(), calls: [] };
  const runner = new TaskOperationRunner(fakeConnection(state), new TaskOperationStore(new MemoryStorage()));
  const observed: string[] = [];

  await assert.rejects(runner.run({
    kind: 'export', key: 'export:pending', reconnectTimeoutMs: 20,
    start: async operationId => { observed.push(operationId); throw new ConnectionUnavailableError(); },
  }), (error: unknown) => error instanceof TaskVerificationPendingError && error.operationId === observed[0]);

  assert.equal(observed.length, 2);
  assert.equal(new Set(observed).size, 1, 'the response-loss retry reuses one operation id');
  assert.equal(callsOf(state, 'jobs.list').length, 2, 'both uncertain receipts are checked before remaining pending');
});

test('F-0015/AC-9 a same-address identity switch never reuses the previous Host operation', async () => {
  const state: FakeState = { jobs: new Map(), identities: ['host-a', 'host-b'], calls: [] };
  const runner = new TaskOperationRunner(fakeConnection(state), new TaskOperationStore(new MemoryStorage()));
  const observed: string[] = [];
  let starts = 0;
  const run = () => runner.run<{ text: string }>({
    kind: 'asr', key: 'asr:shared-key',
    start: async operationId => {
      starts += 1; observed.push(operationId);
      const job = snapshot(`job-host-${starts}`, operationId);
      state.jobs.set(job.id, job);
      return job;
    },
  });

  const first = await run();
  const second = await run();
  assert.equal(starts, 2, 'the second identity starts on its own Host instead of locating the old job');
  assert.notEqual(first.operationId, second.operationId);
  assert.equal(first.hostId, 'host-a');
  assert.equal(second.hostId, 'host-b');
  assert.deepEqual(observed, [first.operationId, second.operationId]);

  await runner.complete('asr', 'asr:shared-key', second.hostId);
  assert.equal(callsOf(state, 'projects.identity').length, 2, 'completion uses the task host rather than re-reading a potentially switched identity');
});

test('F-0015/AC-9 a completed job survives failed project persistence and retry reuses its result', async () => {
  const storage = new MemoryStorage();
  const state: FakeState = { jobs: new Map(), calls: [] };
  const runner = new TaskOperationRunner(fakeConnection(state), new TaskOperationStore(storage));
  const service = new ASRService(fakeConnection(state), runner);
  let starts = 0;
  let persistSucceeds = false;
  const run = () => runner.run<{ text: string }>({
    kind: 'asr', key: 'asr:persistence-failure',
    start: async operationId => {
      starts += 1;
      const job = snapshot('job-persistence', operationId);
      state.jobs.set(job.id, job);
      return job;
    },
  });

  const first = await run();
  assert.equal(await service.completeOperation('asr:persistence-failure', persistSucceeds), false);
  assert.equal(new TaskOperationStore(storage).find(HOST_ID, 'asr', 'asr:persistence-failure')?.jobId, 'job-persistence',
    'failed persistence leaves the operation locator in place');
  const retried = await run();
  assert.equal(starts, 1, 'retry after persistence failure recovers the completed job');
  assert.equal(retried.job.id, first.job.id);
  persistSucceeds = true;
  assert.equal(await service.completeOperation('asr:persistence-failure', persistSucceeds), true);
  assert.equal(new TaskOperationStore(storage).find(HOST_ID, 'asr', 'asr:persistence-failure'), undefined);
});

test('F-0015/AC-9 a transport failure while waiting keeps the accepted job for retry', async () => {
  const storage = new MemoryStorage();
  const state: FakeState = { jobs: new Map(), calls: [] };
  let starts = 0;
  let waits = 0;
  const start = async (operationId: string) => {
    starts += 1;
    const job = snapshot('job-wait-retry', operationId, 'running');
    state.jobs.set(job.id, job);
    return job;
  };
  state.wait = async (job: JobSnapshot) => {
    waits += 1;
    if (waits === 1) throw new ConnectionUnavailableError();
    return job.result ?? { text: 'recovered after reconnect' };
  };
  const runner = new TaskOperationRunner(fakeConnection(state), new TaskOperationStore(storage));

  await assert.rejects(runner.run({ kind: 'export', key: 'export:wait-retry', start }), ConnectionUnavailableError);
  assert.equal(new TaskOperationStore(storage).find(HOST_ID, 'export', 'export:wait-retry')?.jobId, 'job-wait-retry');

  const retried = await runner.run<{ text: string }>({ kind: 'export', key: 'export:wait-retry', start });
  assert.equal(starts, 1, 'wait recovery must not create a second operation');
  assert.equal(waits, 2);
  assert.equal(retried.job.id, 'job-wait-retry');
});

test('F-0015/AC-9 only a Host-confirmed terminal job releases its operation locator', async () => {
  const storage = new MemoryStorage();
  const state: FakeState = { jobs: new Map(), calls: [] };
  state.wait = async (job: JobSnapshot) => {
    const failed = { ...job, status: 'error' as const, error: 'provider failed' };
    state.jobs.set(job.id, failed);
    throw new Error('provider failed');
  };
  const runner = new TaskOperationRunner(fakeConnection(state), new TaskOperationStore(storage));

  await assert.rejects(runner.run({
    kind: 'asr', key: 'asr:terminal',
    start: async operationId => {
      const job = snapshot('job-terminal', operationId, 'running');
      state.jobs.set(job.id, job);
      return job;
    },
  }), /provider failed/);
  assert.equal(new TaskOperationStore(storage).find(HOST_ID, 'asr', 'asr:terminal'), undefined);
});

test('F-0015/AC-9 task keys change when ASR or export inputs change', () => {
  const asr = taskOperationKey('asr', 'project', 'video', 'clip.mp4', 42, 'provider', 'model', 'zh');
  assert.notEqual(asr, taskOperationKey('asr', 'project', 'video', 'clip.mp4', 42, 'provider', 'model', 'en'));
  assert.notEqual(asr, taskOperationKey('asr', 'project', 'video', 'clip.mp4', 42, 'provider', 'model', 'zh', 'digest-a'));
  const exported = taskOperationKey('export', 'project', 'video', 'clip.mp4', 42, 'mp4', 'medium', 'none', '0-1-1', 'style-a');
  assert.notEqual(exported, taskOperationKey('export', 'project', 'video', 'clip.mp4', 42, 'mp4', 'medium', 'none', '0-1-1', 'style-b'));
});

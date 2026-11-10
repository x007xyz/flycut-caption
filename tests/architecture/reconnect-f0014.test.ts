// F-0014 AC-5：临时断线只暂停任务等待；身份读取超时不能被当成「换了 Host」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostConnection } from '../../src/runtime/connection.ts';
import { HostSessionController, type SessionTransport } from '../../src/runtime/HostSessionController.ts';
import { PROTOCOL_VERSION } from '../../shared/protocol.ts';

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

test('F-0014/AC-5 waitJob survives a transient socket drop and resumes with jobs.get after reconnect', async () => {
  class FakeSocket {
    static last: FakeSocket;
    onmessage?: (event: { data: string }) => void; onclose?: () => void; onerror?: () => void;
    constructor() {
      FakeSocket.last = this;
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'host/ready', protocolVersion: PROTOCOL_VERSION, generation: 'g', cursor: 0, events: [] }) }));
    }
    close() { this.onclose?.(); }
  }
  const realSocket = globalThis.WebSocket; const realFetch = globalThis.fetch;
  let status = 'running';
  (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const { rpcId } = JSON.parse(init.body) as { rpcId: string };
    return new Response(JSON.stringify({ type: 'server-response', rpcId,
      result: { ok: true, value: { id: 'j1', status, updatedAt: status === 'running' ? 1 : 2, result: status === 'complete' ? 'done' : undefined } } }));
  }) as typeof fetch;
  const connection = new HostConnection({ url: 'http://127.0.0.1:1', auth: { kind: 'bearer', token: 't' } });
  try {
    await connection.open();
    let outcome = 'pending';
    connection.waitJob<string>('j1').then(value => { outcome = `resolved:${value}`; }, error => { outcome = `rejected:${(error as Error).name}`; });
    await tick(10);
    FakeSocket.last.close();
    await tick(10);
    assert.equal(outcome, 'pending', 'a transient drop must not end the wait');
    status = 'complete';
    await connection.open();
    await tick(20);
    assert.equal(outcome, 'resolved:done');
  } finally {
    connection.close();
    (globalThis as { WebSocket: unknown }).WebSocket = realSocket; globalThis.fetch = realFetch;
  }
});

class FakeTransport implements SessionTransport {
  status: 'connecting' | 'connected' | 'disconnected' = 'disconnected';
  listeners = new Set<() => void>();
  identity: () => Promise<unknown> = async () => ({ hostId: 'host-A' });
  async open() { this.set('connected'); return {}; }
  async call(method: string) {
    if (method === 'host.info') return { protocolVersion: PROTOCOL_VERSION, generation: `gen-${Math.random()}`, capabilities: { projects: true } };
    if (method === 'projects.identity') return this.identity();
    throw new Error(`unexpected ${method}`);
  }
  async waitForJobsSnapshot() {}
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  snapshot() { return this.status; }
  isReady() { return this.status === 'connected'; }
  setRefreshHandler() {}
  setErrorHandler() {}
  setSessionExpiry() {}
  close() { this.set('disconnected'); }
  set(status: FakeTransport['status']) { this.status = status; this.listeners.forEach(listener => listener()); }
}

async function connectedController(transport: FakeTransport) {
  const events: string[] = [];
  const controller = new HostSessionController({
    transportFactory: () => transport, onlineSignals: false, storage: undefined, location: { hash: '', assign() {} },
    discover: async () => ({ target: { url: 'http://127.0.0.1:1', label: 'local', source: 'self-hosted' }, auth: { kind: 'bearer', token: 't' } }),
    setTimer: (callback) => setTimeout(callback, 0),
  });
  controller.attachRuntime({ onIdentityChanged: (from, to) => events.push(`changed:${from}->${to}`), onReconnected: id => events.push(`reconnected:${id}`) });
  controller.start();
  for (let i = 0; i < 50 && controller.snapshot().phase !== 'connected'; i++) await tick(5);
  assert.equal(controller.snapshot().phase, 'connected');
  return { controller, events };
}

async function reconnect(controller: HostSessionController, transport: FakeTransport) {
  transport.set('disconnected');
  for (let i = 0; i < 200 && controller.snapshot().phase !== 'connected'; i++) await tick(10);
  assert.equal(controller.snapshot().phase, 'connected');
}

test('F-0014/AC-5 a slow projects.identity on reconnect keeps the same Host instead of resetting the editor', async () => {
  const transport = new FakeTransport();
  const { controller, events } = await connectedController(transport);
  try {
    transport.identity = () => new Promise(resolve => setTimeout(() => resolve({ hostId: 'host-A' }), 800));
    await reconnect(controller, transport);
    assert.deepEqual(events, ['reconnected:host-A']);
    assert.equal(controller.snapshot().identity?.hostId, 'host-A');
  } finally { controller.stop(); }
});

test('F-0014/AC-5 a verified different hostId on reconnect still reports an identity change', async () => {
  const transport = new FakeTransport();
  const { controller, events } = await connectedController(transport);
  try {
    transport.identity = async () => ({ hostId: 'host-B' });
    await reconnect(controller, transport);
    assert.deepEqual(events, ['changed:host-A->host-B']);
  } finally { controller.stop(); }
});

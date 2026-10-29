import type { Context } from '@deepseek-ai/cordis';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { pythonRequestSchema } from '../../shared/protocol';

/** Python is an execution worker owned by the Host, never the UI's control plane. */
export const pythonPlugin = { name: 'flycut-python-worker', inject: ['hostConfig', 'rpc'], apply(ctx: Context) {
  let child: ChildProcess | undefined;
  let ready: Promise<void> | undefined;
  const stop = new AbortController();
  const base = ctx.hostConfig.pythonUrl ?? 'http://127.0.0.1:8765';
  const workerToken = ctx.hostConfig.pythonUrl ? process.env.FLYCUT_PYTHON_TOKEN : randomBytes(32).toString('hex');
  const headers: Record<string, string> = workerToken ? { Authorization: `Bearer ${workerToken}` } : {};
  async function ensure() {
    ready ??= (async () => {
      if (!ctx.hostConfig.pythonUrl) {
        // A private worker port prevents adopting another process's model catalog.
        const { createServer } = await import('node:net');
        const probe = createServer();
        const port = await new Promise<number>((resolve, reject) => {
          probe.once('error', reject); probe.listen(0, '127.0.0.1', () => resolve((probe.address() as { port: number }).port));
        });
        await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
        workerBase = `http://127.0.0.1:${port}`;
        child = spawn(process.env.FLYCUT_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'),
          [join(ctx.hostConfig.resourceRoot, 'python/flycut_runtime.py'), '--port', String(port)], {
            env: { ...process.env, FLYCUT_WORKER_TOKEN: workerToken,
              FLYCUT_RUNTIME_HOME: process.env.FLYCUT_RUNTIME_HOME ?? join(ctx.hostConfig.home, 'python-runtime') },
            stdio: ['ignore', 'ignore', 'pipe'],
          });
        let failure: Error | undefined;
        child.once('error', error => { failure = error; });
        child.stderr?.on('data', data => console.error('[python]', String(data).trim()));
        for (let attempt = 0; attempt < 100; attempt++) {
          stop.signal.throwIfAborted();
          if (failure) throw failure;
          if (child.exitCode !== null) throw new Error(`Python worker exited (${child.exitCode})`);
          try { if ((await fetch(`${workerBase}/health`, { headers, signal: AbortSignal.timeout(500) })).ok) return; } catch { /* booting */ }
          await setTimeout(100, undefined, { signal: stop.signal });
        }
        throw new Error('Python worker did not become ready');
      }
      const response = await fetch(`${workerBase}/health`, { headers, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Configured Python worker is unavailable');
    })().catch(error => { ready = undefined; child?.kill(); throw error; });
    return ready;
  }
  let workerBase = base;
  const python = { async request(path: string, init?: RequestInit) {
    if (!/^\/(health|v1\/)/.test(path)) throw new Error('Invalid Python worker route');
    await ensure(); return fetch(`${workerBase}${path}`, { ...init,
      headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), ...headers },
      signal: init?.signal ? AbortSignal.any([stop.signal, init.signal]) : stop.signal });
  } };
  ctx.provide('python', python);
  // Only catalog/configuration routes are remote; ASR jobs go through Providers and the job service.
  const exposed = ['/health', '/v1/models', '/v1/runtime/config', '/v1/models/discover', '/v1/models/register', '/v1/models/register-discovered', '/v1/models/commit'];
  ctx.effect(() => ctx.rpc.register('python.request', pythonRequestSchema, async input => {
    if (!exposed.includes(input.path)) throw new Error('Python endpoint not exposed');
    const response = await python.request(input.path, { method: input.method,
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body), headers: { 'Content-Type': 'application/json' } }) });
    const data = await response.json(); if (!response.ok) throw new Error((data as { error?: string }).error || 'Python worker request failed'); return data;
  }));
  ctx.effect(() => async () => {
    stop.abort();
    const current = child;
    if (current && current.exitCode === null) {
      const exited = new Promise<void>(resolve => current.once('exit', () => resolve()));
      current.kill(); await exited;
    }
  });
} };

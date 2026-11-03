import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout } from 'node:timers/promises';

export interface WorkerOptions {
  /** Prefix for log lines, e.g. `python` or `funasr`. */
  label: string;
  script: string;
  healthPath: string;
  env?: Record<string, string>;
  /** Connect to an existing process instead of starting one. */
  url?: string;
  token?: string;
}

const freePort = async () => {
  const probe = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    probe.once('error', reject); probe.listen(0, '127.0.0.1', () => resolve((probe.address() as { port: number }).port));
  });
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
};

/**
 * A Python process owned by the Host: started on first use on a private port with a one-off token,
 * restarted after a failure, killed on dispose. With `url` it only connects to an existing process.
 */
export function pythonWorker(options: WorkerOptions) {
  let child: ChildProcess | undefined;
  let ready: Promise<{ baseUrl: string; headers: Record<string, string> }> | undefined;
  const stop = new AbortController();
  const token = options.url ? options.token : randomBytes(32).toString('hex');
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const healthy = (baseUrl: string, timeout: number) => fetch(`${baseUrl}${options.healthPath}`, { headers, signal: AbortSignal.timeout(timeout) })
    .then(response => response.ok, () => false);

  function connect() {
    ready ??= (async () => {
      if (options.url) {
        if (!await healthy(options.url, 5000)) throw new Error(`${options.label} 服务不可用：${options.url}`);
        return { baseUrl: options.url, headers };
      }
      const port = await freePort();
      const baseUrl = `http://127.0.0.1:${port}`;
      const current = child = spawn(process.env.FLYCUT_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'),
        [options.script, '--port', String(port)], {
          env: { ...process.env, ...options.env, ...(token ? { FLYCUT_WORKER_TOKEN: token } : {}) }, stdio: ['ignore', 'ignore', 'pipe'],
        });
      let failure: Error | undefined;
      let stderr = '';
      current.once('error', error => { failure = error; });
      current.once('exit', () => { if (child === current) { child = undefined; ready = undefined; } });
      current.stderr?.on('data', data => { const text = String(data); stderr = (stderr + text).slice(-2000); console.error(`[${options.label}]`, text.trim()); });
      for (let attempt = 0; attempt < 300; attempt++) {
        stop.signal.throwIfAborted();
        if (failure) throw new Error(`无法启动 ${options.label}：${failure.message}。请安装 Python 3 或设置 FLYCUT_PYTHON`);
        if (current.exitCode !== null) throw new Error(`${options.label} 进程退出（${current.exitCode}）：${stderr.trim().split('\n').pop() ?? ''}`);
        if (await healthy(baseUrl, 500)) return { baseUrl, headers };
        await setTimeout(100, undefined, { signal: stop.signal });
      }
      throw new Error(`${options.label} 没有在 30 秒内就绪`);
    })().catch(error => { ready = undefined; child?.kill(); throw error; });
    return ready;
  }

  return {
    connect,
    async request(path: string, init?: RequestInit) {
      const { baseUrl } = await connect();
      return fetch(`${baseUrl}${path}`, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), ...headers },
        signal: init?.signal ? AbortSignal.any([stop.signal, init.signal]) : stop.signal });
    },
    async dispose() {
      stop.abort();
      const current = child;
      if (current && current.exitCode === null) {
        const exited = new Promise<void>(resolve => current.once('exit', () => resolve()));
        current.kill(); await exited;
      }
    },
  };
}

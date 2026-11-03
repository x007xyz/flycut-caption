import { spawn } from 'node:child_process';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Runs a model runner that prints one JSON document on stdout. Output goes to files so a large
 * transcript never blocks on a full pipe; aborting the signal kills the process.
 */
export async function runJson(command: string, args: string[], signal: AbortSignal, env: Record<string, string> = {}): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), 'flycut-runner-'));
  const stdout = await open(join(dir, 'stdout'), 'w+'); const stderr = await open(join(dir, 'stderr'), 'w+');
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['ignore', stdout.fd, stderr.fd], signal });
      child.once('error', reject); child.once('exit', resolve);
    });
    const errors = (await readFile(join(dir, 'stderr'), 'utf8')).trim();
    if (code !== 0) throw new Error(errors.split('\n').slice(-5).join('\n') || `${command} 退出码 ${code}`);
    const text = await readFile(join(dir, 'stdout'), 'utf8');
    try { return JSON.parse(text); } catch { throw new Error(`识别程序没有输出 JSON：${(errors || text).slice(-500)}`); }
  } finally {
    await stdout.close(); await stderr.close(); await rm(dir, { recursive: true, force: true });
  }
}

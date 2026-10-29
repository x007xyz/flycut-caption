import { spawn, spawnSync } from 'node:child_process';
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const build = spawnSync(pnpm, ['build:core'], { stdio: 'inherit', shell: process.platform === 'win32' });
if (build.status) process.exit(build.status);
const children = [spawn(pnpm, ['exec', 'tsx', 'watch', '--tsconfig', 'server/tsconfig.json', 'server/main.ts'], { stdio: 'inherit', shell: process.platform === 'win32' }),
  spawn(pnpm, ['exec', 'vite'], { stdio: 'inherit', shell: process.platform === 'win32' })];
let stopping = false;
function stop(code = 0) { if (stopping) return; stopping = true; children.forEach(child => child.kill('SIGTERM')); process.exitCode = code; }
children.forEach(child => child.on('exit', code => stop(code ?? 0)));
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

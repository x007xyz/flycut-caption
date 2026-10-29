import { spawnSync } from 'node:child_process';
import { copyFile, chmod, mkdir, readFile, rm } from 'node:fs/promises';
try {
  const previous = JSON.parse(await readFile('src-tauri/host/package.json', 'utf8'));
  if (previous.name !== '@flycut/host') throw new Error('Refusing to replace an unrecognized Host directory');
  await rm('src-tauri/host', { recursive: true });
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const result = spawnSync(pnpm, ['--filter', '@flycut/host', 'deploy', '--prod', 'src-tauri/host'],
  { stdio: 'inherit', shell: process.platform === 'win32' });
if (result.status) process.exit(result.status);
await mkdir('src-tauri/binaries', { recursive: true });
const destination = `src-tauri/binaries/flycut-node${process.platform === 'win32' ? '.exe' : ''}`;
await copyFile(process.execPath, destination);
if (process.platform !== 'win32') await chmod(destination, 0o755);
console.log('Packaged Host dependencies and the current platform Node runtime.');

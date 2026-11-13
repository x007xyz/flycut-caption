import { accessSync, constants, existsSync } from 'node:fs';
import { access, copyFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const allowedMacPrefixes = [
  '/System/Library/',
  '/usr/lib/',
  '/Library/Apple/System/Library/',
];

function isAllowedMacDependency(path) {
  return allowedMacPrefixes.some(prefix => path.startsWith(prefix));
}

export function findNonDistributableMacDependencies(otoolOutput, pathExists = existsSync) {
  const libraries = otoolOutput
    .split(/\r?\n/)
    .filter(line => /^\s+\S/.test(line))
    .map(line => line.trim().match(/^(\S.*?)(?: \(compatibility version| \(offset )/)?.[1])
    .filter(Boolean);
  return libraries
    .filter(path => !isAllowedMacDependency(path))
    .map(path => {
      if (path.startsWith('@')) {
        return `${path} (loader-relative; the required dylib is not bundled)`;
      }
      if (path.startsWith('/') && !pathExists(path)) {
        return `${path} (missing from this machine)`;
      }
      return path;
    });
}

export function validateNodeBinary({ nodeBinary, platform = process.platform, run = spawnSync, pathExists = existsSync }) {
  if (!existsSync(nodeBinary)) throw new Error(`Node binary does not exist: ${nodeBinary}`);
  if (platform !== 'win32') {
    try {
      accessSync(nodeBinary, constants.X_OK);
    } catch {
      throw new Error(`Node binary is not executable: ${nodeBinary}`);
    }
  }

  const version = run(nodeBinary, ['--version'], { encoding: 'utf8' });
  if (version.error || version.status !== 0) {
    const detail = version.error?.message ?? (version.stderr || version.stdout || `exit ${version.status}`).trim();
    throw new Error(`Node binary cannot run on this machine: ${nodeBinary}\n${detail}`);
  }

  if (platform === 'darwin') {
    const inspected = run('otool', ['-L', nodeBinary], { encoding: 'utf8' });
    if (inspected.error || inspected.status !== 0) {
      const detail = inspected.error?.message ?? (inspected.stderr || inspected.stdout || `exit ${inspected.status}`).trim();
      throw new Error(`Cannot inspect macOS Node dependencies with otool: ${nodeBinary}\n${detail}`);
    }
    const nonDistributable = findNonDistributableMacDependencies(inspected.stdout, pathExists);
    if (nonDistributable.length > 0) {
      throw new Error([
        `Refusing to package a macOS Node binary with external dependencies: ${nodeBinary}`,
        ...nonDistributable.map(path => `- ${path}`),
        'Use a self-contained official Node binary, for example via FLYCUT_NODE_BINARY=/path/to/node.',
      ].join('\n'));
    }
  }

  return { nodeBinary, version: version.stdout.trim() };
}

export async function copyNodeBinary({ nodeBinary, destination, platform = process.platform }) {
  // Removing first prevents copyFile from following a stale destination symlink into another checkout.
  await rm(destination, { force: true });
  await copyFile(nodeBinary, destination);
  if (platform !== 'win32') await access(destination, constants.X_OK);
}

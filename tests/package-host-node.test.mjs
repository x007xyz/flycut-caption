import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  copyNodeBinary,
  findNonDistributableMacDependencies,
  validateNodeBinary,
} from '../scripts/package-host-node.mjs';

describe('package host Node runtime', () => {
  it('accepts a self-contained macOS Node binary', () => {
    const output = [
      '/path/to/node:',
      '\t/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation (compatibility version 150.0.0, current version 4424.1.255)',
      '\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)',
    ].join('\n');
    assert.deepEqual(findNonDistributableMacDependencies(output, () => true), []);
  });

  it('reports loader-relative and Homebrew dependencies', () => {
    const output = [
      '/path/to/node:',
      '\t@rpath/libnode.147.dylib (compatibility version 0.0.0, current version 0.0.0)',
      '\t/opt/homebrew/opt/libuv/lib/libuv.1.dylib (compatibility version 1.0.0, current version 1.0.0)',
      '\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)',
    ].join('\n');
    assert.deepEqual(findNonDistributableMacDependencies(output, () => true), [
      '@rpath/libnode.147.dylib (loader-relative; the required dylib is not bundled)',
      '/opt/homebrew/opt/libuv/lib/libuv.1.dylib',
    ]);
  });

  it('distinguishes a missing absolute dependency', () => {
    const output = [
      '/path/to/node:',
      '\t/opt/custom/libnode.dylib (compatibility version 0.0.0, current version 0.0.0)',
    ].join('\n');
    assert.deepEqual(findNonDistributableMacDependencies(output, () => false), [
      '/opt/custom/libnode.dylib (missing from this machine)',
    ]);
  });

  it('refuses a macOS Node binary that depends on libnode or Homebrew libraries', () => {
    const otool = [
      '/path/to/node:',
      '\t@rpath/libnode.147.dylib (compatibility version 0.0.0, current version 0.0.0)',
      '\t/opt/homebrew/opt/libuv/lib/libuv.1.dylib (compatibility version 1.0.0, current version 1.0.0)',
    ].join('\n');
    const run = (_command, args) => args[0] === '--version'
      ? { status: 0, stdout: 'v24.6.0\n', stderr: '' }
      : { status: 0, stdout: otool, stderr: '' };
    assert.throws(
      () => validateNodeBinary({ nodeBinary: process.execPath, platform: 'darwin', run, pathExists: () => true }),
      /Refusing to package a macOS Node binary with external dependencies[\s\S]*@rpath\/libnode\.147\.dylib[\s\S]*\/opt\/homebrew\/opt\/libuv/,
    );
  });

  it('replaces a destination symlink without writing through it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flycut-node-package-'));
    const source = join(dir, 'source-node');
    const linkedTarget = join(dir, 'other-checkout-node');
    const destination = join(dir, 'flycut-node');
    try {
      await writeFile(source, 'self-contained-node');
      await writeFile(linkedTarget, 'must-not-change');
      await symlink(linkedTarget, destination);
      await copyNodeBinary({ nodeBinary: source, destination, platform: 'win32' });
      assert.equal(await readFile(destination, 'utf8'), 'self-contained-node');
      assert.equal(await readFile(linkedTarget, 'utf8'), 'must-not-change');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

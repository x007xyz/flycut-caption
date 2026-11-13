import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { findNonDistributableMacDependencies } from '../package-host-node.mjs';
import { collectSecrets, redactSecrets } from './common.mjs';

const MACHO_MAGICS = new Set([
  0xfeedface,
  0xcefaedfe,
  0xfeedfacf,
  0xcffaedfe,
  0xcafebabe,
  0xbebafeca,
]);

export function defaultSpawn(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...options });
}

export function runChecked(cmd, args, { run = defaultSpawn, secrets = [], label } = {}) {
  const res = run(cmd, args, { encoding: 'utf8' });
  if (res.error || res.status !== 0) {
    const rawDetail = res.error?.message || [res.stderr, res.stdout].filter(Boolean).join('\n').trim() || ('exit ' + res.status);
    const safeDetail = redactSecrets(rawDetail, secrets);
    throw new Error((label || cmd) + ' failed: ' + safeDetail);
  }
  return {
    stdout: redactSecrets(res.stdout || '', secrets),
    stderr: redactSecrets(res.stderr || '', secrets),
  };
}

export async function isMachOFile(filePath) {
  if (filePath.endsWith('.class')) return false;
  let handle;
  try {
    handle = await open(filePath, 'r');
    const buf = Buffer.alloc(8);
    const { bytesRead } = await handle.read(buf, 0, 8, 0);
    if (bytesRead < 4) return false;
    const magicBE = buf.readUInt32BE(0);
    if (!MACHO_MAGICS.has(magicBE)) return false;
    if (magicBE === 0xcafebabe && bytesRead >= 8) {
      // Universal Mach-O fat headers store nfat_arch (< 64); Java class files store major/minor version (>= 45).
      const count = buf.readUInt32BE(4);
      return count > 0 && count < 40;
    }
    return true;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function discoverMacSignTargets(appPath, { entitlementsDir = resolve('src-tauri/entitlements') } = {}) {
  const absApp = resolve(appPath);
  const contentsDir = join(absApp, 'Contents');
  if (!existsSync(contentsDir)) {
    throw new Error('macOS app bundle Contents directory not found: ' + absApp);
  }

  const appPlist = join(entitlementsDir, 'app.plist');
  const hostNodePlist = join(entitlementsDir, 'host-node.plist');
  const files = [];
  const nestedBundles = [];

  async function walk(dir) {
    const entries = await readdir(dir);
    for (const name of entries) {
      if (name === '_CodeSignature' || name === '.DS_Store') continue;
      const full = join(dir, name);
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        await walk(full);
        if (/\.(?:framework|app|xpc|appex)$/i.test(name)) {
          nestedBundles.push(full);
        }
        continue;
      }
      if (!stat.isFile()) continue;
      const isNativeExt = /\.(?:node|dylib|so)$/i.test(name);
      if (isNativeExt || (await isMachOFile(full))) {
        files.push(full);
      }
    }
  }

  await walk(contentsDir);

  const depthOf = (p) => relative(absApp, p).split('/').length;
  const classify = (filePath) => {
    const rel = relative(absApp, filePath).replaceAll('\\', '/');
    if (rel === 'Contents/Resources/binaries/flycut-node') {
      return { path: filePath, relativePath: rel, role: 'host-node', entitlements: hostNodePlist, requireRuntime: true, orderGroup: 1 };
    }
    if (rel.startsWith('Contents/MacOS/')) {
      return { path: filePath, relativePath: rel, role: 'main-executable', entitlements: appPlist, requireRuntime: true, orderGroup: 3 };
    }
    return { path: filePath, relativePath: rel, role: 'nested-binary', entitlements: null, requireRuntime: true, orderGroup: 1 };
  };

  const fileTargets = files.map(classify).sort((a, b) => {
    if (a.orderGroup !== b.orderGroup) return a.orderGroup - b.orderGroup;
    const dDiff = depthOf(b.path) - depthOf(a.path);
    if (dDiff !== 0) return dDiff;
    return a.relativePath.localeCompare(b.relativePath);
  });

  const nestedBundleTargets = nestedBundles
    .sort((a, b) => depthOf(b) - depthOf(a) || a.localeCompare(b))
    .map((p) => ({
      path: p,
      relativePath: relative(absApp, p).replaceAll('\\', '/'),
      role: 'nested-bundle',
      entitlements: null,
      requireRuntime: false,
      orderGroup: 2,
    }));

  return [
    ...fileTargets.filter((t) => t.orderGroup === 1),
    ...nestedBundleTargets,
    ...fileTargets.filter((t) => t.orderGroup === 3),
    {
      path: absApp,
      relativePath: '.',
      role: 'app-bundle',
      entitlements: appPlist,
      requireRuntime: true,
      orderGroup: 4,
    },
  ];
}

export function parseOtoolSelfId(otoolDOutput) {
  const lines = otoolDOutput.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length >= 2 ? lines[1] : null;
}

export function checkSingleMacBinaryContainment(filePath, { run = defaultSpawn, pathExists = existsSync } = {}) {
  const idRes = run('otool', ['-D', filePath], { encoding: 'utf8' });
  const selfId = idRes.status === 0 ? parseOtoolSelfId(idRes.stdout || '') : null;

  const depRes = run('otool', ['-L', filePath], { encoding: 'utf8' });
  if (depRes.error || depRes.status !== 0) {
    const msg = depRes.error?.message || (depRes.stderr || depRes.stdout || ('exit ' + depRes.status)).trim();
    throw new Error('otool -L failed for ' + filePath + ': ' + msg);
  }
  let filteredOutput = depRes.stdout;
  if (selfId) {
    let removed = false;
    filteredOutput = depRes.stdout
      .split(/\r?\n/)
      .filter((line) => {
        if (!removed && /^\s+\S/.test(line) && line.trim().startsWith(selfId + ' (')) {
          removed = true;
          return false;
        }
        return true;
      })
      .join('\n');
  }
  return findNonDistributableMacDependencies(filteredOutput, pathExists);
}

export function checkMacSelfContainment(appPath, targets, { run = defaultSpawn, pathExists = existsSync, allowDevDylibs = false } = {}) {
  const issues = [];
  const checked = [];
  for (const target of targets) {
    if (target.role === 'app-bundle' || target.role === 'nested-bundle') continue;
    const bad = checkSingleMacBinaryContainment(target.path, { run, pathExists });
    checked.push(target.relativePath);
    if (bad.length > 0) {
      issues.push({ target: target.relativePath, dependencies: bad });
    }
  }
  if (issues.length > 0 && !allowDevDylibs) {
    const detail = issues.map((i) => i.target + ': ' + i.dependencies.join(', ')).join('\n');
    throw new Error('Non-distributable macOS dynamic library dependencies detected:\n' + detail);
  }
  return { checkedCount: checked.length, issues };
}

export function parseSigningIdentity(findIdentityOutput) {
  const matches = [];
  for (const line of findIdentityOutput.split(/\r?\n/)) {
    const match = line.match(/^\s*\d+\)\s+[0-9A-Fa-f]{40}\s+"([^"]+)"/);
    if (match) matches.push(match[1]);
  }
  const devId = matches.find((id) => id.startsWith('Developer ID Application:'));
  if (devId) return devId;
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error('No valid codesigning identity found in temporary keychain');
  }
  throw new Error('Multiple codesigning identities found; set APPLE_SIGNING_IDENTITY explicitly');
}

export async function withTemporaryKeychain({
  certificateBase64,
  certificatePassword,
  signingIdentity = null,
  env = process.env,
  run = defaultSpawn,
}, fn) {
  const baseTmp = env.RUNNER_TEMP || tmpdir();
  const tempDir = await mkdtemp(join(baseTmp, 'flycut-kc-'));
  const p12Path = join(tempDir, 'cert.p12');
  const kcPath = join(tempDir, 'flycut-' + randomUUID() + '.keychain-db');
  const kcPassword = randomUUID() + '-' + randomUUID();
  const secrets = collectSecrets(env, [certificateBase64, certificatePassword, kcPassword]);
  let previousKeychains = [];
  let keychainCreated = false;

  try {
    const p12Bytes = Buffer.from(certificateBase64.trim(), 'base64');
    if (p12Bytes.length < 32) throw new Error('APPLE_CERTIFICATE did not decode to a valid PKCS#12 payload');
    await writeFile(p12Path, p12Bytes, { mode: 0o600 });
    await chmod(p12Path, 0o600);

    const listRes = run('security', ['list-keychains', '-d', 'user'], { encoding: 'utf8' });
    if (listRes.status === 0) {
      previousKeychains = listRes.stdout
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/^"|"$/g, ''))
        .filter(Boolean);
    }

    runChecked('security', ['create-keychain', '-p', kcPassword, kcPath], { run, secrets, label: 'create-keychain' });
    keychainCreated = true;
    runChecked('security', ['set-keychain-settings', '-lut', '21600', kcPath], { run, secrets, label: 'set-keychain-settings' });
    runChecked('security', ['unlock-keychain', '-p', kcPassword, kcPath], { run, secrets, label: 'unlock-keychain' });
    runChecked(
      'security',
      ['import', p12Path, '-k', kcPath, '-P', certificatePassword, '-T', '/usr/bin/codesign', '-T', '/usr/bin/security'],
      { run, secrets, label: 'security import' },
    );
    runChecked(
      'security',
      ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', kcPassword, kcPath],
      { run, secrets, label: 'set-key-partition-list' },
    );
    runChecked(
      'security',
      ['list-keychains', '-d', 'user', '-s', kcPath, ...previousKeychains],
      { run, secrets, label: 'list-keychains' },
    );

    const identityRes = runChecked('security', ['find-identity', '-v', '-p', 'codesigning', kcPath], {
      run,
      secrets,
      label: 'find-identity',
    });
    const identity = signingIdentity?.trim() || parseSigningIdentity(identityRes.stdout);
    return await fn({ keychainPath: kcPath, identity, tempDir, secrets });
  } finally {
    if (previousKeychains.length > 0) {
      run('security', ['list-keychains', '-d', 'user', '-s', ...previousKeychains], { encoding: 'utf8' });
    }
    if (keychainCreated) {
      run('security', ['delete-keychain', kcPath], { encoding: 'utf8' });
    }
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function verifyMacSignatureOutput(codesignDvText, { expectedTeamId = null, requireRuntime = true } = {}) {
  const text = String(codesignDvText || '');
  const lines = text.split(/\r?\n/);
  const getField = (name) => {
    const line = lines.find((l) => l.startsWith(name + '='));
    return line ? line.slice(name.length + 1).trim() : null;
  };
  const authorities = lines.filter((l) => l.startsWith('Authority=')).map((l) => l.slice('Authority='.length).trim());
  const signature = getField('Signature');
  const teamIdentifier = getField('TeamIdentifier');
  const timestamp = getField('Timestamp') || getField('Signed Time');
  const flagsLine = text.match(/flags=0x[0-9a-fA-F]+\(([^)]*)\)/)?.[1] || '';
  const identifier = getField('Identifier');

  if (signature === 'adhoc' || flagsLine.includes('adhoc')) {
    throw new Error('Code signature is adhoc; Developer ID signature required');
  }
  if (requireRuntime && !flagsLine.split(',').includes('runtime')) {
    throw new Error('Hardened Runtime (runtime flag) missing from signature (' + (flagsLine || 'no flags') + ')');
  }
  if (!timestamp || timestamp === 'none') {
    throw new Error('Secure signing timestamp is missing');
  }
  if (!teamIdentifier || teamIdentifier === 'not set') {
    throw new Error('TeamIdentifier is not set on signature');
  }
  if (expectedTeamId && teamIdentifier !== expectedTeamId) {
    throw new Error('TeamIdentifier mismatch: expected ' + expectedTeamId + ', got ' + teamIdentifier);
  }

  return {
    identifier,
    authorities,
    teamIdentifier,
    timestamp,
    flags: flagsLine,
  };
}

export function signAndVerifyMacBundle({
  appPath,
  targets,
  identity,
  keychainPath,
  expectedTeamId = null,
  run = defaultSpawn,
  secrets = [],
  log = console.log,
}) {
  for (const target of targets) {
    const args = ['--force', '--timestamp', '--sign', identity];
    if (keychainPath) args.push('--keychain', keychainPath);
    if (target.requireRuntime) args.push('--options', 'runtime');
    if (target.entitlements) {
      if (!existsSync(target.entitlements)) {
        throw new Error('Missing entitlements plist: ' + target.entitlements);
      }
      args.push('--entitlements', target.entitlements);
    }
    args.push(target.path);
    runChecked('codesign', args, { run, secrets, label: 'codesign ' + target.relativePath });
    log('[sign:macos] signed ' + target.relativePath + ' (role=' + target.role + ')');
  }

  runChecked('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], {
    run,
    secrets,
    label: 'codesign --verify --deep --strict',
  });

  const verifiedTargets = [];
  let inferredTeamId = expectedTeamId;
  for (const target of targets) {
    runChecked('codesign', ['--verify', '--strict', '--verbose=2', target.path], {
      run,
      secrets,
      label: 'codesign --verify ' + target.relativePath,
    });
    const dv = runChecked('codesign', ['-dv', '--verbose=4', target.path], {
      run,
      secrets,
      label: 'codesign -dv ' + target.relativePath,
    });
    const parsed = verifyMacSignatureOutput(dv.stderr + '\n' + dv.stdout, {
      expectedTeamId: inferredTeamId,
      requireRuntime: target.requireRuntime,
    });
    if (!inferredTeamId) inferredTeamId = parsed.teamIdentifier;
    verifiedTargets.push({ relativePath: target.relativePath, role: target.role, ...parsed });
  }

  return {
    teamIdentifier: inferredTeamId,
    verifiedTargets,
  };
}

export async function createAndSignMacDmg({
  appPath,
  dmgPath,
  volumeName = 'FlyCut Caption',
  identity,
  keychainPath,
  expectedTeamId = null,
  run = defaultSpawn,
  secrets = [],
  log = console.log,
}) {
  const staging = await mkdtemp(join(tmpdir(), 'flycut-dmg-'));
  try {
    const appName = basename(appPath);
    const stagedApp = join(staging, appName);
    runChecked('/usr/bin/ditto', [appPath, stagedApp], { run, secrets, label: 'ditto app into dmg staging' });
    await symlink('/Applications', join(staging, 'Applications'));
    await mkdir(dirname(dmgPath), { recursive: true });
    await rm(dmgPath, { force: true });
    runChecked(
      'hdiutil',
      ['create', '-volname', volumeName, '-srcfolder', staging, '-ov', '-format', 'UDZO', dmgPath],
      { run, secrets, label: 'hdiutil create dmg' },
    );
    const signArgs = ['--force', '--timestamp', '--sign', identity];
    if (keychainPath) signArgs.push('--keychain', keychainPath);
    signArgs.push(dmgPath);
    runChecked('codesign', signArgs, { run, secrets, label: 'codesign dmg' });
    runChecked('codesign', ['--verify', '--verbose=2', dmgPath], { run, secrets, label: 'verify dmg' });
    const dv = runChecked('codesign', ['-dv', '--verbose=4', dmgPath], { run, secrets, label: 'codesign -dv dmg' });
    const dmgInfo = verifyMacSignatureOutput(dv.stderr + '\n' + dv.stdout, {
      expectedTeamId,
      requireRuntime: false,
    });
    log('[sign:macos] packaged and signed DMG ' + basename(dmgPath));
    return dmgInfo;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  collectSecrets,
  preflightSigning,
  redactSecrets,
  sha256File,
  writeSha256Sums,
  writeSigningErrorEvidence,
  writeSigningEvidence,
} from './signing/common.mjs';
import {
  checkMacSelfContainment,
  createAndSignMacDmg,
  discoverMacSignTargets,
  signAndVerifyMacBundle,
  withTemporaryKeychain,
} from './signing/macos.mjs';
import { notarizeMacArtifact } from './signing/macos-notarize.mjs';
import {
  discoverWindowsSignTargets,
  findSigntool,
  signWindowsFiles,
  verifyWindowsTargets,
  withTemporaryWindowsCert,
} from './signing/windows.mjs';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = new Set();
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith('--')) {
      opts[key] = next;
      i++;
    } else {
      flags.add(key);
    }
  }
  return { command, opts, flags };
}

function runCommand(cmd, args, { env = process.env, secrets = [] } = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', env });
  if (res.error || res.status !== 0) {
    const msg = res.error?.message || (cmd + ' ' + args.join(' ') + ' exited with status ' + res.status);
    throw new Error(redactSecrets(msg, secrets));
  }
}

async function findFilesRecursive(dir, predicate) {
  if (!existsSync(dir)) return [];
  const found = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && predicate(full, entry.name)) found.push(full);
    }
  }
  await walk(resolve(dir));
  return found.sort();
}

export async function verifyReleaseArtifacts({ artifactsDir }) {
  const rootDir = resolve(artifactsDir);
  const errorFiles = await findFilesRecursive(rootDir, (_p, name) => /^signing-error-.*\.json$/.test(name));
  if (errorFiles.length > 0) {
    throw new Error('Release blocked: signing error evidence present: ' + errorFiles.map((f) => basename(f)).join(', '));
  }

  const requiredPlatforms = ['macos-arm64', 'windows-x86_64'];
  const evidenceFiles = await findFilesRecursive(rootDir, (_p, name) => /^signing-evidence-.*\.json$/.test(name));
  const evidenceByPlatform = new Map();
  for (const file of evidenceFiles) {
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (data.platform) evidenceByPlatform.set(data.platform, data);
  }

  for (const plat of requiredPlatforms) {
    const ev = evidenceByPlatform.get(plat);
    if (!ev) throw new Error('Release blocked: missing signing evidence for ' + plat);
    if (ev.signed !== true || ev.verified !== true) {
      throw new Error('Release blocked: artifact not signed and verified for ' + plat);
    }
    if (plat === 'macos-arm64' && (ev.notarized !== true || ev.stapled !== true)) {
      throw new Error('Release blocked: macOS artifact is not notarized and stapled');
    }
    if (plat === 'windows-x86_64' && ev.timestamped !== true) {
      throw new Error('Release blocked: Windows artifact signature is missing verified timestamp');
    }
  }

  const sumFiles = await findFilesRecursive(rootDir, (_p, name) => /^SHA256SUMS-.*\.txt$/.test(name));
  if (sumFiles.length < 2) {
    throw new Error('Release blocked: expected SHA256SUMS files for all target platforms');
  }

  const allFiles = await findFilesRecursive(rootDir, () => true);
  const byName = new Map();
  for (const f of allFiles) byName.set(basename(f), f);

  let verifiedHashes = 0;
  for (const sumFile of sumFiles) {
    const content = await readFile(sumFile, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = trimmed.match(/^([a-f0-9]{64})\s+(.+)$/);
      if (!match) throw new Error('Malformed SHA256SUMS entry in ' + basename(sumFile) + ': ' + trimmed);
      const [, expectedHash, fileName] = match;
      const candidate = byName.get(basename(fileName));
      if (!candidate) throw new Error('Missing artifact referenced in ' + basename(sumFile) + ': ' + fileName);
      const actualHash = await sha256File(candidate);
      if (actualHash !== expectedHash) {
        throw new Error('SHA-256 mismatch for ' + fileName + ': expected ' + expectedHash + ', got ' + actualHash);
      }
      verifiedHashes++;
    }
  }

  if (verifiedHashes === 0) throw new Error('No release artifact checksums verified');
  return { platforms: requiredPlatforms, verifiedHashes, evidenceByPlatform: Object.fromEntries(evidenceByPlatform) };
}

async function runMacosFlow({ mode, appPath, dmgPath, outputDir, allowDevDylibs, env = process.env }) {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const absApp = resolve(appPath);
  const absDmg = resolve(dmgPath || ('src-tauri/target/release/bundle/dmg/FlyCut Caption_' + pkg.version + '_aarch64.dmg'));
  const outDir = resolve(outputDir || 'release-artifacts/macos-arm64');
  const secrets = collectSecrets(env);
  const stateFile = join(outDir, 'notary-submission.json');
  let stage = 'preflight';

  try {
    const preflight = preflightSigning({ platform: 'macos', mode, env });
    stage = 'discover-and-containment';
    const targets = await discoverMacSignTargets(absApp);
    const containment = checkMacSelfContainment(absApp, targets, { allowDevDylibs: allowDevDylibs && mode === 'candidate-unsigned' });

    if (!preflight.signed) {
      await mkdir(outDir, { recursive: true });
      const candidateDmg = join(outDir, basename(absDmg));
      await createUnsignedDmgFallback(absApp, candidateDmg);
      await writeSha256Sums([candidateDmg], join(outDir, 'SHA256SUMS-macos-arm64.txt'));
      await writeSigningEvidence({
        outputDir: outDir,
        platform: 'macos-arm64',
        evidence: {
          mode,
          version: pkg.version,
          commit: env.GITHUB_SHA || null,
          signed: false,
          verified: false,
          notarized: false,
          stapled: false,
          containmentCheckedCount: containment.checkedCount,
          containmentIssues: containment.issues,
          artifacts: [basename(candidateDmg)],
        },
      });
      console.log('[sign:macos] unsigned candidate packaged (NOT eligible for release)');
      return;
    }

    const expectedTeamId = preflight.platforms.macos.expectedTeamId;
    let signResult;
    let dmgInfo;
    stage = 'codesign';
    await withTemporaryKeychain({
      certificateBase64: env.APPLE_CERTIFICATE,
      certificatePassword: env.APPLE_CERTIFICATE_PASSWORD,
      signingIdentity: env.APPLE_SIGNING_IDENTITY || null,
      env,
    }, async ({ keychainPath, identity, secrets: kcSecrets }) => {
      const allSecrets = [...new Set([...secrets, ...kcSecrets])];
      signResult = signAndVerifyMacBundle({
        appPath: absApp,
        targets,
        identity,
        keychainPath,
        expectedTeamId,
        secrets: allSecrets,
      });
      dmgInfo = await createAndSignMacDmg({
        appPath: absApp,
        dmgPath: absDmg,
        identity,
        keychainPath,
        expectedTeamId: signResult.teamIdentifier,
        secrets: allSecrets,
      });
    });

    stage = 'notarize';
    const notaryResult = await notarizeMacArtifact({
      artifactPath: absDmg,
      appPath: absApp,
      stateFile,
      submissionId: env.FLYCUT_NOTARY_SUBMISSION_ID || null,
      env,
    });

    stage = 'evidence';
    await mkdir(outDir, { recursive: true });
    const finalDmg = join(outDir, basename(absDmg));
    await copyFile(absDmg, finalDmg);
    const checksumLines = await writeSha256Sums([finalDmg], join(outDir, 'SHA256SUMS-macos-arm64.txt'));
    await writeSigningEvidence({
      outputDir: outDir,
      platform: 'macos-arm64',
      evidence: {
        mode,
        version: pkg.version,
        commit: env.GITHUB_SHA || null,
        signed: true,
        verified: true,
        notarized: true,
        stapled: notaryResult.stapled,
        submissionId: notaryResult.submissionId,
        publisher: {
          teamIdentifier: signResult.teamIdentifier,
          authorities: dmgInfo.authorities,
        },
        containmentCheckedCount: containment.checkedCount,
        signedTargetsCount: signResult.verifiedTargets.length,
        staplerOutput: notaryResult.staplerOutput,
        spctlOutput: notaryResult.spctlOutput,
        appSpctlOutput: notaryResult.appSpctlOutput,
        checksums: checksumLines,
      },
      extraSecrets: secrets,
    });
  } catch (error) {
    await writeSigningErrorEvidence({
      outputDir: outDir,
      platform: 'macos-arm64',
      stage,
      error,
      details: {
        mode,
        submissionId: error?.submissionId || null,
      },
      extraSecrets: secrets,
    });
    throw error;
  }
}

async function createUnsignedDmgFallback(appPath, dmgPath) {
  const { mkdtemp, symlink } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const staging = await mkdtemp(join(tmpdir(), 'flycut-unsigned-dmg-'));
  try {
    runCommand('/usr/bin/ditto', [appPath, join(staging, basename(appPath))]);
    await symlink('/Applications', join(staging, 'Applications'));
    await rm(dmgPath, { force: true });
    runCommand('hdiutil', ['create', '-volname', 'FlyCut Caption', '-srcfolder', staging, '-ov', '-format', 'UDZO', dmgPath]);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

async function runWindowsFlow({ mode, outputDir, env = process.env }) {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const outDir = resolve(outputDir || 'release-artifacts/windows-x86_64');
  const secrets = collectSecrets(env);
  let stage = 'preflight';

  try {
    const preflight = preflightSigning({ platform: 'windows', mode, env });
    if (!preflight.signed) {
      stage = 'tauri-build-unsigned';
      runCommand('pnpm', ['exec', 'tauri', 'build', '--no-sign'], { env, secrets });
      const { installers } = await discoverWindowsSignTargets();
      await mkdir(outDir, { recursive: true });
      const copied = [];
      for (const file of installers) {
        const dest = join(outDir, basename(file));
        await copyFile(file, dest);
        copied.push(dest);
      }
      const checksumLines = await writeSha256Sums(copied, join(outDir, 'SHA256SUMS-windows-x86_64.txt'));
      await writeSigningEvidence({
        outputDir: outDir,
        platform: 'windows-x86_64',
        evidence: {
          mode,
          version: pkg.version,
          commit: env.GITHUB_SHA || null,
          signed: false,
          verified: false,
          timestamped: false,
          checksums: checksumLines,
        },
      });
      console.log('[sign:windows] unsigned candidate packaged (NOT eligible for release)');
      return;
    }

    const winCfg = preflight.platforms.windows;
    const signtool = findSigntool({ env });
    await withTemporaryWindowsCert({
      certificateBase64: env.WINDOWS_CERTIFICATE,
      certificatePassword: env.WINDOWS_CERTIFICATE_PASSWORD,
      timestampUrl: winCfg.timestampUrl,
      env,
    }, async ({ thumbprint, subject, issuer, tauriConfigOverridePath, secrets: certSecrets, ps }) => {
      const allSecrets = [...new Set([...secrets, ...certSecrets])];
      stage = 'pre-bundle-sign';
      const { preBundleTargets } = await discoverWindowsSignTargets();
      signWindowsFiles(preBundleTargets, {
        signtool,
        thumbprint,
        timestampUrl: winCfg.timestampUrl,
        secrets: allSecrets,
      });

      stage = 'tauri-build';
      runCommand('pnpm', ['exec', 'tauri', 'build', '--config', tauriConfigOverridePath], { env, secrets: allSecrets });

      stage = 'verify-signatures';
      const { postBundleTargets, installers } = await discoverWindowsSignTargets();
      const allTargets = [...preBundleTargets, ...postBundleTargets];
      const verified = verifyWindowsTargets({
        targets: allTargets,
        signtool,
        expectedPublisher: winCfg.expectedPublisher,
        ps,
        secrets: allSecrets,
      });

      stage = 'evidence';
      await mkdir(outDir, { recursive: true });
      const copied = [];
      for (const file of installers) {
        const dest = join(outDir, basename(file));
        await copyFile(file, dest);
        copied.push(dest);
      }
      const checksumLines = await writeSha256Sums(copied, join(outDir, 'SHA256SUMS-windows-x86_64.txt'));
      await writeSigningEvidence({
        outputDir: outDir,
        platform: 'windows-x86_64',
        evidence: {
          mode,
          version: pkg.version,
          commit: env.GITHUB_SHA || null,
          signed: true,
          verified: true,
          timestamped: true,
          publisher: {
            subject,
            thumbprint,
            issuer,
            expectedPublisher: winCfg.expectedPublisher,
          },
          timestampUrl: winCfg.timestampUrl,
          verifiedTargets: verified,
          checksums: checksumLines,
        },
        extraSecrets: allSecrets,
      });
    });
  } catch (error) {
    await writeSigningErrorEvidence({
      outputDir: outDir,
      platform: 'windows-x86_64',
      stage,
      error,
      details: { mode },
      extraSecrets: secrets,
    });
    throw error;
  }
}

async function main() {
  const { command, opts, flags } = parseArgs(process.argv.slice(2));
  const mode = opts.mode || 'release';

  if (command === 'preflight') {
    const platform = opts.platform || 'all';
    const result = preflightSigning({ platform, mode, env: process.env });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'macos') {
    await runMacosFlow({
      mode,
      appPath: opts.app || 'src-tauri/target/release/bundle/macos/FlyCut Caption.app',
      dmgPath: opts.dmg,
      outputDir: opts['output-dir'],
      allowDevDylibs: flags.has('allow-dev-dylibs'),
    });
    return;
  }

  if (command === 'windows') {
    await runWindowsFlow({
      mode,
      outputDir: opts['output-dir'],
    });
    return;
  }

  if (command === 'verify-release-artifacts') {
    const dir = opts.dir || 'artifacts';
    const summary = await verifyReleaseArtifacts({ artifactsDir: dir });
    console.log('Release artifacts verified: ' + summary.platforms.join(', ') + ' (' + summary.verifiedHashes + ' SHA-256 hashes)');
    return;
  }

  throw new Error('Usage: node scripts/release-signing.mjs <preflight|macos|windows|verify-release-artifacts> [options]');
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch((error) => {
    const secrets = collectSecrets(process.env);
    console.error(redactSecrets(error?.stack || error?.message || String(error), secrets));
    process.exit(1);
  });
}

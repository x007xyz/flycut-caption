import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { collectSecrets, redactSecrets } from './common.mjs';

function defaultRun(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...options });
}

function runChecked(cmd, args, { run = defaultRun, env = process.env, secrets = [], label } = {}) {
  const res = run(cmd, args, { encoding: 'utf8', env });
  if (res.error || res.status !== 0) {
    const raw = res.error?.message || [res.stderr, res.stdout].filter(Boolean).join('\n').trim() || ('exit ' + res.status);
    throw new Error((label || cmd) + ' failed: ' + redactSecrets(raw, secrets));
  }
  return {
    stdout: redactSecrets(res.stdout || '', secrets),
    stderr: redactSecrets(res.stderr || '', secrets),
  };
}

export async function walkMatching(dir, predicate) {
  if (!dir || !existsSync(dir)) return [];
  const out = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile() && predicate(full, entry.name)) {
        out.push(full);
      }
    }
  }
  await visit(resolve(dir));
  return out.sort();
}

export async function discoverWindowsSignTargets({
  binariesDir = 'src-tauri/binaries',
  hostDir = 'src-tauri/host',
  targetExe = 'src-tauri/target/release/flycut-caption.exe',
  bundleDir = 'src-tauri/target/release/bundle',
} = {}) {
  const binaries = await walkMatching(binariesDir, (_p, name) => /\.(?:exe|dll)$/i.test(name));
  const hostNative = await walkMatching(hostDir, (_p, name) => /\.(?:node|dll|exe)$/i.test(name));
  const preBundleTargets = [...binaries, ...hostNative];

  const msiTargets = await walkMatching(join(bundleDir, 'msi'), (_p, name) => /\.msi$/i.test(name));
  const nsisTargets = await walkMatching(join(bundleDir, 'nsis'), (_p, name) => /\.exe$/i.test(name));
  const mainExeTargets = targetExe && existsSync(targetExe) ? [resolve(targetExe)] : [];
  const postBundleTargets = [...mainExeTargets, ...msiTargets, ...nsisTargets];

  return {
    preBundleTargets,
    postBundleTargets,
    installers: [...msiTargets, ...nsisTargets],
  };
}

export function findSigntool({ env = process.env, exists = existsSync, listDir = readdirSync, run = defaultRun } = {}) {
  if (env.SIGNTOOL_PATH && exists(env.SIGNTOOL_PATH)) return env.SIGNTOOL_PATH;
  const whereRes = run('where.exe', ['signtool.exe'], { encoding: 'utf8' });
  if (whereRes.status === 0 && whereRes.stdout?.trim()) {
    const first = whereRes.stdout.trim().split(/\r?\n/)[0].trim();
    if (first && exists(first)) return first;
  }
  const kitsRoots = [
    'C:\\Program Files (x86)\\Windows Kits\\10\\bin',
    'C:\\Program Files\\Windows Kits\\10\\bin',
  ];
  for (const kitsRoot of kitsRoots) {
    if (!exists(kitsRoot)) continue;
    const versions = listDir(kitsRoot).filter((v) => /^10\./.test(v)).sort().reverse();
    for (const ver of versions) {
      for (const arch of ['x64', 'arm64', 'x86']) {
        const candidate = join(kitsRoot, ver, arch, 'signtool.exe');
        if (exists(candidate)) return candidate;
      }
    }
  }
  throw new Error('signtool.exe not found in PATH or Windows Kits 10 bin directory');
}

export function resolvePowershell({ run = defaultRun } = {}) {
  for (const candidate of ['pwsh.exe', 'powershell.exe', 'pwsh']) {
    const probe = run(candidate, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return 'powershell.exe';
}

export async function withTemporaryWindowsCert({
  certificateBase64,
  certificatePassword,
  timestampUrl = 'http://timestamp.digicert.com',
  env = process.env,
  run = defaultRun,
}, fn) {
  const baseTmp = env.RUNNER_TEMP || tmpdir();
  const tempDir = await mkdtemp(join(baseTmp, 'flycut-win-cert-'));
  const pfxPath = join(tempDir, 'codesign.pfx');
  const tauriConfigOverridePath = join(tempDir, 'tauri.windows.sign.json');
  const secrets = collectSecrets(env, [certificateBase64, certificatePassword]);
  const ps = resolvePowershell({ run });
  let thumbprint = null;

  try {
    const pfxBytes = Buffer.from(certificateBase64.trim(), 'base64');
    if (pfxBytes.length < 32) throw new Error('WINDOWS_CERTIFICATE did not decode to a valid PFX payload');
    await writeFile(pfxPath, pfxBytes, { mode: 0o600 });

    const importScript = [
      "$ErrorActionPreference = 'Stop';",
      '$sec = ConvertTo-SecureString -String $env:FLYCUT_WIN_PFX_PASSWORD -AsPlainText -Force;',
      "$cert = Import-PfxCertificate -FilePath $env:FLYCUT_WIN_PFX_PATH -CertStoreLocation 'Cert:\\CurrentUser\\My' -Password $sec;",
      '$cert | Select-Object Thumbprint, Subject, Issuer, @{N="NotAfter";E={$_.NotAfter.ToString("o")}} | ConvertTo-Json -Compress;',
    ].join(' ');

    const childEnv = {
      ...env,
      FLYCUT_WIN_PFX_PASSWORD: certificatePassword,
      FLYCUT_WIN_PFX_PATH: pfxPath,
    };
    const imported = runChecked(ps, ['-NoProfile', '-NonInteractive', '-Command', importScript], {
      run,
      env: childEnv,
      secrets,
      label: 'Import-PfxCertificate',
    });
    const certInfo = JSON.parse(imported.stdout.trim());
    if (!certInfo?.Thumbprint) throw new Error('Imported Windows certificate did not yield a Thumbprint');
    thumbprint = String(certInfo.Thumbprint).trim();

    await writeFile(
      tauriConfigOverridePath,
      JSON.stringify({
        bundle: {
          windows: {
            certificateThumbprint: thumbprint,
            digestAlgorithm: 'sha256',
            timestampUrl,
            tsp: true,
          },
        },
      }, null, 2) + '\n',
      'utf8',
    );

    return await fn({
      thumbprint,
      subject: certInfo.Subject || null,
      issuer: certInfo.Issuer || null,
      notAfter: certInfo.NotAfter || null,
      timestampUrl,
      tauriConfigOverridePath,
      secrets,
      ps,
    });
  } finally {
    if (thumbprint) {
      run(ps, ['-NoProfile', '-NonInteractive', '-Command', "Remove-Item -Path ('Cert:\\CurrentUser\\My\\' + $env:FLYCUT_WIN_CERT_THUMBPRINT) -Force -ErrorAction SilentlyContinue"], {
        encoding: 'utf8',
        env: { ...env, FLYCUT_WIN_CERT_THUMBPRINT: thumbprint },
      });
    }
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function signWindowsFiles(files, {
  signtool,
  thumbprint,
  timestampUrl = 'http://timestamp.digicert.com',
  run = defaultRun,
  secrets = [],
  log = console.log,
}) {
  for (const filePath of files) {
    runChecked(
      signtool,
      ['sign', '/sha1', thumbprint, '/fd', 'SHA256', '/tr', timestampUrl, '/td', 'SHA256', filePath],
      { run, secrets, label: 'signtool sign ' + basename(filePath) },
    );
    log('[sign:windows] signed ' + basename(filePath));
  }
}

export function verifyWindowsSignatureResult(result, { filePath = '', expectedPublisher = null } = {}) {
  if (!result || result.Status !== 'Valid') {
    throw new Error(
      'Windows Authenticode verification failed for ' + (filePath || 'artifact') +
      ': status=' + (result?.Status || 'Unknown') + ' (' + (result?.StatusMessage || 'no detail') + ')',
    );
  }
  if (!result.TimeStamperSubject) {
    throw new Error('Windows signature missing RFC 3161 timestamp for ' + (filePath || 'artifact'));
  }
  if (!result.SignerSubject) {
    throw new Error('Windows signature missing SignerSubject for ' + (filePath || 'artifact'));
  }
  if (expectedPublisher && !result.SignerSubject.includes(expectedPublisher)) {
    throw new Error(
      'Windows publisher mismatch for ' + (filePath || 'artifact') +
      ': expected "' + expectedPublisher + '", got "' + result.SignerSubject + '"',
    );
  }
  return {
    file: basename(filePath) || filePath,
    status: result.Status,
    signerSubject: result.SignerSubject,
    signerThumbprint: result.SignerThumbprint || null,
    signerIssuer: result.SignerIssuer || null,
    timeStamperSubject: result.TimeStamperSubject,
    timeStamperNotAfter: result.TimeStamperNotAfter || null,
  };
}

export function verifyWindowsTargets({
  targets,
  signtool,
  expectedPublisher = null,
  ps = 'powershell.exe',
  run = defaultRun,
  secrets = [],
  log = console.log,
}) {
  if (!targets || targets.length === 0) {
    throw new Error('No Windows binaries or installers found to verify');
  }
  const verified = [];
  for (const filePath of targets) {
    runChecked(signtool, ['verify', '/pa', '/v', filePath], {
      run,
      secrets,
      label: 'signtool verify ' + basename(filePath),
    });
    const query = [
      "$ErrorActionPreference = 'Stop';",
      '$sig = Get-AuthenticodeSignature -LiteralPath $env:FLYCUT_VERIFY_TARGET;',
      '$sig | Select-Object @{N="Status";E={$_.Status.ToString()}}, StatusMessage, @{N="SignerSubject";E={$_.SignerCertificate.Subject}}, @{N="SignerThumbprint";E={$_.SignerCertificate.Thumbprint}}, @{N="SignerIssuer";E={$_.SignerCertificate.Issuer}}, @{N="TimeStamperSubject";E={$_.TimeStamperCertificate.Subject}}, @{N="TimeStamperNotAfter";E={if ($_.TimeStamperCertificate) { $_.TimeStamperCertificate.NotAfter.ToString("o") } else { $null }}} | ConvertTo-Json -Compress;',
    ].join(' ');
    const psRes = runChecked(ps, ['-NoProfile', '-NonInteractive', '-Command', query], {
      run,
      env: { ...process.env, FLYCUT_VERIFY_TARGET: filePath },
      secrets,
      label: 'Get-AuthenticodeSignature ' + basename(filePath),
    });
    const parsed = JSON.parse(psRes.stdout.trim());
    const checked = verifyWindowsSignatureResult(parsed, { filePath, expectedPublisher });
    log('[verify:windows] verified ' + basename(filePath) + ' signer=' + checked.signerSubject);
    verified.push(checked);
  }
  return verified;
}

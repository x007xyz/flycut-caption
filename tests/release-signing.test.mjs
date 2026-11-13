import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  preflightSigning,
  redactSecrets,
  sha256File,
  writeSha256Sums,
  writeSigningErrorEvidence,
  writeSigningEvidence,
} from '../scripts/signing/common.mjs';
import {
  checkMacSelfContainment,
  checkSingleMacBinaryContainment,
  discoverMacSignTargets,
  verifyMacSignatureOutput,
  withTemporaryKeychain,
} from '../scripts/signing/macos.mjs';
import { notarizeMacArtifact } from '../scripts/signing/macos-notarize.mjs';
import {
  discoverWindowsSignTargets,
  verifyWindowsSignatureResult,
  withTemporaryWindowsCert,
} from '../scripts/signing/windows.mjs';
import { verifyReleaseArtifacts } from '../scripts/release-signing.mjs';
import { validateReleasePipelineConfig } from '../scripts/release.mjs';

describe('F-0057 desktop signing, notarization, and release gate', () => {
  it('F-0057/AC-1 macOS entitlements restrict JIT strictly to host flycut-node', async () => {
    const appPlist = await readFile('src-tauri/entitlements/app.plist', 'utf8');
    const nodePlist = await readFile('src-tauri/entitlements/host-node.plist', 'utf8');
    assert.equal(appPlist.includes('com.apple.security.cs.allow-jit'), false);
    assert.equal(appPlist.includes('com.apple.security.cs.disable-library-validation'), false);
    assert.equal(nodePlist.includes('com.apple.security.cs.allow-jit'), true);
    assert.equal(nodePlist.includes('com.apple.security.cs.allow-unsigned-executable-memory'), true);
    if (process.platform === 'darwin') {
      execFileSync('plutil', ['-lint', 'src-tauri/entitlements/app.plist', 'src-tauri/entitlements/host-node.plist']);
    }
  });

  it('F-0057/AC-1 discoverMacSignTargets orders nested Mach-O, flycut-node, sidecar, ffmpeg, and .node inside-out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flycut-f0057-mac-'));
    try {
      const app = join(dir, 'FlyCut Caption.app');
      const macos = join(app, 'Contents/MacOS');
      const binaries = join(app, 'Contents/Resources/binaries');
      const skiaDir = join(app, 'Contents/Resources/host/node_modules/@napi-rs/canvas-darwin-arm64');
      await mkdir(macos, { recursive: true });
      await mkdir(binaries, { recursive: true });
      await mkdir(skiaDir, { recursive: true });

      const macho64 = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x00, 0x00, 0x00, 0x00]);
      await writeFile(join(macos, 'flycut-caption'), macho64);
      await writeFile(join(binaries, 'flycut-node'), macho64);
      await writeFile(join(binaries, 'funasr-asr'), macho64);
      await writeFile(join(binaries, 'ffmpeg'), macho64);
      await writeFile(join(skiaDir, 'skia.darwin-arm64.node'), macho64);
      await writeFile(join(app, 'Contents/Resources/models.json'), '{}');

      const targets = await discoverMacSignTargets(app, { entitlementsDir: resolve('src-tauri/entitlements') });
      const rels = targets.map((t) => t.relativePath);
      assert.ok(rels.includes('Contents/Resources/host/node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node'));
      assert.ok(rels.includes('Contents/Resources/binaries/flycut-node'));
      assert.ok(rels.includes('Contents/Resources/binaries/funasr-asr'));
      assert.ok(rels.includes('Contents/Resources/binaries/ffmpeg'));
      assert.ok(!rels.includes('Contents/Resources/models.json'));

      const idxSkia = rels.indexOf('Contents/Resources/host/node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node');
      const idxNode = rels.indexOf('Contents/Resources/binaries/flycut-node');
      const idxMain = rels.indexOf('Contents/MacOS/flycut-caption');
      const idxApp = rels.indexOf('.');
      assert.ok(idxSkia < idxMain && idxNode < idxMain && idxMain < idxApp);

      const byRel = Object.fromEntries(targets.map((t) => [t.relativePath, t]));
      assert.equal(byRel['Contents/Resources/binaries/flycut-node'].entitlements, resolve('src-tauri/entitlements/host-node.plist'));
      assert.equal(byRel['Contents/Resources/binaries/funasr-asr'].entitlements, null);
      assert.equal(byRel['Contents/Resources/binaries/ffmpeg'].entitlements, null);
      assert.equal(byRel['Contents/MacOS/flycut-caption'].entitlements, resolve('src-tauri/entitlements/app.plist'));
      assert.equal(byRel['.'].entitlements, resolve('src-tauri/entitlements/app.plist'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('F-0057/AC-1 checkMacSelfContainment inspects real local funasr-asr & skia.node and rejects Homebrew dylibs', () => {
    if (process.platform === 'darwin') {
      if (existsSync('src-tauri/binaries/funasr-asr')) {
        assert.deepEqual(checkSingleMacBinaryContainment('src-tauri/binaries/funasr-asr'), []);
      }
      const skiaNode = 'node_modules/.pnpm/@napi-rs+canvas-darwin-arm64@1.1.0/node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node';
      if (existsSync(skiaNode)) {
        // skia.darwin-arm64.node carries its CI build LC_ID_DYLIB; otool -D excludes self-id while keeping real deps.
        assert.deepEqual(checkSingleMacBinaryContainment(skiaNode), []);
      }
    }
    const fakeRun = (_cmd, args) => args[0] === '-D'
      ? { status: 0, stdout: '/app/ffmpeg:\n', stderr: '' }
      : { status: 0, stdout: '/app/ffmpeg:\n\t/opt/homebrew/opt/x264/lib/libx264.dylib (compatibility version 0.0.0)\n', stderr: '' };
    assert.throws(
      () => checkMacSelfContainment('/app', [{ path: '/app/ffmpeg', relativePath: 'Contents/Resources/binaries/ffmpeg', role: 'nested-binary' }], {
        run: fakeRun,
        pathExists: () => true,
      }),
      /Non-distributable macOS dynamic library dependencies detected[\s\S]*\/opt\/homebrew\/opt\/x264/, 
    );
  });

  it('F-0057/AC-1 AC-8 verifyMacSignatureOutput rejects adhoc, missing runtime, missing timestamp, and wrong team', () => {
    const valid = [
      'Identifier=com.flycut.caption',
      'Format=app bundle with Mach-O thin (arm64)',
      'CodeDirectory v=20500 size=1000 flags=0x10000(runtime) hashes=20+7 location=embedded',
      'Authority=Developer ID Application: FlyCut Team (TEAM123456)',
      'Timestamp=Nov 13, 2026 at 10:00:00 AM',
      'TeamIdentifier=TEAM123456',
    ].join('\n');
    const ok = verifyMacSignatureOutput(valid, { expectedTeamId: 'TEAM123456' });
    assert.equal(ok.teamIdentifier, 'TEAM123456');

    assert.throws(() => verifyMacSignatureOutput(valid.replace('flags=0x10000(runtime)', 'flags=0x20002(adhoc)').concat('\nSignature=adhoc')), /adhoc/);
    assert.throws(() => verifyMacSignatureOutput(valid.replace('flags=0x10000(runtime)', 'flags=0x0(none)')), /Hardened Runtime/);
    assert.throws(() => verifyMacSignatureOutput(valid.replace('Timestamp=Nov 13, 2026 at 10:00:00 AM\n', '')), /timestamp/i);
    assert.throws(() => verifyMacSignatureOutput(valid, { expectedTeamId: 'OTHERTEAM99' }), /TeamIdentifier mismatch/);
  });

  it('F-0057/AC-2 AC-7 AC-8 discoverWindowsSignTargets and verifyWindowsSignatureResult enforce timestamp and publisher', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flycut-f0057-win-'));
    try {
      const bins = join(dir, 'binaries');
      const host = join(dir, 'host/node_modules/@napi-rs/canvas-win32-x64-msvc');
      const msi = join(dir, 'bundle/msi');
      const nsis = join(dir, 'bundle/nsis');
      const targetExe = join(dir, 'flycut-caption.exe');
      await mkdir(bins, { recursive: true });
      await mkdir(host, { recursive: true });
      await mkdir(msi, { recursive: true });
      await mkdir(nsis, { recursive: true });
      await writeFile(join(bins, 'flycut-node.exe'), 'pe');
      await writeFile(join(bins, 'funasr-asr.exe'), 'pe');
      await writeFile(join(bins, 'ffmpeg.exe'), 'pe');
      await writeFile(join(host, 'skia.win32-x64-msvc.node'), 'pe');
      await writeFile(targetExe, 'pe');
      await writeFile(join(msi, 'FlyCut Caption_2.0.2_x64_en-US.msi'), 'msi');
      await writeFile(join(nsis, 'FlyCut Caption_2.0.2_x64-setup.exe'), 'nsis');

      const targets = await discoverWindowsSignTargets({
        binariesDir: bins,
        hostDir: join(dir, 'host'),
        targetExe,
        bundleDir: join(dir, 'bundle'),
      });
      assert.equal(targets.preBundleTargets.length, 4);
      assert.equal(targets.postBundleTargets.length, 3);
      assert.equal(targets.installers.length, 2);

      const validWin = {
        Status: 'Valid',
        StatusMessage: 'Signature verified.',
        SignerSubject: 'CN=FlyCut Studio Inc., O=FlyCut Studio Inc., C=US',
        SignerThumbprint: 'ABCDEF0123456789',
        TimeStamperSubject: 'CN=DigiCert Timestamp 2026',
      };
      const parsed = verifyWindowsSignatureResult(validWin, { filePath: 'setup.exe', expectedPublisher: 'FlyCut Studio Inc.' });
      assert.equal(parsed.status, 'Valid');

      assert.throws(() => verifyWindowsSignatureResult({ ...validWin, Status: 'NotSigned' }, { filePath: 'setup.exe' }), /Authenticode verification failed/);
      assert.throws(() => verifyWindowsSignatureResult({ ...validWin, TimeStamperSubject: null }, { filePath: 'setup.exe' }), /missing RFC 3161 timestamp/);
      assert.throws(() => verifyWindowsSignatureResult(validWin, { filePath: 'setup.exe', expectedPublisher: 'Other Corp' }), /publisher mismatch/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('F-0057/AC-3 AC-5 AC-8 preflightSigning fails closed on missing secrets and redactSecrets scrubs all credentials', async () => {
    assert.throws(
      () => preflightSigning({ platform: 'all', mode: 'release', env: {} }),
      (err) => err.code === 'MISSING_SIGNING_CREDENTIALS'
        && err.message.includes('APPLE_CERTIFICATE')
        && err.message.includes('WINDOWS_CERTIFICATE'),
    );

    const secretVal = 'super-secret-cert-password-1234';
    const rawLog = [
      'import -P ' + secretVal,
      'Authorization: Bearer tok_live_987654321',
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC\n-----END PRIVATE KEY-----',
    ].join('\n');
    const clean = redactSecrets(rawLog, [secretVal]);
    assert.equal(clean.includes(secretVal), false);
    assert.equal(clean.includes('tok_live_987654321'), false);
    assert.equal(clean.includes('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC'), false);

    const outDir = await mkdtemp(join(tmpdir(), 'flycut-f0057-err-'));
    try {
      const { filePath, payload } = await writeSigningErrorEvidence({
        outputDir: outDir,
        platform: 'macos-arm64',
        stage: 'codesign',
        error: new Error('failed with ' + secretVal),
        extraSecrets: [secretVal],
      });
      assert.equal(payload.signed, false);
      assert.equal(payload.releaseAuthorized, false);
      assert.equal(payload.error.includes(secretVal), false);
      assert.equal((await readFile(filePath, 'utf8')).includes(secretVal), false);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it('F-0057/AC-3 AC-8 temporary keychain and Windows cert store always clean up after failure', async () => {
    const kcCalls = [];
    const fakeMacRun = (_cmd, args) => {
      kcCalls.push(args);
      if (args[0] === 'list-keychains' && args[1] === '-d' && args[2] === 'user' && args.length === 3) {
        return { status: 0, stdout: '"/Users/test/Library/Keychains/login.keychain-db"\n', stderr: '' };
      }
      if (args[0] === 'find-identity') {
        return { status: 0, stdout: '1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "Developer ID Application: FlyCut (TEAM123)"\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    let capturedKcDir = '';
    await assert.rejects(
      withTemporaryKeychain({
        certificateBase64: Buffer.from('fake-pkcs12-payload-00000000000000000000').toString('base64'),
        certificatePassword: 'p12-password-secret',
        run: fakeMacRun,
      }, ({ tempDir }) => {
        capturedKcDir = tempDir;
        throw new Error('simulated codesign error');
      }),
      /simulated codesign error/,
    );
    assert.equal(existsSync(capturedKcDir), false);
    assert.ok(kcCalls.some((a) => a[0] === 'delete-keychain'));
    assert.ok(kcCalls.some((a) => a[0] === 'list-keychains' && a[3] === '-s' && a[4] === '/Users/test/Library/Keychains/login.keychain-db'));

    const winCalls = [];
    const fakeWinRun = (cmd, args) => {
      winCalls.push({ cmd, args });
      if (args.includes('$PSVersionTable.PSVersion.Major')) return { status: 0, stdout: '7\n', stderr: '' };
      if (args.some((a) => String(a).includes('Import-PfxCertificate'))) {
        return { status: 0, stdout: JSON.stringify({ Thumbprint: 'DEAD1234', Subject: 'CN=FlyCut', Issuer: 'CN=CA', NotAfter: '2027-01-01T00:00:00Z' }), stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    let capturedOverride = '';
    await assert.rejects(
      withTemporaryWindowsCert({
        certificateBase64: Buffer.from('fake-pfx-payload-0000000000000000000000').toString('base64'),
        certificatePassword: 'pfx-password-secret',
        run: fakeWinRun,
      }, ({ tauriConfigOverridePath }) => {
        capturedOverride = tauriConfigOverridePath;
        throw new Error('simulated windows sign failure');
      }),
      /simulated windows sign failure/,
    );
    assert.equal(existsSync(capturedOverride), false);
    assert.ok(winCalls.some((c) => c.args.some((a) => String(a).includes('Remove-Item'))));
  });

  it('F-0057/AC-6 notarizeMacArtifact preserves submissionId on timeout and queries info before submit on retry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flycut-f0057-notary-'));
    const dmgPath = join(dir, 'FlyCut.dmg');
    const stateFile = join(dir, 'notary-submission.json');
    await writeFile(dmgPath, 'dmg-bytes');
    const env = { APPLE_API_KEY: '-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----', APPLE_API_KEY_ID: 'KEY1234567', APPLE_API_ISSUER: 'ISSUER-UUID' };

    try {
      // 1) Timeout path preserves submissionId without claiming completion
      const calls1 = [];
      const timeoutRun = (cmd, args) => {
        calls1.push([cmd, ...args]);
        if (args[1] === 'submit') return { status: 0, stdout: JSON.stringify({ id: 'sub-uuid-111', status: 'In Progress' }), stderr: '' };
        if (args[1] === 'info') return { status: 0, stdout: JSON.stringify({ id: 'sub-uuid-111', status: 'In Progress' }), stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      };
      await assert.rejects(
        notarizeMacArtifact({
          artifactPath: dmgPath,
          stateFile,
          env,
          run: timeoutRun,
          sleep: async () => {},
          timeoutMs: -1,
          pollIntervalMs: 0,
        }),
        (err) => err.code === 'NOTARIZATION_TIMEOUT' && err.submissionId === 'sub-uuid-111',
      );
      const saved = JSON.parse(await readFile(stateFile, 'utf8'));
      assert.equal(saved.submissionId, 'sub-uuid-111');
      assert.equal(saved.status, 'TimedOut');

      // 2) Retry queries info FIRST and never calls submit again when already Accepted
      const calls2 = [];
      const retryRun = (cmd, args) => {
        calls2.push([cmd, ...args]);
        if (args[1] === 'info') return { status: 0, stdout: JSON.stringify({ id: 'sub-uuid-111', status: 'Accepted' }), stderr: '' };
        if (cmd === 'xcrun' && args[0] === 'stapler') return { status: 0, stdout: 'The validate action worked!', stderr: '' };
        if (cmd === 'spctl') return { status: 0, stdout: '', stderr: 'accepted' };
        throw new Error('Unexpected call: ' + cmd + ' ' + args.join(' '));
      };
      const result = await notarizeMacArtifact({ artifactPath: dmgPath, stateFile, env, run: retryRun, sleep: async () => {} });
      assert.equal(result.submissionId, 'sub-uuid-111');
      assert.equal(result.stapled, true);
      assert.equal(calls2.some((c) => c[2] === 'submit'), false);
      assert.equal(calls2[0][2], 'info');

      // 3) Invalid rejection fetches notary log and fails closed without re-submitting
      const calls3 = [];
      const rejectRun = (cmd, args) => {
        calls3.push([cmd, ...args]);
        if (args[1] === 'info') return { status: 0, stdout: JSON.stringify({ id: 'sub-uuid-111', status: 'Invalid' }), stderr: '' };
        if (args[1] === 'log') return { status: 0, stdout: JSON.stringify({ issues: [{ message: 'binary not signed with Developer ID' }] }), stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      };
      await assert.rejects(
        notarizeMacArtifact({ artifactPath: dmgPath, submissionId: 'sub-uuid-111', env, run: rejectRun, sleep: async () => {} }),
        (err) => err.code === 'NOTARIZATION_REJECTED' && err.notaryLog.includes('binary not signed'),
      );
      assert.equal(calls3.some((c) => c[2] === 'submit'), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('F-0057/AC-7 AC-8 verifyReleaseArtifacts checks evidence, hashes, and blocks unsigned/error artifacts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flycut-f0057-rel-'));
    try {
      const macDir = join(dir, 'macos');
      const winDir = join(dir, 'windows');
      await mkdir(macDir, { recursive: true });
      await mkdir(winDir, { recursive: true });
      const dmg = join(macDir, 'FlyCut.dmg');
      const msi = join(winDir, 'FlyCut.msi');
      await writeFile(dmg, 'mac-installer-bytes');
      await writeFile(msi, 'win-installer-bytes');
      await writeSha256Sums([dmg], join(macDir, 'SHA256SUMS-macos-arm64.txt'));
      await writeSha256Sums([msi], join(winDir, 'SHA256SUMS-windows-x86_64.txt'));
      await writeSigningEvidence({ outputDir: macDir, platform: 'macos-arm64', evidence: { signed: true, verified: true, notarized: true, stapled: true } });
      await writeSigningEvidence({ outputDir: winDir, platform: 'windows-x86_64', evidence: { signed: true, verified: true, timestamped: true } });

      const ok = await verifyReleaseArtifacts({ artifactsDir: dir });
      assert.equal(ok.verifiedHashes, 2);
      assert.equal(ok.evidenceByPlatform['macos-arm64'].releaseAuthorized, false);

      // Tampering a binary fails SHA-256 verification
      await writeFile(dmg, 'tampered');
      await assert.rejects(() => verifyReleaseArtifacts({ artifactsDir: dir }), /SHA-256 mismatch/);
      await writeFile(dmg, 'mac-installer-bytes');

      // Missing Windows timestamp fails
      await writeSigningEvidence({ outputDir: winDir, platform: 'windows-x86_64', evidence: { signed: true, verified: true, timestamped: false } });
      await assert.rejects(() => verifyReleaseArtifacts({ artifactsDir: dir }), /missing verified timestamp/);
      await writeSigningEvidence({ outputDir: winDir, platform: 'windows-x86_64', evidence: { signed: true, verified: true, timestamped: true } });

      // Signing error file blocks release
      await writeSigningErrorEvidence({ outputDir: macDir, platform: 'macos-arm64', stage: 'notarize', error: 'rejected' });
      await assert.rejects(() => verifyReleaseArtifacts({ artifactsDir: dir }), /signing error evidence present/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('F-0057/AC-3 AC-4 release pipeline config and runbook prohibit OS security bypass and fake SmartScreen promises', async () => {
    const info = validateReleasePipelineConfig();
    assert.equal(info.macEntitlements, 'entitlements/app.plist');
    assert.equal(info.windowsDigest, 'sha256');
    const workflow = await readFile('.github/workflows/release.yml', 'utf8');
    assert.ok(workflow.includes("if: startsWith(github.ref, 'refs/tags/v') && needs.preflight.outputs.mode == 'release'"));
    assert.ok(workflow.includes('allow_unsigned_candidate'));
    const runbook = await readFile('docs/40-ops/runbooks/desktop-signing-notarization.md', 'utf8');
    assert.ok(runbook.includes('禁止在用户文档或故障指引中添加关闭 Gatekeeper'));
    assert.ok(runbook.includes('不承诺安装后 SmartScreen 提示立即消失'));
  });
});

import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { collectSecrets, redactSecrets, redactValue, sha256File } from './common.mjs';
import { defaultSpawn, runChecked } from './macos.mjs';

export function parseNotaryJson(stdout, label = 'notarytool') {
  const raw = String(stdout || '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        // fall through
      }
    }
    throw new Error('Failed to parse JSON from ' + label + ': ' + raw.slice(0, 300));
  }
}

export async function withNotaryAuth(env = process.env, fn) {
  const hasApiKey = Boolean(env.APPLE_API_KEY?.trim() && env.APPLE_API_KEY_ID?.trim() && env.APPLE_API_ISSUER?.trim());
  const hasAppleId = Boolean(env.APPLE_ID?.trim() && env.APPLE_PASSWORD?.trim() && env.APPLE_TEAM_ID?.trim());
  const secrets = collectSecrets(env);

  if (hasApiKey) {
    const baseTmp = env.RUNNER_TEMP || tmpdir();
    const dir = await mkdtemp(join(baseTmp, 'flycut-notary-key-'));
    const keyId = env.APPLE_API_KEY_ID.trim();
    const keyPath = join(dir, 'AuthKey_' + keyId + '.p8');
    try {
      const rawKey = env.APPLE_API_KEY.trim();
      const keyText = rawKey.includes('BEGIN PRIVATE KEY')
        ? rawKey + '\n'
        : Buffer.from(rawKey, 'base64').toString('utf8');
      await writeFile(keyPath, keyText, { mode: 0o600 });
      await chmod(keyPath, 0o600);
      return await fn({
        mode: 'api-key',
        authArgs: ['--key', keyPath, '--key-id', keyId, '--issuer', env.APPLE_API_ISSUER.trim()],
        secrets,
      });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  if (hasAppleId) {
    return await fn({
      mode: 'apple-id',
      authArgs: [
        '--apple-id', env.APPLE_ID.trim(),
        '--password', env.APPLE_PASSWORD.trim(),
        '--team-id', env.APPLE_TEAM_ID.trim(),
      ],
      secrets,
    });
  }

  throw new Error('Missing Apple notarization credentials (APPLE_API_KEY/KEY_ID/ISSUER or APPLE_ID/PASSWORD/TEAM_ID)');
}

export async function readNotaryState(stateFile) {
  if (!stateFile || !existsSync(stateFile)) return null;
  try {
    return JSON.parse(await readFile(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

export async function writeNotaryState(stateFile, state, secrets = []) {
  if (!stateFile) return;
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify(redactValue(state, secrets), null, 2) + '\n', 'utf8');
}

export async function resolveExistingSubmission({ submissionId, stateFile, artifactSha256 }) {
  if (submissionId && String(submissionId).trim()) {
    return { id: String(submissionId).trim(), source: 'explicit' };
  }
  const saved = await readNotaryState(stateFile);
  if (saved?.submissionId && (!artifactSha256 || !saved.artifactSha256 || saved.artifactSha256 === artifactSha256)) {
    return { id: String(saved.submissionId).trim(), source: 'state-file' };
  }
  return null;
}

function fetchNotaryLog(id, authArgs, { run, secrets }) {
  const res = run('xcrun', ['notarytool', 'log', id, ...authArgs], { encoding: 'utf8' });
  const text = [res.stdout, res.stderr].filter(Boolean).join('\n').trim();
  return redactSecrets(text || ('notarytool log unavailable (exit ' + res.status + ')'), secrets);
}

export async function notarizeMacArtifact({
  artifactPath,
  appPath = null,
  stateFile = null,
  submissionId = null,
  env = process.env,
  run = defaultSpawn,
  sleep = delay,
  timeoutMs = 30 * 60_000,
  pollIntervalMs = 15_000,
  computeSha256 = sha256File,
  log = console.log,
}) {
  return await withNotaryAuth(env, async ({ mode, authArgs, secrets }) => {
    const artifactSha256 = await computeSha256(artifactPath);
    const artifactName = basename(artifactPath);
    const existing = await resolveExistingSubmission({
      submissionId: submissionId || env.FLYCUT_NOTARY_SUBMISSION_ID,
      stateFile,
      artifactSha256,
    });

    let currentId = existing?.id || null;
    let status = null;
    let submittedAt = new Date().toISOString();

    const queryInfo = (id) => {
      const res = runChecked(
        'xcrun',
        ['notarytool', 'info', id, ...authArgs, '--output-format', 'json'],
        { run, secrets, label: 'notarytool info' },
      );
      return parseNotaryJson(res.stdout, 'notarytool info');
    };

    if (currentId) {
      log('[notary:macos] found existing submissionId=' + currentId + ' (' + existing.source + '), checking status before submit');
      const info = queryInfo(currentId);
      status = info.status || 'Unknown';
      log('[notary:macos] submissionId=' + currentId + ' status=' + status);
    } else {
      const submitRes = runChecked(
        'xcrun',
        ['notarytool', 'submit', artifactPath, ...authArgs, '--no-wait', '--output-format', 'json'],
        { run, secrets, label: 'notarytool submit' },
      );
      const parsed = parseNotaryJson(submitRes.stdout, 'notarytool submit');
      if (!parsed?.id) {
        throw new Error('notarytool submit did not return a submission id');
      }
      currentId = String(parsed.id);
      status = parsed.status || 'In Progress';
      submittedAt = new Date().toISOString();
      log('[notary:macos] submitted ' + artifactName + ' (auth=' + mode + ') submissionId=' + currentId + ' status=' + status);
    }

    await writeNotaryState(stateFile, {
      submissionId: currentId,
      artifactName,
      artifactSha256,
      status,
      submittedAt,
      updatedAt: new Date().toISOString(),
    }, secrets);

    const deadline = Date.now() + timeoutMs;
    while (status !== 'Accepted') {
      if (status === 'Invalid' || status === 'Rejected') {
        const notaryLog = fetchNotaryLog(currentId, authArgs, { run, secrets });
        await writeNotaryState(stateFile, {
          submissionId: currentId,
          artifactName,
          artifactSha256,
          status,
          submittedAt,
          updatedAt: new Date().toISOString(),
          notaryLog,
        }, secrets);
        const err = new Error(
          'Apple notarization ' + status + ' for submissionId=' + currentId + '\n' + notaryLog,
        );
        err.code = 'NOTARIZATION_REJECTED';
        err.submissionId = currentId;
        err.notaryStatus = status;
        err.notaryLog = notaryLog;
        throw err;
      }

      if (Date.now() >= deadline) {
        await writeNotaryState(stateFile, {
          submissionId: currentId,
          artifactName,
          artifactSha256,
          status: 'TimedOut',
          lastKnownStatus: status,
          submittedAt,
          updatedAt: new Date().toISOString(),
        }, secrets);
        const err = new Error(
          'Apple notarization timed out while waiting for submissionId=' + currentId +
          ' (lastStatus=' + status + '). Retry by checking existing submission with FLYCUT_NOTARY_SUBMISSION_ID=' + currentId,
        );
        err.code = 'NOTARIZATION_TIMEOUT';
        err.submissionId = currentId;
        err.lastKnownStatus = status;
        throw err;
      }

      if (pollIntervalMs > 0) await sleep(pollIntervalMs);
      const info = queryInfo(currentId);
      status = info.status || status;
      log('[notary:macos] polling submissionId=' + currentId + ' status=' + status);
      await writeNotaryState(stateFile, {
        submissionId: currentId,
        artifactName,
        artifactSha256,
        status,
        submittedAt,
        updatedAt: new Date().toISOString(),
      }, secrets);
    }

    runChecked('xcrun', ['stapler', 'staple', artifactPath], { run, secrets, label: 'stapler staple artifact' });
    const dmgStaple = runChecked('xcrun', ['stapler', 'validate', artifactPath], {
      run,
      secrets,
      label: 'stapler validate artifact',
    });
    const dmgSpctl = runChecked(
      'spctl',
      ['-a', '-vv', '-t', 'open', '--context', 'context:primary-signature', artifactPath],
      { run, secrets, label: 'spctl validate artifact' },
    );

    let appStaple = null;
    let appSpctl = null;
    if (appPath && existsSync(appPath)) {
      runChecked('xcrun', ['stapler', 'staple', appPath], { run, secrets, label: 'stapler staple app' });
      appStaple = runChecked('xcrun', ['stapler', 'validate', appPath], { run, secrets, label: 'stapler validate app' });
      appSpctl = runChecked('spctl', ['-a', '-vv', '-t', 'exec', appPath], { run, secrets, label: 'spctl validate app' });
    }

    log('[notary:macos] stapled and validated ' + artifactName + ' (submissionId=' + currentId + ')');
    return {
      submissionId: currentId,
      status: 'Accepted',
      stapled: true,
      staplerOutput: [dmgStaple.stdout, dmgStaple.stderr].filter(Boolean).join('\n').trim(),
      spctlOutput: [dmgSpctl.stdout, dmgSpctl.stderr].filter(Boolean).join('\n').trim(),
      appStaplerOutput: appStaple ? [appStaple.stdout, appStaple.stderr].filter(Boolean).join('\n').trim() : null,
      appSpctlOutput: appSpctl ? [appSpctl.stdout, appSpctl.stderr].filter(Boolean).join('\n').trim() : null,
      artifactSha256,
    };
  });
}

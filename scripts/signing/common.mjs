import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export const SECRET_ENV_KEYS = [
  'APPLE_CERTIFICATE',
  'APPLE_CERTIFICATE_PASSWORD',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'APPLE_ID',
  'APPLE_PASSWORD',
  'WINDOWS_CERTIFICATE',
  'WINDOWS_CERTIFICATE_PASSWORD',
];

export function collectSecrets(env = process.env, extraSecrets = []) {
  const values = new Set();
  for (const key of SECRET_ENV_KEYS) {
    const val = env?.[key];
    if (typeof val === 'string' && val.trim().length >= 4) {
      values.add(val);
      values.add(val.trim());
    }
  }
  for (const val of extraSecrets) {
    if (typeof val === 'string' && val.trim().length >= 4) {
      values.add(val);
      values.add(val.trim());
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}

export function redactSecrets(input, secrets = []) {
  if (input == null) return '';
  let text = String(input);
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('[REDACTED]');
  }
  text = text.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    '[REDACTED_PRIVATE_KEY]',
  );
  text = text.replace(
    /(\b(?:Authorization|X-Auth-Token)\s*[:=]\s*(?:Bearer|Basic)?\s*)[^\s'"]+/gi,
    '$1[REDACTED]',
  );
  text = text.replace(/((?:^|\s)(?:-P|-p|\/p|--password)\s+)(?:"[^"]*"|'[^']*'|\S+)/g, '$1[REDACTED]');
  text = text.replace(/\b(MII[A-Za-z0-9+/=]{36,})\b/g, '[REDACTED_CERT_BLOB]');
  return text;
}

export function redactValue(value, secrets = []) {
  if (typeof value === 'string') return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactValue(v, secrets);
    }
    return out;
  }
  return value;
}

function hasNonEmpty(env, key) {
  return typeof env?.[key] === 'string' && env[key].trim().length > 0;
}

export function preflightMacSigning(env = process.env) {
  const missing = [];
  if (!hasNonEmpty(env, 'APPLE_CERTIFICATE')) missing.push('APPLE_CERTIFICATE');
  if (!hasNonEmpty(env, 'APPLE_CERTIFICATE_PASSWORD')) missing.push('APPLE_CERTIFICATE_PASSWORD');

  const apiKeys = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
  const appleIdKeys = ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID'];
  const hasAllApi = apiKeys.every((k) => hasNonEmpty(env, k));
  const hasAllAppleId = appleIdKeys.every((k) => hasNonEmpty(env, k));

  let notaryAuthMode = null;
  if (hasAllApi) {
    notaryAuthMode = 'api-key';
  } else if (hasAllAppleId) {
    notaryAuthMode = 'apple-id';
  } else {
    const anyApi = apiKeys.some((k) => hasNonEmpty(env, k));
    const anyAppleId = appleIdKeys.some((k) => hasNonEmpty(env, k));
    if (anyApi && !anyAppleId) {
      for (const k of apiKeys) if (!hasNonEmpty(env, k)) missing.push(k);
    } else if (anyAppleId && !anyApi) {
      for (const k of appleIdKeys) if (!hasNonEmpty(env, k)) missing.push(k);
    } else {
      missing.push('APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER');
    }
  }

  return {
    platform: 'macos',
    ok: missing.length === 0,
    missing,
    notaryAuthMode,
    expectedTeamId: hasNonEmpty(env, 'APPLE_EXPECTED_TEAM_ID')
      ? env.APPLE_EXPECTED_TEAM_ID.trim()
      : hasNonEmpty(env, 'APPLE_TEAM_ID')
        ? env.APPLE_TEAM_ID.trim()
        : null,
  };
}

export function preflightWindowsSigning(env = process.env) {
  const missing = [];
  if (!hasNonEmpty(env, 'WINDOWS_CERTIFICATE')) missing.push('WINDOWS_CERTIFICATE');
  if (!hasNonEmpty(env, 'WINDOWS_CERTIFICATE_PASSWORD')) missing.push('WINDOWS_CERTIFICATE_PASSWORD');
  return {
    platform: 'windows',
    ok: missing.length === 0,
    missing,
    timestampUrl: hasNonEmpty(env, 'WINDOWS_TIMESTAMP_URL')
      ? env.WINDOWS_TIMESTAMP_URL.trim()
      : 'http://timestamp.digicert.com',
    expectedPublisher: hasNonEmpty(env, 'WINDOWS_EXPECTED_PUBLISHER')
      ? env.WINDOWS_EXPECTED_PUBLISHER.trim()
      : null,
  };
}

export function preflightSigning({ platform = 'all', mode = 'release', env = process.env } = {}) {
  if (!['release', 'candidate-signed', 'candidate-unsigned'].includes(mode)) {
    throw new Error('Unsupported signing mode: ' + mode);
  }
  if (mode === 'candidate-unsigned') {
    return {
      ok: true,
      signed: false,
      mode,
      platform,
      missing: [],
      warnings: ['Unsigned candidate build selected; formal release publishing is disabled.'],
    };
  }

  const checks = [];
  if (platform === 'all' || platform === 'macos') checks.push(preflightMacSigning(env));
  if (platform === 'all' || platform === 'windows') checks.push(preflightWindowsSigning(env));
  if (checks.length === 0) throw new Error('Unsupported signing platform: ' + platform);

  const missingByPlatform = Object.fromEntries(
    checks.filter((c) => !c.ok).map((c) => [c.platform, c.missing]),
  );
  const missing = checks.flatMap((c) => c.missing);
  const ok = missing.length === 0;

  if (!ok) {
    const summary = checks
      .filter((c) => !c.ok)
      .map((c) => c.platform + ': ' + c.missing.join(', '))
      .join('; ');
    const err = new Error(
      'Signing preflight failed (' + mode + '): missing required credentials [' + summary + ']. ' +
      'Configure repository CI secrets before running signed builds or formal releases.',
    );
    err.code = 'MISSING_SIGNING_CREDENTIALS';
    err.missingByPlatform = missingByPlatform;
    err.missing = missing;
    throw err;
  }

  return {
    ok: true,
    signed: true,
    mode,
    platform,
    missing: [],
    platforms: Object.fromEntries(checks.map((c) => [c.platform, c])),
  };
}

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

export async function writeSha256Sums(filePaths, outputPath) {
  const lines = [];
  for (const filePath of filePaths) {
    const digest = await sha256File(filePath);
    lines.push(digest + '  ' + basename(filePath));
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, lines.join('\n') + '\n', 'utf8');
  return lines;
}

export async function writeSigningEvidence({ outputDir, platform, evidence, extraSecrets = [] }) {
  const secrets = collectSecrets(process.env, extraSecrets);
  const payload = redactValue({
    ...evidence,
    platform,
    releaseAuthorized: false,
    generatedAt: new Date().toISOString(),
  }, secrets);
  await mkdir(outputDir, { recursive: true });
  const filePath = join(outputDir, 'signing-evidence-' + platform + '.json');
  await writeFile(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return { filePath, payload };
}

export async function writeSigningErrorEvidence({
  outputDir,
  platform,
  stage,
  error,
  details = {},
  extraSecrets = [],
}) {
  const secrets = collectSecrets(process.env, extraSecrets);
  const payload = redactValue({
    platform,
    stage,
    signed: false,
    verified: false,
    releaseAuthorized: false,
    error: error instanceof Error ? error.message : String(error),
    details,
    failedAt: new Date().toISOString(),
  }, secrets);
  await mkdir(outputDir, { recursive: true });
  const filePath = join(outputDir, 'signing-error-' + platform + '.json');
  await writeFile(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return { filePath, payload };
}

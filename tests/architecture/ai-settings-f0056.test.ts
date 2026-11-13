import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createHost } from '../../server/app';
import type { JobSnapshot } from '../../shared/protocol';
import { EncryptedFileAISecretStore } from '../../server/aiSettings/secrets';

const KEY = 'f0056-integration-encryption-key-at-least-32';

async function setup(options: { home?: string; patch?: Record<string, unknown>; profile?: string } = {}) {
  const home = options.home ?? await mkdtemp(join(tmpdir(), 'flycut-ai-settings-f0056-'));
  const ctx = await createHost({ home, token: 'f0056-token', port: 0, resourceRoot: resolve('.') }, {
    profile: options.profile ?? 'desktop',
    patches: [{ source: 'f0056-test', patch: { config: { 'ai-settings': { secretBackend: 'memory',
      ...(options.profile === 'server' ? { privateNetwork: false } : {}), ...options.patch } } } }],
  });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const makeClient = () => {
    const call = async <T = any>(method: string, payload: unknown = {}): Promise<T> => {
      const response = await fetch(`${base}/rpc`, { method: 'POST', headers: { Authorization: 'Bearer f0056-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }) });
      const envelope = await response.json();
      if (!envelope.result.ok) throw new Error(envelope.result.error.message);
      return envelope.result.value;
    };
    return { call };
  };
  const client = makeClient(); const call = client.call;
  const wait = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      const job = await call<JobSnapshot>('jobs.get', { id });
      if (['complete', 'error', 'cancelled'].includes(job.status)) return job;
      await setTimeout(20);
    }
    throw new Error('job did not settle');
  };
  return { home, ctx, base, call, makeClient, wait, async close(remove = true) {
    await ctx.fiber.dispose(); if (remove) await rm(home, { recursive: true, force: true });
  } };
}

async function fixtureApi(keyHolder: { value: string }) {
  const seen: Array<{ auth?: string; body: string }> = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push({ auth: req.headers.authorization, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
    if (req.url === '/v1/chat/completions') {
      const model = JSON.parse(body).model;
      const content = model === 'fixture-model'
        ? JSON.stringify([{ id: 's1', text: 'corrected' }])
        : 'Provider is available.';
      return res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 1, model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }
    res.statusCode = 401; res.end(JSON.stringify({ error: `key ${keyHolder.value} was rejected` }));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  return { baseUrl, seen, close: () => new Promise<void>(done => server.close(() => done())) };
}

process.env.FLYCUT_AI_SECRET_KEY = KEY;

test('F-0056/AC-4 encrypted secret files serialize mutations and remove temporary files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-ai-secrets-f0056-'));
  const file = join(home, 'ai-secrets.enc');
  const store = new EncryptedFileAISecretStore(file, KEY);
  try {
    const refs = Array.from({ length: 12 }, () => crypto.randomUUID());
    await Promise.all(refs.map((ref, index) => store.set(ref, `value-${index}`)));
    for (let index = 0; index < refs.length; index++) assert.equal(await store.get(refs[index]), `value-${index}`);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await assert.rejects(stat(`${file}.tmp`), { code: 'ENOENT' });
    await Promise.all(refs.slice(0, 6).map(ref => store.delete(ref)));
    for (const ref of refs.slice(0, 6)) assert.equal(await store.get(ref), undefined);
    for (const ref of refs.slice(6)) assert.ok(await store.get(ref));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('F-0056/AC-1 AC-3 AC-7 AC-8 config IDs, immutable secret refs, restart and lost-response migration', async () => {
  const api = await fixtureApi({ value: 'first-secret' });
  const host = await setup({ patch: { secretBackend: 'encrypted-file' } });
  const secondClient = host.makeClient();
  try {
    const identity = await host.call('projects.identity');
    assert.deepEqual(await secondClient.call('projects.identity'), identity);
    assert.deepEqual(await host.call('aiSettings.list'), { hostId: identity.hostId, revision: 0, selectedId: null, configs: [] });
    const saved = await host.call('aiSettings.save', { hostId: identity.hostId, expectedRevision: 0,
      config: { name: 'Fixture', baseUrl: api.baseUrl, model: 'fixture-model', temperature: 0.2, apiKey: 'first-secret' } });
    assert.equal(saved.status, 'saved'); assert.equal(saved.snapshot.configs[0].hasApiKey, true);
    assert.equal(JSON.stringify(saved).includes('first-secret'), false);
    const metadata = await readFile(join(host.home, 'ai-settings.json'), 'utf8');
    const encrypted = await readFile(join(host.home, 'ai-secrets.enc'), 'utf8');
    assert.equal(metadata.includes('first-secret'), false); assert.equal(encrypted.includes('first-secret'), false);
    assert.equal((await stat(join(host.home, 'ai-settings.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(host.home, 'ai-secrets.enc'))).mode & 0o777, 0o600);

    const correction = await host.wait((await host.call('text.start', { mode: 'correction',
      items: [{ id: 's1', text: 'original' }], configId: saved.configId })).id);
    assert.equal(correction.status, 'complete', correction.error);
    assert.deepEqual(correction.result, [{ id: 's1', text: 'corrected' }]);
    assert.equal(api.seen.at(-1)?.auth, 'Bearer first-secret');
    assert.equal(api.seen.at(-1)?.body.includes('first-secret'), false);
    assert.equal(JSON.stringify(await host.call('jobs.get', { id: correction.id })).includes('first-secret'), false);
    assert.equal((await host.call('aiSettings.test', { hostId: identity.hostId, configId: saved.configId })).status, 'ok');
    const secondSnapshot = await secondClient.call('aiSettings.list');
    assert.deepEqual(secondSnapshot, saved.snapshot);
    assert.equal(JSON.stringify(secondSnapshot).includes('first-secret'), false);
    const secondCorrection = await host.wait((await secondClient.call('text.start', { mode: 'correction',
      items: [{ id: 's1', text: 'second client' }], configId: saved.configId })).id);
    assert.equal(secondCorrection.status, 'complete', secondCorrection.error);
    assert.equal(api.seen.at(-1)?.auth, 'Bearer first-secret');

    const unchanged = await host.call('aiSettings.save', { hostId: identity.hostId, expectedRevision: 1, configId: saved.configId,
      config: { name: 'Renamed', baseUrl: api.baseUrl, model: 'fixture-model' } });
    assert.equal(unchanged.status, 'saved'); assert.equal(unchanged.snapshot.configs[0].hasApiKey, true);
    await host.wait((await host.call('text.start', { mode: 'correction', items: [{ id: 's1', text: 'x' }], configId: saved.configId })).id);
    assert.equal(api.seen.at(-1)?.auth, 'Bearer first-secret');

    const conflict = await host.call('aiSettings.save', { hostId: identity.hostId, expectedRevision: 1, configId: saved.configId,
      config: { name: 'Stale', baseUrl: api.baseUrl, model: 'fixture-model', apiKey: 'should-not-write' } });
    assert.equal(conflict.status, 'conflict'); assert.equal(conflict.snapshot.revision, 2);
    assert.equal(conflict.snapshot.configs[0].name, 'Renamed');
    assert.equal((await readFile(join(host.home, 'ai-secrets.enc'), 'utf8')).includes('should-not-write'), false);

    const migrationId = crypto.randomUUID();
    const imported = await host.call('aiSettings.import', { hostId: identity.hostId, expectedRevision: 2, migrationId,
      selectedSourceId: 'legacy-1', configs: [{ sourceId: 'legacy-1', name: 'Imported', baseUrl: api.baseUrl, model: 'fixture-model', apiKey: 'migrated-secret' }] });
    assert.equal(imported.status, 'imported'); assert.equal(imported.duplicate, false);
    const afterImportRevision = imported.snapshot.revision; const importedId = imported.configIds[0];
    const retry = await host.call('aiSettings.import', { hostId: identity.hostId, expectedRevision: 0, migrationId,
      selectedSourceId: 'legacy-1', configs: [{ sourceId: 'legacy-1', name: 'Imported', baseUrl: api.baseUrl, model: 'fixture-model', apiKey: 'migrated-secret' }] });
    assert.equal(retry.status, 'imported'); assert.equal(retry.duplicate, true); assert.deepEqual(retry.configIds, [importedId]);
    assert.equal(retry.snapshot.revision, afterImportRevision);
    await assert.rejects(host.call('aiSettings.import', { hostId: identity.hostId, expectedRevision: afterImportRevision, migrationId,
      configs: [{ sourceId: 'other', name: 'Other', baseUrl: api.baseUrl, model: 'fixture-model', apiKey: 'other' }] }), /另一批配置/);

    const secondImport = await host.call('aiSettings.import', { hostId: identity.hostId, expectedRevision: afterImportRevision,
      migrationId: crypto.randomUUID(), configs: [{ sourceId: 'legacy-1', name: 'Imported', baseUrl: api.baseUrl, model: 'fixture-model', apiKey: 'migrated-secret' }] });
    assert.deepEqual(secondImport.configIds, [importedId]); assert.equal(secondImport.snapshot.configs.length, 2);
    const agent = await host.wait((await host.call('agent.start', { prompt: 'providers?', configId: importedId })).id);
    assert.equal(agent.status, 'complete', agent.error);

    await host.close(false);
    const restarted = await setup({ home: host.home, patch: { secretBackend: 'encrypted-file' } });
    try {
      const reread = await restarted.call('aiSettings.list');
      assert.equal(reread.revision, secondImport.snapshot.revision); assert.equal(reread.configs.length, 2);
      assert.equal(reread.configs.find((item: any) => item.id === importedId).hasApiKey, true);
      const deleted = await restarted.call('aiSettings.remove', { hostId: identity.hostId, expectedRevision: reread.revision, configId: importedId });
      assert.equal(deleted.status, 'removed'); assert.equal(deleted.snapshot.configs.some((item: any) => item.id === importedId), false);
    } finally { await restarted.close(); }
  } finally { await host.close(false).catch(() => undefined); await api.close(); await rm(host.home, { recursive: true, force: true }); }
});

test('F-0056/AC-3 AC-4 failed metadata commit preserves the old secret ref and sanitizes upstream errors', async () => {
  const api = await fixtureApi({ value: 'old-secret' });
  const host = await setup({ patch: { secretBackend: 'encrypted-file' } });
  try {
    const identity = await host.call('projects.identity');
    const saved = await host.call('aiSettings.save', { hostId: identity.hostId, expectedRevision: 0,
      config: { name: 'Fixture', baseUrl: api.baseUrl, model: 'fixture-model', apiKey: 'old-secret' } });
    await mkdir(join(host.home, 'ai-settings.json.tmp'));
    await assert.rejects(host.call('aiSettings.save', { hostId: identity.hostId, expectedRevision: saved.snapshot.revision, configId: saved.configId,
      config: { name: 'Fixture', baseUrl: api.baseUrl, model: 'fixture-model', apiKey: 'new-secret' } }));
    await rm(join(host.home, 'ai-settings.json.tmp'), { recursive: true, force: true });
    assert.equal((await readFile(join(host.home, 'ai-settings.json'), 'utf8')).includes('new-secret'), false);
    await host.wait((await host.call('text.start', { mode: 'correction', items: [{ id: 's1', text: 'x' }], configId: saved.configId })).id);
    assert.equal(api.seen.at(-1)?.auth, 'Bearer old-secret');

    const failingUrl = api.baseUrl.replace('/v1', '/bad');
    const bad = await host.call('aiSettings.save', { hostId: identity.hostId, expectedRevision: saved.snapshot.revision,
      config: { name: 'Bad', baseUrl: failingUrl, model: 'fixture-model', apiKey: 'must-not-leak' } });
    const failed = await host.wait((await host.call('text.start', { mode: 'translation', items: [{ id: 's1', text: 'x' }], configId: bad.configId })).id);
    assert.equal(failed.status, 'error'); assert.equal(failed.error?.includes('must-not-leak'), false);
    assert.equal(JSON.stringify(await host.call('jobs.get', { id: failed.id })).includes('must-not-leak'), false);
  } finally { await host.close(); await api.close(); }
});

test('F-0056/AC-4 server profile rejects loopback for save, test and resolve', async () => {
  const host = await setup({ profile: 'server' });
  try {
    const identity = await host.call('projects.identity');
    await assert.rejects(host.call('aiSettings.save', { hostId: identity.hostId, expectedRevision: 0,
      config: { name: 'Private', baseUrl: 'http://127.0.0.1:9999/v1', model: 'x', apiKey: 'secret' } }), /内网/);
  } finally { await host.close(); }

  const bootstrap = await setup({ patch: { privateNetwork: true } });
  const home = bootstrap.home;
  let identity: any;
  let saved: any;
  try {
    identity = await bootstrap.call('projects.identity');
    saved = await bootstrap.call('aiSettings.save', { hostId: identity.hostId, expectedRevision: 0,
      config: { name: 'Private', baseUrl: 'http://127.0.0.1:9999/v1', model: 'x', apiKey: 'secret' } });
    await bootstrap.close(false);
    const guarded = await setup({ home, profile: 'server' });
    try {
      await assert.rejects(guarded.call('aiSettings.test', { hostId: identity.hostId, configId: saved.configId }), /内网/);
      const job = await guarded.wait((await guarded.call('text.start', { mode: 'correction', items: [{ id: 's1', text: 'x' }], configId: saved.configId })).id);
      assert.equal(job.status, 'error'); assert.match(job.error!, /内网/);
    } finally { await guarded.close(); }
  } finally { await bootstrap.close(false).catch(() => undefined); await rm(home, { recursive: true, force: true }); }
});

test('F-0056/AC-2 AC-8 migration cleans secret refs when a later secret write fails', async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-ai-import-failure-'));
  const created: string[] = [];
  const originalSet = EncryptedFileAISecretStore.prototype.set;
  EncryptedFileAISecretStore.prototype.set = async function (ref, value) {
    if (created.length === 1) throw new Error('simulated secret backend failure');
    created.push(ref); return originalSet.call(this, ref, value);
  };
  const host = await setup({ home, patch: { secretBackend: 'encrypted-file' } });
  try {
    const identity = await host.call('projects.identity');
    await assert.rejects(host.call('aiSettings.import', { hostId: identity.hostId, expectedRevision: 0, migrationId: crypto.randomUUID(),
      configs: [
        { sourceId: 'one', name: 'One', baseUrl: 'https://one.example/v1', model: 'm', apiKey: 'one-key' },
        { sourceId: 'two', name: 'Two', baseUrl: 'https://two.example/v1', model: 'm', apiKey: 'two-key' },
      ] }), /simulated secret backend failure/);
    assert.equal((await host.call('aiSettings.list')).configs.length, 0);
    assert.equal(await new EncryptedFileAISecretStore(join(home, 'ai-secrets.enc'), KEY).get(created[0]), undefined);
  } finally {
    EncryptedFileAISecretStore.prototype.set = originalSet;
    await host.close();
  }
});


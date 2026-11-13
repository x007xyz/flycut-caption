import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHost } from '../../server/app';
import type { ConfirmationRequest } from '../../shared/confirmations';

async function setupHost(options: { home?: string } = {}) {
  const home = options.home ?? await mkdtemp(join(tmpdir(), 'flycut-f0051-test-'));
  const ctx = await createHost({ home, token: 'f0051-test-token', port: 0, resourceRoot: resolve('.') }, {
    profile: 'desktop',
    providers: [],
    patches: [{ source: 'f0051-test', patch: { config: { 'ai-settings': { secretBackend: 'memory' } } } }],
  });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const callRaw = async (method: string, payload: unknown = {}, token = 'f0051-test-token') => {
    const response = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
    });
    return { status: response.status, envelope: await response.json() as any };
  };
  const call = async <T = any>(method: string, payload: unknown = {}): Promise<T> => {
    const { status, envelope } = await callRaw(method, payload);
    assert.equal(status, 200);
    if (!envelope.result.ok) {
      const err = new Error(envelope.result.error.message) as Error & { code?: string };
      err.code = envelope.result.error.code;
      throw err;
    }
    return envelope.result.value;
  };
  return {
    home,
    ctx,
    base,
    call,
    callRaw,
    async close(remove = true) {
      await ctx.fiber.dispose();
      if (remove) await rm(home, { recursive: true, force: true });
    },
  };
}

test('F-0051/AC-3 AC-8 confirmations require UI decision, deduplicate by operationId, and consume overwrite once', async () => {
  const host = await setupHost();
  try {
    const { projectId } = await host.call<{ projectId: string }>('projects.createEmpty', { name: 'Confirm Target' });
    const opId = crypto.randomUUID();

    const created = await host.call<ConfirmationRequest>('confirmations.create', {
      kind: 'trash-project',
      source: 'cli',
      target: { projectId },
      operationId: opId,
    });
    assert.equal(created.status, 'pending');
    assert.equal(created.target.projectName, 'Confirm Target');

    // Idempotent retry with same operationId returns the exact same confirmation
    const duplicate = await host.call<ConfirmationRequest>('confirmations.create', {
      kind: 'trash-project',
      source: 'cli',
      target: { projectId },
      operationId: opId,
    });
    assert.equal(duplicate.id, created.id);

    // Project must still be active before UI decision
    const listedBefore = await host.call<Array<{ id: string }>>('projects.list');
    assert.equal(listedBefore.some(item => item.id === projectId), true);

    // Reject keeps project intact
    const rejected = await host.call<ConfirmationRequest>('confirmations.decide', {
      id: created.id,
      decision: 'reject',
      actor: 'ui-client',
    });
    assert.equal(rejected.status, 'rejected');
    assert.equal((await host.call<Array<{ id: string }>>('projects.list')).some(item => item.id === projectId), true);

    // Approve executes trash-project
    const second = await host.call<ConfirmationRequest>('confirmations.create', {
      kind: 'trash-project',
      source: 'cli',
      target: { projectId },
    });
    const executed = await host.call<ConfirmationRequest>('confirmations.decide', {
      id: second.id,
      decision: 'approve',
      actor: 'ui-client',
    });
    assert.equal(executed.status, 'executed');
    assert.equal((await host.call<Array<{ id: string }>>('projects.list')).some(item => item.id === projectId), false);

    // Overwrite-export requires approval and can only be consumed once
    const { projectId: p2 } = await host.call<{ projectId: string }>('projects.createEmpty', { name: 'Overwrite Target' });
    const overwrite = await host.call<ConfirmationRequest>('confirmations.create', {
      kind: 'overwrite-export',
      source: 'cli',
      target: { projectId: p2, outputName: 'out.mp4', format: 'mp4' },
    });
    const unapprovedConsume = await host.callRaw('confirmations.consume', { id: overwrite.id });
    assert.equal(unapprovedConsume.envelope.result.error.code, 'CONFIRMATION_NOT_APPROVED');

    const approved = await host.call<ConfirmationRequest>('confirmations.decide', {
      id: overwrite.id,
      decision: 'approve',
      actor: 'ui-client',
    });
    assert.equal(approved.status, 'approved');

    const consumed = await host.call<ConfirmationRequest>('confirmations.consume', { id: overwrite.id });
    assert.equal(consumed.status, 'consumed');
    await stat(join(host.home, 'confirmations', `${overwrite.id}.json`));

    const replay = await host.callRaw('confirmations.consume', { id: overwrite.id });
    assert.equal(replay.envelope.result.error.code, 'CONFIRMATION_ALREADY_CONSUMED');
  } finally {
    await host.close();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Context, Plugin } from '@deepseek-ai/cordis';
import { createHost } from '../../server/app';
import type { ConfirmationRequest } from '../../shared/confirmations';
import type { JobSnapshot } from '../../shared/protocol';

const FFMPEG = process.env.FFMPEG_PATH ?? resolve('src-tauri/binaries/ffmpeg');
const CLI_BIN = resolve('dist-cli/flycut.mjs');

function runCli(args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, [CLI_BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

/**
 * Async variant. A synchronous spawn blocks this process's event loop, and the isolated Host under
 * test runs in the same process, so the Host could never answer the CLI request.
 */
function runCliAsync(args: string[], env: Record<string, string | undefined> = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(resolveRun => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('close', status => resolveRun({ status, stdout, stderr }));
  });
}

async function setupHost(options: { home?: string; providers?: Plugin[] } = {}) {
  const home = options.home ?? await mkdtemp(join(tmpdir(), 'flycut-f0051-test-'));
  const ctx = await createHost({ home, token: 'f0051-test-token', port: 0, resourceRoot: resolve('.') }, {
    profile: 'desktop',
    providers: options.providers ?? [],
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
  const waitJob = async (id: string) => {
    for (let i = 0; i < 150; i++) {
      const job = await call<JobSnapshot>('jobs.get', { id });
      if (['complete', 'error', 'cancelled'].includes(job.status)) return job;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Job ${id} did not settle`);
  };
  const upload = async (bytes: Buffer) => {
    const response = await fetch(`${base}/assets`, {
      method: 'POST',
      headers: { Authorization: 'Bearer f0051-test-token' },
      body: new Uint8Array(bytes),
    });
    assert.equal(response.status, 201);
    return ((await response.json()) as { assetId: string }).assetId;
  };
  return {
    home,
    ctx,
    base,
    call,
    callRaw,
    waitJob,
    upload,
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

test('F-0051/AC-1 AC-2 AC-3 AC-7 projectOps transcribes, generates review-only suggestions using Host AI config, and exports formal state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flycut-f0051-media-'));
  const sample = join(dir, 'sample.mp4');
  const gen = spawnSync(FFMPEG, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', sample,
  ], { encoding: 'utf8' });
  assert.equal(gen.status, 0, gen.stderr);

  const aiSecret = 'sk-host-only-secret-value';
  const aiRequests: Array<{ auth?: string; body: string }> = [];
  const aiServer = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    aiRequests.push({ auth: req.headers.authorization, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/chat/completions') {
      const parsed = JSON.parse(body);
      const userMsg = parsed.messages?.find((m: any) => m.role === 'user')?.content ?? '{}';
      const reqWindow = JSON.parse(userMsg);
      return res.end(JSON.stringify({
        id: 'chat-1',
        object: 'chat.completion',
        created: 1,
        model: parsed.model,
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: JSON.stringify({
              version: 1,
              base: reqWindow.base,
              candidates: [{
                startWordId: 'w1',
                endWordId: 'w1',
                scope: 'word',
                category: 'contextual-filler',
                reason: '测试口癖建议',
                confidence: 'high',
              }],
            }),
          },
        }],
      }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>(done => aiServer.listen(0, '127.0.0.1', done));
  const aiBaseUrl = `http://127.0.0.1:${(aiServer.address() as { port: number }).port}/v1`;

  const mockProvider: Plugin = {
    name: 'f0051-mock-asr',
    inject: ['providers'],
    apply(ctx: Context) {
      ctx.effect(() => ctx.providers.register({
        id: 'fixture-asr',
        name: 'Fixture ASR',
        kind: 'builtin',
        models: async () => [
          { id: 'ready-model', name: 'Ready Model', role: 'asr', status: 'ready', timestampLevel: 'word' },
          { id: 'download-model', name: 'Download Model', role: 'asr', status: 'download' },
        ],
        async transcribe(_req, audioPath) {
          const wav = await readFile(audioPath);
          assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
          return {
            text: '嗯你好世界',
            language: 'zh',
            duration: 2,
            hasWordTimestamps: true,
            chunks: [{ id: 's1', text: '嗯，那个你好世界', timestamp: [0.1, 1.8], wordIds: ['w0', 'w1', 'w2', 'w3'] }],
            wordChunks: [
              { id: 'w0', text: '嗯', timestamp: [0.1, 0.3], sentenceId: 's1' },
              { id: 'w1', text: '那个', timestamp: [0.42, 0.65], sentenceId: 's1' },
              { id: 'w2', text: '你好', timestamp: [0.7, 1.2], sentenceId: 's1' },
              { id: 'w3', text: '世界', timestamp: [1.25, 1.8], sentenceId: 's1' },
            ],
          };
        },
      }));
    },
  };

  const host = await setupHost({ providers: [mockProvider] });
  try {
    const assetId = await host.upload(await readFile(sample));
    const created = await host.call<{ projectId: string; videoId: string }>('projects.create', {
      name: 'CLI Ops Test',
      videoName: 'sample.mp4',
      durationSeconds: 2,
      media: { assetId, mimeType: 'video/mp4' },
    });

    // Model not ready returns stable MODEL_NOT_READY code
    const notReady = await host.callRaw('projects.transcribe', {
      projectId: created.projectId,
      videoId: created.videoId,
      model: { providerId: 'fixture-asr', modelId: 'download-model' },
    });
    assert.equal(notReady.envelope.result.error.code, 'MODEL_NOT_READY');

    // Ready model transcribes and persists transcript readable by projects.open
    const transcribeJob = await host.call<JobSnapshot>('projects.transcribe', {
      projectId: created.projectId,
      videoId: created.videoId,
      model: { providerId: 'fixture-asr', modelId: 'ready-model' },
      language: 'zh',
    });
    const transcribed = await host.waitJob(transcribeJob.id);
    assert.equal(transcribed.status, 'complete');

    const opened = await host.call<any>('projects.open', { projectId: created.projectId });
    assert.equal(opened.status, 'ok');
    assert.equal(opened.transcript.chunks.length, 1);
    assert.equal(opened.edits, undefined);

    // Save Host AI config (F-0056) and run semantic + rule suggestions
    const { hostId } = await host.call<{ hostId: string }>('projects.identity');
    await host.call('aiSettings.save', {
      hostId,
      expectedRevision: 0,
      config: { name: 'Fixture AI', baseUrl: aiBaseUrl, model: 'fixture-model', apiKey: aiSecret },
    });

    const suggestJob = await host.call<JobSnapshot>('projects.suggestEdits', {
      projectId: created.projectId,
      videoId: created.videoId,
      kind: 'all',
      configId: (await host.call<any>('aiSettings.list')).selectedId,
    });
    const suggested = await host.waitJob(suggestJob.id);
    assert.equal(suggested.status, 'complete');
    assert.ok((suggested.result as any).total >= 2);
    assert.equal(JSON.stringify(suggested).includes(aiSecret), false);
    assert.equal(aiRequests[0]?.auth, `Bearer ${aiSecret}`);

    // Unconfirmed suggestions MUST NOT touch formal edits or EDL
    const reopenedAfterSuggest = await host.call<any>('projects.open', { projectId: created.projectId });
    assert.equal(reopenedAfterSuggest.edits, undefined);

    // Export new mp4 with hard subtitles (formal duration remains full 2s)
    const exportJob = await host.call<JobSnapshot>('projects.export', {
      projectId: created.projectId,
      videoId: created.videoId,
      format: 'mp4',
      quality: 'low',
      subtitleProcessing: 'hard',
    });
    const exported = await host.waitJob(exportJob.id);
    assert.equal(exported.status, 'complete', exported.error);
    const exportAssetId = (exported.result as any).assetId;
    const downloaded = await fetch(`${host.base}/assets/${exportAssetId}`, {
      headers: { Authorization: 'Bearer f0051-test-token' },
    });
    assert.equal(downloaded.status, 200);
    const bytes = Buffer.from(await downloaded.arrayBuffer());
    assert.ok(bytes.length > 1024);
  } finally {
    await host.close();
    await new Promise<void>(done => aiServer.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('F-0051/AC-1 AC-2 AC-3 AC-4 AC-5 AC-6 AC-7 AC-8 CLI subprocess drives isolated Host end-to-end', async () => {
  const work = await mkdtemp(join(tmpdir(), 'flycut-f0051-cli-'));
  const sample = join(work, 'clip.mp4');
  const gen = spawnSync(FFMPEG, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', sample,
  ], { encoding: 'utf8' });
  assert.equal(gen.status, 0, gen.stderr);

  // Help and empty/bad args without needing Host
  const helpRes = runCli(['--help']);
  assert.equal(helpRes.status, 0);
  assert.match(helpRes.stdout, /FlyCut Caption Host CLI/);
  assert.match(helpRes.stdout, /Examples:/);

  const noHostRes = runCli(['projects', 'list', '--home', join(work, 'missing-home'), '--json']);
  assert.equal(noHostRes.status, 3);
  const noHostJson = JSON.parse(noHostRes.stdout);
  assert.equal(noHostJson.ok, false);
  assert.equal(noHostJson.error.code, 'NO_HOST_CONNECTION');

  const slowProvider: Plugin = {
    name: 'f0051-cli-asr',
    inject: ['providers'],
    apply(ctx: Context) {
      ctx.effect(() => ctx.providers.register({
        id: 'cli-asr',
        name: 'CLI ASR',
        kind: 'builtin',
        models: async () => [{ id: 'fast', name: 'Fast', role: 'asr', status: 'ready', timestampLevel: 'word' },
          { id: 'slow', name: 'Slow', role: 'asr', status: 'ready', timestampLevel: 'word' }],
        async transcribe(req, _audioPath, signal, report) {
          if (req.modelId === 'slow') {
            report({ status: 'running', purpose: 'transcribe', progress: 15, data: 'slow running' });
            await new Promise<void>(resolveWait => {
              const timer = setTimeout(resolveWait, 3500);
              signal.addEventListener('abort', () => { clearTimeout(timer); resolveWait(); }, { once: true });
            });
            signal.throwIfAborted();
          }
          return {
            text: '嗯你好',
            language: 'zh',
            duration: 2,
            hasWordTimestamps: true,
            chunks: [{ id: 's1', text: '嗯，你好', timestamp: [0.1, 1.8], wordIds: ['w0', 'w1'] }],
            wordChunks: [
              { id: 'w0', text: '嗯', timestamp: [0.1, 0.3], sentenceId: 's1' },
              { id: 'w1', text: '你好', timestamp: [0.45, 1.8], sentenceId: 's1' },
            ],
          };
        },
      }));
    },
  };

  const host = await setupHost({ providers: [slowProvider] });
  const cliFlags = ['--host', host.base, '--token', 'f0051-test-token'];
  try {
    // Auth failure does not leak token
    const badAuth = await runCliAsync(['projects', 'list', '--host', host.base, '--token', 'wrong-secret-token-xyz', '--json']);
    assert.equal(badAuth.status, 2);
    assert.equal(badAuth.stdout.includes('wrong-secret-token-xyz'), false);
    assert.equal(badAuth.stderr.includes('wrong-secret-token-xyz'), false);
    assert.equal(JSON.parse(badAuth.stdout).error.code, 'AUTH_FAILED');

    // Empty projects list returns [] with exit 0
    const emptyList = await runCliAsync(['projects', 'list', ...cliFlags, '--json']);
    assert.equal(emptyList.status, 0);
    assert.deepEqual(JSON.parse(emptyList.stdout), { ok: true, data: [] });

    // Invalid UUID rejected with exit 5
    const badId = await runCliAsync(['projects', 'get', 'not-a-uuid', ...cliFlags, '--json']);
    assert.equal(badId.status, 5);
    assert.equal(JSON.parse(badId.stdout).error.code, 'INVALID_ID');

    // Create project via /uploads + idempotent operationId
    const createOp = crypto.randomUUID();
    const created = await runCliAsync(['projects', 'create', '--name', 'CLI Clip', '--file', sample, '--operation-id', createOp, ...cliFlags, '--json']);
    assert.equal(created.status, 0, created.stderr);
    const createdData = JSON.parse(created.stdout).data;
    const createdDup = await runCliAsync(['projects', 'create', '--name', 'CLI Clip', '--file', sample, '--operation-id', createOp, ...cliFlags, '--json']);
    assert.equal(createdDup.status, 0);
    assert.equal(JSON.parse(createdDup.stdout).data.projectId, createdData.projectId);

    // Transcribe with logs isolated to stderr
    const trRes = await runCliAsync(['transcribe', createdData.projectId, '--provider', 'cli-asr', '--model', 'fast', '--language', 'zh', ...cliFlags, '--json']);
    assert.equal(trRes.status, 0, trRes.stderr);
    const trJson = JSON.parse(trRes.stdout);
    assert.equal(trJson.ok, true);
    assert.equal(trJson.data.chunkCount, 1);
    assert.equal(trRes.stdout.includes('f0051-test-token'), false);
    assert.equal(trRes.stderr.includes('f0051-test-token'), false);

    // Suggest fillers (review-only)
    const sugRes = await runCliAsync(['suggest', createdData.projectId, '--kind', 'fillers', ...cliFlags, '--json']);
    assert.equal(sugRes.status, 0, sugRes.stderr);
    const sugJson = JSON.parse(sugRes.stdout);
    assert.equal(sugJson.data.status, 'pending');
    assert.equal(sugJson.data.total, 1);

    // Export to a new file succeeds
    const outMp4 = join(work, 'exported-new.mp4');
    const expRes = await runCliAsync(['export', createdData.projectId, '--format', 'mp4', '--quality', 'low', '--subtitles', 'none', '--out', outMp4, ...cliFlags, '--json']);
    assert.equal(expRes.status, 0, expRes.stderr);
    const expJson = JSON.parse(expRes.stdout);
    assert.equal(expJson.ok, true);
    const outStat = await stat(outMp4);
    assert.ok(outStat.size > 1024);

    // Overwrite export with --yes CANNOT bypass client confirmation
    const overwriteAttempt = await runCliAsync(['export', createdData.projectId, '--format', 'mp4', '--out', outMp4, '--yes', ...cliFlags, '--json']);
    assert.equal(overwriteAttempt.status, 4);
    const overwriteJson = JSON.parse(overwriteAttempt.stdout);
    assert.equal(overwriteJson.error.status, 'pending_confirmation');
    assert.equal(overwriteJson.error.bypassRejected, true);
    assert.equal((await stat(outMp4)).size, outStat.size);

    // Approve overwrite in UI client role -> consume succeeds and replaces file
    await host.call('confirmations.decide', { id: overwriteJson.error.confirmationId, decision: 'approve', actor: 'ui-client' });
    const approvedExport = await runCliAsync(['export', createdData.projectId, '--format', 'mp4', '--quality', 'low', '--out', outMp4, '--confirmation-id', overwriteJson.error.confirmationId, ...cliFlags, '--json']);
    assert.equal(approvedExport.status, 0, approvedExport.stderr);

    // Delete project with --yes CANNOT bypass client confirmation
    const deleteAttempt = await runCliAsync(['projects', 'delete', createdData.projectId, '--yes', ...cliFlags, '--json']);
    assert.equal(deleteAttempt.status, 4);
    const deleteJson = JSON.parse(deleteAttempt.stdout);
    assert.equal(deleteJson.error.status, 'pending_confirmation');
    assert.equal(JSON.parse((await runCliAsync(['projects', 'list', ...cliFlags, '--json'])).stdout).data.length, 1);

    // Ctrl+C stops waiting and reports Host task status
    const ctrlcChild = spawn(process.execPath, [CLI_BIN, 'transcribe', createdData.projectId, '--provider', 'cli-asr', '--model', 'slow', ...cliFlags, '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    ctrlcChild.stdout.on('data', d => { stdout += String(d); });
    await new Promise<void>(resolveReady => {
      const onErr = (d: Buffer) => {
        stderr += String(d);
        if (stderr.includes('slow running')) {
          ctrlcChild.stderr.off('data', onErr);
          resolveReady();
        }
      };
      ctrlcChild.stderr.on('data', onErr);
      ctrlcChild.stderr.on('data', d => { if (!stderr.includes('slow running')) return; stderr += String(d); });
    });
    ctrlcChild.kill('SIGINT');
    const exitCode = await new Promise<number | null>(resolveWait => ctrlcChild.once('close', code => resolveWait(code)));
    assert.equal(exitCode, 130, `stderr=${stderr}`);
    const interruptedJson = JSON.parse(stdout);
    assert.equal(interruptedJson.ok, false);
    assert.equal(interruptedJson.error.code, 'INTERRUPTED');
    assert.equal(interruptedJson.error.details.hostStillRunning, true);
    const jobId = interruptedJson.error.details.jobId;
    const queried = JSON.parse((await runCliAsync(['jobs', 'get', jobId, ...cliFlags, '--json'])).stdout);
    assert.equal(queried.ok, true);
    assert.equal(queried.data.id, jobId);
    // Cancel the background slow job so host.close() settles cleanly
    await host.call('jobs.cancel', { id: jobId });
  } finally {
    await host.close();
    await rm(work, { recursive: true, force: true });
  }
});

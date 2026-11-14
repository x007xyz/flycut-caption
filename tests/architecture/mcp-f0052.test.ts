import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Context, Plugin } from '@deepseek-ai/cordis';
import { createHost } from '../../server/app';

const FFMPEG = process.env.FFMPEG_PATH ?? resolve('src-tauri/binaries/ffmpeg');
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';
const MCP_BIN = resolve('dist-mcp/flycut-mcp.mjs');
const REAL_APP_DATA = process.env.FLYCUT_APP_DATA ?? join(homedir(), 'Library/Application Support/com.flycut.caption');
const REAL_SENSEVOICE_ID = 'sensevoice-small-int8-zh-en-ja-ko-yue-2024-07-17';
const REAL_SAMPLE_CLIP = resolve('tests/media/clips/asr/zh-podcast-3min.mp4');
const REAL_SIDECAR = resolve('src-tauri/binaries/funasr-asr');

before(() => {
  const build = spawnSync('pnpm', ['build:mcp'], { encoding: 'utf8', stdio: 'pipe' });
  assert.equal(build.status, 0, build.stderr ?? 'pnpm build:mcp failed');
  assert.ok(existsSync(MCP_BIN), 'dist-mcp/flycut-mcp.mjs should exist after build:mcp');
});

interface JsonRpcFrame {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

class McpStdioClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
  readonly rawStdoutLines: string[] = [];
  stderr = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (frame: JsonRpcFrame) => void; reject: (err: Error) => void }>();

  constructor(args: string[] = [], env: Record<string, string | undefined> = {}) {
    this.child = spawn(process.execPath, [MCP_BIN, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    const rl = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on('line', line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      this.rawStdoutLines.push(trimmed);
      let frame: JsonRpcFrame;
      try {
        frame = JSON.parse(trimmed) as JsonRpcFrame;
      } catch (err) {
        throw new Error(`Non-JSON output on MCP stdout: ${trimmed} (${String(err)})`);
      }
      assert.equal(frame.jsonrpc, '2.0', `stdout frame must be JSON-RPC 2.0: ${trimmed}`);
      if (typeof frame.id === 'number' && this.pending.has(frame.id)) {
        const entry = this.pending.get(frame.id)!;
        this.pending.delete(frame.id);
        entry.resolve(frame);
      } else if (frame.method) {
        this.notifications.push({ method: frame.method, params: frame.params });
      }
    });
    this.child.stderr.on('data', chunk => {
      this.stderr += String(chunk);
    });
    this.child.once('exit', code => {
      for (const [, entry] of this.pending) {
        entry.reject(new Error(`MCP server exited early (code=${String(code)}): ${this.stderr}`));
      }
      this.pending.clear();
    });
  }

  request(method: string, params?: Record<string, unknown>, idOverride?: number): { id: number; promise: Promise<JsonRpcFrame> } {
    const id = idOverride ?? this.nextId++;
    const promise = new Promise<JsonRpcFrame>((resolveReq, rejectReq) => {
      this.pending.set(id, { resolve: resolveReq, reject: rejectReq });
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
      this.child.stdin.write(`${payload}\n`);
    });
    return { id, promise };
  }

  notify(method: string, params?: Record<string, unknown>) {
    const payload = JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
    this.child.stdin.write(`${payload}\n`);
  }

  async initialize(protocolVersion = '2025-11-25') {
    const res = await this.request('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'flycut-test-client', version: '1.0.0' },
    }).promise;
    assert.equal(res.error, undefined, JSON.stringify(res.error));
    this.notify('notifications/initialized');
    return res.result!;
  }

  async callTool(name: string, args: Record<string, unknown> = {}, meta?: Record<string, unknown>) {
    const res = await this.request('tools/call', {
      name,
      arguments: args,
      ...(meta ? { _meta: meta } : {}),
    }).promise;
    assert.equal(res.error, undefined, `JSON-RPC protocol error for ${name}: ${JSON.stringify(res.error)}`);
    return res.result as {
      content: Array<{ type: string; text: string }>;
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
  }

  async close() {
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    const code = await new Promise<number | null>(resolveClose => {
      if (this.child.exitCode !== null) return resolveClose(this.child.exitCode);
      this.child.once('exit', exitCode => resolveClose(exitCode));
    });
    return code;
  }
}

async function setupHost(options: { home?: string; appData?: string; providers?: Plugin[]; token?: string } = {}) {
  const home = options.home ?? await mkdtemp(join(tmpdir(), 'flycut-f0052-host-'));
  const token = options.token ?? 'f0052-host-secret-token';
  const ctx = await createHost({
    home,
    ...(options.appData ? { appData: options.appData } : {}),
    token,
    port: 0,
    resourceRoot: resolve('.'),
  }, {
    profile: 'desktop',
    ...(options.providers ? { providers: options.providers } : {}),
    patches: [{ source: 'f0052-test', patch: { config: { 'ai-settings': { secretBackend: 'memory' } } } }],
  });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const callRaw = async (method: string, payload: unknown = {}, authToken = token) => {
    const response = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
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
    token,
    base,
    ctx,
    call,
    callRaw,
    async close(remove = true) {
      await ctx.fiber.dispose();
      if (remove) await rm(home, { recursive: true, force: true });
    },
  };
}

test('F-0052/AC-1 AC-2 AC-5 AC-8 MCP protocol discovery, empty sets, no-host guidance, schema validation, and secret isolation', async () => {
  const work = await mkdtemp(join(tmpdir(), 'flycut-f0052-proto-'));
  const missingHome = join(work, 'no-host-here');

  // 1. Discovery & resources & no-host guidance BEFORE any Host starts
  const noHostClient = new McpStdioClient([], { FLYCUT_HOST_HOME: missingHome });
  try {
    const initOld = await noHostClient.initialize('2024-11-05');
    assert.equal(initOld.protocolVersion, '2024-11-05');
    assert.equal((initOld.serverInfo as any).name, 'flycut-caption');

    const initNew = await noHostClient.request('initialize', { protocolVersion: '2025-11-25' }).promise;
    assert.equal(initNew.result?.protocolVersion, '2025-11-25');

    const ping = await noHostClient.request('ping').promise;
    assert.deepEqual(ping.result, {});

    const listTools = await noHostClient.request('tools/list').promise;
    const tools = (listTools.result?.tools ?? []) as Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
    assert.ok(tools.length >= 20, `expected >=20 tools, got ${tools.length}`);
    const toolNames = new Set(tools.map(t => t.name));
    for (const required of [
      'flycut_host_status', 'flycut_list_providers', 'flycut_list_models', 'flycut_prepare_model',
      'flycut_list_ai_configs', 'flycut_list_projects', 'flycut_get_project', 'flycut_create_project',
      'flycut_add_video', 'flycut_transcribe', 'flycut_suggest_edits', 'flycut_list_suggestions',
      'flycut_dismiss_suggestion', 'flycut_export', 'flycut_save_export', 'flycut_list_jobs',
      'flycut_get_job', 'flycut_cancel_job', 'flycut_list_confirmations', 'flycut_get_confirmation',
      'flycut_request_delete_project', 'flycut_request_remove_video',
    ]) {
      assert.ok(toolNames.has(required), `missing tool ${required}`);
    }
    // Must NEVER expose any approval tool
    assert.equal(tools.some(t => /decide|approve/i.test(t.name)), false);

    // All schemas must be draft-7 strict objects without credentials
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} inputSchema.type`);
      assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} strict schema`);
      assert.equal(tool.description.includes('sk-'), false);
      assert.equal(tool.description.includes('Bearer'), false);
    }

    const resourcesList = await noHostClient.request('resources/list').promise;
    const uris = ((resourcesList.result?.resources ?? []) as Array<{ uri: string }>).map(r => r.uri);
    assert.ok(uris.includes('flycut://docs/setup'));
    assert.ok(uris.includes('flycut://host/status'));

    const setupRes = await noHostClient.request('resources/read', { uri: 'flycut://docs/setup' }).promise;
    const setupText = ((setupRes.result?.contents ?? []) as Array<{ text: string }>)[0]?.text ?? '';
    assert.match(setupText, /FlyCut Caption MCP Server Setup/);

    const statusRes = await noHostClient.request('resources/read', { uri: 'flycut://host/status' }).promise;
    const statusJson = JSON.parse(((statusRes.result?.contents ?? []) as Array<{ text: string }>)[0]?.text ?? '{}');
    assert.equal(statusJson.connected, false);
    assert.equal(statusJson.error.code, 'NO_HOST_CONNECTION');

    const noHostCall = await noHostClient.callTool('flycut_list_projects');
    assert.equal(noHostCall.isError, true);
    assert.equal((noHostCall.structuredContent?.error as any)?.code, 'NO_HOST_CONNECTION');
    assert.match((noHostCall.structuredContent?.error as any)?.setup ?? '', /connection\.json/);
  } finally {
    const code = await noHostClient.close();
    assert.equal(code, 0);
  }

  // 2. Auth failure, secret isolation, empty collections, strict schema, not found, version conflict
  const aiSecret = 'sk-mcp-only-ai-secret-value-9999';
  const host = await setupHost({ providers: [], token: 'f0052-real-host-token' });
  const badAuthClient = new McpStdioClient(['--host', host.base, '--token', 'wrong-mcp-secret-xyz']);
  const goodClient = new McpStdioClient(['--host', host.base, '--token', host.token]);
  try {
    await badAuthClient.initialize();
    const badRes = await badAuthClient.callTool('flycut_list_projects');
    assert.equal(badRes.isError, true);
    assert.equal((badRes.structuredContent?.error as any)?.code, 'AUTH_FAILED');
    assert.equal(badAuthClient.rawStdoutLines.join('\n').includes('wrong-mcp-secret-xyz'), false);
    assert.equal(badAuthClient.stderr.includes('wrong-mcp-secret-xyz'), false);

    await goodClient.initialize();
    const status = await goodClient.callTool('flycut_host_status');
    assert.equal(status.isError, undefined);
    assert.equal(status.structuredContent?.connected, true);

    // Empty projects returns structured empty array
    const emptyProjects = await goodClient.callTool('flycut_list_projects');
    assert.equal(emptyProjects.isError, undefined);
    assert.deepEqual(emptyProjects.structuredContent, { ok: true, projects: [], count: 0 });

    // AI configs omit secret key
    const { hostId } = await host.call<{ hostId: string }>('projects.identity');
    await host.call('aiSettings.save', {
      hostId,
      expectedRevision: 0,
      config: { name: 'Secret AI', baseUrl: 'http://127.0.0.1:9/v1', model: 'gpt-test', apiKey: aiSecret },
    });
    const aiConfigs = await goodClient.callTool('flycut_list_ai_configs');
    assert.equal(aiConfigs.isError, undefined);
    assert.equal(JSON.stringify(aiConfigs).includes(aiSecret), false);

    // Invalid UUID -> INVALID_ID
    const invalidId = await goodClient.callTool('flycut_get_project', { projectId: 'not-a-uuid' });
    assert.equal(invalidId.isError, true);
    assert.equal((invalidId.structuredContent?.error as any)?.code, 'INVALID_ID');

    // Prompt/argument injection bypass rejected by strict schema -> INVALID_ARGUMENT
    const bogusPid = crypto.randomUUID();
    for (const extraKey of ['yes', 'approve', 'actor', 'force']) {
      const injected = await goodClient.callTool('flycut_request_delete_project', {
        projectId: bogusPid,
        [extraKey]: true,
      });
      assert.equal(injected.isError, true);
      assert.equal((injected.structuredContent?.error as any)?.code, 'INVALID_ARGUMENT');
    }

    // Non-existent target -> NOT_FOUND
    const missing = await goodClient.callTool('flycut_get_project', { projectId: bogusPid });
    assert.equal(missing.isError, true);
    assert.equal((missing.structuredContent?.error as any)?.code, 'NOT_FOUND');

    // Newer-version project on disk -> VERSION_CONFLICT
    const conflictPid = crypto.randomUUID();
    const conflictDir = join(host.home, 'projects', conflictPid);
    await mkdir(conflictDir, { recursive: true });
    await writeFile(join(conflictDir, 'project.json'), JSON.stringify({
      formatVersion: 999,
      id: conflictPid,
      name: 'Future Format',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      revision: 1,
      styleRevision: 0,
      videos: [{
        id: crypto.randomUUID(),
        name: 'v.mp4',
        durationSeconds: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        hasTranscript: false,
        styleSource: 'project',
        revision: 1,
        media: { kind: 'stored', file: 'media/v.mp4', size: 1, mimeType: 'video/mp4' },
      }],
    }));
    const conflictRes = await goodClient.callTool('flycut_get_project', { projectId: conflictPid });
    assert.equal(conflictRes.isError, true);
    assert.equal((conflictRes.structuredContent?.error as any)?.code, 'VERSION_CONFLICT');

    // No credentials ever appear on stdout or stderr
    const allOut = goodClient.rawStdoutLines.join('\n') + '\n' + goodClient.stderr;
    assert.equal(allOut.includes(host.token), false);
    assert.equal(allOut.includes(aiSecret), false);
  } finally {
    await badAuthClient.close();
    await goodClient.close();
    await host.close();
    await rm(work, { recursive: true, force: true });
  }
});

test('F-0052/AC-1 AC-3 AC-4 AC-5 AC-6 AC-7 AC-8 full MCP lifecycle, progress, cancel/disconnect, suggestions, overwrite & delete gates', async () => {
  const work = await mkdtemp(join(tmpdir(), 'flycut-f0052-e2e-'));
  const sample = join(work, 'clip.mp4');
  const gen = spawnSync(FFMPEG, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', sample,
  ], { encoding: 'utf8' });
  assert.equal(gen.status, 0, gen.stderr);

  let slowStarted!: () => void;
  const slowStartedPromise = new Promise<void>(resolveReady => { slowStarted = resolveReady; });

  const provider: Plugin = {
    name: 'f0052-mock-asr',
    inject: ['providers'],
    apply(ctx: Context) {
      ctx.effect(() => ctx.providers.register({
        id: 'mcp-asr',
        name: 'MCP Test ASR',
        kind: 'builtin',
        models: async () => [
          { id: 'fast', name: 'Fast', role: 'asr', status: 'ready', timestampLevel: 'word' },
          { id: 'slow', name: 'Slow', role: 'asr', status: 'ready', timestampLevel: 'word' },
        ],
        async transcribe(req, audioPath, signal, report) {
          const wav = await readFile(audioPath);
          assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
          if (req.modelId === 'slow') {
            report({ status: 'running', purpose: 'transcribe', progress: 22, data: 'slow-asr-running' });
            slowStarted();
            await new Promise<void>(resolveWait => {
              const timer = setTimeout(resolveWait, 10_000);
              signal.addEventListener('abort', () => { clearTimeout(timer); resolveWait(); }, { once: true });
            });
            signal.throwIfAborted();
          }
          return {
            text: '嗯你好世界',
            language: 'zh',
            duration: 2,
            hasWordTimestamps: true,
            chunks: [{ id: 's1', text: '嗯，你好世界', timestamp: [0.1, 1.8], wordIds: ['w0', 'w1', 'w2'] }],
            wordChunks: [
              { id: 'w0', text: '嗯', timestamp: [0.1, 0.3], sentenceId: 's1' },
              { id: 'w1', text: '你好', timestamp: [0.4, 1.0], sentenceId: 's1' },
              { id: 'w2', text: '世界', timestamp: [1.1, 1.8], sentenceId: 's1' },
            ],
          };
        },
      }));
    },
  };

  const host = await setupHost({ providers: [provider] });
  const clientA = new McpStdioClient(['--host', host.base, '--token', host.token]);
  let clientB: McpStdioClient | undefined;
  try {
    await clientA.initialize();

    const providersRes = await clientA.callTool('flycut_list_providers');
    assert.equal(providersRes.isError, undefined);
    assert.ok(Number(providersRes.structuredContent?.count) >= 1);

    // Create project + idempotency
    const createOp = crypto.randomUUID();
    const createdRes = await clientA.callTool('flycut_create_project', {
      name: 'MCP Lifecycle Project',
      filePath: sample,
      operationId: createOp,
    });
    assert.equal(createdRes.isError, undefined);
    const created = createdRes.structuredContent!;
    const projectId = String(created.projectId);
    const videoId = String(created.videoId);
    assert.equal(created.clientEntry, `#/projects/${projectId}/videos/${videoId}`);

    const createdDup = await clientA.callTool('flycut_create_project', {
      name: 'MCP Lifecycle Project',
      filePath: sample,
      operationId: createOp,
    });
    assert.equal(createdDup.structuredContent?.projectId, projectId);

    // Empty suggestions returns structured empty collection (AC-5)
    const emptySuggestions = await clientA.callTool('flycut_list_suggestions', { projectId, videoId });
    assert.equal(emptySuggestions.isError, undefined);
    assert.deepEqual(emptySuggestions.structuredContent?.suggestions, []);
    assert.equal(emptySuggestions.structuredContent?.count, 0);

    // Submit transcribe with wait=false -> completed MUST be false (AC-6, AC-7)
    const submittedTr = await clientA.callTool('flycut_transcribe', {
      projectId,
      videoId,
      providerId: 'mcp-asr',
      modelId: 'fast',
      language: 'zh',
      wait: false,
    });
    assert.equal(submittedTr.isError, undefined);
    assert.equal(submittedTr.structuredContent?.completed, false);
    assert.equal(submittedTr.structuredContent?.submitted, true);
    const fastJobId = String(submittedTr.structuredContent?.jobId);

    // Poll until Host confirms completion
    let jobState: Record<string, unknown> = {};
    for (let i = 0; i < 100; i += 1) {
      const polled = await clientA.callTool('flycut_get_job', { jobId: fastJobId });
      jobState = polled.structuredContent!;
      if (jobState.status === 'complete' || jobState.status === 'error') break;
      await new Promise(r => setTimeout(r, 30));
    }
    assert.equal(jobState.completed, true);
    assert.equal(jobState.status, 'complete');

    // Verify UI-facing project view has transcript and no formal edits yet
    const inspected = await clientA.callTool('flycut_get_project', { projectId, videoId });
    assert.equal(inspected.structuredContent?.hasTranscript, true);
    assert.equal((inspected.structuredContent?.transcript as any)?.chunkCount, 1);
    assert.equal(inspected.structuredContent?.edits, null);

    // Generate review-only suggestions -> never touches formal EDL
    const suggested = await clientA.callTool('flycut_suggest_edits', {
      projectId,
      videoId,
      kind: 'fillers',
      wait: true,
    });
    assert.equal(suggested.isError, undefined);
    assert.equal(suggested.structuredContent?.completed, true);
    assert.equal(suggested.structuredContent?.reviewOnly, true);
    assert.equal(suggested.structuredContent?.formalEdlModified, false);
    assert.ok(suggested.structuredContent?.suggestionId);
    assert.equal(suggested.structuredContent?.clientEntry, `#/projects/${projectId}/videos/${videoId}`);

    const listedSug = await clientA.callTool('flycut_list_suggestions', { projectId, videoId });
    assert.equal(listedSug.structuredContent?.count, 1);
    const afterSugProject = await clientA.callTool('flycut_get_project', { projectId, videoId });
    assert.equal(afterSugProject.structuredContent?.edits, null);

    // Export without outPath -> returns assetId and nextStep, then save via flycut_save_export
    const expAssetOnly = await clientA.callTool('flycut_export', {
      projectId,
      videoId,
      format: 'json',
      wait: true,
    });
    assert.equal(expAssetOnly.isError, undefined, JSON.stringify(expAssetOnly));
    const savedJsonPath = join(work, 'out-saved.json');
    const savedAsset = await clientA.callTool('flycut_save_export', {
      assetId: String(expAssetOnly.structuredContent?.assetId),
      outPath: savedJsonPath,
      projectId,
      videoId,
      format: 'json',
    });
    assert.equal(savedAsset.isError, undefined, JSON.stringify(savedAsset));
    assert.equal(savedAsset.structuredContent?.saved, true);
    assert.ok((await stat(savedJsonPath)).size > 10);

    // Export new SRT and MP4 with progressToken (AC-4, AC-6, AC-7)
    const outSrt = join(work, 'out-new.srt');
    const expSrt = await clientA.callTool('flycut_export', {
      projectId,
      videoId,
      format: 'srt',
      outPath: outSrt,
      wait: true,
    });
    assert.equal(expSrt.isError, undefined, JSON.stringify(expSrt));
    assert.equal(expSrt.structuredContent?.completed, true);
    const srtContent = await readFile(outSrt, 'utf8');
    assert.match(srtContent, /你好世界/);

    const outMp4 = join(work, 'out-new.mp4');
    const expMp4 = await clientA.callTool('flycut_export', {
      projectId,
      videoId,
      format: 'mp4',
      quality: 'low',
      subtitleProcessing: 'none',
      outPath: outMp4,
      wait: true,
    }, { progressToken: 'export-mp4-1' });
    assert.equal(expMp4.isError, undefined, JSON.stringify(expMp4));
    assert.equal(expMp4.structuredContent?.completed, true);
    assert.ok((await stat(outMp4)).size > 1024);
    assert.ok(clientA.notifications.some(n => n.method === 'notifications/progress' && n.params?.progressToken === 'export-mp4-1'));

    // Overwrite existing file without confirmationId -> pending_confirmation + idempotent operationId (AC-3, AC-8)
    const beforeSize = (await stat(outMp4)).size;
    const owOp = crypto.randomUUID();
    const owAttempt1 = await clientA.callTool('flycut_export', {
      projectId,
      videoId,
      format: 'mp4',
      quality: 'low',
      outPath: outMp4,
      wait: true,
      operationId: owOp,
    });
    assert.equal(owAttempt1.isError, true);
    assert.equal((owAttempt1.structuredContent?.error as any)?.code, 'CONFIRMATION_REQUIRED');
    const owSc = owAttempt1.structuredContent!;
    const owConfId = String(owSc.confirmationId);
    assert.equal(owSc.status, 'pending_confirmation');
    assert.equal(owSc.clientOnlyApproval, true);

    // Retry same operationId reuses same confirmationId
    const owAttempt2 = await clientA.callTool('flycut_export', {
      projectId,
      videoId,
      format: 'mp4',
      quality: 'low',
      outPath: outMp4,
      wait: true,
      operationId: owOp,
    });
    assert.equal(owAttempt2.structuredContent?.confirmationId, owConfId);
    assert.equal((await stat(outMp4)).size, beforeSize);

    // Before UI approves -> CONFIRMATION_NOT_APPROVED
    const notApproved = await clientA.callTool('flycut_export', {
      projectId,
      videoId,
      format: 'mp4',
      quality: 'low',
      outPath: outMp4,
      overwrite: true,
      confirmationId: owConfId,
      wait: true,
    });
    assert.equal(notApproved.isError, true);
    assert.equal((notApproved.structuredContent?.error as any)?.code, 'CONFIRMATION_NOT_APPROVED');

    // UI approves -> overwrite succeeds and consumes confirmation once
    await host.call('confirmations.decide', { id: owConfId, decision: 'approve', actor: 'ui-client' });
    const owSuccess = await clientA.callTool('flycut_export', {
      projectId,
      videoId,
      format: 'mp4',
      quality: 'low',
      outPath: outMp4,
      overwrite: true,
      confirmationId: owConfId,
      wait: true,
    });
    assert.equal(owSuccess.isError, undefined, JSON.stringify(owSuccess));
    assert.equal(owSuccess.structuredContent?.confirmationConsumed, owConfId);

    // Replaying consumed confirmationId fails with CONFIRMATION_ALREADY_CONSUMED
    const replayOw = await clientA.callTool('flycut_export', {
      projectId,
      videoId,
      format: 'mp4',
      quality: 'low',
      outPath: outMp4,
      overwrite: true,
      confirmationId: owConfId,
      wait: true,
    });
    assert.equal(replayOw.isError, true);
    assert.equal((replayOw.structuredContent?.error as any)?.code, 'CONFIRMATION_ALREADY_CONSUMED');

    // Rejected overwrite confirmation returns CONFIRMATION_REJECTED
    const owRejectReq = await clientA.callTool('flycut_export', {
      projectId,
      videoId,
      format: 'mp4',
      outPath: outMp4,
      overwrite: true,
    });
    const rejectConfId = String(owRejectReq.structuredContent?.confirmationId);
    await host.call('confirmations.decide', { id: rejectConfId, decision: 'reject', actor: 'ui-client' });
    const rejectedAttempt = await clientA.callTool('flycut_export', {
      projectId,
      videoId,
      format: 'mp4',
      outPath: outMp4,
      overwrite: true,
      confirmationId: rejectConfId,
    });
    assert.equal(rejectedAttempt.isError, true);
    assert.equal((rejectedAttempt.structuredContent?.error as any)?.code, 'CONFIRMATION_REJECTED');

    // Delete project creates pending confirmation (deduplicated) and does NOT delete project
    const delOp = crypto.randomUUID();
    const delReq1 = await clientA.callTool('flycut_request_delete_project', { projectId, operationId: delOp });
    const delReq2 = await clientA.callTool('flycut_request_delete_project', { projectId, operationId: delOp });
    assert.equal(delReq1.structuredContent?.status, 'pending_confirmation');
    assert.equal(delReq1.structuredContent?.executed, false);
    assert.equal(delReq1.structuredContent?.confirmationId, delReq2.structuredContent?.confirmationId);
    assert.equal((await clientA.callTool('flycut_list_projects')).structuredContent?.count, 1);

    // Remove video creates pending confirmation; list/get confirmations expose it; dismiss suggestion cleans pending batch
    const rmVidReq = await clientA.callTool('flycut_request_remove_video', { projectId, videoId });
    assert.equal(rmVidReq.structuredContent?.status, 'pending_confirmation');
    const rmConfId = String(rmVidReq.structuredContent?.confirmationId);
    const confGet = await clientA.callTool('flycut_get_confirmation', { confirmationId: rmConfId });
    assert.equal((confGet.structuredContent?.confirmation as any)?.kind, 'remove-video');
    const confList = await clientA.callTool('flycut_list_confirmations', { status: 'pending' });
    assert.ok(Number(confList.structuredContent?.count) >= 2);

    const suggestionId = String(suggested.structuredContent?.suggestionId);
    const dismissed = await clientA.callTool('flycut_dismiss_suggestion', { projectId, videoId, suggestionId });
    assert.equal(dismissed.structuredContent?.dismissed, true);
    assert.equal((await clientA.callTool('flycut_list_suggestions', { projectId, videoId })).structuredContent?.count, 0);

    // AC-6: notifications/cancelled stops local wait without falsely claiming Host cancelled
    const slowReq = clientA.request('tools/call', {
      name: 'flycut_transcribe',
      arguments: {
        projectId,
        videoId,
        providerId: 'mcp-asr',
        modelId: 'slow',
        wait: true,
      },
      _meta: { progressToken: 'slow-tr-1' },
    });
    await slowStartedPromise;
    clientA.notify('notifications/cancelled', { requestId: slowReq.id, reason: 'client stopped waiting' });
    const cancelledWaitFrame = await slowReq.promise;
    const cancelledWait = (cancelledWaitFrame.result as any).structuredContent;
    assert.equal(cancelledWait.stoppedWaiting, true);
    assert.equal(cancelledWait.hostTaskCancelled, false);
    assert.equal(cancelledWait.hostStillRunning, true);
    const slowJobId = String(cancelledWait.jobId);

    // Client A disconnects -> Host keeps job alive -> Client B reconnects and cancels explicitly
    assert.equal(await clientA.close(), 0);
    clientB = new McpStdioClient(['--host', host.base, '--token', host.token]);
    await clientB.initialize();
    const jobSnapshot = await clientB.callTool('flycut_get_job', { jobId: slowJobId });
    assert.equal(jobSnapshot.structuredContent?.running, true);

    const cancelledHost = await clientB.callTool('flycut_cancel_job', { jobId: slowJobId });
    assert.equal(cancelledHost.structuredContent?.hostTaskCancelled, true);
    assert.equal(cancelledHost.structuredContent?.status, 'cancelled');

    const allSecretCheck = clientA.rawStdoutLines.join('\n') + clientA.stderr + clientB.rawStdoutLines.join('\n') + clientB.stderr;
    assert.equal(allSecretCheck.includes(host.token), false);
  } finally {
    await clientA.close().catch(() => undefined);
    await clientB?.close().catch(() => undefined);
    await host.close();
    await rm(work, { recursive: true, force: true });
  }
});

test('F-0052/AC-4 AC-9 real SenseVoice ASR model + real media end-to-end through MCP stdio', async t => {
  const realModelDir = join(REAL_APP_DATA, 'models', REAL_SENSEVOICE_ID);
  if (!existsSync(realModelDir) || !existsSync(REAL_SIDECAR) || !existsSync(REAL_SAMPLE_CLIP)) {
    t.skip('Real SenseVoice model, funasr-asr sidecar, or tests/media clip not present in environment');
    return;
  }

  const work = await mkdtemp(join(tmpdir(), 'flycut-f0052-real-asr-'));
  const clip = join(work, 'zh-clip-6s.mp4');
  const slice = spawnSync(FFMPEG, [
    '-y', '-v', 'error', '-i', REAL_SAMPLE_CLIP, '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', clip,
  ], { encoding: 'utf8' });
  assert.equal(slice.status, 0, slice.stderr);

  const host = await setupHost({ appData: REAL_APP_DATA });
  const client = new McpStdioClient(['--host', host.base, '--token', host.token]);
  try {
    await client.initialize();

    const modelsRes = await client.callTool('flycut_list_models', { role: 'asr', providerId: 'sherpa-onnx' });
    const models = ((modelsRes.structuredContent?.groups as any[])?.[0]?.models ?? []) as Array<{ id: string; status: string }>;
    const sensevoice = models.find(m => m.id === REAL_SENSEVOICE_ID);
    assert.ok(sensevoice, 'SenseVoice Small INT8 should be listed');
    assert.equal(sensevoice.status, 'ready');

    const created = await client.callTool('flycut_create_project', {
      name: 'Real SenseVoice MCP Demo',
      filePath: clip,
    });
    const projectId = String(created.structuredContent?.projectId);
    const videoId = String(created.structuredContent?.videoId);

    const transcribed = await client.callTool('flycut_transcribe', {
      projectId,
      videoId,
      providerId: 'sherpa-onnx',
      modelId: REAL_SENSEVOICE_ID,
      language: 'zh',
      wait: true,
    }, { progressToken: 'real-asr' });
    assert.equal(transcribed.isError, undefined, JSON.stringify(transcribed));
    assert.equal(transcribed.structuredContent?.completed, true);
    assert.ok(Number(transcribed.structuredContent?.chunkCount) >= 1);

    const opened = await client.callTool('flycut_get_project', { projectId, videoId });
    assert.equal(opened.structuredContent?.hasTranscript, true);

    const outMp4 = join(work, 'real-hardsub.mp4');
    const exported = await client.callTool('flycut_export', {
      projectId,
      videoId,
      format: 'mp4',
      quality: 'low',
      subtitleProcessing: 'hard',
      outPath: outMp4,
      wait: true,
    });
    assert.equal(exported.isError, undefined, JSON.stringify(exported));
    assert.equal(exported.structuredContent?.completed, true);
    assert.ok((await stat(outMp4)).size > 1024);

    const probe = spawnSync(FFPROBE, ['-v', 'error', '-show_streams', '-of', 'json', outMp4], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    const streams = (JSON.parse(probe.stdout).streams ?? []) as Array<{ codec_type: string }>;
    assert.ok(streams.some(s => s.codec_type === 'video'));
    assert.ok(streams.some(s => s.codec_type === 'audio'));
  } finally {
    await client.close();
    await host.close();
    await rm(work, { recursive: true, force: true });
  }
});

test('F-0052/AC-4 AC-5 Codex CLI registers and inspects flycut-caption MCP server', async t => {
  const whichCodex = spawnSync('which', ['codex'], { encoding: 'utf8' });
  if (whichCodex.status !== 0) {
    t.skip('codex CLI binary not installed');
    return;
  }
  const codexHome = await mkdtemp(join(tmpdir(), 'flycut-f0052-codex-'));
  try {
    const env = { ...process.env, CODEX_HOME: codexHome };
    const add = spawnSync('codex', ['mcp', 'add', 'flycut-caption', '--', process.execPath, MCP_BIN], { encoding: 'utf8', env });
    assert.equal(add.status, 0, add.stderr);

    const list = spawnSync('codex', ['mcp', 'list', '--json'], { encoding: 'utf8', env });
    assert.equal(list.status, 0, list.stderr);
    const servers = JSON.parse(list.stdout) as Array<{ name: string; enabled: boolean; transport: { type: string; command: string; args: string[] } }>;
    const found = servers.find(s => s.name === 'flycut-caption');
    assert.ok(found, 'flycut-caption should be listed in codex mcp list');
    assert.equal(found.enabled, true);
    assert.equal(found.transport.type, 'stdio');
    assert.equal(found.transport.args[0], MCP_BIN);

    const get = spawnSync('codex', ['mcp', 'get', 'flycut-caption', '--json'], { encoding: 'utf8', env });
    assert.equal(get.status, 0, get.stderr);
    const info = JSON.parse(get.stdout) as { name: string; transport: { args: string[] } };
    assert.equal(info.name, 'flycut-caption');
    assert.equal(info.transport.args[0], MCP_BIN);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});


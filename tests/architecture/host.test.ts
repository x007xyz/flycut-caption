import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import type { Context, Plugin } from '@deepseek-ai/cordis';
import { createHost } from '../../server/app';
import { apiAsrPlugin } from '../../server/plugins/asr';
import { z } from 'zod';
import { encodePcmWav } from '../../shared/asr/apiProtocol';
import type { JobSnapshot } from '../../shared/protocol';

const execFileAsync = promisify(execFile);

const fixture = { text: 'hello', chunks: [{ id: 's1', text: 'hello', timestamp: [0, 1] }], language: 'en', duration: 3 };
const mockProvider: Plugin = { name: 'test-provider', inject: ['providers'], apply(ctx: Context) {
  ctx.effect(() => ctx.providers.register({ id: 'python-runtime', name: 'Fixture ASR', async transcribe(_input, path, signal, report) {
    assert.equal((await readFile(path)).toString(), 'fixture-audio');
    report({ status: 'running', progress: 25 });
    await setTimeout(40, undefined, { signal }); return structuredClone(fixture) as any;
  } }));
} };
async function setup(providers: Plugin[] = [mockProvider]) {
  const home = await mkdtemp(join(tmpdir(), 'flycut-host-test-'));
  const ctx = await createHost({ home, token: 'test-credential', port: 0, resourceRoot: resolve('.') }, { providers });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const headers = { Authorization: 'Bearer test-credential', 'Content-Type': 'application/json' };
  const call = async <T = any>(method: string, payload: unknown = {}): Promise<T> => {
    const rpcId = crypto.randomUUID();
    const response = await fetch(`${base}/rpc`, { method: 'POST', headers,
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }) });
    const envelope = await response.json(); assert.equal(envelope.rpcId, rpcId);
    if (!envelope.result.ok) throw new Error(envelope.result.error.message);
    return envelope.result.value;
  };
  const wait = async (id: string) => {
    for (let i = 0; i < 100; i++) { const job = await call<JobSnapshot>('jobs.get', { id }); if (['complete', 'error', 'cancelled'].includes(job.status)) return job; await setTimeout(20); }
    throw new Error('Job did not settle');
  };
  const upload = async (body: any) => (await (await fetch(`${base}/assets`, { method: 'POST', headers: { Authorization: 'Bearer test-credential' }, body })).json()).assetId;
  return { home, ctx, base, call, wait, upload, async close() { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }); } };
}

test('HTTP authentication and WebSocket snapshots; LangGraph executes ASR and pause analysis', async () => {
  const host = await setup();
  const events: any[] = [];
  const ws = new WebSocket(`${host.base.replace('http', 'ws')}/events?token=test-credential`);
  ws.on('message', data => events.push(JSON.parse(String(data))));
  try {
    assert.equal((await fetch(`${host.base}/rpc`, { method: 'POST' })).status, 401);
    const assetId = await host.upload('fixture-audio');
    const job = await host.call('workflow.start', { asr: { providerId: 'python-runtime', modelId: 'fixture', assetId },
      steps: [{ id: 'cut', providerId: 'delete-silence', capabilityId: 'delete-silence', enabled: true, config: { threshold: 1 } }] });
    const completed = await host.wait(job.id);
    assert.equal(completed.status, 'complete');
    assert.equal((completed.result as any).transcript.text, 'hello');
    assert.ok((completed.result as any).cuts.length > 0);
    await setTimeout(30);
    assert.ok(events.some(event => event.type === 'host/ready'));
    assert.ok(events.some(event => event.type === 'jobs/snapshot'));
    assert.ok(events.some(event => event.type === 'event' && event.name === 'job/updated' && event.payload.job.status === 'complete'));
    assert.ok(events.find(event => event.type === 'host/ready').events.includes('job/updated'));
    assert.equal(JSON.parse(await readFile(join(host.home, 'jobs', `${job.id}.json`), 'utf8')).status, 'complete');
  } finally { ws.terminate(); await host.close(); }
});

test('cancellation reaches the actual Provider and plugin unload withdraws registration', async () => {
  const host = await setup();
  try {
    const assetId = await host.upload('fixture-audio');
    const job = await host.call('workflow.start', { asr: { providerId: 'python-runtime', modelId: 'fixture', assetId } });
    const cancelled = await host.call('jobs.cancel', { id: job.id }); assert.equal(cancelled.status, 'cancelled');
    const fiber = host.ctx.plugin({ name: 'temporary-provider', inject: ['providers'], apply(ctx: Context) {
      ctx.effect(() => ctx.providers.register({ id: 'api', name: 'Temporary', async transcribe() { throw new Error('unused'); } }));
    } });
    await fiber.await(); assert.equal(host.ctx.providers.get('api').name, 'Temporary');
    await fiber.dispose(); assert.throws(() => host.ctx.providers.get('api'), /unavailable/);
  } finally { await host.close(); }
});

test('enabled unsupported pipeline steps fail explicitly rather than silently skipping', async () => {
  const host = await setup();
  try {
    const assetId = await host.upload('fixture-audio');
    const job = await host.call('workflow.start', { asr: { providerId: 'python-runtime', modelId: 'fixture', assetId },
      steps: [{ id: 'separate', providerId: 'audio-separator', capabilityId: 'separate-vocals', enabled: true, config: {} }] });
    const settled = await host.wait(job.id); assert.equal(settled.status, 'error'); assert.match(settled.error!, /not available/);
  } finally { await host.close(); }
});

test('real API Provider uploads PCM WAV and normalizes timestamps through the Host graph', async () => {
  let calls = 0;
  const upstream = createServer(async (req, res) => {
    assert.equal(req.url, '/v1/audio/transcriptions');
    assert.equal(req.headers.authorization, 'Bearer fixture-key');
    let length = 0; for await (const chunk of req) length += chunk.length;
    assert.ok(length > 32000); calls++;
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ text: 'hello', segments: [{ start: 0, end: 1, text: 'hello' }] }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const host = await setup([apiAsrPlugin]);
  try {
    const assetId = await host.upload(encodePcmWav(new Float32Array(16000)));
    const job = await host.call('workflow.start', { asr: { providerId: 'api', modelId: 'fixture', assetId,
      api: { id: 'test', name: 'test', baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`, model: 'fixture', apiKey: 'fixture-key', timestamps: 'segment', timeoutSeconds: 10 } } });
    const settled = await host.wait(job.id); assert.equal(settled.status, 'complete', settled.error);
    assert.equal((settled.result as any).transcript.chunks[0].text, 'hello'); assert.equal(calls, 1);
    assert.ok(!(await readFile(join(host.home, 'jobs', `${job.id}.json`), 'utf8')).includes('fixture-key'));
  } finally { await host.close(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});

test('LangGraph Agent Loop calls a tool and continues with its result', async () => {
  let calls = 0;
  const model = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body); calls++;
    const message = calls === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_fixture', type: 'function', function: { name: 'list_asr_providers', arguments: '{}' } }] }
      : { role: 'assistant', content: 'Provider is available.' };
    if (calls === 2) assert.ok(request.messages.some((item: any) => item.role === 'tool' && item.content.includes('Fixture ASR')));
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ id: `chat-${calls}`, object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, message, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const host = await setup();
  try {
    const job = await host.call('agent.start', { prompt: 'Which ASR Providers are available?', model: {
      baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`, model: 'fixture', apiKey: 'fixture-model-key' } });
    const settled = await host.wait(job.id); assert.equal(settled.status, 'complete', settled.error);
    assert.equal(calls, 2); assert.equal((settled.result as any).messages.at(-1).content, 'Provider is available.');
  } finally { await host.close(); await new Promise<void>(resolve => model.close(() => resolve())); }
});

test('restart preserves completed jobs and marks unsettled executions as interrupted', async () => {
  const host = await setup(); const home = host.home;
  const assetId = await host.upload('fixture-audio');
  const job = await host.call('workflow.start', { asr: { providerId: 'python-runtime', modelId: 'fixture', assetId } });
  await host.wait(job.id); await host.ctx.fiber.dispose();
  const interruptedId = crypto.randomUUID();
  await writeFile(join(home, 'jobs', `${interruptedId}.json`), JSON.stringify({ id: interruptedId, status: 'running', createdAt: '', updatedAt: '' }));
  const next = await createHost({ home, token: 'next-token', port: 0, resourceRoot: resolve('.') }, { providers: [mockProvider] });
  try { assert.equal(next.jobs.get(job.id).status, 'complete'); assert.equal(next.jobs.get(interruptedId).status, 'error'); assert.match(next.jobs.get(interruptedId).error!, /restarted/); }
  finally { await next.fiber.dispose(); await rm(home, { recursive: true, force: true }); }
});

test('text Provider executes correction on the Host and returns results through the same job protocol', async () => {
  const upstream = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(JSON.parse(input.messages[1].content)[0].id, 's1');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify([{ id: 's1', text: 'corrected' }]) } }] }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const host = await setup();
  try {
    const job = await host.call('text.start', { mode: 'correction', items: [{ id: 's1', text: 'original' }],
      model: { id: 'fixture', name: 'fixture', model: 'fixture', apiKey: 'fixture-text-key',
        baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1` } });
    const result = await host.wait(job.id);
    assert.equal(result.status, 'complete', result.error); assert.deepEqual(result.result, [{ id: 's1', text: 'corrected' }]);
    assert.ok(!(await readFile(join(host.home, 'jobs', `${job.id}.json`), 'utf8')).includes('fixture-text-key'));
  } finally { await host.close(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});

test('Export plugin runs FFmpeg as a cancellable Host job and returns an asset', async (t) => {
  try { await execFileAsync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-version']); }
  catch { t.skip('ffmpeg is not installed in this environment'); return; }
  const fixtureDir = await mkdtemp(join(tmpdir(), 'flycut-export-fixture-'));
  const fixturePath = join(fixtureDir, 'input.mp4');
  await execFileAsync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=16000', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', fixturePath]);
  const previousFfmpeg = process.env.FFMPEG_PATH; process.env.FFMPEG_PATH = process.env.FFMPEG_PATH ?? 'ffmpeg';
  const host = await setup();
  try {
    const assetId = await host.upload(await readFile(fixturePath));
    const job = await host.call('export.start', { assetId, segments: [{ start: 0, end: 1, keep: true }], options: { format: 'mp4', quality: 'low', preserveAudio: true, subtitleProcessing: 'none' } });
    const settled = await host.wait(job.id); assert.equal(settled.status, 'complete', settled.error);
    const result = settled.result as { assetId: string; mimeType: string };
    assert.equal(result.mimeType, 'video/mp4');
    const output = await fetch(`${host.base}/assets/${result.assetId}`, { headers: { Authorization: 'Bearer test-credential' } });
    assert.equal(output.status, 200); assert.ok((await output.arrayBuffer()).byteLength > 1000);
  } finally {
    await host.close(); if (previousFfmpeg === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previousFfmpeg;
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test('plugins register RPC methods, expose events and contribute capabilities without touching the Gateway', async () => {
  const host = await setup();
  const frames: any[] = [];
  const ws = new WebSocket(`${host.base.replace('http', 'ws')}/events?token=test-credential`);
  ws.on('message', data => frames.push(JSON.parse(String(data))));
  await new Promise(resolve => ws.once('open', resolve));
  try {
    const fiber = host.ctx.plugin({ name: 'echo-plugin', inject: ['rpc'], apply(ctx: Context) {
      ctx.effect(() => ctx.rpc.register('echo.say' as any, z.object({ text: z.string() }) as any, ({ text }: any) => ({ text }) as any));
      ctx.effect(() => ctx.rpc.expose('vendor/ping' as any));
    } });
    await fiber.await();
    assert.deepEqual(await host.call('echo.say', { text: 'hi' }), { text: 'hi' });
    await assert.rejects(host.call('echo.say', { text: 1 }));
    assert.ok((await host.call('host.info')).methods.includes('echo.say'));
    host.ctx.emit('vendor/ping' as any, { content: 'ok' });
    host.ctx.emit('internal/unexposed' as any);
    await setTimeout(30);
    const forwarded = frames.filter(frame => frame.type === 'event' && frame.name === 'vendor/ping');
    assert.equal(forwarded.length, 1); assert.equal(forwarded[0].payload.content, 'ok');
    assert.ok(!frames.some(frame => frame.name === 'internal/unexposed'));
    await fiber.dispose();
    await assert.rejects(host.call('echo.say', { text: 'hi' }), /Unknown RPC method/);
    assert.deepEqual((await host.call('host.info')).capabilities, { export: true });
    assert.ok(!(await host.call('host.info')).events.includes('vendor/ping'));
  } finally { ws.terminate(); await host.close(); }
});

test('third-party Provider IDs, editor analyzers and Agent tools extend the Host through registries', async () => {
  const host = await setup([{ name: 'custom-provider', inject: ['providers'], apply(ctx: Context) {
    ctx.effect(() => ctx.providers.register({ id: 'vendor-asr', name: 'Vendor ASR', async transcribe() { return structuredClone(fixture) as any; } }));
  } }]);
  try {
    const analyzer = host.ctx.plugin({ name: 'custom-analyzer', inject: ['editorPlugins'], apply(ctx: Context) {
      ctx.effect(() => ctx.editorPlugins.register({ manifest: { schemaVersion: 1, id: 'trim-head', name: 'Trim head', description: '', kind: 'editor-action', status: 'available', input: [], output: [] },
        analyze: () => ({ ranges: [{ start: 0, end: 0.5, reason: 'head' }], totalDuration: 0.5 }),
        buildOperations: result => result.ranges.map(range => ({ type: 'delete-range' as const, ...range })) }));
    } });
    await analyzer.await();
    assert.ok((await host.call('editing.list')).some((item: any) => item.id === 'trim-head'));
    const assetId = await host.upload('fixture-audio');
    const job = await host.call('workflow.start', { asr: { providerId: 'vendor-asr', modelId: 'fixture', assetId },
      steps: [{ id: 'head', providerId: 'vendor', capabilityId: 'trim-head', enabled: true, config: {} }] });
    const settled = await host.wait(job.id); assert.equal(settled.status, 'complete', settled.error);
    assert.deepEqual((settled.result as any).cuts, [{ start: 0, end: 0.5, stepId: 'head' }]);
    await analyzer.dispose();
    const failed = await host.wait((await host.call('workflow.start', { asr: { providerId: 'vendor-asr', modelId: 'fixture', assetId },
      steps: [{ id: 'head', providerId: 'vendor', capabilityId: 'trim-head', enabled: true, config: {} }] })).id);
    assert.equal(failed.status, 'error');
    const toolFiber = host.ctx.plugin({ name: 'custom-tool', inject: ['agentTools'], apply(ctx: Context) {
      ctx.effect(() => ctx.agentTools.register({ name: 'vendor_tool', description: 'Vendor tool', schema: z.object({}), async invoke() { return 'vendor'; } }));
    } });
    await toolFiber.await();
    assert.ok((await host.call('agent.tools')).some((item: any) => item.name === 'vendor_tool'));
    await toolFiber.dispose();
    assert.ok(!(await host.call('agent.tools')).some((item: any) => item.name === 'vendor_tool'));
  } finally { await host.close(); }
});

test('Agent streams messages as remote events and policy plugins can intercept tool calls', async () => {
  let calls = 0;
  const model = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body); calls++;
    const message = calls === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_fixture', type: 'function', function: { name: 'list_asr_providers', arguments: '{}' } }] }
      : { role: 'assistant', content: 'done' };
    if (calls === 2) assert.ok(request.messages.some((item: any) => item.role === 'tool' && item.content === 'blocked by policy'));
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ id: `chat-${calls}`, object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, message, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const host = await setup();
  const frames: any[] = [];
  const ws = new WebSocket(`${host.base.replace('http', 'ws')}/events?token=test-credential`);
  ws.on('message', data => frames.push(JSON.parse(String(data))));
  await new Promise(resolve => ws.once('open', resolve));
  try {
    const policy = host.ctx.plugin({ name: 'deny-policy', apply(ctx: Context) {
      ctx.on('agent/before-tool', call => call.name === 'list_asr_providers' ? 'blocked by policy' : undefined);
    } });
    await policy.await();
    const job = await host.call('agent.start', { prompt: 'providers?', model: {
      baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`, model: 'fixture' } });
    const settled = await host.wait(job.id); assert.equal(settled.status, 'complete', settled.error);
    await setTimeout(30);
    const streamed = frames.filter(frame => frame.type === 'event' && frame.name === 'agent/message' && frame.payload.jobId === job.id);
    assert.equal(streamed.length, 2); assert.equal(streamed[0].payload.message.toolCalls[0].name, 'list_asr_providers');
    assert.ok(frames.some(frame => frame.name === 'agent/tool-result' && frame.payload.content === 'blocked by policy'));
    const seqs = frames.filter(frame => frame.type === 'event').map(frame => frame.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  } finally { ws.terminate(); await host.close(); await new Promise<void>(resolve => model.close(() => resolve())); }
});

test('models plugin owns catalog, library scan, custom registration and file-mode downloads', async () => {
  const files = new Map([['model.onnx', 'onnx-bytes'], ['tokens.txt', 'a 0']]);
  const mirror = createServer((req, res) => {
    const body = files.get((req.url ?? '').replace('/repo/', ''));
    if (!body) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'application/octet-stream'); res.end(body);
  });
  await new Promise<void>(resolve => mirror.listen(0, '127.0.0.1', resolve));
  const host = await setup();
  const library = await mkdtemp(join(tmpdir(), 'flycut-library-'));
  try {
    const builtIn = await host.call('models.list');
    assert.ok(builtIn.length > 0 && builtIn.every((model: any) => !model.custom));
    const qwen = join(library, 'nested/Qwen3-ASR'); await mkdir(qwen, { recursive: true });
    await writeFile(join(qwen, 'config.json'), JSON.stringify({ model_type: 'qwen3_asr', thinker_config: {} }));
    assert.equal((await host.call('models.scan', { root: library })).entries[0].kind, 'unsupported');
    for (const file of ['model.safetensors', 'preprocessor_config.json', 'tokenizer_config.json', 'vocab.json', 'merges.txt', 'chat_template.json']) await writeFile(join(qwen, file), 'fixture');
    const scanned = await host.call('models.scan', { root: library });
    const entry = scanned.entries[0]; assert.equal(entry.kind, 'asr'); assert.equal(entry.model.provider, 'qwen-asr');
    assert.equal(await host.call('models.libraryRoot'), scanned.root);
    await host.call('models.registerCustom', { model: entry.model });
    assert.ok((await host.call('models.scan', { root: library })).entries[0].registered);
    await assert.rejects(host.call('models.registerCustom', { model: entry.model }), /已存在/);
    assert.equal((await host.call('models.environment', { modelId: entry.model.id })).modelReady, true);

    const remote = { ...builtIn.find((model: any) => model.family === 'sense_voice'), id: 'custom-remote', name: 'Remote', local_path: null, custom: true,
      files: [{ path: 'model.onnx', sha256: null }, { path: 'tokens.txt', sha256: null }],
      recognizer_config: { model_type: 'sense_voice', sense_voice_model: 'model.onnx', tokens: 'tokens.txt' },
      download_sources: [{ region: 'global', provider: 'fixture', download_mode: 'files', url: `http://127.0.0.1:${(mirror.address() as { port: number }).port}/repo/` }] };
    await host.call('models.registerCustom', { model: remote });
    assert.ok(!(await host.call('models.status')).downloaded_model_ids.includes('custom-remote'));
    const job = await host.call('models.download', { modelId: 'custom-remote' });
    const settled = await host.wait(job.id); assert.equal(settled.status, 'complete', settled.error);
    assert.equal(await readFile(join(host.home, 'app-data/models/custom-remote/model.onnx'), 'utf8'), 'onnx-bytes');
    assert.ok((await host.call('models.status')).downloaded_model_ids.includes('custom-remote'));
    assert.equal((await host.ctx.models.resolve('custom-remote'))?.path, join(host.home, 'app-data/models/custom-remote'));
    await host.call('models.removeCustom', { modelId: 'custom-remote' });
    assert.ok(!(await host.call('models.list')).some((model: any) => model.id === 'custom-remote'));
  } finally { await host.close(); await rm(library, { recursive: true, force: true }); await new Promise<void>(resolve => mirror.close(() => resolve())); }
});

test('assets stream in and out, can be released, and expire after their TTL', async () => {
  const host = await setup(); const home = host.home;
  const payload = Buffer.alloc(3 * 1024 * 1024, 7);
  const assetId = await host.upload(payload);
  const download = await fetch(`${host.base}/assets/${assetId}`, { headers: { Authorization: 'Bearer test-credential' } });
  assert.equal(download.headers.get('content-length'), String(payload.length));
  assert.ok(Buffer.from(await download.arrayBuffer()).equals(payload));
  const released = await host.upload('release-me');
  await host.call('assets.delete', { assetId: released });
  assert.equal((await fetch(`${host.base}/assets/${released}`, { headers: { Authorization: 'Bearer test-credential' } })).status, 404);
  await host.ctx.fiber.dispose();
  const next = await createHost({ home, token: 'next-token', port: 0, resourceRoot: resolve('.'), assetTtlHours: 0 }, { providers: [mockProvider] });
  try { assert.throws(() => readFileSync(join(home, 'assets', assetId))); }
  finally { await next.fiber.dispose(); await rm(home, { recursive: true, force: true }); }
});

test('profile layers disable built-ins, reject unmet dependencies, and hot-reload external plugins', async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-profile-'));
  const pluginFile = join(home, 'plugins', 'echo.mjs');
  await mkdir(join(home, 'plugins'), { recursive: true });
  const writePlugin = (reply: string) => writeFile(pluginFile, `export default { name: 'echo', inject: ['rpc'], apply(ctx, config) {
    ctx.effect(() => ctx.rpc.register('echo.say', undefined, () => ({ reply: '${reply}', prefix: config?.prefix })));
  } };\n`);
  await writePlugin('v1');
  await writeFile(join(home, 'profile.patch.yml'), [
    '# Harness-style patch layer', 'disable: [asr-python, python]', 'plugins:', '  - id: echo', '    module: echo.mjs', '    config:', '      prefix: p', ''].join('\n'));
  const base = { home, token: 'profile-token', port: 0, resourceRoot: resolve('.') };
  await assert.rejects(createHost(base, { patches: [{ source: 'test', patch: { disable: ['providers'] } }] }), /依赖不满足/);
  const ctx = await createHost(base);
  const url = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const call = async (method: string, payload: unknown = {}) => {
    const response = await fetch(`${url}/rpc`, { method: 'POST', headers: { Authorization: 'Bearer profile-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }) });
    const envelope = await response.json(); if (!envelope.result.ok) throw new Error(envelope.result.error.message); return envelope.result.value;
  };
  try {
    const listed = await call('plugins.list');
    assert.ok(listed.layers[0].endsWith('profile.patch.yml'));
    assert.ok(!listed.plugins.some((item: any) => item.id === 'python'));
    assert.equal(listed.plugins.find((item: any) => item.id === 'echo').state, 'active');
    assert.ok(!(await call('providers.list')).some((item: any) => item.id === 'python-runtime'));
    assert.deepEqual(await call('echo.say'), { reply: 'v1', prefix: 'p' });
    await writePlugin('v2');
    assert.equal((await call('plugins.reload', { id: 'echo' })).state, 'active');
    assert.deepEqual(await call('echo.say'), { reply: 'v2', prefix: 'p' });
    await assert.rejects(call('plugins.reload', { id: 'gateway' }), /核心插件/);
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }); }
});

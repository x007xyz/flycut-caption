import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createServer, request } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import type { Context, Plugin } from '@deepseek-ai/cordis';
import { cloudPlugin } from '../../server/plugins/cloud';
import { createHost } from '../../server/app';
import { z } from 'zod';
import { encodePcmWav } from '../../shared/asr/apiProtocol';
import type { JobSnapshot } from '../../shared/protocol';

const execFileAsync = promisify(execFile);

const fixture = { text: 'hello', chunks: [{ id: 's1', text: 'hello', timestamp: [0, 1] }], language: 'en', duration: 3 };
const fixtureModels = async () => [{ id: 'fixture', name: 'Fixture', role: 'asr' as const, status: 'ready' as const }];
const mockProvider: Plugin = { name: 'test-provider', inject: ['providers'], apply(ctx: Context) {
  ctx.effect(() => ctx.providers.register({ id: 'fixture-asr', name: 'Fixture ASR', kind: 'builtin', models: fixtureModels, async transcribe(_input, path, signal, report) {
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
  const ws = new WebSocket(`${host.base.replace('http', 'ws')}/events`, { headers: { Authorization: 'Bearer test-credential' } });
  ws.on('message', data => events.push(JSON.parse(String(data))));
  try {
    assert.equal((await fetch(`${host.base}/rpc`, { method: 'POST' })).status, 401);
    const assetId = await host.upload('fixture-audio');
    const job = await host.call('workflow.start', { asr: { providerId: 'fixture-asr', modelId: 'fixture', assetId },
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
    const job = await host.call('workflow.start', { asr: { providerId: 'fixture-asr', modelId: 'fixture', assetId } });
    const cancelled = await host.call('jobs.cancel', { id: job.id }); assert.equal(cancelled.status, 'cancelled');
    const fiber = host.ctx.plugin({ name: 'temporary-provider', inject: ['providers'], apply(ctx: Context) {
      ctx.effect(() => ctx.providers.register({ id: 'temporary', name: 'Temporary', kind: 'builtin', models: fixtureModels }));
    } });
    await fiber.await(); assert.equal(host.ctx.providers.get('temporary').name, 'Temporary');
    await fiber.dispose(); assert.throws(() => host.ctx.providers.get('temporary'), /unavailable/);
  } finally { await host.close(); }
});

test('enabled unsupported pipeline steps fail explicitly rather than silently skipping', async () => {
  const host = await setup();
  try {
    const assetId = await host.upload('fixture-audio');
    const job = await host.call('workflow.start', { asr: { providerId: 'fixture-asr', modelId: 'fixture', assetId },
      steps: [{ id: 'separate', providerId: 'audio-separator', capabilityId: 'separate-vocals', enabled: true, config: {} }] });
    const settled = await host.wait(job.id); assert.equal(settled.status, 'error'); assert.match(settled.error!, /not available/);
  } finally { await host.close(); }
});

test('OpenAI-compatible endpoint uploads PCM WAV, keeps the key in memory and normalizes timestamps', async () => {
  let calls = 0;
  const upstream = createServer(async (req, res) => {
    assert.equal(req.url, '/v1/audio/transcriptions');
    assert.equal(req.headers.authorization, 'Bearer fixture-key');
    let length = 0; for await (const chunk of req) length += chunk.length;
    assert.ok(length > 32000); calls++;
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ text: 'hello', segments: [{ start: 0, end: 1, text: 'hello' }] }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const host = await setup();
  try {
    const assetId = await host.upload(encodePcmWav(new Float32Array(16000)));
    const saved = await host.call('endpoints.save', { name: 'test', label: 'Test API', protocol: 'openai', apiKey: 'fixture-key', timeoutSeconds: 10,
      baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`, models: [{ id: 'fixture', timestamps: 'segment' }] });
    assert.equal(saved.providerId, 'openai:test'); assert.equal(saved.hasApiKey, true); assert.equal(saved.apiKey, undefined);
    assert.ok(!(await readFile(join(host.home, 'app-data/endpoints.json'), 'utf8')).includes('fixture-key'));
    const job = await host.call('workflow.start', { asr: { providerId: 'openai:test', modelId: 'fixture', assetId } });
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
  const job = await host.call('workflow.start', { asr: { providerId: 'fixture-asr', modelId: 'fixture', assetId } });
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
  const ws = new WebSocket(`${host.base.replace('http', 'ws')}/events`, { headers: { Authorization: 'Bearer test-credential' } });
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
    assert.deepEqual((await host.call('host.info')).capabilities, { export: true, projects: true, 'projects.linkedMedia': true,
      browserSession: true, cookieMedia: true, resumableUpload: true });
    assert.ok(!(await host.call('host.info')).events.includes('vendor/ping'));
  } finally { ws.terminate(); await host.close(); }
});

test('third-party Provider IDs, editor analyzers and Agent tools extend the Host through registries', async () => {
  const host = await setup([{ name: 'custom-provider', inject: ['providers'], apply(ctx: Context) {
    ctx.effect(() => ctx.providers.register({ id: 'vendor-asr', name: 'Vendor ASR', kind: 'builtin', models: fixtureModels, async transcribe() { return structuredClone(fixture) as any; } }));
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
  const ws = new WebSocket(`${host.base.replace('http', 'ws')}/events`, { headers: { Authorization: 'Bearer test-credential' } });
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

test('registry checks model status, declared options and transcript timing; models service downloads files', async () => {
  const files = new Map([['model.onnx', 'onnx-bytes'], ['tokens.txt', 'a 0']]);
  const mirror = createServer((req, res) => {
    const body = files.get((req.url ?? '').replace('/repo/', ''));
    if (!body) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'application/octet-stream'); res.end(body);
  });
  await new Promise<void>(resolve => mirror.listen(0, '127.0.0.1', resolve));
  let downloaded = false;
  const entry = { id: 'fixture-files', files: [{ path: 'model.onnx', sha256: null }, { path: 'tokens.txt', sha256: null }],
    download_sources: [{ region: 'global', provider: 'fixture', download_mode: 'files', url: `http://127.0.0.1:${(mirror.address() as { port: number }).port}/repo/` }],
    artifact: { archive_name: '', extract_dir: '', size_mb_estimate: 1 } } as any;
  const words = { ...fixture, hasWordTimestamps: true, chunks: [{ id: 's1', text: 'hello', timestamp: [0, 1], wordIds: ['w1'] }],
    wordChunks: [{ id: 'w1', text: 'hello', timestamp: [0.5, 2], sentenceId: 's1' }] };
  const host = await setup([{ name: 'download-provider', inject: ['providers', 'models'], apply(ctx: Context) {
    ctx.effect(() => ctx.providers.register({ id: 'local', name: 'Local', kind: 'builtin',
      async models() { return [{ id: 'm', name: 'M', role: 'asr', status: downloaded ? 'ready' : 'download',
        options: { mode: { type: 'select', label: 'Mode', options: [{ value: 'a', label: 'A' }] } } }]; },
      async prepare(_id, signal, report) { await ctx.models.download(entry, signal, report); downloaded = true; },
      async transcribe() { return structuredClone(words) as any; } }));
  } }]);
  try {
    const assetId = await host.upload('fixture-audio');
    const run = async (asr: object) => host.wait((await host.call('workflow.start', { asr: { providerId: 'local', modelId: 'm', assetId, ...asr } })).id);
    assert.match((await run({})).error!, /未下载/);
    const groups = await host.call('providers.models');
    assert.equal(groups.find((group: any) => group.provider.id === 'local').models[0].status, 'download');
    const job = await host.wait((await host.call('providers.prepare', { providerId: 'local', modelId: 'm' })).id);
    assert.equal(job.status, 'complete', job.error);
    assert.equal(await readFile(join(host.home, 'app-data/models/fixture-files/model.onnx'), 'utf8'), 'onnx-bytes');
    assert.equal(await host.ctx.models.locate(entry), join(host.home, 'app-data/models/fixture-files'));
    assert.match((await run({ options: { other: 'x' } })).error!, /不支持选项/);
    assert.match((await run({ options: { mode: 'b' } })).error!, /无效/);
    // The word ends after its sentence: the claim is dropped, the sentence survives.
    const settled = await run({ options: { mode: 'a' } });
    assert.equal(settled.status, 'complete', settled.error);
    const transcript = (settled.result as any).transcript;
    assert.equal(transcript.hasWordTimestamps, false); assert.deepEqual(transcript.wordChunks, []); assert.equal(transcript.chunks[0].wordIds, undefined);
  } finally { await host.close(); await new Promise<void>(resolve => mirror.close(() => resolve())); }
});

test('FlyCut protocol endpoint: health check, models, escaped options, polling and cancellation', async () => {
  const seen: { options?: string; cancelled?: boolean; auth?: string } = {};
  let version = 1; let slow = false;
  const service = createServer(async (req, res) => {
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    seen.auth = req.headers.authorization;
    if (req.url === '/v1/health') return json(200, { protocol: 'flycut-provider', version, capabilities: ['asr'] });
    if (req.url === '/v1/models') return json(200, { models: [{ id: 'remote-1', name: 'Remote', role: 'asr', status: 'ready',
      options: { hotword: { type: 'string', label: 'Hotword' } } }] });
    if (req.url === '/v1/asr/jobs') { for await (const chunk of req) void chunk; seen.options = String(req.headers['x-flycut-options']); return json(202, { id: 'job1' }); }
    if (req.url === '/v1/jobs/job1') return json(200, slow ? { id: 'job1', status: 'running', progress: 10 } : { id: 'job1', status: 'complete', result: fixture });
    if (req.url === '/v1/jobs/job1/cancel') { seen.cancelled = true; return json(200, { id: 'job1', status: 'cancelled' }); }
    json(404, { error: 'not found' });
  });
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve));
  const host = await setup();
  try {
    await host.call('endpoints.save', { name: 'gpu', label: 'GPU box', protocol: 'flycut', apiKey: 'k1',
      baseUrl: `http://127.0.0.1:${(service.address() as { port: number }).port}` });
    const group = (await host.call('providers.models')).find((item: any) => item.provider.id === 'flycut:gpu');
    assert.equal(group.provider.kind, 'endpoint'); assert.equal(group.models[0].id, 'remote-1');
    const assetId = await host.upload('fixture-audio');
    const start = () => host.call('workflow.start', { asr: { providerId: 'flycut:gpu', modelId: 'remote-1', assetId, language: 'zh', options: { hotword: '飞剪' } } });
    const done = await host.wait((await start()).id);
    assert.equal(done.status, 'complete', done.error); assert.equal((done.result as any).transcript.text, 'hello');
    assert.equal(seen.auth, 'Bearer k1'); assert.deepEqual(JSON.parse(seen.options!), { hotword: '飞剪' }); assert.ok(/^[\x20-\x7e]+$/.test(seen.options!));
    slow = true;
    const running = await start(); await setTimeout(200);
    assert.equal((await host.call('jobs.cancel', { id: running.id })).status, 'cancelled');
    await setTimeout(50); assert.equal(seen.cancelled, true);
    // A service speaking another protocol version is refused instead of half-working.
    version = 2;
    await host.call('endpoints.save', { name: 'gpu', label: 'GPU box', protocol: 'flycut', baseUrl: `http://127.0.0.1:${(service.address() as { port: number }).port}` });
    assert.match((await host.call('providers.models')).find((item: any) => item.provider.id === 'flycut:gpu').error, /协议版本不兼容/);
    assert.deepEqual(await host.call('endpoints.remove', { name: 'gpu' }), { removed: 'gpu' });
    assert.ok(!(await host.call('providers.list')).some((item: any) => item.id === 'flycut:gpu'));
  } finally { await host.close(); await new Promise<void>(resolve => service.close(() => resolve())); }
});

test('FlyCut Cloud appears only when configured and authenticates with the user API key', async () => {
  const seen: string[] = [];
  const service = createServer((req, res) => {
    seen.push(String(req.headers.authorization));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/v1/health' ? { protocol: 'flycut-provider', version: 1 }
      : { models: [{ id: 'cloud-asr', name: 'Cloud', role: 'asr', status: 'ready', timestampLevel: 'word' }] }));
  });
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve));
  const configured: Plugin = { ...cloudPlugin, apply: (ctx: Context) => cloudPlugin.apply(ctx, { baseUrl: `http://127.0.0.1:${(service.address() as { port: number }).port}` }) };
  try {
    const unconfigured = await setup([cloudPlugin]);
    try {
      assert.deepEqual(await unconfigured.call('cloud.status'), { available: false, hasApiKey: false });
      assert.ok(!(await unconfigured.call('providers.list')).some((item: any) => item.id === 'flycut-cloud'));
    } finally { await unconfigured.close(); }
    const host = await setup([configured]);
    try {
      const cloud = async () => (await host.call('providers.models')).find((item: any) => item.provider.id === 'flycut-cloud');
      assert.match((await cloud()).error, /API Key/);
      assert.equal(seen.length, 0);
      assert.deepEqual(await host.call('cloud.setApiKey', { apiKey: 'paid-key' }), { available: true, hasApiKey: true });
      const group = await cloud();
      assert.equal(group.error, undefined); assert.equal(group.provider.kind, 'builtin'); assert.equal(group.models[0].id, 'cloud-asr');
      assert.ok(seen.length >= 2 && seen.every(header => header === 'Bearer paid-key'));
      assert.deepEqual(await host.call('cloud.setApiKey', { apiKey: '' }), { available: true, hasApiKey: false });
      assert.match((await cloud()).error, /API Key/);
    } finally { await host.close(); }
  } finally { await new Promise<void>(resolve => service.close(() => resolve())); }
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
    '# Harness-style patch layer', 'disable: [asr-cloud]', 'plugins:', '  - id: echo', '    module: echo.mjs', '    config:', '      prefix: p', ''].join('\n'));
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
    assert.ok(!listed.plugins.some((item: any) => item.id === 'asr-cloud'));
    assert.equal(listed.plugins.find((item: any) => item.id === 'echo').state, 'active');
    const listedProviders = await call('providers.list');
    assert.ok(listedProviders.some((item: any) => item.id === 'sherpa-onnx'));
    await assert.rejects(call('cloud.status'));
    assert.deepEqual(await call('echo.say'), { reply: 'v1', prefix: 'p' });
    await writePlugin('v2');
    assert.equal((await call('plugins.reload', { id: 'echo' })).state, 'active');
    assert.deepEqual(await call('echo.say'), { reply: 'v2', prefix: 'p' });
    await assert.rejects(call('plugins.reload', { id: 'gateway' }), /核心插件/);
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }); }
});

/** Raw GET so tests can forge `Host` and `Origin`, which fetch does not let callers set. */
function rawGet(url: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((done, fail) => {
    const req = request(url, { headers }, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', fail); req.end();
  });
}

test('server profile withdraws shutdown, plugin management and private-network endpoints', async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-server-profile-'));
  const ctx = await createHost({ home, token: 'server-token', port: 0, resourceRoot: resolve('.') }, { profile: 'server', providers: [mockProvider] });
  const url = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const call = async (method: string, payload: unknown = {}) => {
    const response = await fetch(`${url}/rpc`, { method: 'POST', headers: { Authorization: 'Bearer server-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }) });
    const envelope = await response.json(); if (!envelope.result.ok) throw new Error(envelope.result.error.message); return envelope.result.value;
  };
  const endpoint = (baseUrl: string) => ({ name: 'x', label: 'X', protocol: 'flycut', baseUrl });
  try {
    const info = await call('host.info');
    for (const method of ['host.shutdown', 'plugins.list', 'plugins.reload']) assert.ok(!info.methods.includes(method), method);
    assert.ok(info.methods.includes('workflow.start') && info.methods.includes('export.start') && info.methods.includes('endpoints.save'));
    await assert.rejects(call('host.shutdown'), /Unknown RPC method/);
    for (const address of ['http://127.0.0.1:9000', 'http://10.0.0.8', 'http://192.168.1.2:80', 'http://[::1]:9000', 'http://localhost:9000']) {
      await assert.rejects(call('endpoints.save', endpoint(address)), /内网/, address);
    }
    assert.equal((await call('endpoints.save', endpoint('https://asr.example.com'))).providerId, 'flycut:x');
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }); }
  const desktopHome = await mkdtemp(join(tmpdir(), 'flycut-desktop-profile-'));
  const desktop = await createHost({ home: desktopHome, token: 'desktop-token', port: 0, resourceRoot: resolve('.') }, { providers: [mockProvider] });
  try {
    const response = await fetch(`http://127.0.0.1:${(desktop.httpServer.address() as { port: number }).port}/rpc`, { method: 'POST',
      headers: { Authorization: 'Bearer desktop-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'save', method: 'endpoints.save', payload: endpoint('http://127.0.0.1:9000') }) });
    assert.equal((await response.json()).result.value.providerId, 'flycut:x');
  } finally { await desktop.fiber.dispose(); await rm(desktopHome, { recursive: true, force: true }); }
});

test('Host serves the built frontend, a same-origin bootstrap and configured origins', async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-web-root-'));
  const web = join(home, 'dist'); await mkdir(join(web, 'assets'), { recursive: true });
  await writeFile(join(web, 'index.html'), '<!doctype html><title>FlyCut</title>');
  await writeFile(join(web, 'assets', 'index-abc.js'), 'console.log(1)');
  await writeFile(join(home, 'secret.txt'), 'outside');
  const ctx = await createHost({ home, token: 'web-token', port: 0, resourceRoot: resolve('.'), webRoot: web,
    allowedOrigins: ['https://flycut.example.com'] }, { providers: [mockProvider] });
  const port = (ctx.httpServer.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  try {
    const page = await rawGet(`${url}/`);
    assert.equal(page.status, 200); assert.match(page.body, /FlyCut/); assert.match(String(page.headers['content-type']), /text\/html/);
    assert.match((await rawGet(`${url}/editor/route`)).body, /FlyCut/);
    const bundle = await rawGet(`${url}/assets/index-abc.js`);
    assert.equal(bundle.status, 200); assert.match(String(bundle.headers['content-type']), /javascript/); assert.match(String(bundle.headers['cache-control']), /immutable/);
    assert.equal((await rawGet(`${url}/assets/missing.js`)).status, 404);
    assert.equal((await rawGet(`${url}/..%2fsecret.txt`)).status, 404);
    // Host assets keep their auth even though they share the `/assets/` prefix with bundles.
    assert.equal((await rawGet(`${url}/assets/${crypto.randomUUID()}`)).status, 401);

    const bootstrap = await rawGet(`${url}/__flycut/connection`);
    assert.equal(bootstrap.status, 200);
    const bootstrapBody = JSON.parse(bootstrap.body);
    assert.equal(bootstrapBody.auth, 'session'); assert.equal(typeof bootstrapBody.csrf, 'string'); assert.equal(bootstrapBody.token, undefined);
    assert.match(String(bootstrap.headers['set-cookie']), /flycut_session=/); assert.match(String(bootstrap.headers['set-cookie']), /HttpOnly/);
    assert.equal((await rawGet(`${url}/__flycut/connection`, { host: `evil.example:${port}` })).status, 403, 'DNS rebinding Host header');
    assert.equal((await rawGet(`${url}/__flycut/connection`, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await rawGet(`${url}/__flycut/connection`, { host: 'flycut.example.com', origin: 'https://flycut.example.com' })).status, 200);

    const rpc = (origin: string) => fetch(`${url}/rpc`, { method: 'POST', headers: { Authorization: 'Bearer web-token', 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ type: 'client-request', rpcId: 'o', method: 'host.info', payload: {} }) });
    const allowed = await rpc('https://flycut.example.com');
    assert.equal(allowed.status, 200); assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://flycut.example.com');
    assert.equal((await rpc('https://evil.example')).status, 401);
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }); }
});

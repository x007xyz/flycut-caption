import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createHost } from '../../server/app';
import { encodePcmWav } from '../../shared/asr/apiProtocol';
import { TTS_CLONE_AUTH_STATEMENT_ZH, type ModelInfo } from '../../shared/providers';
import type { JobSnapshot } from '../../shared/protocol';
import { validateTtsAudio } from '../../shared/tts/audio';
import { startExampleTtsServer } from '../../scripts/examples/tts-provider-server.mjs';

function makeValidWav(durationSeconds = 0.25, sampleRate = 24000) {
  const numSamples = Math.max(1, Math.round(durationSeconds * sampleRate));
  const dataBytes = numSamples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < numSamples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000), 44 + i * 2);
  }
  return buf;
}

async function bootHost() {
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0053-arch-'));
  const ctx = await createHost({ home, token: 'f0053-token', port: 0, resourceRoot: resolve('.') }, { profile: 'desktop', patches: [] });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const call = async <T = any>(method: string, payload: unknown = {}): Promise<T> => {
    const response = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { Authorization: 'Bearer f0053-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
    });
    const envelope = await response.json();
    if (!envelope.result.ok) throw new Error(envelope.result.error.message);
    return envelope.result.value;
  };
  const waitJob = async (id: string) => {
    for (let i = 0; i < 120; i++) {
      const job = await call<JobSnapshot>('jobs.get', { id });
      if (['complete', 'error', 'cancelled'].includes(job.status)) return job;
      await setTimeout(25);
    }
    throw new Error('Job timeout');
  };
  const upload = async (bytes: Buffer) => {
    const res = await fetch(`${base}/assets`, {
      method: 'POST',
      headers: { Authorization: 'Bearer f0053-token' },
      body: new Uint8Array(bytes),
    });
    return (await res.json()).assetId as string;
  };
  return { home, ctx, base, call, waitJob, upload, close: async () => { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }); } };
}

test('F-0053/AC-1 AC-2 AC-4 single HTTP Provider serves ASR+TTS, handles auth/timeout/corrupt/cancel/cloning-auth and hides unsupported stubs', async () => {
  const seen: { auth?: string; ttsBodies: any[]; ttsHeaders: any[]; cancelled: boolean } = {
    ttsBodies: [], ttsHeaders: [], cancelled: false,
  };
  let mode: 'ok' | 'slow' | 'corrupt' | 'cross-origin' | 'auth-fail' | 'hang' = 'ok';
  let capabilities = ['asr', 'tts'];

  const models: ModelInfo[] = [
    { id: 'multi-asr', name: 'Multi ASR', role: 'asr', languages: ['zh', 'en'], timestampLevel: 'segment', status: 'ready' },
    {
      id: 'kokoro-fixed',
      name: 'Kokoro Fixed',
      role: 'tts',
      languages: ['zh', 'en'],
      status: 'ready',
      tts: {
        voices: [
          { id: 'zf_xiaobei', name: 'Xiaobei', languages: ['zh'], gender: 'female' },
          { id: 'af_heart', name: 'Heart', languages: ['en'], gender: 'female' },
        ],
        voiceCloning: false,
        durationControl: true,
        streaming: false,
        outputFormats: ['wav'],
      },
      options: { pitch: { type: 'number', label: 'Pitch', default: 0, min: -6, max: 6, step: 1 } },
    },
    {
      id: 'cosyvoice-clone',
      name: 'CosyVoice Clone',
      role: 'tts',
      languages: ['zh', 'en'],
      status: 'ready',
      tts: {
        voices: [{ id: 'base_zh', name: 'Base ZH', languages: ['zh'] }],
        voiceCloning: true,
        cloningTerms: 'Reference audio is processed in memory only and deleted immediately.',
        maxReferenceSeconds: 15,
        durationControl: true,
        streaming: true,
        outputFormats: ['wav'],
      },
    },
  ];

  const validWav = makeValidWav(0.3, 24000);
  const service = createServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    seen.auth = req.headers.authorization;
    if (mode === 'auth-fail' && req.url?.startsWith('/v1/tts')) {
      return json(401, { error: 'Invalid TTS API key' });
    }
    if (mode === 'hang' && req.url === '/v1/tts/jobs') {
      await setTimeout(2500);
      if (!res.writableEnded) json(202, { id: 'late-job' });
      return;
    }
    if (req.url === '/v1/health') return json(200, { protocol: 'flycut-provider', version: 1, name: 'Unified TTS+ASR', capabilities });
    if (req.url === '/v1/models') return json(200, { models });
    if (req.url === '/v1/asr/jobs') {
      for await (const chunk of req) void chunk;
      return json(202, { id: 'asr-job' });
    }
    if (req.url === '/v1/jobs/asr-job') {
      return json(200, { id: 'asr-job', status: 'complete', result: { text: 'ok', language: 'zh', duration: 1, chunks: [{ id: 'c0', text: 'ok', timestamp: [0, 1] }], hasWordTimestamps: false } });
    }
    if (req.url === '/v1/tts/jobs' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      if (req.headers['content-type']?.startsWith('audio/wav')) {
        const meta = JSON.parse(String(req.headers['x-flycut-tts-request'] ?? '{}'));
        if (!meta.authorization?.confirmed || !meta.authorization?.statement) {
          return json(403, { error: 'Speaker authorization required' });
        }
        seen.ttsHeaders.push({ meta, referenceBytes: raw.byteLength });
      } else {
        seen.ttsBodies.push(JSON.parse(raw.toString('utf8')));
      }
      return json(202, { id: 'tts-job' });
    }
    if (req.url === '/v1/jobs/tts-job') {
      if (mode === 'slow') return json(200, { id: 'tts-job', status: 'running', progress: 40, message: 'Synthesizing...' });
      return json(200, {
        id: 'tts-job',
        status: 'complete',
        result: {
          audioUrl: mode === 'cross-origin' ? 'http://127.0.0.1:9/evil.wav' : '/v1/jobs/tts-job/audio',
          mimeType: 'audio/wav',
          format: 'wav',
          durationSeconds: 0.3,
          sampleRate: 24000,
        },
      });
    }
    if (req.url === '/v1/jobs/tts-job/audio') {
      const payload = mode === 'corrupt' ? Buffer.from('<html>corrupt</html>') : validWav;
      res.writeHead(200, { 'Content-Type': mode === 'corrupt' ? 'text/html' : 'audio/wav', 'Content-Length': payload.byteLength });
      res.end(payload);
      return;
    }
    if (req.url === '/v1/jobs/tts-job/cancel' && req.method === 'POST') {
      seen.cancelled = true;
      return json(200, { id: 'tts-job', status: 'cancelled' });
    }
    json(404, { error: 'Not found' });
  });
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve));
  const serviceUrl = `http://127.0.0.1:${(service.address() as { port: number }).port}`;

  const host = await bootHost();
  try {
    // AC-1: built-in sherpa-onnx has no TTS stub method; calling TTS on it fails explicitly.
    assert.equal(host.ctx.providers.get('sherpa-onnx').synthesize, undefined);
    const sherpaTtsJob = await host.waitJob((await host.call<JobSnapshot>('tts.synthesize', {
      request: { providerId: 'sherpa-onnx', modelId: 'fsmn-vad', text: 'test', language: 'zh' },
    })).id);
    assert.equal(sherpaTtsJob.status, 'error');
    assert.match(sherpaTtsJob.error!, /不支持语音合成/);

    // Save single unified endpoint providing both ASR + TTS.
    const savedEndpoint = await host.call('endpoints.save', {
      name: 'unified',
      label: 'Unified Service',
      protocol: 'flycut',
      baseUrl: serviceUrl,
      apiKey: 'secret-tts-key-999',
      timeoutSeconds: 10,
    });
    assert.equal(savedEndpoint.providerId, 'flycut:unified');
    assert.equal(savedEndpoint.hasApiKey, true);

    const groups = await host.call('providers.models');
    const unified = groups.find((g: any) => g.provider.id === 'flycut:unified');
    assert.equal(unified.models.filter((m: ModelInfo) => m.role === 'asr').length, 1);
    assert.equal(unified.models.filter((m: ModelInfo) => m.role === 'tts').length, 2);

    // Fixed-voice TTS synthesis & audio asset storage
    const synthJob = await host.waitJob((await host.call<JobSnapshot>('tts.synthesize', {
      request: {
        providerId: 'flycut:unified',
        modelId: 'kokoro-fixed',
        text: '你好飞剪',
        voiceId: 'zf_xiaobei',
        language: 'zh',
        speed: 1.1,
        options: { pitch: 2 },
      },
    })).id);
    assert.equal(synthJob.status, 'complete', synthJob.error);
    const synthResult = synthJob.result as any;
    assert.equal(synthResult.format, 'wav');
    assert.equal(synthResult.sampleRate, 24000);
    assert.equal(synthResult.cloned, false);
    assert.equal(seen.auth, 'Bearer secret-tts-key-999');
    assert.deepEqual(seen.ttsBodies[0], {
      model: 'kokoro-fixed',
      text: '你好飞剪',
      language: 'zh',
      voiceId: 'zf_xiaobei',
      speed: 1.1,
      options: { pitch: 2 },
    });
    const assetRes = await fetch(`${host.base}/assets/${synthResult.assetId}`, {
      headers: { Authorization: 'Bearer f0053-token' },
    });
    assert.equal(assetRes.status, 200);
    assert.ok(Buffer.from(await assetRes.arrayBuffer()).equals(validWav));

    // ASR works on the exact same Provider instance
    const wavAssetId = await host.upload(Buffer.from(await encodePcmWav(new Float32Array(1600)).arrayBuffer()));
    const asrJob = await host.waitJob((await host.call<JobSnapshot>('workflow.start', {
      asr: { providerId: 'flycut:unified', modelId: 'multi-asr', language: 'zh', assetId: wavAssetId },
    })).id);
    assert.equal(asrJob.status, 'complete', asrJob.error);

    // Cloning gate: unsupported model rejected; missing authorization rejected; authorized cloning succeeds
    const refAssetId = await host.upload(validWav);
    const cloneUnsupported = await host.waitJob((await host.call<JobSnapshot>('tts.synthesize', {
      request: {
        providerId: 'flycut:unified',
        modelId: 'kokoro-fixed',
        text: '不允许克隆',
        language: 'zh',
        cloneReferenceAssetId: refAssetId,
        cloneAuthorization: { confirmed: true, statement: TTS_CLONE_AUTH_STATEMENT_ZH, confirmedAt: new Date().toISOString() },
      },
    })).id);
    assert.equal(cloneUnsupported.status, 'error');
    assert.match(cloneUnsupported.error!, /不支持声音克隆/);

    const cloneNoAuth = await host.waitJob((await host.call<JobSnapshot>('tts.synthesize', {
      request: {
        providerId: 'flycut:unified',
        modelId: 'cosyvoice-clone',
        text: '未授权不能克隆',
        language: 'zh',
        cloneReferenceAssetId: refAssetId,
      },
    })).id);
    assert.equal(cloneNoAuth.status, 'error');
    assert.match(cloneNoAuth.error!, /授权确认/);

    const cloneOk = await host.waitJob((await host.call<JobSnapshot>('tts.synthesize', {
      request: {
        providerId: 'flycut:unified',
        modelId: 'cosyvoice-clone',
        text: '本人授权测试',
        language: 'zh',
        cloneReferenceAssetId: refAssetId,
        cloneAuthorization: {
          confirmed: true,
          statement: TTS_CLONE_AUTH_STATEMENT_ZH,
          confirmedAt: '2026-11-13T10:00:00.000Z',
          sourceLabel: 'my-voice.wav',
        },
      },
    })).id);
    assert.equal(cloneOk.status, 'complete', cloneOk.error);
    assert.equal((cloneOk.result as any).cloned, true);
    assert.equal(seen.ttsHeaders[0].meta.authorization.confirmed, true);
    assert.equal(seen.ttsHeaders[0].meta.authorization.statement, TTS_CLONE_AUTH_STATEMENT_ZH);
    assert.equal(seen.ttsHeaders[0].referenceBytes, validWav.byteLength);

    // Corrupt audio & cross-origin URL rejection
    mode = 'corrupt';
    const corruptJob = await host.waitJob((await host.call<JobSnapshot>('tts.synthesize', {
      request: { providerId: 'flycut:unified', modelId: 'kokoro-fixed', text: 'corrupt', voiceId: 'zf_xiaobei', language: 'zh' },
    })).id);
    assert.equal(corruptJob.status, 'error');
    assert.match(corruptJob.error!, /非音频|文本/);

    mode = 'cross-origin';
    const crossOriginJob = await host.waitJob((await host.call<JobSnapshot>('tts.synthesize', {
      request: { providerId: 'flycut:unified', modelId: 'kokoro-fixed', text: 'ssrf', voiceId: 'zf_xiaobei', language: 'zh' },
    })).id);
    assert.equal(crossOriginJob.status, 'error');
    assert.match(crossOriginJob.error!, /跨源/);

    // Auth failure does not leak key
    mode = 'auth-fail';
    const authFailJob = await host.waitJob((await host.call<JobSnapshot>('tts.synthesize', {
      request: { providerId: 'flycut:unified', modelId: 'kokoro-fixed', text: 'auth', voiceId: 'zf_xiaobei', language: 'zh' },
    })).id);
    assert.equal(authFailJob.status, 'error');
    assert.match(authFailJob.error!, /鉴权失败/);
    assert.ok(!authFailJob.error!.includes('secret-tts-key-999'));

    // Cancellation propagates to remote /v1/jobs/{id}/cancel
    mode = 'slow';
    const slowJob = await host.call<JobSnapshot>('tts.synthesize', {
      request: { providerId: 'flycut:unified', modelId: 'kokoro-fixed', text: 'cancel me', voiceId: 'zf_xiaobei', language: 'zh' },
    });
    await setTimeout(120);
    const cancelled = await host.call<JobSnapshot>('jobs.cancel', { id: slowJob.id });
    assert.equal(cancelled.status, 'cancelled');
    await setTimeout(60);
    assert.equal(seen.cancelled, true);

    // Capabilities without 'tts' refuse TTS calls
    mode = 'ok';
    capabilities = ['asr'];
    await host.call('endpoints.save', { name: 'asr-only', label: 'ASR Only', protocol: 'flycut', baseUrl: serviceUrl });
    const noCapJob = await host.waitJob((await host.call<JobSnapshot>('tts.synthesize', {
      request: { providerId: 'flycut:asr-only', modelId: 'kokoro-fixed', text: 'no cap', voiceId: 'zf_xiaobei', language: 'zh' },
    })).id);
    assert.equal(noCapJob.status, 'error');
    assert.match(noCapJob.error!, /未声明 tts 能力/);

    // Ensure secret key was never persisted anywhere on disk
    const endpointsJson = await readFile(join(host.home, 'app-data/endpoints.json'), 'utf8');
    assert.ok(!endpointsJson.includes('secret-tts-key-999'));
    const jobJson = await readFile(join(host.home, 'jobs', `${authFailJob.id}.json`), 'utf8');
    assert.ok(!jobJson.includes('secret-tts-key-999'));
  } finally {
    await host.close();
    await new Promise<void>(resolve => service.close(() => resolve()));
  }
});

test('F-0053/AC-7 AC-8 tts.getSettings and tts.saveSettings persist across Host restarts, enforce revision conflicts, and deduplicate by operationId', async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0053-persist-'));
  const host1 = await createHost({ home, token: 'p1', port: 0, resourceRoot: resolve('.') }, { profile: 'desktop', patches: [] });
  const url1 = `http://127.0.0.1:${(host1.httpServer.address() as { port: number }).port}`;
  const call1 = async (method: string, payload: unknown = {}) => {
    const res = await fetch(`${url1}/rpc`, {
      method: 'POST',
      headers: { Authorization: 'Bearer p1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
    });
    return (await res.json()).result;
  };
  try {
    const initial = (await call1('tts.getSettings')).value;
    assert.equal(initial.revision, 0);
    assert.equal(initial.selectedModel, null);

    const opId = crypto.randomUUID();
    const settings = {
      selectedModel: { providerId: 'flycut:tts', modelId: 'kokoro-v1' },
      voiceId: 'zf_xiaobei',
      language: 'zh',
      speed: 1.2,
      options: { format: 'wav' },
    };
    const saved = (await call1('tts.saveSettings', {
      hostId: initial.hostId,
      expectedRevision: 0,
      operationId: opId,
      settings,
    })).value;
    assert.equal(saved.status, 'saved');
    assert.equal(saved.snapshot.revision, 1);
    assert.equal(saved.snapshot.lastOperationId, opId);

    // Uncertain-save retry with same operationId is idempotent even at stale revision 0
    const retried = (await call1('tts.saveSettings', {
      hostId: initial.hostId,
      expectedRevision: 0,
      operationId: opId,
      settings,
    })).value;
    assert.equal(retried.status, 'saved');
    assert.equal(retried.duplicate, true);
    assert.equal(retried.snapshot.revision, 1);

    // Stale expectedRevision with a different write returns conflict without overwriting
    const conflict = (await call1('tts.saveSettings', {
      hostId: initial.hostId,
      expectedRevision: 0,
      settings: { ...settings, voiceId: 'af_heart' },
    })).value;
    assert.equal(conflict.status, 'conflict');
    assert.equal(conflict.snapshot.voiceId, 'zf_xiaobei');
    assert.equal(conflict.snapshot.revision, 1);

    await host1.fiber.dispose();

    // Reopen Host: settings survive with exact same hostId & revision
    const host2 = await createHost({ home, token: 'p2', port: 0, resourceRoot: resolve('.') }, { profile: 'desktop', patches: [] });
    const url2 = `http://127.0.0.1:${(host2.httpServer.address() as { port: number }).port}`;
    try {
      const res = await fetch(`${url2}/rpc`, {
        method: 'POST',
        headers: { Authorization: 'Bearer p2', 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'reopen', method: 'tts.getSettings', payload: {} }),
      });
      const reopened = (await res.json()).result.value;
      assert.equal(reopened.hostId, initial.hostId);
      assert.equal(reopened.revision, 1);
      assert.deepEqual(reopened.selectedModel, settings.selectedModel);
      assert.equal(reopened.voiceId, 'zf_xiaobei');
      assert.equal(reopened.speed, 1.2);
    } finally {
      await host2.fiber.dispose();
    }
  } finally {
    await host1.fiber.dispose().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  }
});

test('F-0053/AC-1 AC-2 OpenAI-compatible endpoint supports mixed ASR+TTS models without cloning', async () => {
  const wav = makeValidWav(0.2, 16000);
  const upstream = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer oa-key');
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.url === '/v1/audio/speech') {
      const payload = JSON.parse(body);
      assert.equal(payload.model, 'tts-1');
      assert.equal(payload.voice, 'nova');
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end(wav);
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const host = await bootHost();
  try {
    await host.call('endpoints.save', {
      name: 'oa-tts',
      label: 'OpenAI TTS',
      protocol: 'openai',
      baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`,
      apiKey: 'oa-key',
      models: [{ id: 'tts-1', role: 'tts', timestamps: 'none', voices: ['nova', 'alloy'], languages: ['en', 'zh'] }],
    });
    assert.equal(host.ctx.providers.get('openai:oa-tts').transcribe, undefined);
    const job = await host.waitJob((await host.call<JobSnapshot>('tts.synthesize', {
      request: { providerId: 'openai:oa-tts', modelId: 'tts-1', text: 'hello world', voiceId: 'nova', language: 'en' },
    })).id);
    assert.equal(job.status, 'complete', job.error);
    assert.equal((job.result as any).format, 'wav');
  } finally {
    await host.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

test('F-0053/AC-2 AC-4 reference HTTP TTS server contract is reproducible end-to-end with Host', async () => {
  const example = await startExampleTtsServer({ port: 0, token: 'demo-tts-secret' });
  const host = await bootHost();
  try {
    await host.call('endpoints.save', {
      name: 'example-tts',
      label: 'Example TTS Server',
      protocol: 'flycut',
      baseUrl: example.url,
      apiKey: 'demo-tts-secret',
    });
    const groups = await host.call('providers.models');
    const group = groups.find((g: any) => g.provider.id === 'flycut:example-tts');
    assert.ok(group);
    assert.equal(group.models.length, 2);
    assert.equal(group.models[0].tts.voiceCloning, false);
    assert.equal(group.models[1].tts.voiceCloning, true);

    const synth = await host.waitJob((await host.call<JobSnapshot>('tts.synthesize', {
      request: {
        providerId: 'flycut:example-tts',
        modelId: 'kokoro-demo',
        text: '测试示例服务试听',
        voiceId: 'zf_xiaobei',
        language: 'zh',
        speed: 1.0,
      },
    })).id);
    assert.equal(synth.status, 'complete', synth.error);
    const assetRes = await fetch(`${host.base}/assets/${(synth.result as any).assetId}`, {
      headers: { Authorization: 'Bearer f0053-token' },
    });
    assert.equal(assetRes.status, 200);
    const audioBytes = Buffer.from(await assetRes.arrayBuffer());
    const checked = validateTtsAudio(audioBytes, 'audio/wav');
    assert.equal(checked.format, 'wav');
    assert.ok((checked.durationSeconds ?? 0) > 0.2);

    // Second independent client connected to the same live Host reads consistent settings & audition
    const initialSettings = await host.call('tts.getSettings');
    const saveRes = await host.call('tts.saveSettings', {
      hostId: initialSettings.hostId,
      expectedRevision: initialSettings.revision,
      settings: {
        selectedModel: { providerId: 'flycut:example-tts', modelId: 'kokoro-demo' },
        voiceId: 'zf_xiaobei',
        language: 'zh',
        speed: 1.0,
        options: {},
      },
    });
    assert.equal(saveRes.status, 'saved');

    const secondClientRes = await fetch(`${host.base}/rpc`, {
      method: 'POST',
      headers: { Authorization: 'Bearer f0053-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'client-2', method: 'tts.getSettings', payload: {} }),
    });
    const client2Snapshot = (await secondClientRes.json()).result.value;
    assert.deepEqual(client2Snapshot.selectedModel, { providerId: 'flycut:example-tts', modelId: 'kokoro-demo' });
    assert.equal(client2Snapshot.voiceId, 'zf_xiaobei');
    assert.equal(client2Snapshot.revision, saveRes.snapshot.revision);
    assert.equal(client2Snapshot.lastAudition.assetId, (synth.result as any).assetId);
  } finally {
    await host.close();
    await example.close();
  }
});

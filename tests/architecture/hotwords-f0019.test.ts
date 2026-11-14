import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createHost } from '../../server/app';
import type { JobSnapshot } from '../../shared/protocol';
import type { SaveTerminologyResult, TerminologySnapshot } from '../../shared/terminology';
import { encodePcmWav } from '../../shared/asr/apiProtocol';

async function bootHost(home?: string) {
  const resolvedHome = home ?? await mkdtemp(join(tmpdir(), 'flycut-f0019-host-'));
  const token = 'f0019-test-token';
  const ctx = await createHost({ home: resolvedHome, token, port: 0, resourceRoot: resolve('.') }, {
    profile: 'desktop',
    patches: [{ source: 'f0019-test', patch: { config: { 'ai-settings': { secretBackend: 'memory' } } } }],
  });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const call = async <T = any>(method: string, payload: unknown = {}): Promise<T> => {
    const response = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
    });
    const envelope = await response.json() as any;
    if (!envelope.result.ok) {
      const err = new Error(envelope.result.error.message) as Error & { code?: string };
      err.code = envelope.result.error.code;
      throw err;
    }
    return envelope.result.value;
  };
  const waitJob = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const job = await call<JobSnapshot>('jobs.get', { id });
      if (['complete', 'error', 'cancelled'].includes(job.status)) return job;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`Job ${id} timed out`);
  };
  const upload = async (bytes: Buffer) => {
    const response = await fetch(`${base}/assets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: new Uint8Array(bytes),
    });
    assert.equal(response.status, 201);
    return ((await response.json()) as { assetId: string }).assetId;
  };
  return { home: resolvedHome, ctx, base, call, waitJob, upload };
}

test('F-0019/AC-1 AC-7 AC-8 terminology persists across Host restart, preserves F-0032 translations, detects baseRevision conflict, and deduplicates by operationId', async () => {
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0019-persist-'));
  const host1 = await bootHost(home);
  let projectId = '';
  try {
    const wav = Buffer.from(await encodePcmWav(new Float32Array(16000)).arrayBuffer());
    const assetId = await host1.upload(wav);
    const created = await host1.call<{ projectId: string; videoId: string }>('projects.create', {
      name: '热词口播测试',
      videoName: 'talk.wav',
      durationSeconds: 1,
      media: { assetId, mimeType: 'audio/wav' },
    });
    projectId = created.projectId;

    const opId = randomUUID();
    const saved1 = await host1.call<SaveTerminologyResult>('projects.saveTerminology', {
      projectId,
      baseRevision: 0,
      operationId: opId,
      terms: [
        { term: 'FlyCut', asHotword: true, weight: 2.5, translations: { en: 'FlyCut' } },
        { term: '  flycut  ', asHotword: true },
        { term: 'FunASR', asHotword: true, weight: 1.8 },
      ],
    });
    assert.equal(saved1.status, 'saved');
    if (saved1.status === 'saved') {
      assert.equal(saved1.revision, 1);
      assert.equal(saved1.terminology.length, 2);
      assert.deepEqual(saved1.terminology[0].translations, { en: 'FlyCut' });
    }

    // Idempotent retry returns exact same result without bumping revision
    const retry1 = await host1.call<SaveTerminologyResult>('projects.saveTerminology', {
      projectId,
      baseRevision: 0,
      operationId: opId,
      terms: [{ term: 'FlyCut', asHotword: true }],
    });
    assert.equal(retry1.status, 'saved');
    if (retry1.status === 'saved') assert.equal(retry1.revision, 1);

    // Stale baseRevision returns conflict without overwriting
    const conflict = await host1.call<SaveTerminologyResult>('projects.saveTerminology', {
      projectId,
      baseRevision: 0,
      terms: [{ term: 'Other', asHotword: true }],
    });
    assert.equal(conflict.status, 'conflict');
    assert.equal(conflict.revision, 1);

    // Update term without specifying translations -> existing F-0032 translations stay intact
    const saved2 = await host1.call<SaveTerminologyResult>('projects.saveTerminology', {
      projectId,
      baseRevision: 1,
      terms: [
        { term: 'FlyCut', asHotword: true, weight: 3 },
        { term: 'FunASR', asHotword: true, weight: 2 },
      ],
    });
    assert.equal(saved2.status, 'saved');
    if (saved2.status === 'saved') {
      assert.deepEqual(saved2.terminology[0].translations, { en: 'FlyCut' });
    }
  } finally {
    await host1.ctx.fiber.dispose();
  }

  // Reopen in fresh Host process (simulating restart & second client)
  const host2 = await bootHost(home);
  try {
    const snap = await host2.call<TerminologySnapshot>('projects.getTerminology', { projectId });
    assert.equal(snap.revision, 2);
    assert.equal(snap.terminology.length, 2);
    assert.equal(snap.terminology[0].weight, 3);
    assert.deepEqual(snap.terminology[0].translations, { en: 'FlyCut' });
  } finally {
    await host2.ctx.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  }
});

test('F-0019/AC-2 AC-3 AC-4 enforces model capabilities, sends 0 hotwords to unsupported models, and compares ON vs OFF on real HTTP ASR', async () => {
  const seenHeaders: Array<{ model: string; hotwords?: string; options?: string }> = [];
  const jobs = new Map<string, any>();
  const httpAsr = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/v1/health') {
      json(200, { protocol: 'flycut-provider', version: 1, name: 'MockHotwordASR', capabilities: ['asr'] });
      return;
    }
    if (url.pathname === '/v1/models') {
      json(200, {
        models: [
          {
            id: 'paraformer-hotword',
            name: 'Paraformer Hotword',
            role: 'asr',
            languages: ['zh', 'en'],
            timestampLevel: 'word',
            status: 'ready',
            hotwords: { supported: true, weights: true, format: 'weighted-lines' },
          },
          {
            id: 'no-hotword-model',
            name: 'Plain ASR',
            role: 'asr',
            languages: ['zh', 'en'],
            timestampLevel: 'segment',
            status: 'ready',
            hotwords: { supported: false },
          },
        ],
      });
      return;
    }
    if (url.pathname === '/v1/asr/jobs' && req.method === 'POST') {
      for await (const chunk of req) { void chunk; }
      const model = String(req.headers['x-flycut-model'] ?? '');
      const hotwords = req.headers['x-flycut-hotwords'] ? String(req.headers['x-flycut-hotwords']) : undefined;
      const options = req.headers['x-flycut-options'] ? String(req.headers['x-flycut-options']) : undefined;
      seenHeaders.push({ model, hotwords, options });
      const parsedHw = hotwords ? JSON.parse(hotwords) as Array<{ term: string; weight?: number }> : [];
      const hasFlycut = parsedHw.some((h) => h.term === 'FlyCut' && h.term !== 'other');
      const hasDeepMind = parsedHw.some((h) => h.term === 'DeepMind');
      const text = hasFlycut && hasDeepMind
        ? '今天我们在 DeepMind 团队介绍 FlyCut 工具'
        : '今天我们在迪普迈德团队介绍飞卡特工具';
      const id = randomUUID();
      jobs.set(id, {
        id,
        status: 'complete',
        result: {
          text,
          language: 'zh',
          duration: 2,
          hasWordTimestamps: false,
          chunks: [{ id: 'c1', text, timestamp: [0, 2] }],
        },
      });
      json(202, { id });
      return;
    }
    if (url.pathname.startsWith('/v1/jobs/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop() ?? '');
      json(200, jobs.get(id) ?? { id, status: 'error', error: 'missing' });
      return;
    }
    json(404, { error: 'not found' });
  });
  await new Promise<void>((resolveListen) => httpAsr.listen(0, '127.0.0.1', resolveListen));
  const asrPort = (httpAsr.address() as { port: number }).port;

  const host = await bootHost();
  try {
    // Built-in sherpa-onnx models must truthfully declare hotwords.supported = false
    const groups = await host.call<any[]>('providers.models');
    const sherpa = groups.find((g) => g.provider.id === 'sherpa-onnx');
    assert.ok(sherpa);
    for (const m of sherpa.models.filter((x: any) => x.role === 'asr')) {
      assert.equal(m.hotwords?.supported, false);
    }

    await host.call('endpoints.save', {
      name: 'hw-asr',
      label: 'Hotword Test ASR',
      protocol: 'flycut',
      baseUrl: `http://127.0.0.1:${asrPort}`,
    });

    const wav = Buffer.from(await encodePcmWav(new Float32Array(32000)).arrayBuffer());
    const assetId = await host.upload(wav);
    const created = await host.call<{ projectId: string; videoId: string }>('projects.create', {
      name: '术语对比',
      videoName: 'sample.wav',
      durationSeconds: 2,
      media: { assetId, mimeType: 'audio/wav' },
    });

    // 1. Unsupported model: direct workflow with hotwords must fail explicitly
    const badJob = await host.call<JobSnapshot>('workflow.start', {
      asr: { providerId: 'flycut:hw-asr', modelId: 'no-hotword-model', assetId: await host.upload(wav), language: 'zh', hotwords: [{ term: 'FlyCut' }] },
    });
    const badDone = await host.waitJob(badJob.id);
    assert.equal(badDone.status, 'error');
    assert.match(badDone.error ?? '', /不支持热词/);

    // 2. Transcribe with hotwords OFF (empty terminology)
    const offJob = await host.call<JobSnapshot>('projects.transcribe', {
      projectId: created.projectId,
      model: { providerId: 'flycut:hw-asr', modelId: 'paraformer-hotword' },
      language: 'zh',
    });
    const offDone = await host.waitJob(offJob.id);
    assert.equal(offDone.status, 'complete', offDone.error);
    const offOpen = await host.call<any>('projects.open', { projectId: created.projectId });
    assert.match(offOpen.transcript.text, /迪普迈德.*飞卡特/);

    // 3. Save terminology and transcribe with hotwords ON
    await host.call('projects.saveTerminology', {
      projectId: created.projectId,
      baseRevision: 0,
      terms: [
        { term: 'DeepMind', asHotword: true, weight: 4 },
        { term: 'FlyCut', asHotword: true, weight: 3 },
      ],
    });

    // Unsupported model via projects.transcribe sends 0 hotwords and succeeds as plain recognition
    const plainJob = await host.call<JobSnapshot>('projects.transcribe', {
      projectId: created.projectId,
      model: { providerId: 'flycut:hw-asr', modelId: 'no-hotword-model' },
      language: 'zh',
    });
    const plainDone = await host.waitJob(plainJob.id);
    assert.equal(plainDone.status, 'complete', plainDone.error);

    const onJob = await host.call<JobSnapshot>('projects.transcribe', {
      projectId: created.projectId,
      model: { providerId: 'flycut:hw-asr', modelId: 'paraformer-hotword' },
      language: 'zh',
    });
    const onDone = await host.waitJob(onJob.id);
    assert.equal(onDone.status, 'complete', onDone.error);
    const onOpen = await host.call<any>('projects.open', { projectId: created.projectId });
    assert.match(onOpen.transcript.text, /DeepMind.*FlyCut/);

    const unsupportedReq = seenHeaders.find((h) => h.model === 'no-hotword-model');
    assert.equal(unsupportedReq?.hotwords, undefined);
    const supportedReq = seenHeaders.find((h) => h.model === 'paraformer-hotword' && h.hotwords);
    assert.ok(supportedReq?.hotwords);
    assert.deepEqual(JSON.parse(supportedReq.hotwords), [
      { term: 'DeepMind', weight: 4 },
      { term: 'FlyCut', weight: 3 },
    ]);
  } finally {
    await host.ctx.fiber.dispose();
    await rm(host.home, { recursive: true, force: true });
    await new Promise<void>((r) => httpAsr.close(() => r()));
  }
});

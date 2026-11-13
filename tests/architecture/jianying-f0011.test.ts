import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createHost } from '../../server/app';
import { generateJianyingDraft, probeJianyingMedia } from '../../server/jianying/generate';
import { ProjectStore, fingerprintFile } from '../../server/projects/store';
import { createEdl } from '../../shared/editing/edl';
import {
  buildJianyingCapabilities, buildJianyingDraft, JIANYING_CAPABILITIES, jianyingDegradations,
  type JianyingSnapshot,
} from '../../shared/jianying/draft';

const execFileAsync = promisify(execFile);
const demo = resolve('src/assets/demo.mp4');

async function shortVideo(directory: string): Promise<string> {
  const output = join(directory, 'f0011-source.mp4');
  await execFileAsync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-t', '18', '-i', demo, '-c', 'copy', output]);
  return output;
}

function sampleSnapshot(durationUs: number, width: number, height: number): JianyingSnapshot {
  return {
    edl: createEdl(durationUs / 1_000_000, [{ start: 2, end: 2.5 }, { start: 8, end: 9 }]),
    // Deliberately independent labels and non-overlapping source ranges: importing can reorder overlapping text.
    cues: [
      { id: 'cue-a', text: 'F0011 A 01-01.8', secondText: 'Secondary subtitle', timestamp: [1, 1.8] },
      { id: 'cue-b', text: 'F0011 B 03-07', timestamp: [3, 7] },
      { id: 'cue-c', text: 'F0011 C 10-12', timestamp: [10, 12] },
    ],
    style: {
      fontId: 'inter', fontSizeRatio: 0.045, bottomOffsetRatio: 60 / 1080, fontWeight: 'bold', fontStyle: 'normal',
      textDecoration: 'none', color: '#FFFFFF', colorOpacity: 1, backgroundColor: '#000000', borderColor: '#111111',
      borderOpacity: 1, textAlign: 'center', lineHeight: 1.2, letterSpacing: 0, borderWidth: 2, backgroundOpacity: 0,
    },
    videoWidth: width, videoHeight: height,
    projectId: '00000000-0000-4000-8000-000000000011', projectName: '口播项目',
    videoId: '00000000-0000-4000-8000-000000000012', videoName: 'demo.mp4',
  };
}

async function setup(options: { internal?: boolean; profile?: string; home?: string; allowLinkedMedia?: boolean } = {}) {
  const home = options.home ?? await mkdtemp(join(tmpdir(), 'flycut-f0011-host-'));
  const output = join(home, 'output');
  await mkdir(output, { recursive: true });
  const ctx = await createHost({ home, token: 'f0011-client', port: 0, resourceRoot: resolve('.'), shellToken: 'f0011-shell' }, {
    profile: options.profile,
    providers: [],
    patches: [{ source: 'F-0011 test', patch: { disable: [], enable: [], plugins: [],
      config: { jianying: { internalValidation: options.internal === true, allowLinkedMedia: options.allowLinkedMedia !== false } } } }],
  });
  const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
  const call = async <T = unknown>(method: string, payload: unknown = {}): Promise<T> => {
    const rpcId = crypto.randomUUID();
    const response = await fetch(`${base}/rpc`, { method: 'POST',
      headers: { Authorization: 'Bearer f0011-client', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }) });
    const envelope = await response.json() as { rpcId: string; result: { ok: boolean; value?: T; error?: { message: string } } };
    assert.equal(envelope.rpcId, rpcId);
    if (!envelope.result.ok) throw new Error(envelope.result.error?.message ?? 'RPC failed');
    return envelope.result.value as T;
  };
  const upload = async (bytes: Buffer) => {
    const response = await fetch(`${base}/assets`, { method: 'POST', headers: { Authorization: 'Bearer f0011-client' }, body: bytes });
    assert.equal(response.status, 201);
    return (await response.json() as { assetId: string }).assetId;
  };
  const registerDirectory = async (path = output) => {
    const response = await fetch(`${base}/shell/jianying/directories`, { method: 'POST',
      headers: { Authorization: 'Bearer f0011-shell', 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
    assert.equal(response.status, 201);
    return await response.json() as { grant: string; expiresAt: string };
  };
  const waitJob = async (id: string) => {
    for (let index = 0; index < 200; index++) {
      const job = await call<{ id: string; status: string; result?: unknown; error?: string }>('jobs.get', { id });
      if (['complete', 'error', 'cancelled'].includes(job.status)) return job;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
    }
    throw new Error('Jianying job did not settle');
  };
  return { home, output, ctx, base, call, upload, registerDirectory, waitJob,
    async dispose() { await ctx.fiber.dispose(); },
    async close() { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }); } };
}

test('F-0011/AC-1 normal Host fails closed while the explicit validation build exposes the write path', async () => {
  assert.equal(JIANYING_CAPABILITIES.exportEnabled, false);
  assert.equal(JIANYING_CAPABILITIES.verifiedByImport, false);
  assert.equal(JIANYING_CAPABILITIES.targets.find(target => target.id === 'jianying-macos-11.7.0')?.status, 'observed-unverified');
  assert.equal(buildJianyingCapabilities(true).exportMode, 'internal-validation');
  const normal = await setup({ internal: false });
  try {
    const methods = normal.ctx.rpc.methods();
    assert.ok(methods.includes('jianying.capabilities'));
    assert.equal(methods.includes('jianying.preflight'), false);
    assert.equal(methods.includes('jianying.start'), false);
    assert.equal(normal.ctx.rpc.match('POST', '/shell/jianying/directories'), undefined);
    const capabilities = await normal.call<ReturnType<typeof buildJianyingCapabilities>>('jianying.capabilities');
    assert.equal(capabilities.exportEnabled, false);
    await assert.rejects(normal.call('jianying.start', { preflightId: crypto.randomUUID() }), /Unknown RPC method/);
  } finally { await normal.close(); }

  const internal = await setup({ internal: true });
  try {
    const capabilities = await internal.call<ReturnType<typeof buildJianyingCapabilities>>('jianying.capabilities');
    assert.equal(capabilities.exportEnabled, true);
    assert.equal(capabilities.exportMode, 'internal-validation');
    assert.ok(internal.ctx.rpc.methods().includes('jianying.preflight'));
    assert.ok(internal.ctx.rpc.methods().includes('jianying.start'));
  } finally { await internal.close(); }
});

test('F-0011/AC-2 AC-3 AC-4 AC-7 AC-8 shell-only opaque grant produces independently checked draft', async () => {
  const host = await setup({ internal: true });
  try {
    const source = await shortVideo(host.home);
    const sourceBefore = await stat(source);
    const probe = await probeJianyingMedia(source);
    const snapshot = sampleSnapshot(probe.durationUs, probe.width, probe.height);
    const assetId = await host.upload(await readFile(source));

    const unauthenticated = await fetch(`${host.base}/shell/jianying/directories`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: host.output }) });
    assert.equal(unauthenticated.status, 401);
    const browserAttempt = await fetch(`${host.base}/shell/jianying/directories`, { method: 'POST',
      headers: { Authorization: 'Bearer f0011-shell', Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: host.output }) });
    assert.equal(browserAttempt.status, 401);

    const directory = await host.registerDirectory();
    const preflight = await host.call<any>('jianying.preflight', {
      directoryGrant: directory.grant, draftName: 'F0011 independent timing', source: { kind: 'asset', assetId }, snapshot,
    });
    assert.equal(preflight.mediaStrategy, 'copy');
    assert.equal(preflight.videoSegmentCount, 3);
    assert.equal(preflight.textSegmentCount, 3);
    assert.ok(preflight.estimatedBytes >= sourceBefore.size);
    await assert.rejects(host.call('jianying.preflight', {
      directoryGrant: directory.grant, draftName: 'reuse', source: { kind: 'asset', assetId }, snapshot,
    }), /already prepared/);
    await assert.rejects(host.call('jianying.preflight', {
      directoryGrant: directory.grant, draftName: 'extra path', source: { kind: 'asset', assetId }, snapshot, outputParent: '/tmp/arbitrary',
    }), /Unrecognized key|invalid input|expected/i);

    const job = await host.call<any>('jianying.start', { preflightId: preflight.preflightId });
    const settled = await host.waitJob(job.id);
    assert.equal(settled.status, 'complete', settled.error);
    const result = settled.result as any;
    assert.equal(result.draftName, 'F0011 independent timing');
    assert.equal(result.videoSegmentCount, 3);
    assert.equal(result.textSegmentCount, 3);

    // These expectations are literal and independent of the generator's projection/verifier implementation.
    const content = JSON.parse(await readFile(join(result.draftPath, 'draft_content.json'), 'utf8'));
    const sourceSeconds = probe.durationUs / 1e6;
    assert.deepEqual(content.tracks[0].segments.map((segment: any) => [segment.source_timerange.start / 1e6,
      segment.source_timerange.duration / 1e6, segment.target_timerange.start / 1e6]),
    [[0, 2, 0], [2.5, 5.5, 2], [9, sourceSeconds - 9, 7.5]]);
    const textSegments = content.tracks[1].segments.map((segment: any) => [segment.target_timerange.start / 1e6,
      segment.target_timerange.duration / 1e6, segment.material_id]);
    assert.deepEqual(textSegments.map((segment: any[]) => segment.slice(0, 2)), [[1, 0.8], [2.5, 4], [8.5, 2]]);
    const texts = new Map(content.materials.texts.map((material: any) => [material.id, JSON.parse(material.content).text]));
    assert.deepEqual(textSegments.map((segment: any[]) => texts.get(segment[2])), ['F0011 A 01-01.8', 'F0011 B 03-07', 'F0011 C 10-12']);
    const copied = await stat(join(result.draftPath, 'materials'));
    assert.ok(copied.isDirectory());
    const media = (await readdir(join(result.draftPath, 'materials'))).find(name => name.endsWith('.mp4'));
    assert.ok(media);
    const sourceHash = createHash('sha256').update(await readFile(source)).digest('hex');
    const copiedHash = createHash('sha256').update(await readFile(join(result.draftPath, 'materials', media!))).digest('hex');
    assert.equal(copiedHash, sourceHash);
    assert.equal((await stat(source)).mtimeMs, sourceBefore.mtimeMs);
    await assert.rejects(stat(join(host.output, 'root_meta_info.json')));
    const repeated = await host.call<any>('jianying.start', { preflightId: preflight.preflightId });
    assert.equal(repeated.id, job.id);
    assert.equal(repeated.status, 'complete');
  } finally { await host.close(); }
});

test('F-0011/AC-5 start is idempotent after a lost response and across a Host restart', async () => {
  const first = await setup({ internal: true });
  let preflightId = '';
  try {
    const source = await shortVideo(first.home);
    const probe = await probeJianyingMedia(source);
    const snapshot = sampleSnapshot(probe.durationUs, probe.width, probe.height);
    const assetId = await first.upload(await readFile(source));
    const directory = await first.registerDirectory();
    const preflight = await first.call<any>('jianying.preflight', { directoryGrant: directory.grant,
      draftName: 'F0011 idempotent', source: { kind: 'asset', assetId }, snapshot });
    preflightId = preflight.preflightId;
    // Concurrent clicks share one request; then a lost-response retry must still find that same job.
    const [original, concurrent] = await Promise.all([
      first.call<any>('jianying.start', { preflightId }),
      first.call<any>('jianying.start', { preflightId }),
    ]);
    assert.equal(concurrent.id, original.id);
    const retry = await first.call<any>('jianying.start', { preflightId });
    assert.equal(retry.id, original.id);
    const settled = await first.waitJob(original.id);
    assert.equal(settled.status, 'complete', settled.error);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
    await first.dispose();

    const next = await setup({ internal: true, home: first.home });
    try {
      const resumed = await next.call<any>('jianying.start', { preflightId });
      assert.equal(resumed.id, original.id);
      assert.equal(resumed.status, 'complete');
      assert.equal((await next.call<any>('jobs.list')).filter((job: any) => job.id === original.id).length, 1);
    } finally { await next.close(); }
  } finally {
    await first.dispose().catch(() => undefined);
  }
});

test('F-0011/AC-3 server profile hard-denies linked project media despite a permissive patch', async () => {
  const host = await setup({ internal: true, profile: 'server', allowLinkedMedia: true });
  try {
    const source = await shortVideo(host.home);
    const probe = await probeJianyingMedia(source);
    const store = new ProjectStore(host.home);
    await store.init();
    const project = await store.create({ name: 'linked server', video: { name: 'linked.mp4', durationSeconds: probe.durationUs / 1e6 },
      media: async () => ({ kind: 'linked', path: source, ...await fingerprintFile(source) }) });
    const video = project.videos[0];
    const directory = await host.registerDirectory();
    await assert.rejects(host.call('jianying.preflight', { directoryGrant: directory.grant, draftName: 'F0011 server linked',
      source: { kind: 'project', projectId: project.id, videoId: video.id },
      snapshot: { ...sampleSnapshot(probe.durationUs, probe.width, probe.height), projectId: project.id, videoId: video.id } }),
    /does not allow linked local media/);
    assert.deepEqual(await readdir(host.output), []);
  } finally { await host.close(); }
});

test('F-0011/AC-3 AC-4 project source resolves media internally and overlapping subtitles fail closed', async () => {
  const host = await setup({ internal: true });
  try {
    const source = await shortVideo(host.home);
    const probe = await probeJianyingMedia(source);
    const snapshot = sampleSnapshot(probe.durationUs, probe.width, probe.height);
    const assetId = await host.upload(await readFile(source));
    const created = await host.call<any>('projects.create', { name: 'F0011 project', videoName: 'f0011-source.mp4',
      durationSeconds: probe.durationUs / 1e6, media: { assetId, mimeType: 'video/mp4' } });
    const projectSnapshot = { ...snapshot, projectId: created.projectId, videoId: created.videoId };
    const directory = await host.registerDirectory();
    const preflight = await host.call<any>('jianying.preflight', { directoryGrant: directory.grant,
      draftName: 'F0011 project source', source: { kind: 'project', projectId: created.projectId, videoId: created.videoId }, snapshot: projectSnapshot });
    assert.equal(preflight.videoSegmentCount, 3);

    const overlapDirectory = await host.registerDirectory();
    await assert.rejects(host.call('jianying.preflight', { directoryGrant: overlapDirectory.grant, draftName: 'F0011 overlap',
      source: { kind: 'project', projectId: created.projectId, videoId: created.videoId },
      snapshot: { ...projectSnapshot, cues: [{ id: 'a', text: 'A', timestamp: [1, 5] }, { id: 'b', text: 'B', timestamp: [4.5, 5.5] }] } }),
    /overlap/i);
    assert.deepEqual(await readdir(host.output), []);
  } finally { await host.close(); }
});

test('F-0011/AC-5 AC-6 cancellation and failures remove staging without touching existing folders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flycut-f0011-cancel-'));
  try {
    const source = await shortVideo(root);
    const probe = await probeJianyingMedia(source);
    const snapshot = sampleSnapshot(probe.durationUs, probe.width, probe.height);
    const output = join(root, 'output');
    await mkdir(join(output, 'existing'), { recursive: true });
    await writeFile(join(output, 'existing', 'keep.txt'), 'keep');
    await assert.rejects(generateJianyingDraft({ snapshot, sourcePath: join(root, 'missing.mp4'), outputParent: output, draftName: 'missing' }), /Source media is missing/);
    await assert.rejects(generateJianyingDraft({ snapshot, sourcePath: source, outputParent: output, draftName: 'existing' }), /already exists/);
    assert.equal(await readFile(join(output, 'existing', 'keep.txt'), 'utf8'), 'keep');

    const controller = new AbortController();
    await assert.rejects(generateJianyingDraft({ snapshot, sourcePath: source, outputParent: output, draftName: 'copy-cancel', signal: controller.signal,
      onProgress(progress) { if (progress.stage === 'copying') controller.abort(); } }), /cancelled/);
    await assert.rejects(generateJianyingDraft({ snapshot, sourcePath: source, outputParent: output, draftName: 'post-copy-failure',
      now: () => { throw new Error('injected post-copy failure'); } }), /injected post-copy failure/);
    assert.deepEqual((await readdir(output)).sort(), ['existing']);
    assert.equal((await readdir(join(output, 'existing'))).includes('copy-cancel'), false);

    const overlapping = { ...snapshot, cues: [{ id: 'a', text: 'A', timestamp: [1, 5] }, { id: 'b', text: 'B', timestamp: [4.5, 5.5] }] } as JianyingSnapshot;
    let ids = 0;
    assert.throws(() => buildJianyingDraft({ snapshot: overlapping, timestampUs: 1,
      media: { path: '/tmp/source.mp4', materialName: 'source.mp4', durationUs: probe.durationUs, width: probe.width, height: probe.height, size: 1 },
      location: { draftName: 'overlap', finalPath: '/tmp/overlap', parentPath: '/tmp' }, id: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}` }), /overlap/i);
    assert.ok(jianyingDegradations(snapshot).includes('secondary-subtitles-omitted'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

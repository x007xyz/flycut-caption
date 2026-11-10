import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createHost } from '../../server/app';
import { probeJianyingMedia, generateJianyingDraft } from '../../server/jianying/generate';
import { createEdl } from '../../shared/editing/edl';
import { buildJianyingDraft, JIANYING_CAPABILITIES, jianyingDegradations, type JianyingSnapshot } from '../../shared/jianying/draft';

const execFileAsync = promisify(execFile);
const demo = resolve('src/assets/demo.mp4');

async function shortVideo(directory: string): Promise<string> {
  const output = join(directory, 'f0011-source.mp4');
  await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-t', '18', '-i', demo, '-c', 'copy', output]);
  return output;
}

function sampleSnapshot(durationUs: number, width: number, height: number): JianyingSnapshot {
  return {
    edl: createEdl(durationUs / 1_000_000, [{ start: 2, end: 2.5 }, { start: 8, end: 9 }]),
    cues: [
      { id: 'cue-a', text: '第一段主字幕', secondText: 'Secondary subtitle', timestamp: [1, 3] },
      { id: 'cue-b', text: '跨切点字幕', timestamp: [7.5, 9.5] },
      { id: 'cue-c', text: '第三段字幕', timestamp: [12, 14] },
    ],
    style: {
      fontId: 'inter', fontSizeRatio: 0.045, bottomOffsetRatio: 60 / 1080, fontWeight: 'bold', fontStyle: 'normal',
      textDecoration: 'none', color: '#FFFFFF', colorOpacity: 1, backgroundColor: '#000000', borderColor: '#111111',
      borderOpacity: 1, textAlign: 'center', lineHeight: 1.2, letterSpacing: 0, borderWidth: 2, backgroundOpacity: 0,
    },
    videoWidth: width,
    videoHeight: height,
    projectId: '00000000-0000-4000-8000-000000000011', projectName: '口播项目',
    videoId: '00000000-0000-4000-8000-000000000012', videoName: 'demo.mp4',
  };
}

test('F-0011/AC-1 verified candidate stays disabled and has no export RPC', async () => {
  assert.equal(JIANYING_CAPABILITIES.verifiedByImport, false);
  assert.equal(JIANYING_CAPABILITIES.exportEnabled, false);
  assert.equal(JIANYING_CAPABILITIES.targets[0].status, 'unverified');
  const home = await mkdtemp(join(tmpdir(), 'flycut-f0011-cap-'));
  const ctx = await createHost({ home, token: 'f0011-cap', port: 0, resourceRoot: resolve('.') }, { gateway: false });
  try {
    const value = await ctx.rpc.invoke('jianying.capabilities', undefined) as typeof JIANYING_CAPABILITIES;
    assert.equal(value.verifiedByImport, false);
    assert.equal(value.exportEnabled, false);
    const methods = ctx.rpc.methods();
    assert.ok(methods.includes('jianying.capabilities'));
    assert.equal(methods.some(method => /^jianying\.(start|preflight|export)/.test(method)), false);
    assert.equal(methods.some(method => method.includes('grant') || method.includes('directory')), false);
  } finally {
    await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true });
  }
});

test('F-0011/AC-4 AC-7 real video candidate preserves EDL ranges, projected subtitles and copied media', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flycut-f0011-draft-'));
  try {
    const source = await shortVideo(root);
    const probe = await probeJianyingMedia(source);
    const snapshot = sampleSnapshot(probe.durationUs, probe.width, probe.height);
    const outputParent = join(root, 'output');
    await mkdir(outputParent);
    assert.deepEqual(jianyingDegradations(snapshot), [
      'secondary-subtitles-omitted', 'font-family-not-preserved', 'exact-text-position-not-preserved',
      'font-size-and-spacing-unverified', 'subtitle-frame-quantization-unverified',
    ]);
    const generated = await generateJianyingDraft({ snapshot, sourcePath: source, outputParent, draftName: 'F0011 候选草稿' });
    assert.equal(generated.videoSegmentCount, 3);
    assert.ok(generated.textSegmentCount >= 4);
    const contentBytes = await readFile(join(generated.draftPath, 'draft_content.json'));
    const infoBytes = await readFile(join(generated.draftPath, 'draft_info.json'));
    assert.deepEqual(contentBytes, infoBytes);
    const content = JSON.parse(contentBytes.toString('utf8'));
    assert.equal(content.version, 360000);
    assert.equal(content.platform.os, 'windows');
    assert.equal(content.tracks[0].segments.length, 3);
    assert.deepEqual(content.tracks[0].segments.map((segment: { source_timerange: { start: number } }) => segment.source_timerange.start),
      [0, 2_500_000, 9_000_000]);
    assert.equal(content.materials.videos[0].path, generated.mediaPath);
    assert.equal((await readdir(generated.draftPath)).some(name => name.includes('.tmp')), false);
    assert.equal((await stat(generated.mediaPath)).size, (await stat(source)).size);
    const sourceHash = createHash('sha256').update(await readFile(source)).digest('hex');
    assert.equal(generated.mediaSha256, sourceHash);
    assert.equal((await stat(generated.contentPath)).isFile(), true);
    assert.equal((await stat(join(outputParent, 'root_meta_info.json')).catch(() => undefined)), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('F-0011/AC-3 AC-5 AC-6 candidate harness refuses existing names and leaves no staging on cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flycut-f0011-cancel-'));
  try {
    const source = await shortVideo(root);
    const probe = await probeJianyingMedia(source);
    const snapshot = sampleSnapshot(probe.durationUs, probe.width, probe.height);
    const outputParent = join(root, 'output');
    await mkdir(join(outputParent, 'existing'), { recursive: true });
    await writeFile(join(outputParent, 'existing', 'keep.txt'), 'keep');
    await assert.rejects(generateJianyingDraft({ snapshot, sourcePath: source, outputParent, draftName: 'existing' }), /already exists/);
    assert.equal(await readFile(join(outputParent, 'existing', 'keep.txt'), 'utf8'), 'keep');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(generateJianyingDraft({ snapshot, sourcePath: source, outputParent, draftName: 'cancelled', signal: controller.signal }), /cancelled/);
    assert.deepEqual((await readdir(outputParent)).sort(), ['existing']);
    assert.equal((await readdir(join(outputParent, 'existing'))).includes('cancelled'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('F-0011/AC-7 builder keeps frozen integer-microsecond inputs without temporary suggestions', () => {
  const snapshot = sampleSnapshot(18_000_000, 1280, 720);
  const original = structuredClone(snapshot);
  let ids = 0;
  const bundle = buildJianyingDraft({ snapshot, timestampUs: 1_700_000_000_000_000,
    media: { path: '/tmp/draft/materials/source.mp4', materialName: 'source.mp4', durationUs: 18_000_000, width: 1280, height: 720, size: 12345 },
    location: { draftName: 'frozen', finalPath: '/tmp/draft', parentPath: '/tmp' },
    id: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}` });
  assert.deepEqual(snapshot, original);
  assert.equal(bundle.videoSegmentCount, 3);
  assert.equal((bundle.content.tracks as any[])[0].segments[1].source_timerange.start, 2_500_000);
  assert.equal((bundle.content.materials as any).texts.length, bundle.textSegmentCount);
  assert.deepEqual(bundle.degradationKeys.includes('secondary-subtitles-omitted'), true);
});

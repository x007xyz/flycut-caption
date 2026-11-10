import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { deriveKept, projectCues, toUs, type Cue } from '../../shared/editing/edl';
import { buildJianyingDraft, jianyingDraftNameSchema, type JianyingSnapshot } from '../../shared/jianying/draft';

export interface GenerateJianyingOptions {
  snapshot: JianyingSnapshot;
  sourcePath: string;
  outputParent: string;
  draftName: string;
  signal?: AbortSignal;
  now?: () => number;
  ffmpeg?: string;
}

export interface GeneratedJianyingDraft {
  draftName: string;
  draftPath: string;
  contentPath: string;
  mediaPath: string;
  mediaSha256: string;
  mediaBytes: number;
  videoSegmentCount: number;
  textSegmentCount: number;
}

export interface ProbeResult { durationUs: number; width: number; height: number; fps: number }

function assertNotAborted(signal?: AbortSignal) { if (signal?.aborted) throw new Error('Jianying draft generation cancelled'); }

async function sha256(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    assertNotAborted(signal);
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

function ffmpegArguments(ffmpeg: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout += String(data); });
    child.stderr.on('data', data => { if (stderr.length < 128 * 1024) stderr += String(data); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolvePromise({ stdout, stderr })
      : reject(new Error(`FFmpeg failed (${code ?? 'unknown'}): ${stderr.slice(-800)}`)));
  });
}

export async function probeJianyingMedia(sourcePath: string, ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'): Promise<ProbeResult> {
  const { stderr } = await ffmpegArguments(ffmpeg, ['-hide_banner', '-i', sourcePath, '-t', '0', '-f', 'null', '-']);
  const duration = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(stderr);
  const size = /Video:.*?,\s*(\d{2,5})x(\d{2,5})[\s,]/.exec(stderr);
  const fps = /(\d+(?:\.\d+)?)\s*fps/.exec(stderr);
  if (!duration || !size) throw new Error('Unable to probe source video dimensions or duration');
  return {
    durationUs: Math.round((Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1_000_000),
    width: Number(size[1]), height: Number(size[2]), fps: fps ? Number(fps[1]) : 30,
  };
}

async function ensureAbsent(path: string) {
  try { await lstat(path); throw new Error(`Draft target already exists: ${path}`); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function safeLeaf(value: string) { return value.replace(/[^a-zA-Z0-9._-]/g, '_'); }

export async function generateJianyingDraft(options: GenerateJianyingOptions): Promise<GeneratedJianyingDraft> {
  assertNotAborted(options.signal);
  const draftName = jianyingDraftNameSchema.parse(options.draftName);
  if (!isAbsolute(options.outputParent)) throw new Error('Output parent must be absolute');
  const parentInfo = await stat(options.outputParent).catch(() => undefined);
  if (!parentInfo?.isDirectory()) throw new Error('Output parent is not a directory');
  const parentPath = await realpath(options.outputParent);
  const finalPath = resolve(parentPath, draftName);
  const inside = relative(parentPath, finalPath);
  if (!inside || inside.startsWith('..') || inside.includes(sep)) throw new Error('Draft target escapes the selected parent');
  await ensureAbsent(finalPath);
  const sourceInfo = await stat(options.sourcePath).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Source media is missing');
    throw error;
  });
  if (!sourceInfo.isFile() || sourceInfo.size <= 0) throw new Error('Source media is missing or empty');
  assertNotAborted(options.signal);
  const probe = await probeJianyingMedia(options.sourcePath, options.ffmpeg);
  if (Math.abs(probe.durationUs - options.snapshot.edl.sourceDurationUs) > 50_000) throw new Error('EDL duration does not match source media');
  if (probe.width !== options.snapshot.videoWidth || probe.height !== options.snapshot.videoHeight) throw new Error('Snapshot dimensions do not match source media');

  const staging = join(parentPath, `.${draftName}.flycut-${randomUUID()}.tmp`);
  const materials = join(staging, 'materials');
  const extension = extname(options.sourcePath).toLowerCase() || '.mp4';
  const mediaName = `${safeLeaf(draftName)}-source${extension}`;
  const stagingMedia = join(materials, mediaName);
  const finalMedia = join(finalPath, 'materials', mediaName);
  let committed = false;
  try {
    await mkdir(materials, { recursive: true, mode: 0o700 });
    assertNotAborted(options.signal);
    await copyFile(options.sourcePath, stagingMedia);
    assertNotAborted(options.signal);
    const sourceHash = await sha256(options.sourcePath, options.signal);
    const copiedHash = await sha256(stagingMedia, options.signal);
    if (sourceHash !== copiedHash) throw new Error('Copied media hash does not match source media');

    const ffmpeg = options.ffmpeg || process.env.FFMPEG_PATH || 'ffmpeg';
    await ffmpegArguments(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '0', '-i', options.sourcePath,
      '-frames:v', '1', '-q:v', '4', join(staging, 'draft_cover.jpg')]);
    assertNotAborted(options.signal);
    const cover = await readFile(join(staging, 'draft_cover.jpg'));
    if (cover.length < 4 || cover[0] !== 0xff || cover[1] !== 0xd8 || cover[2] !== 0xff) throw new Error('Cover generation did not produce a JPEG');

    const timestampUs = (options.now ?? Date.now)() * 1000;
    const bundle = buildJianyingDraft({
      snapshot: options.snapshot, timestampUs, id: randomUUID,
      media: { path: finalMedia, materialName: mediaName, durationUs: probe.durationUs,
        width: probe.width, height: probe.height, size: sourceInfo.size },
      location: { draftName, finalPath, parentPath },
    });
    await writeFile(join(staging, 'draft_content.json'), bundle.contentText, 'utf8');
    await writeFile(join(staging, 'draft_info.json'), bundle.contentText, 'utf8');
    await writeFile(join(staging, 'draft_meta_info.json'), bundle.metaText, 'utf8');
    assertNotAborted(options.signal);

    await verifyJianyingDirectory({ directory: staging, finalPath, snapshot: options.snapshot, sourcePath: options.sourcePath,
      expectedMediaName: mediaName, expectedMediaSha256: copiedHash, expectedMediaBytes: sourceInfo.size, signal: options.signal });
    await ensureAbsent(finalPath);
    assertNotAborted(options.signal);
    await rename(staging, finalPath);
    committed = true;
    return { draftName, draftPath: finalPath, contentPath: join(finalPath, 'draft_content.json'), mediaPath: finalMedia,
      mediaSha256: copiedHash, mediaBytes: sourceInfo.size, videoSegmentCount: deriveKept(options.snapshot.edl).length,
      textSegmentCount: projectCues(options.snapshot.edl, options.snapshot.cues as Cue[]).filter(cue => cue.text.length > 0).length };
  } finally {
    if (!committed) await rm(staging, { recursive: true, force: true });
  }
}

export interface VerifyJianyingOptions {
  directory: string;
  finalPath: string;
  snapshot: JianyingSnapshot;
  sourcePath: string;
  expectedMediaName: string;
  expectedMediaSha256: string;
  expectedMediaBytes: number;
  signal?: AbortSignal;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid JSON object: ${path}`);
  return value as Record<string, unknown>;
}

export async function verifyJianyingDirectory(options: VerifyJianyingOptions): Promise<void> {
  const contentBytes = await readFile(join(options.directory, 'draft_content.json'));
  const infoBytes = await readFile(join(options.directory, 'draft_info.json'));
  if (!contentBytes.equals(infoBytes)) throw new Error('draft_content.json and draft_info.json are not byte-identical');
  type Timerange = { start?: number; duration?: number };
  type Segment = { material_id?: string; source_timerange?: Timerange | null; target_timerange?: Timerange;
    extra_material_refs?: string[] };
  type Track = { type?: string; segments?: Segment[] };
  type Material = { id?: string; content?: unknown; path?: string };
  type DraftContent = { version?: unknown; new_version?: unknown; platform?: { os?: unknown; app_version?: unknown };
    duration?: unknown; tracks?: Track[]; materials?: { texts?: Material[]; videos?: Material[]; speeds?: Material[] } };
  const content = JSON.parse(contentBytes.toString('utf8')) as DraftContent;
  const meta = await readJson(join(options.directory, 'draft_meta_info.json'));
  const snapshot = options.snapshot;
  if (content.version !== 360000 || content.new_version !== '110.0.0') throw new Error('Unexpected draft version fields');
  if (content.platform?.os !== 'windows' || content.platform?.app_version !== '5.9.0') throw new Error('Unexpected draft platform');
  if (content.duration !== deriveKept(snapshot.edl).at(-1)?.outputEndUs) throw new Error('Draft duration does not match the EDL');
  if (meta.draft_name !== jianyingDraftNameSchema.parse(String(meta.draft_name))) throw new Error('Draft name is invalid');
  if (meta.draft_fold_path !== options.finalPath) throw new Error('Draft fold path does not use the final target');
  if (meta.tm_duration !== content.duration) throw new Error('Meta duration does not match draft duration');
  if (!Array.isArray(content.tracks) || content.tracks.length !== 2) throw new Error('Draft must contain one video and one text track');
  const videoTrack = content.tracks.find(track => track.type === 'video');
  const textTrack = content.tracks.find(track => track.type === 'text');
  if (!videoTrack || !textTrack || !Array.isArray(videoTrack.segments) || !Array.isArray(textTrack.segments)) throw new Error('Draft tracks are incomplete');
  const kept = deriveKept(snapshot.edl);
  if (videoTrack.segments.length !== kept.length) throw new Error('Video segment count does not match kept ranges');
  for (const [index, range] of kept.entries()) {
    const segment = videoTrack.segments[index];
    const expectedDuration = range.endUs - range.startUs;
    if (segment.source_timerange?.start !== range.startUs || segment.source_timerange?.duration !== expectedDuration
      || segment.target_timerange?.start !== range.outputStartUs || segment.target_timerange?.duration !== expectedDuration)
      throw new Error(`Video segment ${index} does not match the EDL`);
  }
  const cues = projectCues(snapshot.edl, snapshot.cues as Cue[]).filter(cue => cue.text.length > 0);
  if (textTrack.segments.length !== cues.length) throw new Error('Text segment count does not match projected cues');
  const textMaterials = new Map((content.materials?.texts ?? []).map(material => [material.id, material]));
  for (const [index, cue] of cues.entries()) {
    const segment = textTrack.segments[index];
    const startUs = toUs(cue.timestamp[0]); const durationUs = toUs(cue.timestamp[1]) - startUs;
    if (segment.target_timerange?.start !== startUs || segment.target_timerange?.duration !== durationUs)
      throw new Error(`Text segment ${index} does not match the EDL projection`);
    const material = textMaterials.get(segment.material_id);
    if (!material) throw new Error(`Text material ${segment.material_id} is unresolved`);
    const parsed = JSON.parse(String(material.content)) as { text?: string };
    if (parsed.text !== cue.text) throw new Error(`Text segment ${index} content does not match the snapshot`);
  }
  const videos = content.materials?.videos ?? [];
  if (videos.length !== 1 || typeof videos[0].path !== 'string') throw new Error('Draft must reference exactly one source video');
  const expectedMedia = join(options.finalPath, 'materials', options.expectedMediaName);
  if (videos[0].path !== expectedMedia) throw new Error('Draft media path does not use the final materials directory');
  const speedIds = new Set((content.materials?.speeds ?? []).map(speed => speed.id));
  for (const segment of videoTrack.segments) {
    if (!Array.isArray(segment.extra_material_refs) || !segment.extra_material_refs.length
      || segment.extra_material_refs.some((id: string) => !speedIds.has(id))) throw new Error('Video segment has an unresolved speed reference');
  }
  const stagedMedia = join(options.directory, 'materials', options.expectedMediaName);
  const mediaInfo = await stat(stagedMedia);
  if (mediaInfo.size !== options.expectedMediaBytes) throw new Error('Draft media size does not match the source');
  const copiedHash = await sha256(stagedMedia, options.signal); const sourceHash = await sha256(options.sourcePath, options.signal);
  if (copiedHash !== options.expectedMediaSha256 || sourceHash !== options.expectedMediaSha256)
    throw new Error('Draft media hash does not match the source');
  const cover = await readFile(join(options.directory, 'draft_cover.jpg'));
  if (cover.length < 4 || cover[0] !== 0xff || cover[1] !== 0xd8 || cover[2] !== 0xff) throw new Error('Cover is not a JPEG');
}

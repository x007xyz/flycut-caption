import type { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { access, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { deriveKept } from '../../shared/editing/edl';
import type { JobSnapshot } from '../../shared/protocol';
import {
  assertNonOverlappingJianyingCues, buildJianyingCapabilities, jianyingDegradations, jianyingDraftNameSchema,
  jianyingPreflightInputSchema, jianyingStartInputSchema, JIANYING_DIRECTORY_TTL_MS, JIANYING_PREFLIGHT_TTL_MS,
  type JianyingJobResult, type JianyingPreflightInput, type JianyingPreflightResult, type JianyingSnapshot, type JianyingSource,
} from '../../shared/jianying/draft';
import { ProjectStore, fingerprintFile } from '../projects/store';
import { generateJianyingDraft, jianyingAvailableBytes, probeJianyingMedia, type JianyingSourceRevision } from '../jianying/generate';

export interface JianyingPluginConfig {
  /** Developer-only switch. The normal product build leaves this off and registers no write methods. */
  internalValidation?: boolean;
  /** Desktop may resolve linked project media. The server profile hard-disables this below. */
  allowLinkedMedia?: boolean;
}

interface DirectoryGrant { parentPath: string; expiresAt: number; consumed: boolean; preflightId?: string }
interface PreparedExport {
  parentPath: string; draftName: string; finalPath: string; source: JianyingSource; sourcePath: string; sourceName: string;
  sourceRevision: JianyingSourceRevision; sourceFingerprint: string; snapshot: JianyingSnapshot;
  estimatedBytes: number; availableBytes: number; expiresAt: number; consumed: boolean;
}

const DIRECTORY_BODY = z.strictObject({ path: z.string().min(1).max(32_768) });
const OPERATION = z.strictObject({ preflightId: z.uuid(), jobId: z.uuid(), createdAt: z.string() });
const MIB = 1024 * 1024;

/** Deployment boundary: ordinary profile patches cannot re-enable linked local media on the server profile. */
export function jianyingLinkedMediaAllowed(profileName: string | undefined, configured: boolean | undefined): boolean {
  if (profileName === 'server') return false;
  return configured !== false;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('Request body exceeds limit');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

async function assertWritableDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('Selected output directory must be absolute');
  const before = await lstat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Selected output directory no longer exists');
    throw error;
  });
  if (before.isSymbolicLink() || !before.isDirectory()) throw new Error('Selected output path is not a real directory');
  await access(path, 5);
  const canonical = await realpath(path);
  const after = await lstat(canonical);
  if (after.isSymbolicLink() || !after.isDirectory()) throw new Error('Selected output path is not a real directory');
  // Keep only the resolved parent. macOS temp paths legitimately contain a system-level /var → /private/var link;
  // the selected directory itself, the canonical directory, and every staging target are still checked for links.
  return canonical;
}

async function assertAbsent(path: string) {
  try { await lstat(path); throw new Error('A draft folder with this name already exists'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

/**
 * F-0011 write path. The shell selects a directory and registers it once over a shell-only route; ordinary RPC receives
 * only the resulting opaque grant. The write methods exist only in an explicit internal device-validation build. The
 * normal build remains fail-closed while real timing, editing and reopen evidence is incomplete.
 */
export const jianyingPlugin = { name: 'flycut-jianying', inject: ['hostConfig', 'rpc', 'jobs', 'assets'],
  apply(ctx: Context, config: JianyingPluginConfig = {}) {
    const internalValidation = config.internalValidation ?? process.env.FLYCUT_JIANYING_INTERNAL_VALIDATION === '1';
    const allowLinkedMedia = jianyingLinkedMediaAllowed(ctx.hostConfig.profileName, config.allowLinkedMedia);
    const store = new ProjectStore(ctx.hostConfig.home);
    const bundledFfmpeg = join(ctx.hostConfig.resourceRoot, 'binaries', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    const ffmpegPath = async () => process.env.FFMPEG_PATH || await access(bundledFfmpeg).then(() => bundledFfmpeg).catch(() => 'ffmpeg');
    const grants = new Map<string, DirectoryGrant>();
    const prepared = new Map<string, PreparedExport>();
    const operations = new Map<string, { jobId: string; createdAt: string }>();
    const startedJobs = new Map<string, string>();
    const startFlights = new Map<string, Promise<JobSnapshot>>();
    const operationRoot = join(ctx.hostConfig.home, 'jianying', 'operations');
    const operationFile = (preflightId: string) => join(operationRoot, `${preflightId}.json`);
    const readOperation = async (preflightId: string) => {
      const cached = operations.get(preflightId); if (cached) return cached;
      try {
        const value = OPERATION.parse(JSON.parse(await readFile(operationFile(preflightId), 'utf8')) as unknown);
        if (value.preflightId !== preflightId) throw new Error('Jianying operation identity does not match its record');
        const result = { jobId: value.jobId, createdAt: value.createdAt }; operations.set(preflightId, result); return result;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    };
    const writeOperation = async (preflightId: string, jobId: string) => {
      const value = { preflightId, jobId, createdAt: new Date().toISOString() };
      await mkdir(operationRoot, { recursive: true, mode: 0o700 });
      const file = operationFile(preflightId); const temporary = `${file}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await rename(temporary, file); }
      catch (error) { await rm(temporary, { force: true }); throw error; }
      operations.set(preflightId, { jobId, createdAt: value.createdAt });
    };
    const prune = () => {
      const now = Date.now();
      for (const [id, grant] of grants) if (grant.expiresAt <= now || grant.consumed) grants.delete(id);
      for (const [id, item] of prepared) if (item.expiresAt <= now || item.consumed) prepared.delete(id);
    };
    const timer = setInterval(prune, 60_000); timer.unref();
    ctx.effect(() => () => clearInterval(timer));

    const resolveSource = async (source: JianyingSource, snapshot: JianyingSnapshot, allowLinked: boolean) => {
      if (source.kind === 'asset') {
        if (!snapshot.videoName) throw new Error('Video name is required for a standalone draft export');
        return { path: ctx.assets.path(source.assetId), name: snapshot.videoName };
      }
      if (snapshot.projectId !== source.projectId || snapshot.videoId !== source.videoId)
        throw new Error('Draft snapshot does not belong to the selected project video');
      const project = await store.read(source.projectId);
      if (project.deletedAt) throw new Error('Project is in Trash');
      const video = project.videos.find(item => item.id === source.videoId);
      if (!video) throw new Error('Project video no longer exists');
      if (video.media.kind === 'linked') {
        if (!allowLinked) throw new Error('This Host does not allow linked local media');
        return { path: video.media.path, name: video.name };
      }
      return { path: store.mediaFile(source.projectId, video.media.file), name: video.name };
    };

    const preflight = async (input: JianyingPreflightInput): Promise<JianyingPreflightResult> => {
      prune();
      const grant = grants.get(input.directoryGrant);
      if (!grant || grant.expiresAt <= Date.now() || grant.consumed) throw new Error('Output directory grant is invalid or expired');
      if (grant.preflightId) throw new Error('Output directory grant is already prepared');
      const parentPath = await assertWritableDirectory(grant.parentPath);
      const draftName = jianyingDraftNameSchema.parse(input.draftName);
      const finalPath = resolve(parentPath, draftName);
      await assertAbsent(finalPath);

      // Linked project media are resolved by project identity; ordinary RPC never supplies a local path.
      const source = await resolveSource(input.source, input.snapshot, allowLinkedMedia);
      const fingerprint = await fingerprintFile(source.path).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Source media is missing; relink it and try again');
        throw error;
      });
      const probe = await probeJianyingMedia(source.path, await ffmpegPath());
      if (Math.abs(probe.durationUs - input.snapshot.edl.sourceDurationUs) > 50_000)
        throw new Error('EDL duration does not match source media');
      if (probe.width !== input.snapshot.videoWidth || probe.height !== input.snapshot.videoHeight)
        throw new Error('Snapshot dimensions do not match source media');
      const cues = assertNonOverlappingJianyingCues(input.snapshot);
      const estimatedBytes = fingerprint.size + Math.ceil(fingerprint.size * 0.01) + 4 * MIB;
      const availableBytes = await jianyingAvailableBytes(parentPath);
      if (availableBytes < estimatedBytes) throw new Error('Not enough free space for the draft and its media copy');

      const preflightId = randomUUID();
      const expiresAt = Date.now() + JIANYING_PREFLIGHT_TTL_MS;
      prepared.set(preflightId, { parentPath, draftName, finalPath, source: input.source, sourcePath: source.path, sourceName: source.name,
        sourceRevision: { size: fingerprint.size }, sourceFingerprint: fingerprint.fingerprint,
        snapshot: structuredClone(input.snapshot), estimatedBytes, availableBytes, expiresAt, consumed: false });
      grant.preflightId = preflightId;
      return { preflightId, expiresAt: new Date(expiresAt).toISOString(), draftName, mediaStrategy: 'copy',
        sourceBytes: fingerprint.size, estimatedBytes, availableBytes,
        videoSegmentCount: deriveKept(input.snapshot.edl).length, textSegmentCount: cues.length,
        degradationKeys: jianyingDegradations(input.snapshot) };
    };

    const startOnce = async (preflightId: string): Promise<JobSnapshot> => {
      const owned = startedJobs.get(preflightId);
      if (owned) return ctx.jobs.get(owned);
      const existing = await readOperation(preflightId);
      if (existing) {
        try { return ctx.jobs.get(existing.jobId); }
        catch { throw new Error('Jianying operation references a missing Job; refusing to start a duplicate'); }
      }
      try {
        const recovered = ctx.jobs.get(preflightId);
        startedJobs.set(preflightId, recovered.id);
        return recovered;
      } catch { /* no deterministic job yet */ }
      prune();
      const item = prepared.get(preflightId);
      if (!item || item.expiresAt <= Date.now() || item.consumed) throw new Error('Prepared export is invalid or expired');
      item.consumed = true;
      const grantId = [...grants.entries()].find(([, grant]) => grant.preflightId === preflightId)?.[0];
      if (!grantId) throw new Error('Output directory grant is no longer available');
      grants.get(grantId)!.consumed = true;
      const job = ctx.jobs.create(async (signal, report) => {
        await assertWritableDirectory(item.parentPath);
        await assertAbsent(item.finalPath);
        const current = await fingerprintFile(item.sourcePath);
        if (current.fingerprint !== item.sourceFingerprint || current.size !== item.sourceRevision.size)
          throw new Error('Source media changed after export was prepared');
        const generated = await generateJianyingDraft({
          snapshot: item.snapshot, sourcePath: item.sourcePath, outputParent: item.parentPath, draftName: item.draftName,
          signal, expectedSource: item.sourceRevision,
          ffmpeg: await ffmpegPath(),
          onProgress: progress => report({ status: 'running', purpose: 'export', progress: progress.progress,
            data: progress.detail ? `${progress.stage}:${progress.detail}` : progress.stage }),
        });
        const result: JianyingJobResult = { draftName: generated.draftName, draftPath: generated.draftPath,
          createdAt: new Date().toISOString(), sourceBytes: item.sourceRevision.size, copiedBytes: generated.mediaBytes,
          videoSegmentCount: generated.videoSegmentCount, textSegmentCount: generated.textSegmentCount,
          degradationKeys: jianyingDegradations(item.snapshot) };
        return result;
      }, preflightId);
      startedJobs.set(preflightId, job.id);
      // The deterministic Job ID makes a lost response recoverable even if writing the association is interrupted.
      try { await writeOperation(preflightId, job.id); }
      catch (error) { console.error('Could not persist Jianying operation association', error); }
      return ctx.jobs.get(job.id);
    };
    const start = (preflightId: string): Promise<JobSnapshot> => {
      const flight = startFlights.get(preflightId);
      if (flight) return flight;
      const created = startOnce(preflightId).finally(() => startFlights.delete(preflightId));
      startFlights.set(preflightId, created);
      return created;
    };

    ctx.effect(() => ctx.rpc.register('jianying.capabilities', undefined, () => buildJianyingCapabilities(internalValidation)));
    ctx.effect(() => ctx.rpc.capability('jianyingCapabilities'));
    ctx.effect(() => ctx.rpc.capability('jianyingExport', internalValidation));

    if (internalValidation) {
      ctx.effect(() => ctx.rpc.register('jianying.preflight', jianyingPreflightInputSchema, preflight));
      ctx.effect(() => ctx.rpc.register('jianying.start', jianyingStartInputSchema, ({ preflightId }) => start(preflightId)));
      ctx.effect(() => ctx.rpc.route({ method: 'POST', pattern: /^\/shell\/jianying\/directories$/, auth: 'shell', async handle(req, res) {
        const { path } = DIRECTORY_BODY.parse(await readBody(req));
        const parentPath = await assertWritableDirectory(path);
        const grant = randomUUID();
        const expiresAt = Date.now() + JIANYING_DIRECTORY_TTL_MS;
        grants.set(grant, { parentPath, expiresAt, consumed: false });
        res.writeHead(201, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ grant, expiresAt: new Date(expiresAt).toISOString() }));
      } }));
    }
  } };

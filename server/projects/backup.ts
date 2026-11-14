import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  BACKUP_DISK_RESERVE_BYTES,
  BACKUP_EXTENSION,
  BACKUP_FORMAT_VERSION,
  BACKUP_STAGING_TTL_MS,
  backupManifestSchema,
  type BackupExportResult,
  type BackupImportResult,
  type BackupInspectionResult,
  type BackupManifest,
  type BackupManifestEntry,
  type BackupMissingMediaItem,
  type BackupPreviewResult,
  type BackupStyleSummary,
} from '../../shared/backup';
import { HostRpcError } from '../../shared/errors';
import {
  PROJECT_FORMAT_VERSION,
  projectEditsSchema,
  projectFileSchema,
  transcriptRecordSchema,
  type ProjectFile,
  type ProjectMedia,
  type ProjectVideo,
} from '../../shared/projects';
import type { AssetService, ProgressReporter } from '../services';
import { BackupZipReader, BackupZipWriter } from './backupArchive';
import { migrateProject, NewerFormatError } from './migrations';
import { ProjectStore } from './store';

const STAGING_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.aac': 'audio/aac',
};

export type MediaStatusFn = (projectId: string, media: ProjectMedia, thorough?: boolean) => Promise<'ok' | 'missing'>;

export interface BackupPaths {
  backupsRoot: string;
  stagingDir: string;
  tmpDir: string;
  importsDir: string;
}

export function backupPaths(home: string): BackupPaths {
  const backupsRoot = join(home, 'backups');
  return {
    backupsRoot,
    stagingDir: join(backupsRoot, 'staging'),
    tmpDir: join(backupsRoot, 'tmp'),
    importsDir: join(backupsRoot, 'imports'),
  };
}

export async function defaultAvailableBytes(dir: string): Promise<number> {
  await mkdir(dir, { recursive: true });
  const info = await statfs(dir);
  return Number(info.bavail) * Number(info.bsize);
}

async function hashFileSha256(filePath: string, signal?: AbortSignal): Promise<{ size: number; sha256: string }> {
  signal?.throwIfAborted();
  const info = await stat(filePath);
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    const onAbort = () => {
      stream.destroy(new Error('Job cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    stream.on('data', (chunk: Buffer | string) => {
      hash.update(chunk);
    });
    stream.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    stream.on('end', () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    });
  });
  return { size: info.size, sha256: hash.digest('hex') };
}

async function fileExists(filePath: string): Promise<boolean> {
  return stat(filePath).then((s) => s.isFile(), () => false);
}

function mimeFromName(name: string): string {
  const ext = extname(name).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

function sanitizeBackupFilename(projectName: string): string {
  const clean = [...projectName]
    .map((ch) => (ch.charCodeAt(0) < 32 ? '-' : ch))
    .join('')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 64)
    .trim();
  return `${clean || 'flycut-project'}${BACKUP_EXTENSION}`;
}

function countVideoEdits(
  edits: Awaited<ReturnType<ProjectStore['readEdits']>>,
  transcript: Awaited<ReturnType<ProjectStore['readTranscript']>>,
): { subtitleCount: number; editCount: number } {
  const chunks = edits?.chunks ?? transcript?.chunks ?? [];
  const subtitleCount = chunks.length;
  if (!edits) return { subtitleCount, editCount: 0 };
  const transcriptChunks = new Map((transcript?.chunks ?? []).map((c) => [c.id, c]));
  let chunkEdits = 0;
  for (const chunk of edits.chunks) {
    const orig = transcriptChunks.get(chunk.id);
    if (!orig || orig.text !== chunk.text || Boolean(chunk.deleted) !== Boolean(orig.deleted) || chunk.secondText || (chunk.keywords?.length ?? 0) > 0) {
      chunkEdits += 1;
    }
  }
  const edlHistory = edits.editing?.history?.length ?? 0;
  const deletedWords = edits.deletedWordIds?.length ?? 0;
  const textHistory = edits.textHistory?.length ?? 0;
  const langTracks = (edits.languageTracks?.length ?? 0) > 0 ? 1 : 0;
  return {
    subtitleCount,
    editCount: chunkEdits + edlHistory + deletedWords + textHistory + langTracks,
  };
}

export async function computeBackupPreview(
  store: ProjectStore,
  mediaStatus: MediaStatusFn,
  projectId: string,
): Promise<BackupPreviewResult> {
  let project: ProjectFile;
  try {
    project = await store.read(projectId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      throw new HostRpcError('NOT_FOUND', '项目不存在');
    }
    if (error instanceof NewerFormatError) {
      throw new HostRpcError('BACKUP_INVALID', `项目「${error.projectName}」由更新版本创建，当前版本无法备份`);
    }
    throw error;
  }
  if (project.deletedAt) {
    throw new HostRpcError('PROJECT_TRASHED', '项目已移到回收站，无法备份');
  }

  let subtitleCount = 0;
  let editCount = 0;
  let artifactCount = 0;
  let estimatedMediaBytes = 0;
  let estimatedMetaBytes = 1024;
  const missingMedia: BackupMissingMediaItem[] = [];

  const styleSummary: BackupStyleSummary = {
    hasProjectStyle: Boolean(project.style),
    customVideoStyleCount: project.videos.filter((v) => v.styleSource === 'custom').length,
  };

  for (const video of project.videos) {
    const vDir = store.videoDir(project.id, video.id);
    const [transcript, edits, hasThumb, hasSuggestions, mStatus] = await Promise.all([
      store.readTranscript(project.id, video.id),
      store.readEdits(project.id, video.id),
      fileExists(join(vDir, 'thumbnail.jpg')),
      fileExists(join(vDir, 'pending-suggestions.json')),
      mediaStatus(project.id, video.media, true),
    ]);
    const counts = countVideoEdits(edits, transcript);
    subtitleCount += counts.subtitleCount;
    editCount += counts.editCount;
    if (transcript) {
      artifactCount += 1;
      estimatedMetaBytes += (await stat(join(vDir, 'transcript.json')).catch(() => ({ size: 0 }))).size;
    }
    if (edits) {
      estimatedMetaBytes += (await stat(join(vDir, 'edits.json')).catch(() => ({ size: 0 }))).size;
    }
    if (hasThumb) {
      artifactCount += 1;
      estimatedMetaBytes += (await stat(join(vDir, 'thumbnail.jpg')).catch(() => ({ size: 0 }))).size;
    }
    if (hasSuggestions) {
      artifactCount += 1;
      estimatedMetaBytes += (await stat(join(vDir, 'pending-suggestions.json')).catch(() => ({ size: 0 }))).size;
    }
    if (mStatus === 'ok') {
      const src = video.media.kind === 'stored' ? store.mediaFile(project.id, video.media.file) : video.media.path;
      const info = await stat(src).catch(() => undefined);
      estimatedMediaBytes += info?.size ?? video.media.size;
    } else {
      missingMedia.push({
        videoId: video.id,
        videoName: video.name,
        fileName: video.media.kind === 'linked' ? basename(video.media.path) : video.name,
      });
    }
  }

  return {
    projectId: project.id,
    projectName: project.name,
    revision: project.revision,
    videoCount: project.videos.length,
    subtitleCount,
    editCount,
    styleSummary,
    artifactCount,
    estimatedMediaBytes,
    estimatedTotalBytes: estimatedMediaBytes + estimatedMetaBytes,
    missingMedia,
    empty: project.videos.length === 0 && subtitleCount === 0,
    excludesSecretsNotice: true,
  };
}

interface PendingPackSource {
  entryPath: string;
  kind: 'meta' | 'media' | 'artifact';
  method: 'store' | 'deflate';
  buffer?: Buffer;
  filePath?: string;
  size: number;
  sha256: string;
}

export async function exportProjectBackup(params: {
  home: string;
  store: ProjectStore;
  assets: AssetService;
  mediaStatus: MediaStatusFn;
  appVersion: string;
  projectId: string;
  expectedRevision: number;
  includeMissingMedia: boolean;
  signal: AbortSignal;
  report: ProgressReporter;
}): Promise<BackupExportResult> {
  const { home, store, assets, mediaStatus, appVersion, projectId, expectedRevision, includeMissingMedia, signal, report } = params;
  const paths = backupPaths(home);
  await mkdir(paths.tmpDir, { recursive: true });

  const preview = await computeBackupPreview(store, mediaStatus, projectId);
  if (preview.revision !== expectedRevision) {
    throw new HostRpcError('CONTENT_CHANGED', '内容已更新，请重新检查', {
      expectedRevision,
      actualRevision: preview.revision,
    });
  }
  if (preview.missingMedia.length > 0 && !includeMissingMedia) {
    throw new HostRpcError('MISSING_MEDIA', '项目存在丢失的媒体文件，请先重新关联或选择跳过丢失媒体备份', {
      missingMedia: preview.missingMedia,
    });
  }

  const project = await store.read(projectId);
  if (project.deletedAt) throw new HostRpcError('PROJECT_TRASHED', '项目已移到回收站，无法备份');
  if (project.revision !== expectedRevision) {
    throw new HostRpcError('CONTENT_CHANGED', '内容已更新，请重新检查', {
      expectedRevision,
      actualRevision: project.revision,
    });
  }

  report({ status: 'running', progress: 5, data: '正在收集项目内容与媒体…' });

  const missingSet = new Set(preview.missingMedia.map((m) => m.videoId));
  const sanitizedVideos: ProjectVideo[] = [];
  const pendingSources: PendingPackSource[] = [];

  for (const video of project.videos) {
    signal.throwIfAborted();
    const vDir = store.videoDir(project.id, video.id);
    const isMissingMedia = missingSet.has(video.id);

    let sanitizedMedia: ProjectMedia;
    if (!isMissingMedia) {
      const sourcePath = video.media.kind === 'stored' ? store.mediaFile(project.id, video.media.file) : video.media.path;
      const sourceName = video.media.kind === 'linked' ? basename(video.media.path) : video.name;
      const storedRel = ProjectStore.storedName(video.id, sourceName);
      const { size, sha256 } = await hashFileSha256(sourcePath, signal);
      const mimeType = video.media.kind === 'stored' && video.media.mimeType ? video.media.mimeType : mimeFromName(sourceName);
      sanitizedMedia = { kind: 'stored', file: storedRel, size, mimeType };
      pendingSources.push({
        entryPath: storedRel,
        kind: 'media',
        method: 'store',
        filePath: sourcePath,
        size,
        sha256,
      });
    } else {
      const storedRel = ProjectStore.storedName(video.id, video.name);
      sanitizedMedia = { kind: 'stored', file: storedRel, size: 0, mimeType: '' };
    }
    sanitizedVideos.push({
      ...video,
      media: sanitizedMedia,
    });

    const jsonArtifacts: Array<{ file: string; kind: 'meta' | 'artifact'; method: 'deflate' | 'store' }> = [
      { file: 'transcript.json', kind: 'artifact', method: 'deflate' },
      { file: 'edits.json', kind: 'meta', method: 'deflate' },
      { file: 'pending-suggestions.json', kind: 'artifact', method: 'deflate' },
      { file: 'thumbnail.jpg', kind: 'artifact', method: 'store' },
    ];
    for (const art of jsonArtifacts) {
      const abs = join(vDir, art.file);
      if (!(await fileExists(abs))) continue;
      const buf = await readFile(abs);
      const sha256 = createHash('sha256').update(buf).digest('hex');
      pendingSources.push({
        entryPath: `videos/${video.id}/${art.file}`,
        kind: art.kind,
        method: art.method,
        buffer: buf,
        size: buf.length,
        sha256,
      });
    }
  }

  const sanitizedProject: ProjectFile = projectFileSchema.parse({
    formatVersion: PROJECT_FORMAT_VERSION,
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    revision: project.revision,
    videos: sanitizedVideos,
    ...(project.style ? { style: project.style } : {}),
    styleRevision: project.styleRevision,
  });
  const projectBuf = Buffer.from(JSON.stringify(sanitizedProject, null, 2), 'utf8');
  const projectEntry: PendingPackSource = {
    entryPath: 'project.json',
    kind: 'meta',
    method: 'deflate',
    buffer: projectBuf,
    size: projectBuf.length,
    sha256: createHash('sha256').update(projectBuf).digest('hex'),
  };
  const allPayloadSources = [projectEntry, ...pendingSources];

  const manifestEntries: BackupManifestEntry[] = allPayloadSources.map((src) => ({
    path: src.entryPath,
    size: src.size,
    sha256: src.sha256,
    kind: src.kind,
    method: src.method,
  }));

  const manifest: BackupManifest = {
    backupVersion: BACKUP_FORMAT_VERSION,
    projectFormatVersion: PROJECT_FORMAT_VERSION,
    appVersion,
    exportedAt: new Date().toISOString(),
    projectName: project.name,
    videoCount: preview.videoCount,
    subtitleCount: preview.subtitleCount,
    editCount: preview.editCount,
    styleSummary: preview.styleSummary,
    artifactCount: preview.artifactCount,
    mediaBytes: preview.estimatedMediaBytes,
    missingMedia: preview.missingMedia,
    entries: manifestEntries,
  };
  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');

  const totalBytes = Math.max(1, manifestBuf.length + allPayloadSources.reduce((acc, s) => acc + s.size, 0));
  let packedBytes = 0;

  const tmpZip = join(paths.tmpDir, `export-${randomUUID()}.flycut.zip.tmp`);
  let writer: BackupZipWriter | undefined;
  try {
    writer = await BackupZipWriter.open(tmpZip);
    await writer.addBuffer('manifest.json', manifestBuf, 'deflate', signal);
    packedBytes += manifestBuf.length;

    for (const src of allPayloadSources) {
      signal.throwIfAborted();
      if (src.buffer) {
        await writer.addBuffer(src.entryPath, src.buffer, src.method, signal);
        packedBytes += src.buffer.length;
        report({
          status: 'running',
          progress: Math.min(95, 15 + Math.round((packedBytes / totalBytes) * 80)),
          data: `正在打包 ${src.entryPath}`,
        });
      } else if (src.filePath) {
        await writer.addFile(src.entryPath, src.filePath, src.method, {
          knownUncompressedSize: src.size,
          signal,
          onBytes: (delta) => {
            packedBytes += delta;
            report({
              status: 'running',
              progress: Math.min(95, 15 + Math.round((packedBytes / totalBytes) * 80)),
              data: `正在打包媒体 ${basename(src.entryPath)}`,
            });
          },
        });
      }
    }
    await writer.finalize();
    writer = undefined;

    const latest = await store.read(projectId);
    if (latest.revision !== expectedRevision) {
      throw new HostRpcError('CONTENT_CHANGED', '内容已更新，请重新检查', {
        expectedRevision,
        actualRevision: latest.revision,
      });
    }

    const { size: archiveSize, sha256: archiveSha256 } = await hashFileSha256(tmpZip, signal);
    const assetId = await assets.adopt(tmpZip);
    report({ status: 'complete', progress: 100, data: '备份归档已完成' });
    return {
      assetId,
      filename: sanitizeBackupFilename(project.name),
      size: archiveSize,
      sha256: archiveSha256,
      revision: latest.revision,
      manifest,
    };
  } catch (error) {
    await writer?.close().catch(() => undefined);
    await rm(tmpZip, { force: true }).catch(() => undefined);
    throw error;
  }
}

export interface BackupStagingMeta {
  stagingId: string;
  size: number;
  sha256: string;
  createdAt: string;
}

function stagingZipPath(home: string, stagingId: string): string {
  if (!STAGING_ID_RE.test(stagingId)) throw new HostRpcError('INVALID_ID', '无效的暂存备份 ID');
  return join(backupPaths(home).stagingDir, `${stagingId}.zip`);
}

function stagingMetaPath(home: string, stagingId: string): string {
  if (!STAGING_ID_RE.test(stagingId)) throw new HostRpcError('INVALID_ID', '无效的暂存备份 ID');
  return join(backupPaths(home).stagingDir, `${stagingId}.json`);
}

export async function saveBackupStagingFromStream(
  home: string,
  source: NodeJS.ReadableStream,
  maxBytes = 16 * 1024 * 1024 * 1024,
): Promise<BackupStagingMeta> {
  const paths = backupPaths(home);
  await mkdir(paths.stagingDir, { recursive: true });
  const stagingId = randomUUID();
  const finalZip = stagingZipPath(home, stagingId);
  const partialZip = `${finalZip}.part`;
  const hash = createHash('sha256');
  let bytes = 0;

  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        cb(new Error('备份文件超出最大上传限制'));
        return;
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });

  try {
    await pipeline(source, meter, createWriteStream(partialZip));
    await rename(partialZip, finalZip);
    const meta: BackupStagingMeta = {
      stagingId,
      size: bytes,
      sha256: hash.digest('hex'),
      createdAt: new Date().toISOString(),
    };
    await writeFile(stagingMetaPath(home, stagingId), JSON.stringify(meta));
    return meta;
  } catch (error) {
    await rm(partialZip, { force: true }).catch(() => undefined);
    await rm(finalZip, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function saveBackupStagingFromFile(home: string, filePath: string): Promise<BackupStagingMeta> {
  const info = await stat(filePath).catch(() => undefined);
  if (!info?.isFile()) {
    throw new HostRpcError('NOT_FOUND', '所选备份文件不存在');
  }
  return saveBackupStagingFromStream(home, createReadStream(filePath));
}

export async function discardBackupStaging(home: string, stagingId: string): Promise<void> {
  await Promise.all([
    rm(stagingZipPath(home, stagingId), { force: true }).catch(() => undefined),
    rm(stagingMetaPath(home, stagingId), { force: true }).catch(() => undefined),
  ]);
}

export async function cleanupExpiredBackupStaging(home: string, ttlMs = BACKUP_STAGING_TTL_MS): Promise<void> {
  const { stagingDir, tmpDir } = backupPaths(home);
  const cutoff = Date.now() - ttlMs;
  for (const dir of [stagingDir, tmpDir]) {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      const full = join(dir, name);
      const info = await stat(full).catch(() => undefined);
      if (info && info.mtimeMs < cutoff) {
        await rm(full, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}

interface ValidatedStagingArchive {
  reader: BackupZipReader;
  stagingDigest: string;
  archiveBytes: number;
  manifest: BackupManifest;
  project: ProjectFile;
  requiredBytes: number;
  availableBytes: number;
}

async function openAndValidateStaging(params: {
  home: string;
  stagingId: string;
  signal?: AbortSignal;
  report?: ProgressReporter;
  statAvailableBytes?: (dir: string) => Promise<number>;
  verifyAllEntries: boolean;
}): Promise<ValidatedStagingArchive> {
  const { home, stagingId, signal, report, verifyAllEntries } = params;
  const zipPath = stagingZipPath(home, stagingId);
  const info = await stat(zipPath).catch(() => undefined);
  if (!info?.isFile()) {
    throw new HostRpcError('BACKUP_INVALID', '暂存备份文件不存在或已过期，请重新选择备份文件', {
      reason: 'STAGING_NOT_FOUND',
    });
  }

  report?.({ status: 'running', progress: 5, data: '正在校验归档索引…' });
  const { sha256: stagingDigest } = await hashFileSha256(zipPath, signal);
  const reader = await BackupZipReader.open(zipPath);

  try {
    if (!reader.entries.has('manifest.json') || !reader.entries.has('project.json')) {
      throw new HostRpcError('BACKUP_INVALID', '无法导入此备份：缺少 manifest.json 或 project.json', {
        reason: 'CORRUPT_ARCHIVE',
      });
    }

    const manifestRaw = JSON.parse((await reader.readBuffer('manifest.json', undefined, signal)).buffer.toString('utf8')) as unknown;
    const manifestParsed = backupManifestSchema.safeParse(manifestRaw);
    if (!manifestParsed.success) {
      throw new HostRpcError('BACKUP_INVALID', '无法导入此备份：备份清单格式无效', {
        reason: 'CORRUPT_ARCHIVE',
      });
    }
    const manifest = manifestParsed.data;
    if (manifest.backupVersion > BACKUP_FORMAT_VERSION) {
      throw new HostRpcError(
        'BACKUP_INVALID',
        `无法导入此备份：备份版本（v${manifest.backupVersion}）高于当前应用支持的版本（v${BACKUP_FORMAT_VERSION}）`,
        { reason: 'UNSUPPORTED_BACKUP_VERSION' },
      );
    }
    if (manifest.projectFormatVersion > PROJECT_FORMAT_VERSION) {
      throw new HostRpcError(
        'BACKUP_INVALID',
        `无法导入此备份：项目格式版本（v${manifest.projectFormatVersion}）高于当前应用支持的版本（v${PROJECT_FORMAT_VERSION}）`,
        { reason: 'UNSUPPORTED_PROJECT_VERSION' },
      );
    }

    const projectRaw = JSON.parse((await reader.readBuffer('project.json', undefined, signal)).buffer.toString('utf8')) as unknown;
    const rawVideos = (projectRaw as { videos?: unknown })?.videos;
    if (Array.isArray(rawVideos)) {
      for (const item of rawVideos) {
        const media = (item as { media?: { kind?: unknown } })?.media;
        if (media?.kind === 'linked') {
          throw new HostRpcError('BACKUP_INVALID', '无法导入此备份：归档内包含非法的本机绝对媒体路径', {
            reason: 'UNSAFE_LINKED_MEDIA',
          });
        }
      }
    }

    let project: ProjectFile;
    try {
      project = projectFileSchema.parse(migrateProject(projectRaw));
    } catch (error) {
      if (error instanceof NewerFormatError) {
        throw new HostRpcError('BACKUP_INVALID', `无法导入此备份：项目版本过新（${error.projectName}）`, {
          reason: 'UNSUPPORTED_PROJECT_VERSION',
        });
      }
      throw new HostRpcError('BACKUP_INVALID', '无法导入此备份：project.json 格式无效', {
        reason: 'CORRUPT_ARCHIVE',
      });
    }

    const expectedPaths = new Set(manifest.entries.map((e) => e.path));
    if (expectedPaths.size !== manifest.entries.length) {
      throw new HostRpcError('BACKUP_INVALID', '无法导入此备份：清单存在重复条目', { reason: 'CORRUPT_ARCHIVE' });
    }
    for (const [entryPath] of reader.entries) {
      if (entryPath !== 'manifest.json' && !expectedPaths.has(entryPath)) {
        throw new HostRpcError('BACKUP_INVALID', `无法导入此备份：归档包含未在清单声明的文件（${entryPath}）`, {
          reason: 'CORRUPT_ARCHIVE',
        });
      }
    }
    for (const entry of manifest.entries) {
      const zipEntry = reader.entries.get(entry.path);
      if (!zipEntry || zipEntry.uncompressedSize !== entry.size) {
        throw new HostRpcError('BACKUP_INVALID', `无法导入此备份：条目大小与清单不一致（${entry.path}）`, {
          reason: 'INTEGRITY_MISMATCH',
        });
      }
    }

    const requiredBytes = reader.totalUncompressedBytes + BACKUP_DISK_RESERVE_BYTES;
    const getAvail = params.statAvailableBytes ?? defaultAvailableBytes;
    const availableBytes = await getAvail(join(home, 'projects'));
    if (availableBytes < requiredBytes) {
      throw new HostRpcError(
        'INSUFFICIENT_SPACE',
        `无法导入此备份：磁盘可用空间不足（需要至少 ${Math.ceil(requiredBytes / (1024 * 1024))} MiB）`,
        { reason: 'INSUFFICIENT_SPACE', requiredBytes, availableBytes },
      );
    }

    if (verifyAllEntries) {
      const total = Math.max(1, reader.totalUncompressedBytes);
      let verifiedBytes = 0;
      for (const entry of manifest.entries) {
        signal?.throwIfAborted();
        await reader.verifyEntry(entry.path, entry.sha256, signal, (delta) => {
          verifiedBytes += delta;
          report?.({
            status: 'running',
            progress: Math.min(98, 10 + Math.round((verifiedBytes / total) * 88)),
            data: `正在校验 ${entry.path}`,
          });
        });
      }
    }

    return {
      reader,
      stagingDigest,
      archiveBytes: info.size,
      manifest,
      project,
      requiredBytes,
      availableBytes,
    };
  } catch (error) {
    await reader.close().catch(() => undefined);
    throw error;
  }
}

export async function inspectBackupStaging(params: {
  home: string;
  stagingId: string;
  signal?: AbortSignal;
  report?: ProgressReporter;
  statAvailableBytes?: (dir: string) => Promise<number>;
}): Promise<BackupInspectionResult> {
  const validated = await openAndValidateStaging({
    ...params,
    verifyAllEntries: true,
  });
  try {
    const { stagingDigest, archiveBytes, manifest, requiredBytes, availableBytes } = validated;
    params.report?.({ status: 'complete', progress: 100, data: '备份预检通过' });
    return {
      stagingId: params.stagingId,
      stagingDigest,
      archiveBytes,
      backupVersion: manifest.backupVersion,
      projectFormatVersion: manifest.projectFormatVersion,
      appVersion: manifest.appVersion,
      exportedAt: manifest.exportedAt,
      projectName: manifest.projectName,
      videoCount: manifest.videoCount,
      subtitleCount: manifest.subtitleCount,
      editCount: manifest.editCount,
      styleSummary: manifest.styleSummary,
      artifactCount: manifest.artifactCount,
      mediaBytes: manifest.mediaBytes,
      missingMedia: manifest.missingMedia,
      requiredBytes,
      availableBytes,
    };
  } finally {
    await validated.reader.close().catch(() => undefined);
  }
}

export async function importProjectBackup(params: {
  home: string;
  store: ProjectStore;
  stagingId: string;
  expectedDigest?: string;
  name?: string;
  operationId?: string;
  signal?: AbortSignal;
  report?: ProgressReporter;
  statAvailableBytes?: (dir: string) => Promise<number>;
}): Promise<BackupImportResult> {
  const { home, store, stagingId, expectedDigest, name, operationId, signal, report } = params;
  const paths = backupPaths(home);
  await mkdir(paths.importsDir, { recursive: true });

  const idempotencyFile = operationId ? join(paths.importsDir, `${operationId}.json`) : undefined;
  if (idempotencyFile) {
    const existing = await readFile(idempotencyFile, 'utf8')
      .then((raw) => JSON.parse(raw) as BackupImportResult)
      .catch(() => undefined);
    if (existing && (await store.read(existing.projectId).catch(() => undefined))) {
      report?.({ status: 'complete', progress: 100, data: '项目已导入' });
      return existing;
    }
  }

  const validated = await openAndValidateStaging({
    home,
    stagingId,
    signal,
    report,
    statAvailableBytes: params.statAvailableBytes,
    verifyAllEntries: false,
  });
  const { reader, stagingDigest, manifest, project } = validated;
  const entryByPath = new Map(manifest.entries.map((e) => [e.path, e]));

  if (expectedDigest && stagingDigest !== expectedDigest) {
    await reader.close().catch(() => undefined);
    throw new HostRpcError('CONTENT_CHANGED', '内容已更新，请重新检查', {
      expectedDigest,
      actualDigest: stagingDigest,
    });
  }

  const newProjectId = randomUUID();
  const importTempDir = join(store.root, `.import-${randomUUID()}`);
  const videoIdMap = new Map<string, string>();
  for (const video of project.videos) {
    videoIdMap.set(video.id, randomUUID());
  }

  try {
    await store.init();
    await mkdir(importTempDir, { recursive: true });

    const totalBytes = Math.max(1, reader.totalUncompressedBytes);
    let writtenBytes = 0;
    const bump = (delta: number, label: string) => {
      writtenBytes += delta;
      report?.({
        status: 'running',
        progress: Math.min(95, 10 + Math.round((writtenBytes / totalBytes) * 85)),
        data: label,
      });
    };

    let mediaMissingCount = 0;
    const importedVideos: ProjectVideo[] = [];

    for (const oldVideo of project.videos) {
      signal?.throwIfAborted();
      const newVideoId = videoIdMap.get(oldVideo.id)!;
      const newVideoDir = join(importTempDir, 'videos', newVideoId);
      await mkdir(newVideoDir, { recursive: true });

      let nextMedia: ProjectMedia;
      if (oldVideo.media.kind === 'stored' && reader.entries.has(oldVideo.media.file)) {
        const manifestEntry = entryByPath.get(oldVideo.media.file);
        const newMediaRel = ProjectStore.storedName(newVideoId, oldVideo.media.file);
        const targetMediaAbs = join(importTempDir, newMediaRel);
        await mkdir(join(importTempDir, 'media'), { recursive: true });
        const streamed = await reader.streamEntry(
          oldVideo.media.file,
          createWriteStream(targetMediaAbs),
          signal,
          (delta) => bump(delta, `正在导入媒体 ${oldVideo.name}`),
        );
        if (manifestEntry && streamed.sha256 !== manifestEntry.sha256) {
          throw new HostRpcError('BACKUP_INVALID', `无法导入此备份：媒体完整性校验失败（${oldVideo.media.file}）`, {
            reason: 'INTEGRITY_MISMATCH',
          });
        }
        nextMedia = {
          kind: 'stored',
          file: newMediaRel,
          size: streamed.size,
          mimeType: oldVideo.media.mimeType,
        };
      } else {
        mediaMissingCount += 1;
        nextMedia = {
          kind: 'stored',
          file: ProjectStore.storedName(newVideoId, oldVideo.name),
          size: 0,
          mimeType: oldVideo.media.kind === 'stored' ? oldVideo.media.mimeType : '',
        };
      }

      const transcriptEntryPath = `videos/${oldVideo.id}/transcript.json`;
      if (reader.entries.has(transcriptEntryPath)) {
        const { buffer, sha256 } = await reader.readBuffer(transcriptEntryPath, undefined, signal);
        if (entryByPath.get(transcriptEntryPath)?.sha256 !== sha256) {
          throw new HostRpcError('BACKUP_INVALID', '无法导入此备份：转写记录校验失败', { reason: 'INTEGRITY_MISMATCH' });
        }
        const parsedTranscript = transcriptRecordSchema.parse(JSON.parse(buffer.toString('utf8')));
        await writeFile(join(newVideoDir, 'transcript.json'), JSON.stringify(parsedTranscript));
        bump(buffer.length, `正在导入字幕 ${oldVideo.name}`);
      }

      const editsEntryPath = `videos/${oldVideo.id}/edits.json`;
      if (reader.entries.has(editsEntryPath)) {
        const { buffer, sha256 } = await reader.readBuffer(editsEntryPath, undefined, signal);
        if (entryByPath.get(editsEntryPath)?.sha256 !== sha256) {
          throw new HostRpcError('BACKUP_INVALID', '无法导入此备份：编辑记录校验失败', { reason: 'INTEGRITY_MISMATCH' });
        }
        const parsedEdits = projectEditsSchema.parse(JSON.parse(buffer.toString('utf8')));
        await writeFile(join(newVideoDir, 'edits.json'), JSON.stringify(parsedEdits));
        bump(buffer.length, `正在导入编辑记录 ${oldVideo.name}`);
      }

      const thumbEntryPath = `videos/${oldVideo.id}/thumbnail.jpg`;
      if (reader.entries.has(thumbEntryPath)) {
        const { buffer, sha256 } = await reader.readBuffer(thumbEntryPath, undefined, signal);
        if (entryByPath.get(thumbEntryPath)?.sha256 !== sha256) {
          throw new HostRpcError('BACKUP_INVALID', '无法导入此备份：封面图校验失败', { reason: 'INTEGRITY_MISMATCH' });
        }
        await writeFile(join(newVideoDir, 'thumbnail.jpg'), buffer);
        bump(buffer.length, `正在导入封面 ${oldVideo.name}`);
      }

      const suggestionsEntryPath = `videos/${oldVideo.id}/pending-suggestions.json`;
      if (reader.entries.has(suggestionsEntryPath)) {
        const { buffer, sha256 } = await reader.readBuffer(suggestionsEntryPath, undefined, signal);
        if (entryByPath.get(suggestionsEntryPath)?.sha256 !== sha256) {
          throw new HostRpcError('BACKUP_INVALID', '无法导入此备份：待确认建议校验失败', { reason: 'INTEGRITY_MISMATCH' });
        }
        const rawList = JSON.parse(buffer.toString('utf8')) as unknown;
        if (Array.isArray(rawList)) {
          const remapped = rawList.map((item) =>
            item && typeof item === 'object' ? { ...(item as Record<string, unknown>), projectId: newProjectId, videoId: newVideoId } : item,
          );
          await writeFile(join(newVideoDir, 'pending-suggestions.json'), JSON.stringify(remapped, null, 2));
        }
        bump(buffer.length, `正在导入建议 ${oldVideo.name}`);
      }

      importedVideos.push({
        ...oldVideo,
        id: newVideoId,
        media: nextMedia,
      });
    }

    const projectJsonRead = await reader.readBuffer('project.json', undefined, signal);
    if (entryByPath.get('project.json')?.sha256 !== projectJsonRead.sha256) {
      throw new HostRpcError('BACKUP_INVALID', '无法导入此备份：project.json 校验失败', { reason: 'INTEGRITY_MISMATCH' });
    }

    const now = new Date().toISOString();
    const importedName = name?.trim() || project.name;
    const newProject: ProjectFile = projectFileSchema.parse({
      formatVersion: PROJECT_FORMAT_VERSION,
      id: newProjectId,
      name: importedName,
      createdAt: now,
      updatedAt: now,
      revision: 1,
      videos: importedVideos,
      ...(project.style ? { style: project.style } : {}),
      styleRevision: project.styleRevision,
    });
    await writeFile(join(importTempDir, 'project.json'), JSON.stringify(newProject));

    signal?.throwIfAborted();

    const finalDir = store.dir(newProjectId);
    await rename(importTempDir, finalDir);

    const result: BackupImportResult = {
      projectId: newProjectId,
      name: importedName,
      videoCount: importedVideos.length,
      mediaMissingCount,
      firstVideoId: importedVideos[0]?.id,
    };
    if (idempotencyFile) {
      const tmpIdem = `${idempotencyFile}.${randomUUID()}.tmp`;
      await writeFile(tmpIdem, JSON.stringify(result)).catch(() => undefined);
      await rename(tmpIdem, idempotencyFile).catch(() => undefined);
    }
    report?.({ status: 'complete', progress: 100, data: '项目备份导入完成' });
    return result;
  } catch (error) {
    await rm(importTempDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await reader.close().catch(() => undefined);
  }
}

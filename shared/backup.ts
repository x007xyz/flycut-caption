import { z } from 'zod';
import { projectIdSchema } from './projects';

export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_EXTENSION = '.flycut.zip';
export const BACKUP_DISK_RESERVE_BYTES = 64 * 1024 * 1024;
export const BACKUP_STAGING_TTL_MS = 2 * 60 * 60 * 1000;
/** Upper bound for metadata JSON entries inside a backup archive (128 MiB per entry). */
export const BACKUP_MAX_META_ENTRY_BYTES = 128 * 1024 * 1024;
/** Upper bound for total uncompressed archive size (64 GiB). */
export const BACKUP_MAX_TOTAL_UNCOMPRESSED_BYTES = 64 * 1024 * 1024 * 1024;

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ALLOWED_BACKUP_ENTRY_PATTERNS = [
  /^manifest\.json$/,
  /^project\.json$/,
  new RegExp(`^videos\\/${UUID_PATTERN}\\/(?:transcript|edits|pending-suggestions)\\.json$`, 'i'),
  new RegExp(`^videos\\/${UUID_PATTERN}\\/thumbnail\\.jpg$`, 'i'),
  new RegExp(`^media\\/${UUID_PATTERN}(?:\\.[a-z0-9]{1,8})?$`, 'i'),
];

export function validateBackupEntryPath(entryPath: string): { ok: true } | { ok: false; reason: string } {
  if (!entryPath) return { ok: false, reason: 'Empty archive entry path' };
  if (entryPath.includes('\0')) return { ok: false, reason: 'Null byte in archive entry path' };
  if (entryPath.includes('\\')) return { ok: false, reason: 'Backslash in archive entry path' };
  if (entryPath.startsWith('/')) return { ok: false, reason: 'Absolute archive entry path' };
  if (/^[a-zA-Z]:/.test(entryPath)) return { ok: false, reason: 'Drive-prefixed archive entry path' };
  const parts = entryPath.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    return { ok: false, reason: `Unsafe path segment in archive entry: ${entryPath}` };
  }
  if (!ALLOWED_BACKUP_ENTRY_PATTERNS.some((pattern) => pattern.test(entryPath))) {
    return { ok: false, reason: `Disallowed archive entry path: ${entryPath}` };
  }
  return { ok: true };
}

export const backupMissingMediaItemSchema = z.object({
  videoId: z.uuid(),
  videoName: z.string(),
  fileName: z.string(),
});
export type BackupMissingMediaItem = z.infer<typeof backupMissingMediaItemSchema>;

export const backupStyleSummarySchema = z.object({
  hasProjectStyle: z.boolean(),
  customVideoStyleCount: z.number().int().min(0),
});
export type BackupStyleSummary = z.infer<typeof backupStyleSummarySchema>;

export const backupManifestEntrySchema = z.object({
  path: z.string().min(1),
  size: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  kind: z.enum(['meta', 'media', 'artifact']),
  method: z.enum(['store', 'deflate']),
});
export type BackupManifestEntry = z.infer<typeof backupManifestEntrySchema>;

export const backupManifestSchema = z.object({
  backupVersion: z.number().int().min(1),
  projectFormatVersion: z.number().int().min(1),
  appVersion: z.string().min(1),
  exportedAt: z.string().min(1),
  projectName: z.string(),
  videoCount: z.number().int().min(0),
  subtitleCount: z.number().int().min(0),
  editCount: z.number().int().min(0),
  styleSummary: backupStyleSummarySchema,
  artifactCount: z.number().int().min(0),
  mediaBytes: z.number().int().min(0),
  missingMedia: z.array(backupMissingMediaItemSchema),
  entries: z.array(backupManifestEntrySchema),
});
export type BackupManifest = z.infer<typeof backupManifestSchema>;

export const backupPreviewInputSchema = z.strictObject({
  projectId: projectIdSchema,
});

export interface BackupPreviewResult {
  projectId: string;
  projectName: string;
  revision: number;
  videoCount: number;
  subtitleCount: number;
  editCount: number;
  styleSummary: BackupStyleSummary;
  artifactCount: number;
  estimatedMediaBytes: number;
  estimatedTotalBytes: number;
  missingMedia: BackupMissingMediaItem[];
  empty: boolean;
  excludesSecretsNotice: true;
}

export const backupExportInputSchema = z.strictObject({
  projectId: projectIdSchema,
  expectedRevision: z.number().int().min(0),
  includeMissingMedia: z.boolean().default(false),
  operationId: z.uuid().optional(),
});
export type BackupExportInput = z.input<typeof backupExportInputSchema>;

export interface BackupExportResult {
  assetId: string;
  filename: string;
  size: number;
  sha256: string;
  revision: number;
  manifest: BackupManifest;
}

export const backupInspectInputSchema = z.strictObject({
  stagingId: z.uuid(),
  operationId: z.uuid().optional(),
});
export type BackupInspectInput = z.input<typeof backupInspectInputSchema>;

export interface BackupInspectionResult {
  stagingId: string;
  stagingDigest: string;
  archiveBytes: number;
  backupVersion: number;
  projectFormatVersion: number;
  appVersion: string;
  exportedAt: string;
  projectName: string;
  videoCount: number;
  subtitleCount: number;
  editCount: number;
  styleSummary: BackupStyleSummary;
  artifactCount: number;
  mediaBytes: number;
  missingMedia: BackupMissingMediaItem[];
  requiredBytes: number;
  availableBytes: number;
}

export const backupImportInputSchema = z.strictObject({
  stagingId: z.uuid(),
  expectedDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  operationId: z.uuid().optional(),
});
export type BackupImportInput = z.input<typeof backupImportInputSchema>;

export interface BackupImportResult {
  projectId: string;
  name: string;
  videoCount: number;
  mediaMissingCount: number;
  firstVideoId?: string;
}

export const backupDiscardStagingInputSchema = z.strictObject({
  stagingId: z.uuid(),
});

export const backupShellStageSchema = z.strictObject({
  path: z.string().min(1).max(4096),
});

export type BackupRejectionReason =
  | 'CORRUPT_ARCHIVE'
  | 'UNSAFE_PATH'
  | 'UNSUPPORTED_BACKUP_VERSION'
  | 'UNSUPPORTED_PROJECT_VERSION'
  | 'INTEGRITY_MISMATCH'
  | 'INSUFFICIENT_SPACE'
  | 'UNSAFE_LINKED_MEDIA'
  | 'STAGING_NOT_FOUND';

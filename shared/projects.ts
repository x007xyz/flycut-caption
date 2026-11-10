// Project data contract shared by the Host `projects` plugin and the frontend (F-0002).
// Storage layout and versioning: docs/20-architecture/adr/0001-project-storage-format.md
// Desktop media: docs/20-architecture/adr/0002-desktop-project-media.md
// Format 2 (F-0003): several videos, project style, per-video revisions, Trash: docs/20-architecture/adr/0003-multi-video-projects.md
import { z } from 'zod';
import { editingSchema } from './editing/edl';
import { modelRefSchema } from './providers';
import { textRecordSchema } from './text/corrections';

/** Bump together with a migration in `server/projects/migrations.ts` and a note in ADR-0001. */
export const PROJECT_FORMAT_VERSION = 3;

export const projectIdSchema = z.uuid();

/** Subtitle chunks keep unknown fields: the format must not silently drop data it does not know. */
const chunkSchema = z.looseObject({
  id: z.string().min(1),
  text: z.string(),
  timestamp: z.tuple([z.number().finite(), z.number().finite()]),
  secondText: z.string().optional(),
  deleted: z.boolean().optional(),
});
export type ProjectChunk = z.infer<typeof chunkSchema>;

export const transcriptRecordSchema = z.object({
  editing: editingSchema.optional(),
  text: z.string(),
  chunks: z.array(chunkSchema),
  wordChunks: z.array(chunkSchema).optional(),
  hasWordTimestamps: z.boolean().optional(),
  language: z.string(),
  duration: z.number().finite().min(0),
});

/** What autosave writes: the user's edits on top of the transcript. Small (about 200 KB for an hour). */
export const projectEditsSchema = z.object({
  editing: editingSchema.optional(),
  chunks: z.array(chunkSchema),
  /** Word chunks the user deleted; the word list itself lives in transcript.json. */
  deletedWordIds: z.array(z.string()).default([]),
  /**
   * Format 1: the video's main and secondary style, including the aspect preset.
   * Format 2: only for a video whose `styleSource` is `custom`; a video that follows the project ignores it.
   * Opaque to the Host.
   */
  stylePair: z.record(z.string(), z.unknown()).optional(),
  /** Format 2: the video's aspect preset. Always per video, whatever the style source (F-0003 AC-13). */
  aspectPreset: z.string().optional(),
  /**
   * F-0013: append-only text operations. Format 3 additive extension: old edits have no field and read as none;
   * the project format version stays 3. At most 100 records are kept (newest first when read back).
   */
  textHistory: z.array(textRecordSchema).optional(),
});
export type ProjectEdits = z.infer<typeof projectEditsSchema>;

export const storedMediaSchema = z.object({ kind: z.literal('stored'), file: z.string(), size: z.number().int().min(0), mimeType: z.string() });
export const linkedMediaSchema = z.object({ kind: z.literal('linked'), path: z.string().min(1), size: z.number().int().min(0),
  mtimeMs: z.number(), fingerprint: z.string() });
export const projectMediaSchema = z.discriminatedUnion('kind', [storedMediaSchema, linkedMediaSchema]);
export type ProjectMedia = z.infer<typeof projectMediaSchema>;

export const projectVideoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  durationSeconds: z.number().min(0),
  createdAt: z.string(),
  media: projectMediaSchema,
  hasTranscript: z.boolean().default(false),
  model: modelRefSchema.optional(),
  /** Format 2: grows on every edits save of this video. Saves send it back; another video's saves do not touch it. */
  revision: z.number().int().min(0).default(0),
  /** Format 2: last edits save of this video (ISO 8601). */
  updatedAt: z.string().optional(),
  /** Format 2: `project` uses the project style, `custom` the video's own `stylePair` in edits.json. */
  styleSource: z.enum(['project', 'custom']).default('project'),
});
export type ProjectVideo = z.infer<typeof projectVideoSchema>;

/** Main and secondary subtitle style. Opaque to the Host. */
export const projectStyleSchema = z.object({ primary: z.record(z.string(), z.unknown()), secondary: z.record(z.string(), z.unknown()) });

/** `project.json`. `revision` grows by one on every successful write; saves send it back as `baseRevision`. */
export const projectFileSchema = z.object({
  formatVersion: z.number().int().min(1),
  id: z.uuid(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  revision: z.number().int().min(0),
  videos: z.array(projectVideoSchema),
  /**
   * Format 2: main and secondary style shared by the videos that follow the project (the aspect preset is ignored).
   * Missing in a project migrated from format 1 until its style is saved: the Host then reads the first video's
   * format-1 `stylePair` instead.
   */
  style: projectStyleSchema.optional(),
  /** Format 2: grows on every project style save. */
  styleRevision: z.number().int().min(0).default(0),
  /** Format 2: set while the project is in Trash (ISO 8601). */
  deletedAt: z.string().optional(),
  /** Format 2: when the Host deletes the project permanently (ISO 8601). */
  purgeAfter: z.string().optional(),
});
export type ProjectFile = z.infer<typeof projectFileSchema>;
export type ProjectStyle = z.infer<typeof projectStyleSchema>;

/** One row of the projects home. Mirrors `src/components/Project/types.ts`. */
export interface ProjectListItem {
  id: string;
  name: string;
  durationSeconds: number;
  createdAt: string;
  updatedAt: string;
  revision: number;
  videoCount: number;
  /** First video, for thumbnails and opening a single-video project. */
  videoId?: string;
  hasThumbnail: boolean;
  mediaMissing: boolean;
  /** Projects saved by a newer FlyCut are listed but cannot be opened. */
  newerVersion?: boolean;
}

/** One row of Trash (F-0003 AC-23). */
export interface TrashItem extends ProjectListItem {
  deletedAt: string;
  purgeAfter: string;
}

/** One video on the project detail page (F-0003 AC-26). */
export interface ProjectVideoSummary {
  id: string;
  name: string;
  durationSeconds: number;
  createdAt: string;
  updatedAt: string;
  hasTranscript: boolean;
  mediaMissing: boolean;
  hasThumbnail: boolean;
  styleSource: 'project' | 'custom';
  revision: number;
}

export type ProjectDetailResult =
  | { status: 'ok'; project: { id: string; name: string; createdAt: string; updatedAt: string; revision: number; styleRevision: number };
    videos: ProjectVideoSummary[] }
  | { status: 'trashed'; name: string } | { status: 'newer-version'; name: string };

/** How the client plays a project's media. `path` only exists on the desktop (the shell's asset protocol). */
export type ProjectPlayback = { kind: 'path'; path: string } | { kind: 'url'; path: string };

export type ProjectOpenResult =
  | { status: 'ok'; project: ProjectFile; video: ProjectVideo; transcript?: z.infer<typeof transcriptRecordSchema>; edits?: ProjectEdits;
    media: { status: 'ok' | 'missing'; name: string; playback?: ProjectPlayback };
    /** Format 2: the project style in effect (stored, or read from a format-1 video); none means the default style. */
    projectStyle?: ProjectStyle;
    /** Format 2: the other videos, for the editor's video switcher (F-0003 AC-30). */
    videos: ProjectVideoSummary[] }
  | { status: 'newer-version'; name: string } | { status: 'trashed'; name: string };

export type SaveResult = { status: 'saved'; revision: number; updatedAt: string } | { status: 'conflict'; revision: number; updatedAt: string };
/**
 * Format 2 saves (F-0003 AC-14, AC-15). `revision` is the video's or the style's revision; `projectRevision` the project's.
 * `trashed` / `deleted`: the project went to Trash or was deleted elsewhere; nothing was written.
 */
export type SaveResultV2 =
  | { status: 'saved'; revision: number; projectRevision: number; updatedAt: string }
  | { status: 'conflict'; revision: number; updatedAt: string }
  | { status: 'trashed' } | { status: 'deleted' } | { status: 'video-missing' };

/** `assetId`: an uploaded file the project takes over (Web). `mediaRef`: a local file the desktop shell registered. */
export const mediaSourceSchema = z.union([z.object({ assetId: z.uuid(), mimeType: z.string().default('') }), z.object({ mediaRef: z.uuid() })]);

export const projectCreateSchema = z.object({ name: z.string().trim().min(1).max(200), videoName: z.string().min(1).max(260),
  durationSeconds: z.number().min(0).default(0), media: mediaSourceSchema });
export const projectOpenSchema = z.object({ projectId: projectIdSchema, videoId: z.uuid().optional() });
export const saveTranscriptSchema = z.object({ projectId: projectIdSchema, videoId: z.uuid(), transcript: transcriptRecordSchema,
  model: modelRefSchema.optional(), durationSeconds: z.number().min(0).optional() });
export const saveEditsSchema = z.object({ projectId: projectIdSchema, videoId: z.uuid(), edits: projectEditsSchema,
  baseRevision: z.number().int().min(0), force: z.boolean().default(false) });
/** Save as new project (AC-25): copies the project, then writes `edits` (this window's version) into the copy. */
export const duplicateSchema = z.object({ projectId: projectIdSchema, videoId: z.uuid(), name: z.string().trim().min(1).max(200),
  edits: projectEditsSchema.optional(),
  /**
   * F-0004: the new project's ID, chosen by the client so a retry after a lost response returns the same copy
   * instead of making another one (ADR-0004). Without it the Host picks one.
   */
  copyId: z.uuid().optional() });
export const relinkSchema = z.object({ projectId: projectIdSchema, videoId: z.uuid(), media: mediaSourceSchema });
export const thumbnailSchema = z.object({ projectId: projectIdSchema, videoId: z.uuid() });
/** Desktop shell only (`/shell/projects/media`): registers a file the user picked. */
export const shellLinkSchema = z.object({ path: z.string().min(1).max(4096) });

// ---------- F-0003 ----------
export const projectNameSchema = z.string().trim().min(1).max(200);
export const createEmptySchema = z.object({ name: projectNameSchema });
export const projectRefSchema = z.object({ projectId: projectIdSchema });
export const renameSchema = z.object({ projectId: projectIdSchema, name: projectNameSchema });
/** The Trash rows the user saw: projects trashed after that are not deleted (F-0003 AC-24). */
export const emptyTrashSchema = z.object({ projectIds: z.array(projectIdSchema).max(10_000) });
export const addVideoSchema = z.object({ projectId: projectIdSchema, videoName: z.string().min(1).max(260),
  durationSeconds: z.number().min(0).default(0), media: mediaSourceSchema });
export const removeVideoSchema = z.object({ projectId: projectIdSchema, videoId: z.uuid() });
export const saveVideoEditsSchema = z.object({ projectId: projectIdSchema, videoId: z.uuid(), edits: projectEditsSchema,
  styleSource: z.enum(['project', 'custom']), baseRevision: z.number().int().min(0), force: z.boolean().default(false) });
export const saveProjectStyleSchema = z.object({ projectId: projectIdSchema, style: projectStyleSchema,
  baseRevision: z.number().int().min(0), force: z.boolean().default(false) });
/**
 * Save as new project after the original was deleted permanently (F-0003 AC-32): the window's subtitles, edits and style
 * go into a new project whose media reads as missing, so the user chooses the file again (F-0002 AC-7). Never a local path.
 */
export const createFromSnapshotSchema = z.object({ name: projectNameSchema, videoName: z.string().min(1).max(260),
  durationSeconds: z.number().min(0).default(0), transcript: transcriptRecordSchema.optional(), edits: projectEditsSchema,
  styleSource: z.enum(['project', 'custom']), style: projectStyleSchema.optional() });

// ---------- F-0004 ----------
/** Version of the crash-recovery support the Host offers (`projects.identity`). */
export const RECOVERY_PROTOCOL_VERSION = 1;
/**
 * A Host's stable identity (F-0004, ADR-0004): a random ID kept in the Host home. Same across restarts and token
 * changes, different for another Host home. Clients keep recovery copies per Host by it, never by URL.
 */
export interface HostIdentity { hostId: string; recovery: number }

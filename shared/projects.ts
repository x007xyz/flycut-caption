// Project data contract shared by the Host `projects` plugin and the frontend (F-0002).
// Storage layout and versioning: docs/20-architecture/adr/0001-project-storage-format.md
// Desktop media: docs/20-architecture/adr/0002-desktop-project-media.md
import { z } from 'zod';
import { modelRefSchema } from './providers';

/** Bump together with a migration in `server/projects/migrations.ts` and a note in ADR-0001. */
export const PROJECT_FORMAT_VERSION = 1;

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
  text: z.string(),
  chunks: z.array(chunkSchema),
  wordChunks: z.array(chunkSchema).optional(),
  hasWordTimestamps: z.boolean().optional(),
  language: z.string(),
  duration: z.number().finite().min(0),
});

/** What autosave writes: the user's edits on top of the transcript. Small (about 200 KB for an hour). */
export const projectEditsSchema = z.object({
  chunks: z.array(chunkSchema),
  /** Word chunks the user deleted; the word list itself lives in transcript.json. */
  deletedWordIds: z.array(z.string()).default([]),
  /** Main and secondary subtitle style, including the aspect preset. Opaque to the Host. */
  stylePair: z.record(z.string(), z.unknown()).optional(),
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
});
export type ProjectVideo = z.infer<typeof projectVideoSchema>;

/** `project.json`. `revision` grows by one on every successful write; saves send it back as `baseRevision`. */
export const projectFileSchema = z.object({
  formatVersion: z.number().int().min(1),
  id: z.uuid(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  revision: z.number().int().min(0),
  videos: z.array(projectVideoSchema),
});
export type ProjectFile = z.infer<typeof projectFileSchema>;

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

/** How the client plays a project's media. `path` only exists on the desktop (the shell's asset protocol). */
export type ProjectPlayback = { kind: 'path'; path: string } | { kind: 'url'; path: string };

export type ProjectOpenResult =
  | { status: 'ok'; project: ProjectFile; video: ProjectVideo; transcript?: z.infer<typeof transcriptRecordSchema>; edits?: ProjectEdits;
    media: { status: 'ok' | 'missing'; name: string; playback?: ProjectPlayback } }
  | { status: 'newer-version'; name: string };

export type SaveResult = { status: 'saved'; revision: number; updatedAt: string } | { status: 'conflict'; revision: number; updatedAt: string };

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
  edits: projectEditsSchema.optional() });
export const relinkSchema = z.object({ projectId: projectIdSchema, videoId: z.uuid(), media: mediaSourceSchema });
export const thumbnailSchema = z.object({ projectId: projectIdSchema, videoId: z.uuid() });
/** Desktop shell only (`/shell/projects/media`): registers a file the user picked. */
export const shellLinkSchema = z.object({ path: z.string().min(1).max(4096) });

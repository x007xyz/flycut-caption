import { migrateLegacy, type Cue } from '../../shared/editing/edl';
// File layout of one Host's projects (ADR-0001). The `projects` plugin is the only caller.
//
//   <home>/projects/<projectId>/
//     project.json
//     videos/<videoId>/{transcript.json, edits.json, thumbnail.jpg}
//     media/<videoId>.<ext>
//     project.v<n>.json      the last format-n project.json, kept when a write first upgrades it (ADR-0003)
//   <home>/projects/.purge-<projectId>-<random>/   a permanent delete in progress; finished on the next start
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, cp, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import {
  PROJECT_FORMAT_VERSION, projectEditsSchema, projectFileSchema, transcriptRecordSchema,
  type ProjectEdits, type ProjectFile, type ProjectListItem, type ProjectMedia, type ProjectStyle, type ProjectVideo, type TrashItem,
} from '../../shared/projects';
import { trimTextHistory } from '../../shared/text/corrections';
import { migrateProject, NewerFormatError } from './migrations';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINGERPRINT_BYTES = 1024 * 1024;

/** Size, mtime and a hash of the first and last MiB: cheap enough for multi-GB files, catches replaced files. */
export async function fingerprintFile(path: string) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error('不是文件');
  const handle = await open(path, 'r');
  try {
    const hash = createHash('sha256').update(String(info.size));
    const head = Buffer.alloc(Math.min(FINGERPRINT_BYTES, info.size));
    await handle.read(head, 0, head.length, 0); hash.update(head);
    if (info.size > FINGERPRINT_BYTES) {
      const tail = Buffer.alloc(Math.min(FINGERPRINT_BYTES, info.size - head.length));
      await handle.read(tail, 0, tail.length, info.size - tail.length); hash.update(tail);
    }
    return { size: info.size, mtimeMs: info.mtimeMs, fingerprint: hash.digest('hex') };
  } finally { await handle.close(); }
}

/** Write-then-rename: an interrupted write leaves the previous file intact and at most a stray `.tmp`. */
async function writeJson(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value)); await rename(temporary, file); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}

const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as unknown;
const exists = (file: string) => stat(file).then(() => true, () => false);

export class ProjectStore {
  readonly root: string;
  /** Writes to one project run one after another; different projects do not wait for each other. */
  private queues = new Map<string, Promise<unknown>>();
  constructor(home: string) { this.root = join(home, 'projects'); }

  dir(id: string) { if (!ID.test(id)) throw new Error('Invalid project ID'); return join(this.root, id); }
  videoDir(id: string, videoId: string) { if (!ID.test(videoId)) throw new Error('Invalid video ID'); return join(this.dir(id), 'videos', videoId); }
  mediaFile(id: string, file: string) {
    // `file` comes from project.json; keep it inside the project's media folder.
    if (!/^media\/[0-9a-f-]{36}(\.[a-z0-9]{1,8})?$/i.test(file)) throw new Error('Invalid media file');
    return join(this.dir(id), file);
  }

  async init() { await mkdir(this.root, { recursive: true }); }

  /** Finishes permanent deletes a crash or shutdown interrupted (F-0003 AC-5). */
  async finishPurges() {
    const names = await readdir(this.root).catch(() => [] as string[]);
    await Promise.all(names.filter(name => name.startsWith('.purge-')).map(name => rm(join(this.root, name), { recursive: true, force: true })));
  }

  /**
   * Deletes a project permanently. The folder is first renamed out of the listing, so an interrupted delete never shows
   * a half-deleted project; `rm` removes symbolic links themselves and never what they point to, and linked media
   * (ADR-0002) live outside the folder, so the user's original files are never touched.
   */
  async purge(id: string) {
    const doomed = join(this.root, `.purge-${id}-${randomUUID()}`);
    await rename(this.dir(id), doomed);
    await rm(doomed, { recursive: true, force: true });
  }

  /** Deletes one video's folder and its stored media (F-0003 AC-11). Linked media are left alone. */
  async removeVideoFiles(id: string, video: ProjectVideo) {
    await rm(this.videoDir(id, video.id), { recursive: true, force: true });
    if (video.media.kind === 'stored') await rm(this.mediaFile(id, video.media.file), { force: true });
  }

  /**
   * The project style in effect. A project migrated from format 1 has none stored yet: its videos' format-1 edits
   * still carry the style the user chose, so the first one found becomes the project style (F-0003 AC-12, AC-16).
   */
  async projectStyle(project: ProjectFile): Promise<ProjectStyle | undefined> {
    if (project.style) return project.style;
    for (const video of project.videos) {
      const pair = (await this.readEdits(project.id, video.id).catch(() => undefined))?.stylePair;
      if (pair && typeof pair.primary === 'object' && pair.primary && typeof pair.secondary === 'object' && pair.secondary)
        return { primary: pair.primary as Record<string, unknown>, secondary: pair.secondary as Record<string, unknown> };
    }
    return undefined;
  }

  /** Runs `task` after every earlier write to the same project has settled. */
  exclusive<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.queues.set(id, next);
    void next.finally(() => { if (this.queues.get(id) === next) this.queues.delete(id); }).catch(() => undefined);
    return next;
  }

  /** Reads and migrates `project.json`. Throws `NewerFormatError` for a newer format without touching any file. */
  async read(id: string): Promise<ProjectFile> {
    return projectFileSchema.parse(migrateProject(await readJson(join(this.dir(id), 'project.json'))));
  }

  async writeProject(project: ProjectFile) {
    const file = join(this.dir(project.id), 'project.json');
    // The first write after a format upgrade keeps the old file: older FlyCut versions refuse the new one (ADR-0003).
    const previous = await readJson(file).then(raw => Number((raw as { formatVersion?: unknown }).formatVersion), () => undefined);
    if (previous !== undefined && Number.isInteger(previous) && previous < PROJECT_FORMAT_VERSION) {
      const backup = join(this.dir(project.id), `project.v${previous}.json`);
      if (!(await exists(backup))) await copyFile(file, backup);
    }
    await writeJson(file, { ...project, formatVersion: PROJECT_FORMAT_VERSION });
  }

  /** Projects in Trash, oldest deletion last (F-0003 AC-23). */
  async trash(): Promise<TrashItem[]> {
    const items = await this.list(async () => 'ok', 'trash');
    return items.filter((item): item is TrashItem => !!item.deletedAt).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }

  /** Active projects (the home page), or with `which: 'trash'` the ones in Trash. */
  async list(mediaStatus: (id: string, media: ProjectMedia) => Promise<'ok' | 'missing'>, which: 'active' | 'trash' = 'active'):
    Promise<Array<ProjectListItem & Partial<Pick<TrashItem, 'deletedAt' | 'purgeAfter'>>>> {
    const names = await readdir(this.root).catch(() => [] as string[]);
    const items = await Promise.all(names.filter(name => ID.test(name)).map(async (id): Promise<ProjectListItem | undefined> => {
      let raw: unknown;
      try { raw = await readJson(join(this.dir(id), 'project.json')); } catch { return undefined; }
      let project: ProjectFile;
      try { project = projectFileSchema.parse(migrateProject(raw)); }
      catch (error) {
        if (!(error instanceof NewerFormatError) || which === 'trash') return undefined;
        const value = raw as Partial<ProjectFile>;
        return { id, name: error.projectName, durationSeconds: 0, createdAt: String(value.createdAt ?? ''), updatedAt: String(value.updatedAt ?? ''),
          revision: 0, videoCount: Array.isArray(value.videos) ? value.videos.length : 0, hasThumbnail: false, mediaMissing: false, newerVersion: true };
      }
      if (!!project.deletedAt !== (which === 'trash')) return undefined;
      const first = project.videos[0];
      const missing = (await Promise.all(project.videos.map(video => mediaStatus(id, video.media)))).includes('missing');
      return { id, name: project.name, durationSeconds: project.videos.reduce((sum, video) => sum + video.durationSeconds, 0),
        createdAt: project.createdAt, updatedAt: project.updatedAt, revision: project.revision, videoCount: project.videos.length,
        videoId: first?.id, hasThumbnail: first ? await exists(join(this.videoDir(id, first.id), 'thumbnail.jpg')) : false, mediaMissing: missing,
        ...(project.deletedAt ? { deletedAt: project.deletedAt, purgeAfter: project.purgeAfter ?? project.deletedAt } : {}) };
    }));
    return items.filter(item => !!item).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async create(input: { name: string; video: Pick<ProjectVideo, 'name' | 'durationSeconds' | 'model'>; media: (projectId: string, videoId: string) => Promise<ProjectMedia> }) {
    await this.init();
    const id = randomUUID(); const videoId = randomUUID(); const now = new Date().toISOString();
    await mkdir(this.videoDir(id, videoId), { recursive: true });
    try {
      const media = await input.media(id, videoId);
      const project: ProjectFile = { formatVersion: PROJECT_FORMAT_VERSION, id, name: input.name, createdAt: now, updatedAt: now, revision: 1,
        styleRevision: 0, videos: [{ ...input.video, id: videoId, createdAt: now, updatedAt: now, media, hasTranscript: false, revision: 0, styleSource: 'project' }] };
      await this.writeProject(project);
      return project;
    } catch (error) { await rm(this.dir(id), { recursive: true, force: true }); throw error; }
  }

  /** A project without videos (F-0003 AC-1). */
  async createEmpty(name: string) {
    await this.init();
    const id = randomUUID(); const now = new Date().toISOString();
    await mkdir(this.dir(id), { recursive: true });
    const project: ProjectFile = { formatVersion: PROJECT_FORMAT_VERSION, id, name, createdAt: now, updatedAt: now, revision: 1, styleRevision: 0, videos: [] };
    try { await this.writeProject(project); } catch (error) { await rm(this.dir(id), { recursive: true, force: true }); throw error; }
    return project;
  }

  async readTranscript(id: string, videoId: string) {
    const file = join(this.videoDir(id, videoId), 'transcript.json');
    return (await exists(file)) ? transcriptRecordSchema.parse(await readJson(file)) : undefined;
  }
  async writeTranscript(id: string, videoId: string, transcript: unknown) {
    await mkdir(this.videoDir(id, videoId), { recursive: true });
    await writeJson(join(this.videoDir(id, videoId), 'transcript.json'), transcript);
  }
  async readEdits(id: string, videoId: string): Promise<ProjectEdits | undefined> {
    const file = join(this.videoDir(id, videoId), 'edits.json');
    if (!(await exists(file))) return undefined;
    const edits = projectEditsSchema.parse(await readJson(file));
    if (edits.textHistory?.length) edits.textHistory = trimTextHistory(edits.textHistory);
    if (edits.editing) return edits;
    const transcript = await this.readTranscript(id, videoId);
    if (!transcript?.duration) return edits;
    const deleted = new Set(edits.deletedWordIds);
    const words = (transcript.wordChunks ?? []).map(w => ({ ...w, deleted: deleted.has(w.id) }));
    return { ...edits, editing: { edl: migrateLegacy(transcript.duration, edits.chunks as unknown as Cue[], words as unknown as Cue[],
      transcript.hasWordTimestamps === true), history: [] } };
  }
  async writeEdits(id: string, videoId: string, edits: ProjectEdits) {
    edits = projectEditsSchema.parse(edits);
    // F-0013: the format-3 text history is bounded on both sides; an older client cannot grow the file without limit.
    if (edits.textHistory?.length) edits.textHistory = trimTextHistory(edits.textHistory);
    if (edits.editing) {
      const transcript = await this.readTranscript(id, videoId);
      const project = await this.read(id);
      const duration = transcript?.duration ?? project.videos.find(v => v.id === videoId)?.durationSeconds;
      if (!duration || Math.round(duration * 1e6) !== edits.editing.edl.sourceDurationUs)
        throw new Error('EDL media duration does not match');
      if (edits.chunks.some(c => c.timestamp[0] < 0 || c.timestamp[1] <= c.timestamp[0] || c.timestamp[1] > duration))
        throw new Error('Invalid subtitle source timestamp');
    }
    await mkdir(this.videoDir(id, videoId), { recursive: true });
    await writeJson(join(this.videoDir(id, videoId), 'edits.json'), edits);
  }

  /**
   * Copies a whole project under a new ID (Save as new project). Linked media keep pointing at the same file.
   * With a client-chosen `copyId` (F-0004) a retry returns the finished copy; a copy a crash left half done is redone.
   */
  async duplicate(id: string, name: string, copyId: string = randomUUID()) {
    const project = await this.read(id);
    const existing = await this.read(copyId).catch(() => undefined);
    if (existing?.id === copyId) return existing;
    await rm(this.dir(copyId), { recursive: true, force: true });
    const now = new Date().toISOString();
    await cp(this.dir(id), this.dir(copyId), { recursive: true, filter: source => !source.endsWith('.tmp') });
    const copy: ProjectFile = { ...project, id: copyId, name, createdAt: now, updatedAt: now, revision: 1, deletedAt: undefined, purgeAfter: undefined };
    await this.writeProject(copy);
    return copy;
  }

  static storedName(videoId: string, originalName: string) {
    const extension = extname(originalName).toLowerCase();
    return `media/${videoId}${/^\.[a-z0-9]{1,8}$/.test(extension) ? extension : ''}`;
  }
}

// File layout of one Host's projects (ADR-0001). The `projects` plugin is the only caller.
//
//   <home>/projects/<projectId>/
//     project.json
//     videos/<videoId>/{transcript.json, edits.json, thumbnail.jpg}
//     media/<videoId>.<ext>
import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, readdir, readFile, rename, rm, stat, writeFile, cp } from 'node:fs/promises';
import { extname, join } from 'node:path';
import {
  PROJECT_FORMAT_VERSION, projectEditsSchema, projectFileSchema, transcriptRecordSchema,
  type ProjectEdits, type ProjectFile, type ProjectListItem, type ProjectMedia, type ProjectVideo,
} from '../../shared/projects';
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
    await writeJson(join(this.dir(project.id), 'project.json'), { ...project, formatVersion: PROJECT_FORMAT_VERSION });
  }

  async list(mediaStatus: (id: string, media: ProjectMedia) => Promise<'ok' | 'missing'>): Promise<ProjectListItem[]> {
    const names = await readdir(this.root).catch(() => [] as string[]);
    const items = await Promise.all(names.filter(name => ID.test(name)).map(async (id): Promise<ProjectListItem | undefined> => {
      let raw: unknown;
      try { raw = await readJson(join(this.dir(id), 'project.json')); } catch { return undefined; }
      let project: ProjectFile;
      try { project = projectFileSchema.parse(migrateProject(raw)); }
      catch (error) {
        if (!(error instanceof NewerFormatError)) return undefined;
        const value = raw as Partial<ProjectFile>;
        return { id, name: error.projectName, durationSeconds: 0, createdAt: String(value.createdAt ?? ''), updatedAt: String(value.updatedAt ?? ''),
          revision: 0, videoCount: Array.isArray(value.videos) ? value.videos.length : 0, hasThumbnail: false, mediaMissing: false, newerVersion: true };
      }
      const first = project.videos[0];
      const missing = (await Promise.all(project.videos.map(video => mediaStatus(id, video.media)))).includes('missing');
      return { id, name: project.name, durationSeconds: project.videos.reduce((sum, video) => sum + video.durationSeconds, 0),
        createdAt: project.createdAt, updatedAt: project.updatedAt, revision: project.revision, videoCount: project.videos.length,
        videoId: first?.id, hasThumbnail: first ? await exists(join(this.videoDir(id, first.id), 'thumbnail.jpg')) : false, mediaMissing: missing };
    }));
    return items.filter((item): item is ProjectListItem => !!item).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async create(input: { name: string; video: Omit<ProjectVideo, 'id' | 'createdAt' | 'media' | 'hasTranscript'>; media: (projectId: string, videoId: string) => Promise<ProjectMedia> }) {
    await this.init();
    const id = randomUUID(); const videoId = randomUUID(); const now = new Date().toISOString();
    await mkdir(this.videoDir(id, videoId), { recursive: true });
    try {
      const media = await input.media(id, videoId);
      const project: ProjectFile = { formatVersion: PROJECT_FORMAT_VERSION, id, name: input.name, createdAt: now, updatedAt: now, revision: 1,
        videos: [{ ...input.video, id: videoId, createdAt: now, media, hasTranscript: false }] };
      await this.writeProject(project);
      return project;
    } catch (error) { await rm(this.dir(id), { recursive: true, force: true }); throw error; }
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
    return (await exists(file)) ? projectEditsSchema.parse(await readJson(file)) : undefined;
  }
  async writeEdits(id: string, videoId: string, edits: ProjectEdits) {
    await mkdir(this.videoDir(id, videoId), { recursive: true });
    await writeJson(join(this.videoDir(id, videoId), 'edits.json'), edits);
  }

  /** Copies a whole project under a new ID (Save as new project). Linked media keep pointing at the same file. */
  async duplicate(id: string, name: string) {
    const project = await this.read(id);
    const copyId = randomUUID(); const now = new Date().toISOString();
    await cp(this.dir(id), this.dir(copyId), { recursive: true, filter: source => !source.endsWith('.tmp') });
    const copy: ProjectFile = { ...project, id: copyId, name, createdAt: now, updatedAt: now, revision: 1 };
    await this.writeProject(copy);
    return copy;
  }

  static storedName(videoId: string, originalName: string) {
    const extension = extname(originalName).toLowerCase();
    return `media/${videoId}${/^\.[a-z0-9]{1,8}$/.test(extension) ? extension : ''}`;
  }
}

// Project format migrations (ADR-0001). `migrations[n]` turns a version-n `project.json` into version n+1.
// Every format change adds one entry here, a test in tests/architecture/projects.test.ts and a note in ADR-0001.
import { PROJECT_FORMAT_VERSION } from '../../shared/projects';

type RawProject = Record<string, unknown> & { formatVersion: number };

export const migrations: Record<number, (raw: RawProject) => RawProject> = {};

export class NewerFormatError extends Error {
  readonly projectName: string;
  readonly version: number;
  constructor(projectName: string, version: number) {
    super(`项目格式版本 ${version} 比当前程序支持的 ${PROJECT_FORMAT_VERSION} 更新`);
    this.projectName = projectName; this.version = version;
  }
}

/** Raises a project to the current version. Never writes: callers persist the result on their next save. */
export function migrateProject(raw: unknown, table = migrations, current = PROJECT_FORMAT_VERSION): RawProject {
  if (!raw || typeof raw !== 'object') throw new Error('project.json 不是对象');
  let project = raw as RawProject;
  const version = Number(project.formatVersion);
  if (!Number.isInteger(version) || version < 1) throw new Error('project.json 缺少有效的 formatVersion');
  if (version > current) throw new NewerFormatError(String(project.name ?? ''), version);
  for (let next = version; next < current; next++) {
    const step = table[next];
    if (!step) throw new Error(`缺少项目格式 ${next} → ${next + 1} 的迁移`);
    project = { ...step(project), formatVersion: next + 1 };
  }
  return project;
}

// 崩溃恢复副本（F-0004，ADR-0004）：客户端保存的、还没写进 Host 的编辑状态。
// Host 仍是正式项目数据的来源；副本只是临时的，保存成功或用户放弃后删除。
// 这个文件只放数据格式和比较，不依赖界面和存储，供 projectService 和测试共用。
import { z } from 'zod';
import { editingSchema, type Editing } from '../../shared/editing/edl';
import { textRecordSchema, type TextRecord } from '../../shared/text/corrections';

export const RECOVERY_SCHEMA_VERSION = 1;

/** 一份完整的编辑快照：字幕（含译文、删除标记）、删除的字词、样式来源、样式和画幅。不含媒体、转写原文、密钥或撤销栈。 */
export const recoveryContentSchema = z.object({
  editing: editingSchema.optional(),
  chunks: z.array(z.looseObject({ id: z.string(), text: z.string(), timestamp: z.tuple([z.number(), z.number()]) })),
  deletedWordIds: z.array(z.string()),
  /** F-0013: confirmed text operations, kept so a recovery write does not erase the project history. */
  textHistory: z.array(textRecordSchema).optional(),
  styleSource: z.enum(['project', 'custom']),
  /** 当前生效的主、副字幕样式（含画幅）。跟随项目时它就是要写进项目样式的内容 */
  stylePair: z.object({ primary: z.record(z.string(), z.unknown()), secondary: z.record(z.string(), z.unknown()) }),
});
export type RecoveryContent = z.infer<typeof recoveryContentSchema>;

export const recoveryCopySchema = z.object({
  schemaVersion: z.literal(RECOVERY_SCHEMA_VERSION),
  /** `hostId|projectId|videoId|sessionId`：一个编辑会话只有一份，新记录整份替换旧记录 */
  key: z.string(),
  /** `hostId|projectId|videoId`：打开项目时按它查找 */
  scope: z.string(),
  hostId: z.string(),
  projectId: z.string(),
  videoId: z.string(),
  sessionId: z.string(),
  /** 会话内递增；放弃时按它条件删除，别的窗口刚写入的更新版本不会被删掉 */
  sequence: z.number().int().min(0),
  /** 记录时间（ISO 8601），只用于展示和排序，不用来判断版本 */
  recordedAt: z.string(),
  /** 这份编辑基于的视频修订号和项目样式修订号：恢复前与 Host 比较，不同就是冲突 */
  baseVideoRevision: z.number().int().min(0),
  baseStyleRevision: z.number().int().min(0),
  projectName: z.string().optional(),
  content: recoveryContentSchema,
});
export type RecoveryCopy = z.infer<typeof recoveryCopySchema>;

export const scopeOf = (hostId: string, projectId: string, videoId: string) => `${hostId}|${projectId}|${videoId}`;
export const keyOf = (hostId: string, projectId: string, videoId: string, sessionId: string) => `${scopeOf(hostId, projectId, videoId)}|${sessionId}`;

/** 与键顺序无关、忽略 undefined 的 JSON：Host 读回的对象键顺序可能和编辑器里不同 */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => item === undefined ? 'null' : canonical(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

type StylePair = RecoveryContent['stylePair'];
const aspectOf = (pair: StylePair) => pair.primary.aspectPreset;
/** 主、副字幕样式，不含画幅（画幅按视频保存） */
const styleKey = (pair: StylePair) => canonical({ primary: { ...pair.primary, aspectPreset: undefined }, secondary: { ...pair.secondary, aspectPreset: undefined } });

/** Host 上这个视频当前的内容（已经按打开项目的规则算好生效样式） */
export interface HostContent {
  editing?: Editing;
  chunks: unknown[];
  deletedWordIds: string[];
  textHistory?: TextRecord[];
  styleSource: 'project' | 'custom';
  /** 这个视频打开时生效的样式（含画幅） */
  effectiveStyle: StylePair;
  /** 项目样式（跟随项目的视频用它） */
  projectStyle: StylePair;
}

/**
 * 副本和 Host 的差别，按两次保存分开：这个视频的修改（字幕、删除、画幅、样式来源、单独样式）和项目样式。
 * 两部分都相同，说明这份副本已经写进 Host（保存成功但副本没来得及删，或者另一次恢复已经写入），不需要再提示。
 */
export function diffWithHost(content: RecoveryContent, host: HostContent) {
  const sameWords = canonical([...content.deletedWordIds].sort()) === canonical([...host.deletedWordIds].sort());
  const text = content.textHistory !== undefined && canonical(content.textHistory) !== canonical(host.textHistory ?? []);
  const video = (content.editing !== undefined && canonical(content.editing) !== canonical(host.editing)) || canonical(content.chunks) !== canonical(host.chunks) || !sameWords || text || content.styleSource !== host.styleSource
    || aspectOf(content.stylePair) !== aspectOf(host.effectiveStyle)
    || (content.styleSource === 'custom' && styleKey(content.stylePair) !== styleKey(host.effectiveStyle));
  const style = content.styleSource === 'project' && styleKey(content.stylePair) !== styleKey(host.projectStyle);
  return { video, style, same: !video && !style };
}

/** 副本是否与 Host 冲突：只看还没写进去的那部分，它基于的修订号已经不是 Host 当前的修订号 */
export function conflictsWithHost(copy: Pick<RecoveryCopy, 'baseVideoRevision' | 'baseStyleRevision'>, diff: ReturnType<typeof diffWithHost>,
  revisions: { video: number; style: number }) {
  return (diff.video && revisions.video !== copy.baseVideoRevision) || (diff.style && revisions.style !== copy.baseStyleRevision);
}

/** 读到的记录：能解析的副本，或者解析不了的原始记录（保留，不删除） */
export type StoredRecord = { ok: true; copy: RecoveryCopy } | { ok: false; key: string };

export function parseRecord(raw: unknown): StoredRecord {
  const parsed = recoveryCopySchema.safeParse(raw);
  if (parsed.success) return { ok: true, copy: parsed.data };
  const key = raw && typeof raw === 'object' && typeof (raw as { key?: unknown }).key === 'string' ? (raw as { key: string }).key : '';
  return { ok: false, key };
}

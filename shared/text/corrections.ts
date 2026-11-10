// F-0013: AI correction review and persistent text history, shared by the client, Host and tests.
// Pending suggestions never reach the project; only a confirmed batch becomes one TextRecord.
import { z } from 'zod';

export interface TextItem { id: string; text: string }

/** One reviewed AI suggestion. `aiText` lets the user restore the model output after a manual edit. */
export interface CorrectionSuggestion {
  id: string;
  before: string;
  after: string;
  aiText: string;
  selected: boolean;
  adjusted: boolean;
  batchId: string;
}

export const MAX_TEXT_HISTORY = 100;

export const textSnapshotSchema = z.object({ id: z.string().min(1), text: z.string() });
export type TextSnapshot = z.infer<typeof textSnapshotSchema>;

/** `undo`/`redo` mirror cutHistory: Ctrl+Z on a text operation is recorded, the original record stays. */
export const textRecordKindSchema = z.enum(['ai-correction', 'history-restore', 'undo', 'redo']);
export type TextRecordKind = z.infer<typeof textRecordKindSchema>;

export const textRecordSchema = z.object({
  id: z.string().min(1),
  at: z.string().min(1),
  kind: textRecordKindSchema,
  /** Text of the affected subtitles before this operation. */
  before: z.array(textSnapshotSchema),
  /** Text of the affected subtitles after this operation. */
  after: z.array(textSnapshotSchema),
});
export type TextRecord = z.infer<typeof textRecordSchema>;

/** Oldest records fall off first so the project file stays bounded. */
export function trimTextHistory(records: readonly TextRecord[], max = MAX_TEXT_HISTORY): TextRecord[] {
  if (max <= 0) return [];
  return records.slice(Math.max(0, records.length - max));
}

/** Batch correction results must match the request exactly: every id once, non-empty text. */
export function validateCorrectionResults(requested: readonly TextItem[], parsed: unknown): TextItem[] {
  if (!Array.isArray(parsed)) throw new Error('AI 返回内容不是数组');
  const expected = new Map(requested.map(item => [item.id, item]));
  if (expected.size !== requested.length) throw new Error('纠错请求包含重复的字幕 ID');
  const texts = new Map<string, string>();
  const duplicate: string[] = [];
  const unknown: string[] = [];
  for (const entry of parsed) {
    const raw = entry && typeof entry === 'object' ? entry as { id?: unknown; text?: unknown } : {};
    const id = raw.id === undefined || raw.id === null ? '' : String(raw.id);
    if (!expected.has(id)) { unknown.push(id || '(无 id)'); continue; }
    if (texts.has(id)) { duplicate.push(id); continue; }
    texts.set(id, typeof raw.text === 'string' ? raw.text : '');
  }
  const missing = requested.filter(item => !texts.has(item.id)).map(item => item.id);
  const empty = requested.filter(item => {
    const text = texts.get(item.id);
    return text !== undefined && !text.trim();
  }).map(item => item.id);
  const problems = [
    missing.length && `缺少 ${missing.length} 条（id: ${missing.slice(0, 5).join(', ')}）`,
    duplicate.length && `重复 ${duplicate.length} 条（id: ${duplicate.slice(0, 5).join(', ')}）`,
    unknown.length && `多出 ${unknown.length} 条未知 id（${unknown.slice(0, 5).join(', ')}）`,
    empty.length && `空文本 ${empty.length} 条（id: ${empty.slice(0, 5).join(', ')}）`,
  ].filter(Boolean);
  if (problems.length) throw new Error(`AI 返回结果校验失败：${problems.join('；')}`);
  return requested.map(item => ({ id: item.id, text: texts.get(item.id)! }));
}

/** Split a long subtitle list into model-sized batches while preserving order. */
export function splitCorrectionBatches(items: readonly TextItem[], maxItems = 25, maxChars = 2400): TextItem[][] {
  if (!items.length) return [];
  const batches: TextItem[][] = [];
  let current: TextItem[] = [];
  let chars = 0;
  for (const item of items) {
    const nextChars = chars + item.text.length;
    if (current.length && (current.length >= maxItems || nextChars > maxChars)) {
      batches.push(current); current = []; chars = 0;
    }
    current.push(item); chars += item.text.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** Human-readable difference marker for subtitle rows: unchanged prefix/suffix, changed middle. */
export function markTextDiff(before: string, after: string) {
  if (before === after) return { prefix: before, before: '', after: '', suffix: '' };
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return {
    prefix: before.slice(0, prefix),
    before: before.slice(prefix, before.length - suffix),
    after: after.slice(prefix, after.length - suffix),
    suffix: suffix ? before.slice(before.length - suffix) : '',
  };
}

export interface TextUpdate { id: string; text: string; /** Optional formal text this update was prepared against. */ before?: string }
export type TextUpdateValidation =
  | { ok: true; changes: TextSnapshot[] }
  | { ok: false; reason: 'empty' | 'duplicate' | 'unknown' | 'blank' | 'stale'; ids: string[] };

/** Validate one atomic text submission. Only `text` is ever part of a change. */
export function validateTextUpdates(chunks: readonly { id: string; text: string }[], updates: readonly TextUpdate[]): TextUpdateValidation {
  if (!updates.length) return { ok: false, reason: 'empty', ids: [] };
  const byId = new Map(chunks.map(chunk => [chunk.id, chunk.text]));
  const seen = new Set<string>();
  const duplicate: string[] = [];
  const unknown: string[] = [];
  const blank: string[] = [];
  const stale: string[] = [];
  for (const update of updates) {
    if (seen.has(update.id)) { duplicate.push(update.id); continue; }
    seen.add(update.id);
    if (!byId.has(update.id)) { unknown.push(update.id); continue; }
    if (!update.text.trim()) blank.push(update.id);
    if (update.before !== undefined && byId.get(update.id) !== update.before) stale.push(update.id);
  }
  if (duplicate.length) return { ok: false, reason: 'duplicate', ids: duplicate };
  if (unknown.length) return { ok: false, reason: 'unknown', ids: unknown };
  if (blank.length) return { ok: false, reason: 'blank', ids: blank };
  if (stale.length) return { ok: false, reason: 'stale', ids: stale };
  return { ok: true, changes: updates.map(update => ({ id: update.id, text: update.text })) };
}

/** Apply only text values; IDs, timestamps, translations and word projections stay untouched. */
export function applyTextSnapshots<T extends { id: string; text: string }>(chunks: readonly T[], snapshots: readonly TextSnapshot[]): T[] {
  const byId = new Map(snapshots.map(snapshot => [snapshot.id, snapshot.text]));
  return chunks.map(chunk => byId.has(chunk.id) ? { ...chunk, text: byId.get(chunk.id)! } : chunk);
}

export interface TextChangePlan { id: string; before: TextSnapshot[]; after: TextSnapshot[] }

/** One record for a text batch; unchanged and unknown ids are not recorded. */
export function createTextRecord(kind: TextRecordKind, beforeChunks: readonly { id: string; text: string }[], afterChunks: readonly { id: string; text: string }[], options: { id?: string; at?: string } = {}): TextRecord | null {
  const before = new Map(beforeChunks.map(chunk => [chunk.id, chunk.text]));
  const after = new Map(afterChunks.map(chunk => [chunk.id, chunk.text]));
  const ids = [...before.keys()].filter(id => after.has(id) && before.get(id) !== after.get(id));
  if (!ids.length) return null;
  return {
    id: options.id ?? crypto.randomUUID(),
    at: options.at ?? new Date().toISOString(),
    kind,
    before: ids.map(id => ({ id, text: before.get(id)! })),
    after: ids.map(id => ({ id, text: after.get(id)! })),
  };
}

export type TextRestorePlan =
  | { ok: true; record: TextRecord; changes: TextSnapshot[] }
  | { ok: false; reason: 'missing' | 'conflict'; ids: string[] };

/**
 * Plan a history restore. Later edits to any affected subtitle make the whole restore a conflict;
 * unrelated text and every non-text field are left alone.
 */
export function planTextRestore(records: readonly TextRecord[], chunks: readonly { id: string; text: string }[], id: string,
  options: { newId?: string; at?: string } = {}): TextRestorePlan {
  const record = records.find(entry => entry.id === id);
  if (!record) return { ok: false, reason: 'missing', ids: [] };
  const byId = new Map(chunks.map(chunk => [chunk.id, chunk.text]));
  const before = new Map(record.before.map(entry => [entry.id, entry.text]));
  const conflict: string[] = [];
  for (const entry of record.after) {
    if (!byId.has(entry.id) || byId.get(entry.id) !== entry.text) conflict.push(entry.id);
  }
  if (conflict.length) return { ok: false, reason: 'conflict', ids: conflict };
  const changes = record.after.map(entry => ({ id: entry.id, text: before.get(entry.id) ?? byId.get(entry.id)! }));
  return {
    ok: true,
    changes,
    record: {
      id: options.newId ?? crypto.randomUUID(),
      at: options.at ?? new Date().toISOString(),
      kind: 'history-restore',
      before: record.after.map(entry => ({ ...entry })),
      after: changes.map(entry => ({ ...entry })),
    },
  };
}

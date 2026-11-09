// F-0005: the sole edit/time calculation, in original-media integer microseconds.
import { z } from 'zod';

export const US = 1_000_000;
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const intervalSchema = z.object({ startUs: integer, endUs: integer }).refine(r => r.endUs > r.startUs, 'Invalid cut interval');
export type Interval = z.infer<typeof intervalSchema>;
export const edlSchema = z.object({ version: z.literal(1), sourceDurationUs: integer.positive(),
  origin: z.enum(['explicit', 'legacy-export']), deleted: z.array(intervalSchema) }).superRefine((edl, ctx) => {
  if (edl.deleted.some(r => r.endUs > edl.sourceDurationUs)) ctx.addIssue({ code: 'custom', message: 'Cut exceeds source duration' });
});
export type Edl = z.infer<typeof edlSchema>;
export const cutRecordSchema = z.object({ id: z.string(), at: z.string(), kind: z.string(), edl: edlSchema,
  deletedIds: z.array(z.string()), deletedWordIds: z.array(z.string()) });
export type CutRecord = z.infer<typeof cutRecordSchema>;
export const editingSchema = z.object({ edl: edlSchema, history: z.array(cutRecordSchema).default([]) }).refine(
  editing => editing.history.every(r => r.edl.sourceDurationUs === editing.edl.sourceDurationUs), 'History media duration mismatch');
export type Editing = z.infer<typeof editingSchema>;
export interface Cue { id: string; text: string; timestamp: [number, number]; secondText?: string; deleted?: boolean;
  isBlankSpacer?: boolean; wordIds?: string[]; sentenceId?: string }
export interface MappedRange extends Interval { outputStartUs: number; outputEndUs: number }

export function toUs(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0 || !Number.isSafeInteger(Math.round(seconds * US))) throw new Error('Invalid media time');
  return Math.round(seconds * US);
}
export const fromUs = (time: number) => time / US;
export function union(ranges: Interval[]): Interval[] {
  const sorted = ranges.map(r => intervalSchema.parse(r)).sort((a, b) => a.startUs - b.startUs);
  const result: Interval[] = [];
  for (const r of sorted) {
    const last = result.at(-1);
    if (last && r.startUs <= last.endUs) last.endUs = Math.max(last.endUs, r.endUs);
    else result.push({ ...r });
  }
  return result;
}
export function validateEdl(value: unknown): Edl {
  const edl = edlSchema.parse(value);
  return { ...edl, deleted: union(edl.deleted) };
}
export function createEdl(duration: number, deleted: Array<{ start: number; end: number }> = [], origin: Edl['origin'] = 'explicit'): Edl {
  return validateEdl({ version: 1, sourceDurationUs: toUs(duration), origin,
    deleted: deleted.map(r => ({ startUs: toUs(r.start), endUs: toUs(r.end) })) });
}
export function subtract(ranges: Interval[], restored: Interval[]): Interval[] {
  let result = union(ranges);
  for (const r of union(restored)) result = result.flatMap(s => {
    if (r.endUs <= s.startUs || r.startUs >= s.endUs) return [s];
    return [s.startUs < r.startUs ? { startUs: s.startUs, endUs: r.startUs } : null,
      s.endUs > r.endUs ? { startUs: r.endUs, endUs: s.endUs } : null].filter((x): x is Interval => x !== null);
  });
  return result;
}
export function changeCuts(edl: Edl, ranges: Array<{ start: number; end: number }>, deleted = true): Edl {
  const incoming = createEdl(fromUs(edl.sourceDurationUs), ranges).deleted;
  return validateEdl({ ...edl, deleted: deleted ? union([...edl.deleted, ...incoming]) : subtract(edl.deleted, incoming) });
}
export function deriveKept(value: Edl): MappedRange[] {
  const edl = validateEdl(value); const kept: MappedRange[] = [];
  let startUs = 0; let output = 0;
  for (const r of [...edl.deleted, { startUs: edl.sourceDurationUs, endUs: edl.sourceDurationUs }]) {
    if (r.startUs > startUs) {
      kept.push({ startUs, endUs: r.startUs, outputStartUs: output, outputEndUs: output + r.startUs - startUs });
      output += r.startUs - startUs;
    }
    startUs = r.endUs;
  }
  return kept;
}
export const outputDuration = (edl: Edl) => fromUs(deriveKept(edl).at(-1)?.outputEndUs ?? 0);
export function outputToSource(edl: Edl, seconds: number): number | null {
  const time = toUs(seconds); const kept = deriveKept(edl); if (!kept.length) return null;
  const last = kept.at(-1)!;
  if (time >= last.outputEndUs) return fromUs(last.endUs);
  const r = kept.find(s => time >= s.outputStartUs && time < s.outputEndUs)!;
  return fromUs(r.startUs + time - r.outputStartUs);
}
export function sourceToOutput(edl: Edl, seconds: number): number | null {
  const time = toUs(seconds); const kept = deriveKept(edl); if (!kept.length) return null;
  for (const r of kept) {
    if (time < r.startUs) return fromUs(r.outputStartUs);
    if (time < r.endUs) return fromUs(r.outputStartUs + time - r.startUs);
  }
  return fromUs(kept.at(-1)!.outputEndUs);
}
export function isDeleted(edl: Edl, cue: Cue): boolean {
  const start = toUs(cue.timestamp[0]); const end = toUs(cue.timestamp[1]);
  return union(edl.deleted).some(r => r.startUs <= start && r.endUs >= end);
}
export function projectCues(edl: Edl, chunks: Cue[]): Cue[] {
  const kept = deriveKept(edl); const result: Cue[] = [];
  for (const cue of chunks) {
    if (cue.deleted || cue.isBlankSpacer) continue;
    const start = toUs(cue.timestamp[0]); const end = toUs(cue.timestamp[1]);
    for (const r of kept) {
      const a = Math.max(start, r.startUs); const b = Math.min(end, r.endUs);
      if (b > a) result.push({ ...cue, id: `${cue.id}@${r.startUs}`, timestamp:
        [fromUs(r.outputStartUs + a - r.startUs), fromUs(r.outputStartUs + b - r.startUs)] });
    }
  }
  return result.sort((a, b) => a.timestamp[0] - b.timestamp[0]);
}
/** Reproduce the previous builder and Host fast path, including its tail-only trim bug. */
export function migrateLegacy(duration: number, chunks: Cue[], words: Cue[], hasWords: boolean): Edl {
  const deletedSentences = new Set(chunks.filter(c => c.deleted && !c.isBlankSpacer).map(c => c.id));
  const effectiveWords = words.map(w => deletedSentences.has(w.sentenceId ?? '') ? { ...w, deleted: true } : w);
  const units = hasWords && words.length ? [...effectiveWords, ...chunks.filter(c => c.isBlankSpacer)] : chunks;
  if (!units.some(c => c.deleted)) return createEdl(duration, [], 'legacy-export');
  const merged: Array<{ start: number; end: number; deleted: boolean }> = [];
  for (const c of [...units].sort((a, b) => a.timestamp[0] - b.timestamp[0])) {
    // Old exports discarded zero spans; unsafe old data is rejected instead of silently migrated.
    createEdl(duration, [{ start: c.timestamp[0], end: c.timestamp[1] }]);
    const last = merged.at(-1); const deleted = c.deleted === true;
    if (last && last.deleted === deleted && c.timestamp[0] <= last.end + 0.001) last.end = Math.max(last.end, c.timestamp[1]);
    else merged.push({ start: c.timestamp[0], end: c.timestamp[1], deleted });
  }
  const kept = merged.filter(r => !r.deleted);
  if (kept.some((r, i) => i > 0 && r.start < kept[i - 1].end)) throw new Error('Legacy overlapping export ranges require review');
  if (kept.length === 1 && kept[0].start <= 0.001) return createEdl(duration, [], 'legacy-export');
  const keptEdl = createEdl(duration, kept, 'legacy-export');
  const deleted = deriveKept(keptEdl).map(r => ({ start: fromUs(r.startUs), end: fromUs(r.endUs) }));
  return createEdl(duration, deleted, 'legacy-export');
}
export function exportSegments(edl: Edl): Array<{ start: number; end: number; keep: boolean }> {
  return deriveKept(edl).map(r => ({ start: fromUs(r.startUs), end: fromUs(r.endUs), keep: true }));
}

/** Quantize on one output clock; per-segment frame rounding accumulates at joins. */
export function ffmpegVideoFilter(edl: Edl): string {
  const kept = deriveKept(edl);
  if (!kept.length) throw new Error('No retained video');
  const select = kept.map(r => `gte(t,${fromUs(r.startUs)})*lt(t,${fromUs(r.endUs)})`).join('+');
  const positions = kept.map(r => `if(gte(T,${fromUs(r.startUs)})*lt(T,${fromUs(r.endUs)}),T-${fromUs(r.startUs)}+${fromUs(r.outputStartUs)},0)`).join('+');
  return `[0:v:0]select='${select}',setpts='(${positions})/TB',fps=fps=source_fps:round=near,tpad=stop_mode=clone:stop_duration=1,trim=duration=${outputDuration(edl)}[vout]`;
}

/** Adapter for older engines: intervals are already the captured formal export plan. */
export function projectFromKept(chunks: Cue[], segments: Array<{start: number; end: number; keep: boolean}>): Cue[] {
  const kept = segments.filter(s => s.keep);
  if (!kept.length) return [];
  const end = Math.max(...kept.map(s => s.end), ...chunks.map(c => c.timestamp[1]), 0);
  if (!end) return [];
  const inverse = createEdl(end, kept);
  return projectCues(createEdl(end, deriveKept(inverse).map(r => ({ start: fromUs(r.startUs), end: fromUs(r.endUs) }))), chunks);
}

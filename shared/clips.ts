import { z } from 'zod';
import { subtitleGraphicSceneSchema } from './subtitle-graphics/scene.ts';

export const clipCandidateSchema = z.strictObject({
  id: z.string().min(1).max(128),
  start: z.number().finite().nonnegative(),
  end: z.number().finite().positive(),
  score: z.number().finite().min(0).max(100),
  text: z.string(),
  reasons: z.array(z.string().min(1).max(200)).min(1),
});
export type ClipCandidate = z.infer<typeof clipCandidateSchema>;

export const clipCopySchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(5000),
  hashtags: z.array(z.string().trim().min(1).max(80)).max(30),
  generatedAt: z.iso.datetime(),
  baseText: z.string(),
});
export type ClipCopy = z.infer<typeof clipCopySchema>;

export const clipRecordSchema = z.looseObject({
  id: z.uuid(),
  name: z.string().trim().min(1).max(120),
  start: z.number().finite().nonnegative(),
  end: z.number().finite().positive(),
  score: z.number().finite().min(0).max(100),
  text: z.string(),
  reasons: z.array(z.string().min(1).max(200)),
  createdAt: z.iso.datetime(),
  copy: clipCopySchema.optional(),
});
export type ClipRecord = z.infer<typeof clipRecordSchema>;

export const clipsSuggestInputSchema = z.strictObject({ projectId: z.uuid(), videoId: z.uuid() });
export const clipsCreateInputSchema = z.strictObject({
  projectId: z.uuid(), videoId: z.uuid(), start: z.number().finite().nonnegative(), end: z.number().finite().positive(),
  name: z.string().trim().min(1).max(120), score: z.number().finite().min(0).max(100).optional(),
  text: z.string().max(20000).optional(), reasons: z.array(z.string().max(200)).max(20).optional(),
  sourceCandidateId: z.string().max(128).optional(),
});
export const clipCopyInputSchema = z.strictObject({ projectId: z.uuid(), videoId: z.uuid(), clipId: z.uuid(), configId: z.uuid() });
export const clipSaveCopyInputSchema = z.strictObject({ projectId: z.uuid(), videoId: z.uuid(), clipId: z.uuid(), copy: clipCopySchema });

export const clipsDeleteInputSchema = z.strictObject({ projectId: z.uuid(), videoId: z.uuid(), id: z.uuid() });

export interface ClipSuggestionResult {
  base: string;
  durationSeconds: number;
  candidates: ClipCandidate[];
}

const count = (text: string) => Array.from(text.replace(/\s+/gu, '')).length;

/** Snap a time to the nearest sentence boundary so clips never cut a sentence in half. */
export function snapToSentenceBoundary(chunks: ReadonlyArray<{ timestamp: [number, number] }>, time: number): number {
  let best = time; let distance = Infinity;
  for (const chunk of chunks) {
    for (const point of chunk.timestamp) {
      const next = Math.abs(point - time);
      if (next < distance) { distance = next; best = point; }
    }
  }
  return best;
}

export function suggestClips(
  chunks: ReadonlyArray<{ id: string; text: string; timestamp: [number, number] }>,
  duration: number,
  options: { minSeconds?: number; maxSeconds?: number; limit?: number } = {},
): ClipSuggestionResult {
  const minSeconds = options.minSeconds ?? 30;
  const maxSeconds = options.maxSeconds ?? 90;
  const limit = options.limit ?? 10;
  const active = chunks.filter(chunk => chunk.text.trim());
  const candidates: ClipCandidate[] = [];
  for (let start = 0; start < active.length; start += 1) {
    let end = start; let characters = 0;
    while (end < active.length) {
      const span = active[end].timestamp[1] - active[start].timestamp[0];
      if (span > maxSeconds) break;
      characters += count(active[end].text);
      const seconds = span;
      if (seconds >= minSeconds) {
        const density = characters / Math.max(1, seconds);
        const boundary = active[end].timestamp[1] <= duration + 0.01;
        if (boundary) {
          const score = Math.max(0, Math.min(100, Math.round(50 + Math.min(25, density * 3) + (seconds >= 35 && seconds <= 60 ? 15 : 5))));
          candidates.push({ id: `${active[start].id}-${active[end].id}`, start: active[start].timestamp[0], end: active[end].timestamp[1],
            score, text: active.slice(start, end + 1).map(chunk => chunk.text).join(' '),
            reasons: [`时长 ${seconds.toFixed(1)} 秒`, `信息密度 ${density.toFixed(2)} 字/秒`, '起止在句子边界'] });
        }
      }
      end += 1;
    }
  }
  return { base: JSON.stringify([chunks]), durationSeconds: duration,
    candidates: candidates.sort((a, b) => b.score - a.score).slice(0, limit) };
}


export const clipBatchItemSchema = z.strictObject({
  clipId: z.uuid(),
  name: z.string().trim().min(1).max(120),
  segments: z.array(z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().positive(), keep: z.boolean() })).min(1).max(500),
  subtitleProcessing: z.enum(['none', 'hard']).default('hard'),
  scene: subtitleGraphicSceneSchema.optional(),
});
export type ClipBatchItem = z.infer<typeof clipBatchItemSchema>;

export const clipBatchStartInputSchema = z.strictObject({
  projectId: z.uuid(), videoId: z.uuid(), requestId: z.uuid(),
  items: z.array(clipBatchItemSchema).min(1).max(50),
});
export type ClipBatchStartInput = z.infer<typeof clipBatchStartInputSchema>;

export const clipBatchStatusInputSchema = z.strictObject({ projectId: z.uuid(), requestId: z.uuid() });
export const clipBatchCancelInputSchema = clipBatchStatusInputSchema;

export type ClipBatchItemStatus = 'pending' | 'running' | 'saved' | 'failed' | 'cancelled';
export interface ClipBatchItemState { clipId: string; name: string; status: ClipBatchItemStatus; outputFile?: string; error?: string }
export interface ClipBatchSnapshot {
  requestId: string; projectId: string; videoId: string;
  status: 'queued' | 'running' | 'completed' | 'partial' | 'cancelled' | 'failed';
  jobId?: string; items: ClipBatchItemState[]; createdAt: string; updatedAt: string;
}
export const clipBatchSnapshotSchema = z.looseObject({
  requestId: z.uuid(), projectId: z.uuid(), videoId: z.uuid(),
  status: z.enum(['queued', 'running', 'completed', 'partial', 'cancelled', 'failed']),
  jobId: z.string().optional(),
  items: z.array(z.looseObject({ clipId: z.uuid(), name: z.string(), status: z.enum(['pending', 'running', 'saved', 'failed', 'cancelled']),
    outputFile: z.string().optional(), error: z.string().optional() })),
  createdAt: z.string(), updatedAt: z.string(),
});

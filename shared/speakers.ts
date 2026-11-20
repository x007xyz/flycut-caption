import { z } from 'zod';
import { modelRefSchema } from './providers';

export const speakerSegmentSchema = z.looseObject({
  speaker: z.string().min(1).max(64),
  start: z.number().finite().nonnegative(),
  end: z.number().finite().positive(),
});
export type SpeakerSegment = z.infer<typeof speakerSegmentSchema>;

export const speakerAnalyzeInputSchema = z.strictObject({
  projectId: z.uuid(),
  videoId: z.uuid(),
  model: modelRefSchema,
  operationId: z.uuid().optional(),
});
export type SpeakerAnalyzeInput = z.infer<typeof speakerAnalyzeInputSchema>;

export const speakerVoicesInputSchema = z.strictObject({
  projectId: z.uuid(),
  videoId: z.uuid(),
  voices: z.record(z.string().max(64), z.string().min(1).max(200)),
});

export const speakerNamesInputSchema = z.strictObject({
  projectId: z.uuid(),
  videoId: z.uuid(),
  names: z.record(z.string().max(64), z.string().trim().min(1).max(80)),
});

/** Stable speaker for a cue: the segment with the largest overlap. */
export function speakerForCue(segments: ReadonlyArray<{ speaker: string; start: number; end: number }>, timestamp: [number, number]): string | null {
  let best: { speaker: string; overlap: number } | null = null;
  for (const segment of segments) {
    const overlap = Math.min(timestamp[1], segment.end) - Math.max(timestamp[0], segment.start);
    if (overlap > 0 && (!best || overlap > best.overlap)) best = { speaker: segment.speaker, overlap };
  }
  return best?.speaker ?? null;
}

export interface SpeakerAnalyzeResult {
  status: 'saved';
  segments: SpeakerSegment[];
  speakerCount: number;
  durationSeconds: number;
  videoRevision: number;
  projectRevision: number;
  updatedAt: string;
}

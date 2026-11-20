import { z } from 'zod';

export const reframeRecordSchema = z.looseObject({
  model: z.string().min(1).max(100),
  fps: z.number().finite().positive(),
  samples: z.array(z.object({ time: z.number().finite().nonnegative(), centerX: z.number().finite().nonnegative(), confidence: z.number().finite().min(0).max(1) })).max(20000),
  sourceFingerprint: z.string().min(1),
  createdAt: z.iso.datetime(),
});
export type ReframeRecord = z.infer<typeof reframeRecordSchema>;

export const reframeAnalyzeInputSchema = z.strictObject({ projectId: z.uuid(), videoId: z.uuid(), fps: z.number().finite().min(0.5).max(5).optional() });

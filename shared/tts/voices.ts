import { z } from 'zod';

export const VOICE_FILE_PATTERN = /^voices\/[0-9a-f-]{36}\.wav$/i;

export const voiceAuthorizationSchema = z.strictObject({
  confirmed: z.literal(true),
  statement: z.string().trim().min(1).max(300),
  confirmedAt: z.iso.datetime(),
  sourceLabel: z.string().trim().min(1).max(200).optional(),
});

export const voiceProfileSchema = z.looseObject({
  id: z.uuid(),
  name: z.string().trim().min(1).max(80),
  file: z.string().regex(VOICE_FILE_PATTERN, 'Invalid voice sample path'),
  durationSeconds: z.number().finite().positive(),
  sourceVideoId: z.uuid(),
  sourceStart: z.number().finite().nonnegative(),
  sourceEnd: z.number().finite().positive(),
  authorization: voiceAuthorizationSchema,
  createdAt: z.iso.datetime(),
});
export type VoiceProfile = z.infer<typeof voiceProfileSchema>;

export const createVoiceProfileInputSchema = z.strictObject({
  projectId: z.uuid(),
  videoId: z.uuid(),
  start: z.number().finite().nonnegative(),
  end: z.number().finite().positive(),
  name: z.string().trim().min(1).max(80),
  authorization: voiceAuthorizationSchema,
}).refine(input => input.end > input.start && input.end - input.start >= 1 && input.end - input.start <= 15,
  '样本时长必须在 1–15 秒之间');
export type CreateVoiceProfileInput = z.infer<typeof createVoiceProfileInputSchema>;

export const voiceProfilesInputSchema = z.strictObject({ projectId: z.uuid() });
export const deleteVoiceProfileInputSchema = z.strictObject({ projectId: z.uuid(), id: z.uuid() });

export type CreateVoiceProfileResult =
  | { status: 'saved'; profile: VoiceProfile; projectRevision: number; updatedAt: string }
  | { status: 'conflict'; reason: 'trashed' | 'deleted' | 'video-missing' | 'invalid-range' | 'missing-media' };

export interface DeleteVoiceProfileResult {
  deleted: boolean;
  remoteRetained: true;
  note: string;
}

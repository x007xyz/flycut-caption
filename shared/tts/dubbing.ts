import { z } from 'zod';
import type { LanguageTrack } from '../languageTracks';
import { modelRefSchema, optionValuesSchema, ttsAudioFormatSchema, ttsRequestSchema, type ModelRef, type ProviderModels } from '../providers.ts';

/** Safe relative path inside `<projectDir>/videos/<videoId>/`. */
export const DUBBING_FILE_PATTERN = /^dubbing\/[0-9a-f-]{36}\.(wav|mp3|ogg|flac)$/i;
export const DUBBING_DURATION_TOLERANCE_SECONDS = 0.01;

export const cueDubbingArtifactSchema = z.looseObject({
  id: z.uuid(),
  trackId: z.string().min(1).max(128),
  chunkId: z.string().min(1).max(128),
  file: z.string().regex(DUBBING_FILE_PATTERN, 'Invalid dubbing file path'),
  mimeType: z.string().min(1).max(100),
  format: ttsAudioFormatSchema,
  byteLength: z.number().int().positive(),
  durationSeconds: z.number().finite().positive(),
  sampleRate: z.number().int().positive().optional(),
  cueDurationSeconds: z.number().finite().positive(),
  text: z.string().trim().min(1).max(5000),
  model: modelRefSchema,
  voiceId: z.string().trim().min(1).max(100).optional(),
  language: z.string().trim().min(1).max(20),
  speed: z.number().finite().min(0.25).max(4).optional(),
  options: optionValuesSchema.optional(),
  operationId: z.uuid().optional(),
  voiceProfileId: z.uuid().optional(),
  createdAt: z.iso.datetime(),
  /** F-0036: how this cue was aligned to its subtitle range. */
  alignment: z.looseObject({ mode: z.enum(['none', 'speed', 'unresolved']), targetSeconds: z.number(),
    sourceSeconds: z.number(), outputSeconds: z.number(), speed: z.number().optional() }).optional(),
});
export type CueDubbingArtifact = z.infer<typeof cueDubbingArtifactSchema>;

export const dubCueInputSchema = z.strictObject({
  projectId: z.uuid(),
  videoId: z.uuid(),
  trackId: z.string().min(1).max(128),
  chunkId: z.string().min(1).max(128),
  baseVideoRevision: z.number().int().min(0),
  expectedText: z.string().trim().min(1).max(5000),
  operationId: z.uuid().optional(),
  /** F-0038: project voice profile used as the cloning reference. */
  voiceProfileId: z.uuid().optional(),
  request: ttsRequestSchema,
}).refine(
  input => Boolean(input.voiceProfileId) || (!input.request.cloneReferenceAssetId && !input.request.cloneAuthorization),
  '声音克隆必须使用项目音色',
);
export type DubCueInput = z.infer<typeof dubCueInputSchema>;

export type DubCueConflictReason =
  | 'revision-mismatch'
  | 'text-changed'
  | 'track-missing'
  | 'chunk-missing'
  | 'trashed'
  | 'deleted'
  | 'video-missing';

export type DubCueResult =
  | {
      status: 'saved';
      duplicate?: boolean;
      artifact: CueDubbingArtifact;
      videoRevision: number;
      projectRevision: number;
      updatedAt: string;
    }
  | {
      status: 'conflict';
      reason: DubCueConflictReason;
      videoRevision?: number;
      projectRevision?: number;
      updatedAt?: string;
    };

export type CueDubbingOutdatedReason = 'textChanged' | 'modelChanged' | 'voiceChanged';

export interface CueDubbingStatusContext {
  currentText: string;
  cueDurationSeconds: number;
  selectedModel?: ModelRef | null;
  voiceId?: string | null;
}

export interface CueDubbingStatus {
  tooLong: boolean;
  exceedsSeconds: number;
  outdated: boolean;
  reasons: CueDubbingOutdatedReason[];
  textChanged: boolean;
  modelChanged: boolean;
  voiceChanged: boolean;
}

/**
 * Picks a ready offline local TTS model only; never auto-picks paid cloud (`flycut-cloud`)
 * or non-offline remote HTTP endpoints unless explicitly saved by the user.
 */
export function pickDefaultOfflineTtsModel(groups: readonly ProviderModels[]): ModelRef | null {
  const candidates: Array<{ ref: ModelRef; recommended: boolean }> = [];
  for (const group of groups) {
    if (group.provider.id === 'flycut-cloud') continue;
    for (const model of group.models) {
      if (model.role !== 'tts' || model.status !== 'ready' || model.offline !== true) continue;
      candidates.push({
        ref: { providerId: group.provider.id, modelId: model.id },
        recommended: model.recommended === true,
      });
    }
  }
  const preferred = candidates.find(item => item.recommended) ?? candidates[0];
  return preferred?.ref ?? null;
}

export function sameModelRef(a: ModelRef | null | undefined, b: ModelRef | null | undefined): boolean {
  if (!a || !b) return false;
  return a.providerId === b.providerId && a.modelId === b.modelId;
}

export function evaluateCueDubbingStatus(
  artifact: Pick<CueDubbingArtifact, 'durationSeconds' | 'text' | 'model' | 'voiceId'>,
  context: CueDubbingStatusContext,
): CueDubbingStatus {
  const cueDuration = Math.max(0, context.cueDurationSeconds);
  const exceedsSeconds = Math.max(0, artifact.durationSeconds - cueDuration);
  const tooLong = artifact.durationSeconds > cueDuration + DUBBING_DURATION_TOLERANCE_SECONDS;

  const textChanged = artifact.text.trim() !== context.currentText.trim();
  const hasSelectedModel = Boolean(context.selectedModel);
  const modelChanged = hasSelectedModel && !sameModelRef(artifact.model, context.selectedModel);
  const nextVoice = context.voiceId?.trim() || undefined;
  const prevVoice = artifact.voiceId?.trim() || undefined;
  const voiceChanged = hasSelectedModel && !modelChanged && nextVoice !== undefined && nextVoice !== prevVoice;

  const reasons: CueDubbingOutdatedReason[] = [];
  if (textChanged) reasons.push('textChanged');
  if (modelChanged) reasons.push('modelChanged');
  if (voiceChanged) reasons.push('voiceChanged');

  return {
    tooLong,
    exceedsSeconds,
    outdated: reasons.length > 0,
    reasons,
    textChanged,
    modelChanged,
    voiceChanged,
  };
}

export function findCueDubbing(
  dubbings: readonly CueDubbingArtifact[] | undefined,
  trackId: string | null | undefined,
  chunkId: string | null | undefined,
): CueDubbingArtifact | undefined {
  if (!dubbings?.length || !trackId || !chunkId) return undefined;
  return dubbings.find(item => item.trackId === trackId && item.chunkId === chunkId);
}

export function upsertCueDubbing(
  dubbings: readonly CueDubbingArtifact[] | undefined,
  artifact: CueDubbingArtifact,
): CueDubbingArtifact[] {
  const filtered = (dubbings ?? []).filter(
    item => item.id !== artifact.id && !(item.trackId === artifact.trackId && item.chunkId === artifact.chunkId),
  );
  return [...filtered, artifact];
}

export function removeTrackDubbings(
  dubbings: readonly CueDubbingArtifact[] | undefined,
  trackId: string,
): CueDubbingArtifact[] {
  if (!dubbings?.length) return [];
  return dubbings.filter(item => item.trackId !== trackId);
}

export function validateCueDubbings(
  dubbings: readonly CueDubbingArtifact[] | undefined,
  tracks: readonly Pick<LanguageTrack, 'id'>[],
  chunks: readonly { id: string }[],
): void {
  if (!dubbings?.length) return;
  const ids = new Set<string>();
  const keys = new Set<string>();
  const trackIds = new Set(tracks.map(track => track.id));
  const chunkIds = new Set(chunks.map(chunk => chunk.id));
  for (const item of dubbings) {
    if (ids.has(item.id)) throw new Error('Duplicate cue dubbing artifact id');
    ids.add(item.id);
    const key = `${item.trackId}\0${item.chunkId}`;
    if (keys.has(key)) throw new Error('Duplicate cue dubbing artifact for subtitle cue');
    keys.add(key);
    if (!trackIds.has(item.trackId)) throw new Error('Cue dubbing references an unknown language track');
    if (!chunkIds.has(item.chunkId)) throw new Error('Cue dubbing references an unknown subtitle');
  }
}


export const trackDubCueSchema = z.strictObject({
  chunkId: z.string().min(1).max(128),
  expectedText: z.string().trim().min(1).max(5000),
});

export const trackDubInputSchema = z.strictObject({
  projectId: z.uuid(),
  videoId: z.uuid(),
  trackId: z.string().min(1).max(128),
  baseVideoRevision: z.number().int().min(0),
  cues: z.array(trackDubCueSchema).min(1).max(500),
  voiceProfileId: z.uuid().optional(),
  request: ttsRequestSchema.omit({ text: true }),
  maxSpeed: z.number().finite().min(1).max(1.25).optional(),
});
export type TrackDubInput = z.infer<typeof trackDubInputSchema>;

export type TrackDubUnresolvedReason = 'too-long' | 'failed';
export interface TrackDubUnresolved { chunkId: string; reason: TrackDubUnresolvedReason; message?: string }

export type TrackDubResult =
  | { status: 'saved'; artifacts: CueDubbingArtifact[]; unresolved: TrackDubUnresolved[];
      videoRevision: number; projectRevision: number; updatedAt: string }
  | { status: 'conflict'; reason: DubCueConflictReason; videoRevision?: number; projectRevision?: number; updatedAt?: string };


export const audioMixModeSchema = z.enum(['dubbing', 'dubbing-background', 'dubbing-ducked']);
export type AudioMixMode = z.infer<typeof audioMixModeSchema>;

export const dubbingMixInputSchema = z.strictObject({
  projectId: z.uuid(),
  videoId: z.uuid(),
  trackId: z.string().min(1).max(128),
  mode: audioMixModeSchema,
  duckVolume: z.number().finite().min(0).max(1).optional(),
  operationId: z.uuid().optional(),
});
export type DubbingMixInput = z.infer<typeof dubbingMixInputSchema>;

export type DubbingMixResult =
  | { status: 'saved'; assetId: string; durationSeconds: number; mode: AudioMixMode; aiLabel: string; warnings: string[] }
  | { status: 'unresolved'; missing: string[]; outdated: string[]; tooLong: string[]; backgroundMissing?: boolean };

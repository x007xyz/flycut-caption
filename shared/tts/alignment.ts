export const DEFAULT_MIN_DUBBING_SPEED = 0.8;
export const DEFAULT_MAX_DUBBING_SPEED = 1.25;
export const ALIGNMENT_TOLERANCE_SECONDS = 0.01;

export type DubbingAlignmentMode = 'none' | 'speed' | 'unresolved';

export interface DubbingAlignment {
  mode: DubbingAlignmentMode;
  targetSeconds: number;
  sourceSeconds: number;
  outputSeconds: number;
  speed?: number;
}

export interface AlignmentPlanInput {
  targetSeconds: number;
  sourceSeconds: number;
  minSpeed?: number;
  maxSpeed?: number;
  durationControl?: boolean;
  toleranceSeconds?: number;
}

/** Plan one cue: unchanged when it fits, otherwise use the TTS speed control within the accepted range. */
export function planDubbingAlignment(input: AlignmentPlanInput): DubbingAlignment {
  const minSpeed = input.minSpeed ?? DEFAULT_MIN_DUBBING_SPEED;
  const maxSpeed = input.maxSpeed ?? DEFAULT_MAX_DUBBING_SPEED;
  const tolerance = input.toleranceSeconds ?? ALIGNMENT_TOLERANCE_SECONDS;
  const target = Math.max(0, input.targetSeconds);
  const source = Math.max(0, input.sourceSeconds);
  const base = { targetSeconds: target, sourceSeconds: source };
  if (source <= target + tolerance) return { ...base, mode: 'none', outputSeconds: source };
  if (input.durationControl !== true || target <= 0) return { ...base, mode: 'unresolved', outputSeconds: source };
  const speed = Math.min(maxSpeed, Math.max(minSpeed, source / target));
  const outputSeconds = source / speed;
  if (outputSeconds <= target + tolerance) return { ...base, mode: 'speed', speed: Number(speed.toFixed(4)), outputSeconds };
  return { ...base, mode: 'unresolved', speed: Number(speed.toFixed(4)), outputSeconds };
}

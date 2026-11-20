import type { FaceBox } from './yunet';

export interface FrameFaces { time: number; faces: FaceBox[] }
export interface CropSample { time: number; centerX: number; confidence: number }

const center = (face: FaceBox) => face.x + face.w / 2;

/** Sticky primary-face selection: stay with the previous subject, keep it briefly through misses,
 *  and only refocus when it disappears or another face is clearly larger/central. */
export function selectPrimaryFaces(frames: FrameFaces[], options: { maxGapSeconds?: number; refocusAfterSeconds?: number } = {}): CropSample[] {
  const maxGap = options.maxGapSeconds ?? 1.5;
  const refocusAfter = options.refocusAfterSeconds ?? 2.5;
  const samples: CropSample[] = [];
  let previous: { centerX: number; time: number } | null = null;
  for (const frame of frames) {
    if (!frame.faces.length) {
      if (previous && frame.time - previous.time <= maxGap) {
        samples.push({ time: frame.time, centerX: previous.centerX, confidence: 0.3 });
      }
      continue;
    }
    const sorted = [...frame.faces].sort((a, b) => b.score - a.score);
    let chosen = sorted[0];
    if (previous) {
      const nearest = sorted.reduce((best, face) => Math.abs(center(face) - previous!.centerX) < Math.abs(center(best) - previous!.centerX) ? face : best, sorted[0]);
      const jump = Math.abs(center(nearest) - previous.centerX);
      const lostTooLong = frame.time - previous.time > refocusAfter;
      const clearlyLarger = sorted[0].w > nearest.w * 1.4;
      chosen = !lostTooLong && !clearlyLarger && jump < 4 * Math.max(nearest.w, 1) ? nearest : sorted[0];
    }
    previous = { centerX: center(chosen), time: frame.time };
    samples.push({ time: frame.time, centerX: center(chosen), confidence: chosen.score });
  }
  return samples;
}

/** Limit per-sample movement so the virtual camera does not whip around, then smooth the path. */
export function smoothCropPath(samples: CropSample[], options: { maxStep?: number; smoothing?: number } = {}): CropSample[] {
  const maxStep = options.maxStep ?? 24;
  const smoothing = options.smoothing ?? 0.25;
  let value: number | null = null;
  return samples.map(sample => {
    if (value === null) value = sample.centerX;
    else {
      const target = Math.max(value - maxStep, Math.min(value + maxStep, sample.centerX));
      value = value + (target - value) * (1 - smoothing);
    }
    return { ...sample, centerX: Math.round(value * 1000) / 1000 };
  });
}

/** Crop window x for a 9:16 crop, clamped inside the source frame (all values in the 640-wide model space). */
export function cropXForCenter(centerX: number, frameHeight = 640, aspect = 9 / 16): number {
  const width = frameHeight * aspect;
  return Math.max(0, Math.min(640 - width, centerX - width / 2));
}

import { calculateBlankSegments } from '../../src/utils/timeUtils';

export interface SmartCutBlankResult {
  segments: Array<{ start: number; end: number }>;
  totalBlankSeconds: number;
}

export function computeSmartCutBlank(
  chunks: Array<{ timestamp: [number, number]; deleted?: boolean }>,
  threshold: number,
  totalDuration?: number,
): SmartCutBlankResult {
  const segments = calculateBlankSegments(chunks, threshold, totalDuration);
  const totalBlankSeconds = segments.reduce((acc, seg) => acc + (seg.end - seg.start), 0);
  return { segments, totalBlankSeconds };
}

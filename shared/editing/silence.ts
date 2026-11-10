/** F-0006: pure pause-candidate generation. All inputs are seconds; output is rounded to microseconds. */

export type SilenceMode = 'shorten' | 'remove';

export interface SilenceParams {
  minPauseSeconds: number;
  guardSeconds: number;
  mode: SilenceMode;
  retainSeconds: number;
}

export interface SpeechSegment {
  start: number;
  end: number;
}

export interface SilenceInput {
  duration: number;
  speech: SpeechSegment[];
  wordSegments?: SpeechSegment[];
  existingDeleted?: SpeechSegment[];
  hasReliableWordTimestamps?: boolean;
  params: SilenceParams;
}

export interface SilenceCandidate {
  id: string;
  start: number;
  end: number;
  reason: 'silence.vad-pause' | 'silence.vad-edge';
  category: 'pause';
  confidence: number;
  defaultSelected: boolean;
}

export const DEFAULT_SILENCE_PARAMS: SilenceParams = {
  minPauseSeconds: 0.5, guardSeconds: 0.15, mode: 'shorten', retainSeconds: 0.25,
};

const round = (value: number) => Math.round(value * 1e6) / 1e6;

export function validateSilenceParams(params: SilenceParams): string[] {
  const errors: string[] = [];
  if (!Number.isFinite(params.minPauseSeconds) || params.minPauseSeconds <= 0) errors.push('min-pause');
  if (!Number.isFinite(params.guardSeconds) || params.guardSeconds < 0) errors.push('guard');
  if (!Number.isFinite(params.retainSeconds) || params.retainSeconds < 0) errors.push('retain');
  if (params.mode !== 'shorten' && params.mode !== 'remove') errors.push('mode');
  if ([params.minPauseSeconds, params.guardSeconds, params.retainSeconds].some(value => value > Number.MAX_SAFE_INTEGER / 1e6)) errors.push('too-large');
  return [...new Set(errors)];
}

function union(segments: SpeechSegment[]): SpeechSegment[] {
  const sorted = segments
    .filter(segment => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start)
    .map(segment => ({ start: Math.max(0, segment.start), end: segment.end }))
    .sort((left, right) => left.start - right.start);
  const merged: SpeechSegment[] = [];
  for (const segment of sorted) {
    const last = merged.at(-1);
    if (last && segment.start <= last.end + 0.001) last.end = Math.max(last.end, segment.end);
    else merged.push({ ...segment });
  }
  return merged;
}

function subtract(ranges: SpeechSegment[], removed: SpeechSegment[]): SpeechSegment[] {
  let result = union(ranges);
  for (const cut of union(removed)) {
    result = result.flatMap(range => {
      if (cut.end <= range.start || cut.start >= range.end) return [range];
      return [
        cut.start > range.start ? { start: range.start, end: cut.start } : null,
        cut.end < range.end ? { start: cut.end, end: range.end } : null,
      ].filter((value): value is SpeechSegment => value !== null);
    });
  }
  return result;
}

function gaps(duration: number, speech: SpeechSegment[]): Array<SpeechSegment & { edge: boolean }> {
  const result: Array<SpeechSegment & { edge: boolean }> = [];
  let cursor = 0;
  for (const segment of speech) {
    if (segment.start > cursor) result.push({ start: cursor, end: segment.start, edge: cursor <= 0.001 });
    cursor = Math.max(cursor, segment.end);
  }
  if (duration > cursor + 0.001) result.push({ start: cursor, end: duration, edge: true });
  return result;
}

export function generateSilenceCandidates(input: SilenceInput): {
  candidates: SilenceCandidate[];
  warnings: string[];
  paramsErrors: string[];
} {
  const paramsErrors = validateSilenceParams(input.params);
  if (paramsErrors.length) return { candidates: [], warnings: [], paramsErrors };
  if (!Number.isFinite(input.duration) || input.duration <= 0) return { candidates: [], warnings: ['invalid-duration'], paramsErrors: [] };
  const speech = union([...(input.speech ?? []), ...(input.wordSegments ?? [])]).filter(segment => segment.start < input.duration);
  const normalized = speech.map(segment => ({ start: segment.start, end: Math.min(segment.end, input.duration) }));
  const warnings: string[] = [];
  if (!normalized.length) return { candidates: [], warnings: ['no-speech'], paramsErrors: [] };
  const existing = input.existingDeleted ?? [];
  const candidates: SilenceCandidate[] = [];
  const reliable = input.hasReliableWordTimestamps === true;
  for (const gap of gaps(input.duration, normalized)) {
    if (gap.end - gap.start < input.params.minPauseSeconds) continue;
    const leftGuard = Math.min(input.params.guardSeconds, (gap.end - gap.start) / 2);
    const rightKeep = input.params.mode === 'shorten'
      ? Math.max(leftGuard, Math.min(input.params.retainSeconds, gap.end - gap.start))
      : Math.min(input.params.guardSeconds, (gap.end - gap.start) / 2);
    let start = gap.start + leftGuard;
    let end = gap.end - rightKeep;
    // Leading/trailing silence keeps padding only on the speech side, never at the file edge.
    const edgeKeep = Math.min(gap.end - gap.start,
      input.params.mode === 'shorten' ? Math.max(input.params.guardSeconds, input.params.retainSeconds) : input.params.guardSeconds);
    const leading = gap.edge && gap.start <= 0.001;
    const trailing = gap.edge && gap.end >= input.duration - 0.001;
    if (leading) { start = gap.start; end = gap.end - edgeKeep; }
    if (trailing) { start = gap.start + edgeKeep; end = gap.end; }
    if (leading && trailing) continue;
    if (!(end > start)) continue;
    for (const piece of subtract([{ start, end }], existing)) {
      if (piece.end - piece.start < 0.001) continue;
      const startRounded = round(piece.start);
      const endRounded = round(piece.end);
      if (endRounded <= startRounded) continue;
      candidates.push({
        id: `silence-${Math.round(startRounded * 1e6)}-${Math.round(endRounded * 1e6)}`,
        start: startRounded, end: endRounded,
        reason: gap.edge ? 'silence.vad-edge' : 'silence.vad-pause',
        category: 'pause', confidence: reliable ? 0.9 : 0.5, defaultSelected: reliable,
      });
    }
  }
  const deduped = new Map(candidates.map(candidate => [candidate.id, candidate]));
  return {
    candidates: [...deduped.values()].sort((left, right) => left.start - right.start),
    warnings,
    paramsErrors: [],
  };
}

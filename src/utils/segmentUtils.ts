import type { SubtitleTranscript } from '../types/subtitle';
import type { TimeSegment } from '../types/history';
import { createEdl, deriveKept, outputToSource, sourceToOutput, fromUs, type Edl } from '../../shared/editing/edl';
export { formatTime } from './timeUtils';
function decision(transcript: SubtitleTranscript, selected: Set<string>): Edl {
  return transcript.editing?.edl ?? createEdl(transcript.duration,
    transcript.chunks.filter(c => selected.has(c.id)).map(c => ({ start: c.timestamp[0], end: c.timestamp[1] })));
}
export function calculateKeptSegments(transcript: SubtitleTranscript, selected: Set<string>): TimeSegment[] {
  return deriveKept(decision(transcript, selected)).map((r, i) => ({ id: `segment-${i}`,
    start: fromUs(r.outputStartUs), end: fromUs(r.outputEndUs), originalStart: fromUs(r.startUs),
    originalEnd: fromUs(r.endUs), duration: fromUs(r.endUs - r.startUs) }));
}
export function calculateDeletedSegments(transcript: SubtitleTranscript, selected: Set<string>): TimeSegment[] {
  return decision(transcript, selected).deleted.map((r, i) => ({ id: `deleted-${i}`,
    start: fromUs(r.startUs), end: fromUs(r.endUs), originalStart: fromUs(r.startUs), originalEnd: fromUs(r.endUs), duration: fromUs(r.endUs - r.startUs) }));
}
function fromSegments(segments: TimeSegment[]) {
  const duration = segments.at(-1)?.originalEnd;
  if (!duration) return null;
  const ranges = [...segments].sort((a, b) => a.originalStart - b.originalStart);
  let start = 0; const deleted = [];
  for (const r of ranges) { if (r.originalStart > start) deleted.push({ start, end: r.originalStart }); start = r.originalEnd; }
  return createEdl(duration, deleted);
}
export function mapToOriginalTime(time: number, segments: TimeSegment[]): number {
  const edl = fromSegments(segments); return edl ? outputToSource(edl, time) ?? 0 : 0;
}
export function mapToNewTime(time: number, segments: TimeSegment[]): number | null {
  const edl = fromSegments(segments); return edl ? sourceToOutput(edl, time) : null;
}
export function isTimeInKeptSegments(time: number, segments: TimeSegment[]): boolean {
  return segments.some(r => time >= r.originalStart && time < r.originalEnd);
}
export function calculateEditingStats(transcript: SubtitleTranscript, selected: Set<string>) {
  const edl = decision(transcript, selected); const totalDeletedTime = edl.deleted.reduce((n, r) => n + fromUs(r.endUs - r.startUs), 0);
  const currentDuration = transcript.duration - totalDeletedTime;
  return { originalDuration: transcript.duration, currentDuration, totalDeletedTime,
    compressionRatio: currentDuration / transcript.duration, deletedChunksCount: selected.size, keptChunksCount: transcript.chunks.length - selected.size };
}
/**
 * 格式化时间差显示
 */
export function formatTimeSaved(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(1)}秒`;
  } else if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}分${remainingSeconds}秒`;
  } else {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}小时${minutes}分钟`;
  }
}
import type { SubtitleChunk, SubtitleTranscript } from '../../src/types/subtitle';

const EPSILON = 0.02;
const span = (value: unknown, duration: number): [number, number] | undefined => {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [start, end] = value;
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  if (start < 0 || end <= start || end > duration + EPSILON) return undefined;
  return [start, Math.min(end, duration)];
};
const text = (value: unknown) => typeof value === 'string' ? value : undefined;

/**
 * Checks every Provider result before it reaches the editor. Sentence timing must be valid or the result
 * is rejected; any invalid word timing downgrades the whole transcript to sentence level, because word
 * cuts are destructive and a Provider's capability claim is not evidence.
 */
export function validateTranscript(raw: unknown): SubtitleTranscript {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('识别结果必须是 JSON 对象');
  const data = raw as Record<string, unknown>;
  const duration = data.duration;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) throw new Error('识别结果缺少有效的 duration');
  if (!Array.isArray(data.chunks)) throw new Error('识别结果缺少 chunks');
  const chunks: SubtitleChunk[] = [];
  const ids = new Set<string>();
  for (const [index, item] of data.chunks.entries()) {
    const chunk = item as Record<string, unknown> | null;
    const id = text(chunk?.id); const content = text(chunk?.text); const timestamp = span(chunk?.timestamp, duration);
    if (!id || ids.has(id) || content === undefined || !timestamp) throw new Error(`识别结果第 ${index + 1} 个句段无效（id、文本或时间戳）`);
    if (chunks.length && timestamp[0] < chunks[chunks.length - 1].timestamp[0]) throw new Error(`识别结果第 ${index + 1} 个句段时间倒序`);
    ids.add(id);
    const result: SubtitleChunk = { id, text: content, timestamp };
    const speaker = text(chunk?.speaker); if (speaker) result.speaker = speaker;
    if (Array.isArray(chunk?.wordIds)) result.wordIds = chunk.wordIds.filter((value): value is string => typeof value === 'string');
    chunks.push(result);
  }
  const words = Array.isArray(data.wordChunks) ? data.wordChunks : [];
  let wordChunks: SubtitleChunk[] = [];
  let hasWordTimestamps = data.hasWordTimestamps === true && words.length > 0 && chunks.length > 0;
  if (hasWordTimestamps) {
    const bySentence = new Map(chunks.map(chunk => [chunk.id, chunk]));
    const byId = new Map<string, SubtitleChunk>();
    for (const item of words) {
      const word = item as Record<string, unknown> | null;
      const id = text(word?.id); const content = text(word?.text); const sentenceId = text(word?.sentenceId);
      const timestamp = span(word?.timestamp, duration); const sentence = sentenceId ? bySentence.get(sentenceId) : undefined;
      if (!id || ids.has(id) || byId.has(id) || content === undefined || !timestamp || !sentence
        || timestamp[0] < sentence.timestamp[0] - EPSILON || timestamp[1] > sentence.timestamp[1] + EPSILON) { hasWordTimestamps = false; break; }
      const result: SubtitleChunk = { id, text: content, timestamp, sentenceId };
      if (sentence.speaker) result.speaker = sentence.speaker;
      byId.set(id, result);
    }
    // Every sentence must list its own words, in order, without gaps or overlaps.
    if (hasWordTimestamps) {
      const used = new Set<string>();
      for (const chunk of chunks) {
        const list = chunk.wordIds ?? [];
        if (!list.length) { hasWordTimestamps = false; break; }
        let previous = -Infinity;
        for (const id of list) {
          const word = byId.get(id);
          if (!word || used.has(id) || word.sentenceId !== chunk.id || word.timestamp[0] < previous - EPSILON) { hasWordTimestamps = false; break; }
          used.add(id); previous = word.timestamp[1]; wordChunks.push(word);
        }
        if (!hasWordTimestamps) break;
      }
      if (used.size !== byId.size) hasWordTimestamps = false;
    }
  }
  if (!hasWordTimestamps) { wordChunks = []; chunks.forEach(chunk => { delete chunk.wordIds; }); }
  return { text: text(data.text) ?? chunks.map(chunk => chunk.text).join(' '), chunks, wordChunks, hasWordTimestamps,
    language: text(data.language) ?? 'auto', duration };
}

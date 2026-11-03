import type { SubtitleChunk, SubtitleTranscript } from '../../src/types/subtitle';

/** 配置 id / 请求关联 id：局域网 HTTP 等非安全上下文没有 crypto.randomUUID。 */
export function newCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function transcriptionEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl.trim());
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) {
    throw new Error('API 地址必须为 HTTPS，本机服务可使用 HTTP；请勿在 URL 中填写密钥或参数。');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/audio/transcriptions')) url.pathname += '/audio/transcriptions';
  return url.toString();
}

/** Settings of an OpenAI-compatible transcription endpoint. */
export interface ASRApiConfig { name: string; baseUrl: string; model: string; timestamps: 'none' | 'segment' | 'word'; timeoutSeconds: number; apiKey?: string }

export function validateASRApiConfig(config: ASRApiConfig) {
  transcriptionEndpoint(config.baseUrl);
  if (!config.name.trim() || !config.model.trim()) throw new Error('请填写 API 名称和模型名。');
  if (!['none', 'segment', 'word'].includes(config.timestamps)) throw new Error('无效的时间戳模式。');
  if (!Number.isFinite(config.timeoutSeconds) || config.timeoutSeconds < 10 || config.timeoutSeconds > 600) throw new Error('超时必须在 10～600 秒之间。');
}

export function encodePcmWav(samples: Float32Array, sampleRate = 16000): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, sample)) * 32767), true));
  return new Blob([buffer], { type: 'audio/wav' });
}

type TimedText = { text: string; start: number; end: number };
function timedItems(value: unknown, word: boolean, duration: number): TimedText[] {
  if (!Array.isArray(value)) return [];
  const items: TimedText[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const text = word ? raw.word ?? raw.text : raw.text;
    if (typeof text !== 'string' || !text.trim() || typeof raw.start !== 'number' || typeof raw.end !== 'number'
      || !Number.isFinite(raw.start) || !Number.isFinite(raw.end) || raw.start < 0 || raw.end <= raw.start || raw.start >= duration) continue;
    // Overlapping or out-of-order responses cannot safely drive destructive word edits.
    if (items.length && raw.start < items[items.length - 1].end - 0.02) continue;
    items.push({ text, start: raw.start, end: Math.min(duration, raw.end) });
  }
  return items;
}

export function normalizeASRApiResponse(raw: unknown, duration: number, offset = 0, prefix = 'api'): SubtitleTranscript {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('ASR API 必须返回 JSON 对象。');
  const data = raw as Record<string, unknown>;
  const text = typeof data.text === 'string' ? data.text.trim() : '';
  const segments = timedItems(data.segments, false, duration);
  const words = timedItems(data.words, true, duration);
  if (data.error || (!text && !segments.length && !words.length && data.text !== '')) throw new Error('ASR API 返回的数据缺少有效 text / segments / words。');
  const chunks: SubtitleChunk[] = [];
  const wordChunks: SubtitleChunk[] = [];
  const makeChunk = (segment: TimedText, index: number) => ({ id: `${prefix}-s-${index}`, text: segment.text, timestamp: [offset + segment.start, offset + segment.end] as [number, number] });
  if (segments.length) chunks.push(...segments.map(makeChunk));
  else if (words.length) {
    // Build readable sentences from real word timing, never distribute text over time.
    let group: TimedText[] = [];
    const flush = () => {
      if (!group.length) return;
      const joined = group.map(w => w.text).join(' ').replace(/([\u3400-\u9fff]) (?=[\u3400-\u9fff])/g, '$1');
      chunks.push(makeChunk({ text: joined, start: group[0].start, end: group[group.length - 1].end }, chunks.length)); group = [];
    };
    for (const word of words) {
      if (group.length && (word.start - group[group.length - 1].end > 0.8 || word.end - group[0].start > 12)) flush();
      group.push(word);
      if (/[。！？.!?]$/.test(word.text.trim())) flush();
    }
    flush();
  } else if (text) chunks.push(makeChunk({ text, start: 0, end: duration }, 0));
  for (const word of words) {
    const chunk = chunks.find(c => offset + word.start >= c.timestamp[0] - 0.05 && offset + word.end <= c.timestamp[1] + 0.05);
    if (!chunk) continue;
    const id = `${prefix}-w-${wordChunks.length}`;
    wordChunks.push({ id, text: word.text, timestamp: [offset + word.start, offset + word.end], sentenceId: chunk.id });
    (chunk.wordIds ??= []).push(id);
  }
  // Require all returned words to be valid and assigned; partial timing must not enable word cuts.
  const hasWordTimestamps = chunks.length > 0 && chunks.every(c => c.wordIds?.length) && Array.isArray(data.words)
    && wordChunks.length === data.words.length && wordChunks.length > 0;
  if (!hasWordTimestamps) chunks.forEach(c => { delete c.wordIds; });
  return { text: text || chunks.map(c => c.text).join(' '), chunks, wordChunks: hasWordTimestamps ? wordChunks : [], hasWordTimestamps,
    language: typeof data.language === 'string' ? data.language : 'auto', duration: duration + offset };
}

export function mergeASRApiTranscripts(parts: SubtitleTranscript[], duration: number): SubtitleTranscript {
  const nonempty = parts.filter(p => p.chunks.length);
  const hasWordTimestamps = nonempty.length > 0 && nonempty.every(p => p.hasWordTimestamps);
  const chunks = parts.flatMap(p => p.chunks).map(c => {
    if (hasWordTimestamps) return c;
    const chunk: SubtitleChunk = { ...c };
    delete chunk.wordIds;
    return chunk;
  });
  return { text: parts.map(p => p.text).filter(Boolean).join(' '), chunks,
    wordChunks: hasWordTimestamps ? parts.flatMap(p => p.wordChunks ?? []) : [], hasWordTimestamps,
    language: parts.find(p => p.language !== 'auto')?.language ?? 'auto', duration };
}

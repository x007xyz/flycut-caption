import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const F0017_DURATION = 3600;
export const F0017_COUNT = 1173;
export const F0017_REAL_SOURCES = [
  'tests/media/external/coscup-BWgFrY91F_I',
  'tests/media/external/coscup-3UegVxMFyeo',
] as const;
export const F0017_REAL_WORD_COUNT = 15014;

export interface F0017TranscriptChunk {
  id: string;
  text: string;
  timestamp: [number, number];
  wordIds?: string[];
  secondText?: string;
}

export interface F0017Transcript {
  text: string;
  chunks: F0017TranscriptChunk[];
  wordChunks?: F0017TranscriptChunk[];
  hasWordTimestamps: boolean;
  language: string;
  duration: number;
}

/** Deterministic UI fixture. It must not be reported as the real COSCUP AC dataset. */
export function makeF0017Transcript(count = F0017_COUNT) {
  const chunks = Array.from({ length: count }, (_, index) => {
    const start = index * (F0017_DURATION / count);
    const end = Math.min(F0017_DURATION, start + Math.max(0.8, F0017_DURATION / count - 0.15));
    const repeat = index % 17 === 0 ? 5 : index % 5 === 0 ? 3 : 1;
    return {
      id: `row-${index}`,
      text: `第 ${index + 1} 句长视频字幕${'，用于检查可变行高'.repeat(repeat)}`,
      secondText: index % 3 === 0 ? `Subtitle row ${index + 1}` : undefined,
      timestamp: [start, end] as [number, number],
    };
  });
  return {
    text: chunks.map(chunk => chunk.text).join(' '),
    chunks,
    hasWordTimestamps: false,
    language: 'zh',
    duration: F0017_DURATION,
  };
}

/** The real AC dataset: two recorded COSCUP transcripts concatenated with the same 0.2s gap as the media. */
export async function makeF0017RealTranscript(root = resolve('.')): Promise<F0017Transcript> {
  const readPart = async (prefix: string, offset: number, sequence: number) => {
    const source = JSON.parse(await readFile(join(root, `${prefix}.transcript.json`), 'utf8')) as F0017Transcript;
    const mapId = (id: string) => `part-${sequence}-${id}`;
    const wordChunks = (source.wordChunks ?? []).map(word => ({
      ...word,
      id: mapId(word.id),
      timestamp: [word.timestamp[0] + offset, word.timestamp[1] + offset] as [number, number],
    }));
    const chunks = source.chunks.map(chunk => ({
      ...chunk,
      id: mapId(chunk.id),
      timestamp: [chunk.timestamp[0] + offset, chunk.timestamp[1] + offset] as [number, number],
      wordIds: chunk.wordIds?.map(mapId),
    }));
    return { source, chunks, wordChunks };
  };

  const first = await readPart(F0017_REAL_SOURCES[0], 0, 1);
  const second = await readPart(F0017_REAL_SOURCES[1], first.source.duration + 0.2, 2);
  return {
    text: [first.source.text, second.source.text].filter(Boolean).join(' '),
    chunks: [...first.chunks, ...second.chunks],
    wordChunks: [...first.wordChunks, ...second.wordChunks],
    hasWordTimestamps: true,
    language: 'zh',
    duration: first.source.duration + second.source.duration + 0.2,
  };
}


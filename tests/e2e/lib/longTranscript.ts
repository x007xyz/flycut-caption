export const F0017_DURATION = 3600;
export const F0017_COUNT = 1173;

/** Deterministic sixty-minute shape: variable-length bilingual rows without depending on ignored media. */
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


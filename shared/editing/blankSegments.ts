// Shared unchanged sentence-gap detector; no frontend imports.
export function calculateBlankSegments(
  chunks: Array<{ timestamp: [number, number]; deleted?: boolean }>,
  threshold: number,
  totalDuration?: number,
): Array<{ start: number; end: number }> {
  if (chunks.length === 0) return [];
  if (threshold <= 0) return [];

  // 仅取未删除片段并按开始时间排序
  const active = chunks
    .filter(c => !c.deleted)
    .slice()
    .sort((a, b) => a.timestamp[0] - b.timestamp[0]);

  if (active.length === 0) return [];

  const result: Array<{ start: number; end: number }> = [];

  // 首段前空隙
  if (active[0].timestamp[0] >= threshold) {
    result.push({ start: 0, end: active[0].timestamp[0] });
  }

  // 段间空隙
  for (let i = 1; i < active.length; i++) {
    const gapStart = active[i - 1].timestamp[1];
    const gapEnd = active[i].timestamp[0];
    if (gapEnd - gapStart >= threshold) {
      result.push({ start: gapStart, end: gapEnd });
    }
  }

  // 末段后空隙
  if (totalDuration !== undefined && isFinite(totalDuration)) {
    const lastEnd = active[active.length - 1].timestamp[1];
    if (totalDuration - lastEnd >= threshold) {
      result.push({ start: lastEnd, end: totalDuration });
    }
  }

  return result;
}


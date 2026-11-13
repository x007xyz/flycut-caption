export const DEFAULT_ROW_HEIGHT = 104;
export const SUBTITLE_OVERSCAN = 6;

export type VirtualAlign = 'auto' | 'start' | 'center';

export interface VirtualLayout {
  sizes: number[];
  starts: number[];
  totalSize: number;
}

export interface VirtualRange {
  start: number;
  end: number;
}

function usableSize(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Build prefix offsets from the last measured heights and deterministic estimates. */
export function createVirtualLayout(
  measured: readonly number[],
  count: number,
  estimate = DEFAULT_ROW_HEIGHT,
): VirtualLayout {
  const fallback = usableSize(estimate, DEFAULT_ROW_HEIGHT);
  const sizes = Array.from({ length: count }, (_, index) => usableSize(measured[index], fallback));
  const starts = new Array<number>(count);
  let totalSize = 0;
  for (let index = 0; index < count; index += 1) {
    starts[index] = totalSize;
    totalSize += sizes[index];
  }
  return { sizes, starts, totalSize };
}

/** First row whose bottom edge is below scrollTop, or count when all rows are above the viewport. */
export function findFirstVisible(layout: VirtualLayout, scrollTop: number): number {
  let low = 0;
  let high = layout.sizes.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (layout.starts[middle] + layout.sizes[middle] <= scrollTop) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** First row that starts at or below the viewport bottom. */
function findFirstAfter(layout: VirtualLayout, edge: number): number {
  let low = 0;
  let high = layout.sizes.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (layout.starts[middle] < edge) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function findVirtualRange(
  layout: VirtualLayout,
  scrollTop: number,
  viewportHeight: number,
  overscan = SUBTITLE_OVERSCAN,
): VirtualRange {
  const count = layout.sizes.length;
  if (!count) return { start: 0, end: 0 };
  const top = Math.max(0, scrollTop);
  const bottom = top + Math.max(0, viewportHeight);
  const visibleStart = findFirstVisible(layout, top);
  const visibleEnd = findFirstAfter(layout, bottom);
  return {
    start: Math.max(0, visibleStart - overscan),
    end: Math.min(count, Math.max(visibleStart + 1, visibleEnd + overscan)),
  };
}

export function isVirtualIndexVisible(
  layout: VirtualLayout,
  index: number,
  scrollTop: number,
  viewportHeight: number,
): boolean {
  if (index < 0 || index >= layout.sizes.length) return false;
  const start = layout.starts[index];
  const end = start + layout.sizes[index];
  return start >= scrollTop && end <= scrollTop + viewportHeight;
}

/**
 * Return the smallest scrollTop that reveals index. 'auto' keeps an already visible row still;
 * 'start' aligns its top; 'center' places it near the middle of the viewport.
 */
export function scrollOffsetForIndex(
  layout: VirtualLayout,
  index: number,
  scrollTop: number,
  viewportHeight: number,
  align: VirtualAlign = 'auto',
): number {
  const count = layout.sizes.length;
  if (!count) return 0;
  const target = Math.max(0, Math.min(count - 1, index));
  const top = layout.starts[target];
  const bottom = top + layout.sizes[target];
  const maxScroll = Math.max(0, layout.totalSize - viewportHeight);
  let offset = Math.max(0, Math.min(maxScroll, top));

  if (align === 'center') offset = top - Math.max(0, (viewportHeight - layout.sizes[target]) / 2);
  else if (align === 'auto') {
    const viewportBottom = scrollTop + viewportHeight;
    if (top < scrollTop) offset = top;
    else if (bottom > viewportBottom) offset = bottom - viewportHeight;
    else offset = scrollTop;
  }

  return Math.max(0, Math.min(maxScroll, offset));
}

/** Offset that keeps the anchor row at the same viewport position after a height mutation. */
export function anchoredScrollTop(
  before: VirtualLayout,
  after: VirtualLayout,
  scrollTop: number,
): number {
  const anchor = findFirstVisible(before, scrollTop);
  if (anchor >= before.sizes.length || anchor >= after.sizes.length) return scrollTop;
  const offsetWithinAnchor = before.starts[anchor] - scrollTop;
  return Math.max(0, after.starts[anchor] - offsetWithinAnchor);
}


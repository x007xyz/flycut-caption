import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  anchoredScrollTop,
  createVirtualLayout,
  findVirtualRange,
  isVirtualIndexVisible,
  scrollOffsetForIndex,
  type VirtualAlign,
  type VirtualLayout,
} from './virtualRows';

interface UseVariableRowsOptions {
  count: number;
  estimate: number;
  measurementKey: string;
  overscan?: number;
}

interface UseVariableRowsResult {
  scrollRef: (node: HTMLDivElement | null) => void;
  contentRef: RefObject<HTMLDivElement | null>;
  layout: VirtualLayout;
  range: { start: number; end: number };
  onScroll: () => void;
  registerRow: (index: number, node: HTMLElement | null) => void;
  scrollToIndex: (index: number, align?: VirtualAlign) => void;
  isIndexVisible: (index: number) => boolean;
  markManualScroll: () => void;
  manualScrollAt: () => number;
}

/**
 * Variable-height rows backed by one scroll container. Heights are measured in place and the
 * first visible row stays anchored while rows above or inside the viewport resize.
 */
export function useVariableRows({
  count,
  estimate,
  measurementKey,
  overscan,
}: UseVariableRowsOptions): UseVariableRowsResult {
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [measureVersion, setMeasureVersion] = useState(0);
  const sizesRef = useRef<number[]>([]);
  const nodesRef = useRef(new Map<number, HTMLElement>());
  const observerRef = useRef<ResizeObserver | null>(null);
  const scrollTopRef = useRef(0);
  const scrollFrameRef = useRef<number | null>(null);
  const estimateRef = useRef(estimate);
  const measurementKeyRef = useRef(measurementKey);
  // No manual input yet. Zero would look like an event three seconds after page load and suppress
  // the first playback follow, even though the user has not touched the list.
  const manualScrollRef = useRef(Number.NEGATIVE_INFINITY);
  const scrollRequestRef = useRef(0);
  const contentRef = useRef<HTMLDivElement>(null);

  const scrollRef = useCallback((node: HTMLDivElement | null) => {
    setScrollElement(node);
  }, []);

  const publishScrollTop = useCallback((next: number) => {
    scrollTopRef.current = next;
    setScrollTop(next);
  }, []);

  const applyMeasuredSize = useCallback((index: number, size: number) => {
    if (!Number.isFinite(size) || size <= 0) return;
    const sizes = sizesRef.current;
    if (Math.abs((sizes[index] ?? estimateRef.current) - size) < 0.5) return;
    const before = createVirtualLayout(sizes, count, estimateRef.current);
    sizes[index] = size;
    const after = createVirtualLayout(sizes, count, estimateRef.current);
    const element = scrollElement;
    if (element && count > 0) {
      const nextTop = anchoredScrollTop(before, after, scrollTopRef.current);
      if (Math.abs(element.scrollTop - nextTop) >= 0.5) {
        element.scrollTop = nextTop;
      }
      scrollTopRef.current = element.scrollTop;
      setScrollTop(element.scrollTop);
    }
    setMeasureVersion(value => value + 1);
  }, [count, scrollElement]);

  useLayoutEffect(() => {
    const changed = measurementKeyRef.current !== measurementKey || estimateRef.current !== estimate;
    estimateRef.current = estimate;
    measurementKeyRef.current = measurementKey;
    if (changed || sizesRef.current.length !== count) {
      sizesRef.current = new Array<number>(count).fill(estimate);
      for (const [index, node] of nodesRef.current) {
        const measured = node.getBoundingClientRect().height;
        if (measured > 0) sizesRef.current[index] = measured;
      }
      setMeasureVersion(value => value + 1);
    }
  }, [count, estimate, measurementKey]);

  useEffect(() => {
    if (!scrollElement) return;
    const updateViewport = () => {
      setViewportHeight(scrollElement.clientHeight);
      publishScrollTop(scrollElement.scrollTop);
    };
    updateViewport();
    const observer = new ResizeObserver(updateViewport);
    observer.observe(scrollElement);
    return () => observer.disconnect();
  }, [publishScrollTop, scrollElement]);

  useEffect(() => {
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        const index = Number((entry.target as HTMLElement).dataset.virtualRowIndex);
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
        if (Number.isInteger(index)) applyMeasuredSize(index, height);
      }
    });
    observerRef.current = observer;
    for (const [index, node] of nodesRef.current) {
      node.dataset.virtualRowIndex = String(index);
      observer.observe(node);
    }
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [applyMeasuredSize]);

  const registerRow = useCallback((index: number, node: HTMLElement | null) => {
    const previous = nodesRef.current.get(index);
    if (previous && previous !== node) {
      observerRef.current?.unobserve(previous);
      nodesRef.current.delete(index);
    }
    if (!node) return;
    node.dataset.virtualRowIndex = String(index);
    nodesRef.current.set(index, node);
    observerRef.current?.observe(node);
    const height = node.getBoundingClientRect().height;
    if (height > 0) applyMeasuredSize(index, height);
  }, [applyMeasuredSize]);

  const onScroll = useCallback(() => {
    const element = scrollElement;
    if (!element || scrollFrameRef.current !== null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      if (!scrollElement) return;
      publishScrollTop(scrollElement.scrollTop);
    });
  }, [publishScrollTop, scrollElement]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  const layout = useMemo(() => {
    void measureVersion;
    return createVirtualLayout(sizesRef.current, count, estimate);
  }, [count, estimate, measureVersion]);
  const range = useMemo(
    () => findVirtualRange(layout, scrollTop, viewportHeight, overscan),
    [layout, overscan, scrollTop, viewportHeight],
  );

  const scrollToIndex = useCallback((index: number, align: VirtualAlign = 'auto') => {
    const element = scrollElement;
    if (!element) return;
    const request = ++scrollRequestRef.current;
    let frames = 24;
    const settle = () => {
      if (request !== scrollRequestRef.current || !element.isConnected) return;
      // Mounted rows replace estimates with measured heights. Re-apply the target after measurement
      // so a whole-list change, such as translation adding a second line everywhere, can still reach
      // a row beyond the old estimated total height.
      const currentLayout = createVirtualLayout(sizesRef.current, count, estimateRef.current);
      const next = scrollOffsetForIndex(currentLayout, index, element.scrollTop, element.clientHeight, align);
      if (Math.abs(element.scrollTop - next) < 0.5 || frames-- <= 0) return;
      element.scrollTop = next;
      publishScrollTop(next);
      requestAnimationFrame(settle);
    };
    settle();
  }, [count, publishScrollTop, scrollElement]);

  const isIndexVisible = useCallback((index: number) => (
    isVirtualIndexVisible(layout, index, scrollTop, viewportHeight)
  ), [layout, scrollTop, viewportHeight]);

  const markManualScroll = useCallback(() => {
    // Only scroll events consult the programmatic window. A wheel, touch, drag or key is real input
    // even when it arrives immediately after playback moved the list.
    scrollRequestRef.current += 1;
    manualScrollRef.current = performance.now();
  }, []);

  const manualScrollAt = useCallback(() => manualScrollRef.current, []);

  return {
    scrollRef,
    contentRef,
    layout,
    range,
    onScroll,
    registerRow,
    scrollToIndex,
    isIndexVisible,
    markManualScroll,
    manualScrollAt,
  };
}


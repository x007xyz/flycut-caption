/** F-0006/F-0007 shared pending-suggestion contract. Never persisted before confirmation. */

export type SuggestionKind = 'silence' | 'filler';
export type SuggestionSource = 'rule' | 'semantic' | 'silence';

export interface CutSuggestion {
  id: string;
  start: number;
  end: number;
  reason: string;
  category?: string;
  label?: string;
  confidence?: number;
  selected: boolean;
  /** F-0009: provenance is additive so F-0006/F-0007 callers remain compatible. */
  source?: SuggestionSource;
  sources?: SuggestionSource[];
  semanticCategory?: string;
  semanticReason?: string;
  semanticConfidence?: 'high' | 'medium' | 'low';
  scope?: 'word' | 'sentence';
  wordIds?: string[];
}

export interface SuggestionBatch {
  kind: SuggestionKind;
  /** Formal edit revision this analysis was based on. */
  base: string;
  preview: boolean;
  items: CutSuggestion[];
  /** F-0009: a batch may combine unchanged rule candidates with semantic candidates. */
  origin?: 'rule' | 'semantic' | 'mixed';
}

export interface PendingRangesView {
  ranges: Array<{ start: number; end: number }>;
  base: string;
  preview: boolean;
}

export function selectedSuggestions(batch: SuggestionBatch | null | undefined): CutSuggestion[] {
  return batch?.items.filter(item => item.selected) ?? [];
}

/** Selected ranges as a non-overlapping union; overlapping candidates count once. */
export function selectPendingRanges(state: { pendingSuggestions?: SuggestionBatch | null }): PendingRangesView | null {
  const batch = state.pendingSuggestions;
  if (!batch) return null;
  const sorted = selectedSuggestions(batch)
    .map(item => ({ start: item.start, end: item.end }))
    .sort((left, right) => left.start - right.start);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const last = ranges.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else ranges.push({ ...range });
  }
  return { ranges, base: batch.base, preview: batch.preview };
}

export interface SuggestionSummary {
  total: number;
  selected: number;
  durationSeconds: number;
}

export function suggestionSummary(batch: SuggestionBatch | null | undefined): SuggestionSummary {
  if (!batch) return { total: 0, selected: 0, durationSeconds: 0 };
  const view = selectPendingRanges({ pendingSuggestions: batch });
  return {
    total: batch.items.length,
    selected: batch.items.filter(item => item.selected).length,
    durationSeconds: view?.ranges.reduce((sum, range) => sum + range.end - range.start, 0) ?? 0,
  };
}

export function validateSuggestionBatch(batch: SuggestionBatch): SuggestionBatch {
  if (batch.kind !== 'silence' && batch.kind !== 'filler') throw new Error('Invalid suggestion kind');
  if (!batch.base) throw new Error('Suggestion base is required');
  if (!Array.isArray(batch.items)) throw new Error('Suggestion items must be an array');
  const ids = new Set<string>();
  for (const item of batch.items) {
    if (!item.id || ids.has(item.id)) throw new Error('Duplicate suggestion id');
    ids.add(item.id);
    if (!Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end <= item.start) {
      throw new Error('Invalid suggestion range');
    }
  }
  return batch;
}

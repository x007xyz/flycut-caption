import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useClientRuntime } from '@/runtime/context';
import { useAppStore } from '@/stores/appStore';
import { useProjectStore } from '@/stores/projectStore';
import { useHistoryStore } from '@/stores/historyStore';
import { useTranslation } from '@/contexts/LocaleProvider';
import { sentenceSplitCopy } from '@/locales/sentenceSplits';
import { analyzeSentenceSplits, isSplitBaseCurrent, normalizeMaxChars, type SplitAnalysis, type SplitPlan, type SplitSuggestion } from '../../shared/asr/sentenceSplitting';
import { applySentenceSplitsWithPersistence } from '@/services/textPersistence';

export type SentenceSplitPhase = 'idle' | 'ready' | 'applying' | 'completed' | 'stale' | 'error';

export interface SentenceSplitState {
  open: boolean;
  phase: SentenceSplitPhase;
  maxChars: number;
  analysis: SplitAnalysis | null;
  hasWordTimestamps: boolean;
  hasSubtitles: boolean;
  suggestions: SplitSuggestion[];
  kept: ReadonlySet<string>;
  pieceTexts: (suggestion: SplitSuggestion) => string[];
  invalidIds: ReadonlySet<string>;
  canApply: boolean;
  applyCount: number;
  appliedCount: number;
  error?: string;
  openPanel: () => void;
  closePanel: () => void;
  setMaxChars: (value: number) => void;
  analyze: () => void;
  toggleKeepOriginal: (chunkId: string) => void;
  updatePiece: (chunkId: string, index: number, text: string) => void;
  apply: () => Promise<void>;
}

const STORAGE_KEY = 'flycut-sentence-split-chars';
const readMaxChars = () => {
  if (typeof localStorage === 'undefined') return normalizeMaxChars(undefined);
  return normalizeMaxChars(Number(localStorage.getItem(STORAGE_KEY) ?? undefined));
};

export function useSentenceSplits(): SentenceSplitState {
  const ctx = useClientRuntime();
  const { language } = useTranslation();
  const c = sentenceSplitCopy(language);
  const chunks = useHistoryStore(state => state.chunks);
  const wordChunks = useHistoryStore(state => state.wordChunks);
  const hasWordTimestamps = useHistoryStore(state => state.hasWordTimestamps);
  const languageTracks = useHistoryStore(state => state.languageTracks);
  const dubbings = useHistoryStore(state => state.dubbings);
  const videoFile = useAppStore(state => state.videoFile);
  const videoId = useProjectStore(state => state.current?.videoId);

  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<SentenceSplitPhase>('idle');
  const [maxChars, setMaxCharsState] = useState(readMaxChars);
  const [analysis, setAnalysis] = useState<SplitAnalysis | null>(null);
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set());
  const [edits, setEdits] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | undefined>();
  const [appliedCount, setAppliedCount] = useState(0);
  const runRef = useRef(0);

  const translatedChunkIds = useMemo(() => new Set(languageTracks.flatMap(track => Object.keys(track.entries))), [languageTracks]);
  const dubbingChunkIds = useMemo(() => new Set(dubbings.map(item => item.chunkId)), [dubbings]);

  const reset = useCallback(() => {
    runRef.current += 1;
    setOpen(false); setPhase('idle'); setAnalysis(null); setKept(new Set()); setEdits({});
    setError(undefined); setAppliedCount(0);
  }, []);

  useEffect(() => { reset(); }, [videoFile, videoId, reset]);

  const runAnalysis = useCallback((limit: number) => {
    const result = analyzeSentenceSplits(chunks, wordChunks, { maxChars: limit,
      translatedChunkIds, dubbingChunkIds });
    setAnalysis(result);
    setKept(new Set());
    setEdits(Object.fromEntries(result.suggestions.map(item => [item.chunkId, item.pieces.map(piece => piece.text)])));
    setError(undefined);
    setAppliedCount(0);
    setPhase('ready');
  }, [chunks, wordChunks, translatedChunkIds, dubbingChunkIds]);

  const openPanel = useCallback(() => {
    setOpen(true);
    runAnalysis(maxChars);
  }, [maxChars, runAnalysis]);

  const closePanel = useCallback(() => {
    if (phase === 'applying') return;
    setOpen(false); setPhase('idle'); setError(undefined);
  }, [phase]);

  const setMaxChars = useCallback((value: number) => {
    const next = normalizeMaxChars(value);
    setMaxCharsState(next);
    try { localStorage.setItem(STORAGE_KEY, String(next)); } catch { /* storage unavailable */ }
    runAnalysis(next);
  }, [runAnalysis]);

  const analyze = useCallback(() => { runAnalysis(maxChars); }, [maxChars, runAnalysis]);

  const toggleKeepOriginal = useCallback((chunkId: string) => {
    setKept(previous => {
      const next = new Set(previous);
      if (next.has(chunkId)) next.delete(chunkId);
      else next.add(chunkId);
      return next;
    });
  }, []);

  const updatePiece = useCallback((chunkId: string, index: number, text: string) => {
    setEdits(previous => {
      const current = previous[chunkId] ?? [];
      const next = [...current];
      next[index] = text;
      return { ...previous, [chunkId]: next };
    });
  }, []);

  const pieceTexts = useCallback((suggestion: SplitSuggestion) =>
    edits[suggestion.chunkId] ?? suggestion.pieces.map(piece => piece.text), [edits]);

  const invalidIds = useMemo(() => {
    const invalid = new Set<string>();
    for (const suggestion of analysis?.suggestions ?? []) {
      if (kept.has(suggestion.chunkId)) continue;
      const texts = edits[suggestion.chunkId] ?? suggestion.pieces.map(piece => piece.text);
      if (texts.length !== suggestion.pieces.length || texts.some(text => !text.trim())) invalid.add(suggestion.chunkId);
    }
    return invalid;
  }, [analysis, kept, edits]);

  const applyCount = useMemo(() => (analysis?.suggestions ?? [])
    .filter(suggestion => !kept.has(suggestion.chunkId) && !invalidIds.has(suggestion.chunkId)).length, [analysis, kept, invalidIds]);
  const canApply = applyCount > 0 && phase === 'ready';

  const apply = useCallback(async () => {
    if (!analysis || (phase !== 'ready' && phase !== 'error')) return;
    if (!isSplitBaseCurrent(analysis.base, chunks, wordChunks)) {
      setPhase('stale');
      return;
    }
    const plans: SplitPlan[] = analysis.suggestions
      .filter(suggestion => !kept.has(suggestion.chunkId) && !invalidIds.has(suggestion.chunkId))
      .map(suggestion => ({
        chunkId: suggestion.chunkId,
        pieces: suggestion.pieces.map((piece, index) => ({
          text: (edits[suggestion.chunkId]?.[index] ?? piece.text).trim(),
          timestamp: piece.timestamp,
          wordIds: piece.wordIds,
        })),
      }));
    if (!plans.length) return;
    const run = runRef.current;
    setPhase('applying'); setError(undefined);
    const result = await applySentenceSplitsWithPersistence(ctx, plans);
    if (run !== runRef.current) return;
    if (result.ok) {
      setAppliedCount(plans.length);
      setPhase('completed');
      return;
    }
    if (result.error === 'stale') { setPhase('stale'); return; }
    setError(result.error === 'apply-failed' ? c.failed : String(result.error ?? c.failed));
    setPhase('error');
  }, [analysis, phase, chunks, wordChunks, kept, invalidIds, edits, ctx, c.failed]);

  return { open, phase, maxChars, analysis, hasWordTimestamps, hasSubtitles: chunks.some(chunk => !chunk.deleted && !chunk.isBlankSpacer), suggestions: analysis?.suggestions ?? [], kept, pieceTexts,
    invalidIds, canApply, applyCount, appliedCount, error, openPanel, closePanel, setMaxChars, analyze,
    toggleKeepOriginal, updatePiece, apply };
}

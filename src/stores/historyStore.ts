// F-0005: one atomic editing snapshot; persisted cut history never contains text edits.
import { createStore } from 'zustand/vanilla';
import { devtools } from 'zustand/middleware';
import { bindRuntimeStore } from './runtimeStore';
import type { SubtitleChunk, SubtitleTranscript } from '@/types/subtitle';
import { normalizeAsrTranscript } from '@/utils/asrTranscriptUtils';
import { joinWordTexts } from '../../shared/text/joinWords';
import { changeCuts, createEdl, editingSchema, isDeleted, outputDuration, validateEdl,
  type Edl, type Editing, type CutRecord } from '../../shared/editing/edl';
import { selectPendingRanges, validateSuggestionBatch, type SuggestionBatch } from '../../shared/editing/suggestions';
import { applyTextSnapshots, createTextRecord, planTextRestore, trimTextHistory, validateTextUpdates,
  type TextRecord, type TextUpdate } from '../../shared/text/corrections';

type ChunkLayer = 'sentence' | 'word';
type Chunk = SubtitleChunk;
interface Snapshot { chunks: Chunk[]; wordChunks: Chunk[]; edl: Edl }
/** `textRecord`: set when this step was a recorded text operation, so undo/redo also append a text record. */
interface Action { before: Snapshot; after: Snapshot; textRecord?: TextRecord }
export interface HistoryState {
  chunks: Chunk[]; wordChunks: Chunk[]; hasWordTimestamps: boolean; language: string;
  sourceDuration: number; edl: Edl | null; cutHistory: CutRecord[];
  cutError: string | null; updatingCuts: boolean;
  pendingCuts: { ranges: Array<{start: number; end: number}>; base: string; preview: boolean } | null;
  pendingSuggestions: SuggestionBatch | null;
  audition: { id: string; mode: 'before' | 'after' } | null;
  historyPreview: Edl | null;
  /** F-0013 persisted text operations (AI corrections and restores), oldest first. */
  textHistory: TextRecord[];
  /** Preview of a text record selected in the unified history; never persisted. */
  textHistoryPreview: TextRecord | null;
  textError: string | null;
  undoStack: Action[]; redoStack: Action[]; lastUpdateTime: number; mergeThreshold: number;
  text: string; duration: number; canUndo: boolean; canRedo: boolean;
}
export interface HistoryActions {
  setTranscript: (transcript: SubtitleTranscript) => void;
  update: (id: string, next: Partial<Chunk>, layer?: ChunkLayer) => void;
  delete: (id: string) => void; deleteWord: (id: string) => void;
  undo: () => void; redo: () => void; clearHistory: () => void;
  deleteSelected: (ids: Set<string>) => void; restoreSelected: (ids: Set<string>) => void;
  setDeletedBatch: (updates: { id: string; deleted: boolean }[]) => void;
  confirmOriginalEditorMarks: (plan: { wordUpdates: {id: string; deleted: boolean}[];
    blankInserts: {start: number; end: number}[]; blankUpdates: {id: string; deleted: boolean}[] }) => void;
  updateChunkText: (id: string, text: string) => void;
  batchUpdateText: (updates: {id: string; text?: string; secondText?: string}[]) => void;
  insertBlankChunks: (ranges: {start: number; end: number}[]) => void;
  proposeCuts: (ranges: {start: number; end: number}[]) => void;
  proposeSuggestions: (batch: SuggestionBatch) => 'ok' | 'cross-kind' | 'invalid';
  toggleSuggestion: (id: string) => void;
  setSuggestionCategorySelected: (category: string, selected: boolean) => void;
  rejectSuggestion: (id: string) => void;
  auditionSuggestion: (id: string, mode: 'before' | 'after') => void;
  stopAudition: () => void;
  previewPending: (preview: boolean) => void; confirmPending: () => void; cancelPending: () => void;
  previewHistory: (id: string | null) => void; restoreHistory: (id: string) => void;
  setTextHistory: (records: TextRecord[]) => void;
  /** One atomic AI-correction confirm; every update is validated before any chunk changes. */
  applyTextBatch: (updates: TextUpdate[], kind?: TextRecord['kind']) => { ok: boolean; count?: number; error?: 'empty' | 'duplicate' | 'unknown' | 'blank' | 'stale' };
  /** Restore one persisted text record as a new record; later edits to an affected subtitle are a conflict. */
  restoreTextHistory: (id: string) => { ok: boolean; count?: number; error?: 'missing' | 'conflict' };
  previewTextHistory: (id: string | null) => void;
  clearTextError: () => void;
  clearCutError: () => void; reset: () => void;
}
const initialState: HistoryState = { chunks: [], wordChunks: [], hasWordTimestamps: false, language: 'en',
  sourceDuration: 0, edl: null, cutHistory: [], cutError: null, updatingCuts: false, pendingCuts: null, pendingSuggestions: null, audition: null, historyPreview: null,
  textHistory: [], textHistoryPreview: null, textError: null,
  undoStack: [], redoStack: [], lastUpdateTime: 0, mergeThreshold: 500, text: '', duration: 0, canUndo: false, canRedo: false };
const plain = (text: string) => text.replace(/[\p{P}\s]/gu, '');
const keyOf = (state: Pick<HistoryState, 'edl' | 'chunks' | 'wordChunks'>) => JSON.stringify([state.edl, state.chunks, state.wordChunks]);
const derived = (snap: Snapshot) => ({ duration: outputDuration(snap.edl), text: snap.chunks.filter(c => !c.deleted).map(c => c.text).join(' ') });
const record = (snap: Snapshot, kind: string): CutRecord => ({ id: crypto.randomUUID(), at: new Date().toISOString(), kind,
  edl: snap.edl, deletedIds: snap.chunks.filter(c => c.deleted).map(c => c.id), deletedWordIds: snap.wordChunks.filter(c => c.deleted).map(c => c.id) });
const snapshot = (s: HistoryState): Snapshot => {
  if (!s.edl) throw new Error('Invalid media duration or edit data');
  return { chunks: s.chunks, wordChunks: s.wordChunks, edl: s.edl };
};
/** Preserve source timestamps. Only reconstruct text where the word/text correspondence is still known. */
function syncWords(chunks: Chunk[], before: Chunk[], after: Chunk[]): Chunk[] {
  const byId = new Map(after.map(w => [w.id, w])); const oldById = new Map(before.map(w => [w.id, w]));
  return chunks.map(c => {
    if (!c.wordIds?.length || c.isBlankSpacer) return c;
    const words = c.wordIds.map(id => byId.get(id)).filter((w): w is Chunk => !!w);
    const oldWords = c.wordIds.map(id => oldById.get(id)).filter((w): w is Chunk => !!w && !w.deleted);
    const active = words.filter(w => !w.deleted);
    const matches = plain(c.text) === plain(joinWordTexts(oldWords.map(w => w.text)));
    return { ...c, deleted: active.length === 0,
      edlWordProjection: matches || c.edlWordProjection,
      text: matches && active.length ? joinWordTexts(active.map(w => w.text)) : c.text };
  });
}
export const createHistoryStore = () => createStore<HistoryState & HistoryActions>()(devtools((set, get) => {
  const fail = (error: unknown) => set({ cutError: error instanceof Error ? error.message : String(error), updatingCuts: false });
  const commit = (next: Snapshot, kind: string, cuts: boolean) => {
    const state = get(); const before = snapshot(state);
    if (JSON.stringify(before) === JSON.stringify(next)) return;
    const history = cuts ? [...(state.cutHistory.length ? state.cutHistory : [record(before, 'baseline')]), record(next, kind)] : state.cutHistory;
    set({ ...next, ...derived(next), cutHistory: history, undoStack: [...state.undoStack, { before, after: next }],
      redoStack: [], canUndo: true, canRedo: false, lastUpdateTime: Date.now(), cutError: null, historyPreview: null,
      textHistoryPreview: null, textError: null, updatingCuts: false });
  };
  /** `spacers: false` cuts the ranges in the EDL only, e.g. fillers inside a sentence whose words are already marked deleted. */
  const cut = (updates: {id: string; deleted: boolean; layer?: ChunkLayer}[], blanks: {start: number; end: number}[] = [], kind = 'edit', spacers = true) => {
    try {
      const state = get(); if (state.updatingCuts || state.cutError) return;
      let { chunks, wordChunks, edl } = snapshot(state);
      const beforeWords = wordChunks;
      const wordTextOk = new Map<string, boolean>();
      for (const u of updates) {
        const units = u.layer === 'word' ? wordChunks : chunks;
        const target = units.find(c => c.id === u.id); if (!target) continue;
        if (u.layer === 'word') {
          if (!state.hasWordTimestamps) throw new Error('Reliable word timestamps are required');
          if (!target.deleted && target.sentenceId) {
            if (!wordTextOk.has(target.sentenceId)) {
              const sentence = chunks.find(c => c.id === target.sentenceId);
              const words = beforeWords.filter(w => w.sentenceId === target.sentenceId && !w.deleted);
              wordTextOk.set(target.sentenceId, !!sentence && plain(sentence.text) === plain(joinWordTexts(words.map(w => w.text))));
            }
            if (!wordTextOk.get(target.sentenceId)) throw new Error('Text was edited; use sentence-level cuts');
          }
        }
        edl = changeCuts(edl, [{ start: target.timestamp[0], end: target.timestamp[1] }], u.deleted);
        if (u.layer === 'word') wordChunks = wordChunks.map(c => c.id === u.id ? { ...c, deleted: u.deleted } : c);
        else {
          chunks = chunks.map(c => c.id === u.id ? { ...c, deleted: u.deleted } : c);
          if (state.hasWordTimestamps && target.wordIds?.length) {
            const ids = new Set(target.wordIds); wordChunks = wordChunks.map(w => ids.has(w.id) ? { ...w, deleted: u.deleted } : w);
          }
        }
      }
      if (wordChunks !== beforeWords) chunks = syncWords(chunks, beforeWords, wordChunks);
      if (blanks.length) edl = changeCuts(edl, blanks);
      if (blanks.length && spacers) {
        const ids = new Set(chunks.map(c => c.id));
        chunks = [...chunks, ...blanks.map(r => ({ id: `blank-${r.start.toFixed(3)}-${r.end.toFixed(3)}`,
          text: '', timestamp: [r.start, r.end] as [number, number], deleted: true, isBlankSpacer: true })).filter(c => !ids.has(c.id))]
          .sort((a, b) => a.timestamp[0] - b.timestamp[0]);
      }
      commit({ chunks, wordChunks, edl }, kind, true);
    } catch (error) { fail(error); }
  };
  const travel = (redo: boolean) => {
    try {
      const s = get(); if (s.updatingCuts) return; const action = (redo ? s.redoStack : s.undoStack).at(-1); if (!action) return;
      const next = redo ? action.after : action.before;
      const changed = JSON.stringify(s.edl) !== JSON.stringify(next.edl);
      // Like cutHistory, undo/redo of a text operation appends a record instead of erasing the original (AC-9).
      const textStep = action.textRecord ? createTextRecord(redo ? 'redo' : 'undo', s.chunks, next.chunks) : null;
      const undoStack = redo ? [...s.undoStack, action] : s.undoStack.slice(0, -1);
      const redoStack = redo ? s.redoStack.slice(0, -1) : [...s.redoStack, action];
      set({ ...next, ...derived(next), undoStack, redoStack, canUndo: !!undoStack.length, canRedo: !!redoStack.length,
        cutHistory: changed ? [...s.cutHistory, record(next, redo ? 'redo' : 'undo')] : s.cutHistory,
        textHistory: textStep ? trimTextHistory([...s.textHistory, textStep]) : s.textHistory,
        historyPreview: null, textHistoryPreview: null, cutError: null, textError: null });
    } catch (error) { fail(error); }
  };
  return { ...initialState,
    setTranscript: transcript => {
      try {
        const normalized = normalizeAsrTranscript(transcript);
        const editing = transcript.editing ? editingSchema.parse(transcript.editing) : { edl: createEdl(transcript.duration), history: [] };
        if (editing.edl.sourceDurationUs !== Math.round(transcript.duration * 1e6)) throw new Error('EDL media duration does not match');
        let chunks = normalized.chunks.map(c => ({ ...c, deleted: c.deleted ?? false }));
        if (editing.edl.origin === 'legacy-export') {
          const existing = new Set(chunks.map(c => c.id));
          chunks = [...chunks, ...editing.edl.deleted.map(r => ({ id: `legacy-${r.startUs}-${r.endUs}`, text: '',
            timestamp: [r.startUs / 1e6, r.endUs / 1e6] as [number, number], deleted: true, isBlankSpacer: true })).filter(c => !existing.has(c.id))];
        }
        const wordChunks = (normalized.wordChunks ?? []).map(c => ({ ...c, deleted: c.deleted ?? false }));
        const snap = { chunks, wordChunks, edl: validateEdl(editing.edl) };
        set({ ...initialState, ...snap, ...derived(snap), sourceDuration: transcript.duration, language: normalized.language,
          hasWordTimestamps: normalized.hasWordTimestamps ?? false, cutHistory: editing.history });
      } catch (error) { fail(error); }
    },
    update: (id, next, layer = 'sentence') => {
      if (next.deleted !== undefined) { cut([{ id, deleted: next.deleted, layer }]); return; }
      try {
        const s = get(); const snap = snapshot(s);
        const field = layer === 'word' ? 'wordChunks' : 'chunks';
        // IDs and source time are immutable. This entry point only edits text/translation/selection.
        const patch = { ...(next.text !== undefined ? { text: next.text, edlWordProjection: false } : {}),
          ...(next.secondText !== undefined ? { secondText: next.secondText } : {}), ...(next.selected !== undefined ? { selected: next.selected } : {}) };
        commit({ ...snap, [field]: snap[field].map(c => c.id === id ? { ...c, ...patch } : c) }, 'text', false);
      } catch (error) { fail(error); }
    },
    delete: id => { const c = get().chunks.find(c => c.id === id); if (c) cut([{ id, deleted: !c.deleted }], [], c.deleted ? 'restore' : 'delete'); },
    deleteWord: id => { const c = get().wordChunks.find(c => c.id === id); if (c) cut([{ id, deleted: !c.deleted, layer: 'word' }]); },
    deleteSelected: ids => cut([...ids].map(id => ({ id, deleted: true })), [], 'delete'),
    restoreSelected: ids => cut([...ids].map(id => ({ id, deleted: false })), [], 'restore'),
    setDeletedBatch: updates => cut(updates),
    confirmOriginalEditorMarks: plan => cut([...plan.wordUpdates.map(u => ({ ...u, layer: 'word' as const })), ...plan.blankUpdates], plan.blankInserts),
    updateChunkText: (id, text) => get().update(id, { text: text.trim() }),
    batchUpdateText: updates => {
      try {
        const s = get(); const map = new Map(updates.map(u => [u.id, u]));
        commit({ ...snapshot(s), chunks: s.chunks.map(c => map.has(c.id) ? { ...c, ...map.get(c.id), edlWordProjection: false } : c) }, 'text', false);
      } catch (error) { fail(error); }
    },
    setTextHistory: records => set({ textHistory: trimTextHistory(records), textHistoryPreview: null, textError: null }),
    applyTextBatch: (updates, kind = 'ai-correction') => {
      try {
        const s = get(); if (s.updatingCuts) return { ok: false, error: 'stale' };
        const validation = validateTextUpdates(s.chunks, updates);
        if ('reason' in validation) {
          const message = validation.reason === 'stale' ? 'Original subtitles changed. Review again.' :
            validation.reason === 'empty' ? 'No text changes to apply.' : `Invalid text update (${validation.reason}).`;
          set({ textError: message });
          return { ok: false, error: validation.reason };
        }
        const nextChunks = applyTextSnapshots(s.chunks, validation.changes);
        const record = createTextRecord(kind, s.chunks, nextChunks);
        if (!record) { set({ textError: null }); return { ok: true, count: 0 }; }
        const before = snapshot(s); const next = { ...before, chunks: nextChunks };
        set({ ...next, ...derived(next), textHistory: trimTextHistory([...s.textHistory, record]),
          undoStack: [...s.undoStack, { before, after: next, textRecord: record }], redoStack: [], canUndo: true, canRedo: false,
          lastUpdateTime: Date.now(), textError: null, textHistoryPreview: null, historyPreview: null });
        return { ok: true, count: record.after.length };
      } catch (error) {
        set({ textError: error instanceof Error ? error.message : String(error) });
        return { ok: false, error: 'unknown' };
      }
    },
    restoreTextHistory: id => {
      try {
        const s = get(); if (s.updatingCuts) return { ok: false, error: 'conflict' };
        const plan = planTextRestore(s.textHistory, s.chunks, id);
        if ('reason' in plan) {
          set({ textError: plan.reason === 'missing' ? 'Text history no longer exists' :
            `Cannot restore: ${plan.ids.length} subtitle(s) changed after this operation` });
          return { ok: false, error: plan.reason };
        }
        const nextChunks = applyTextSnapshots(s.chunks, plan.changes);
        const before = snapshot(s); const next = { ...before, chunks: nextChunks };
        set({ ...next, ...derived(next), textHistory: trimTextHistory([...s.textHistory, plan.record]),
          undoStack: [...s.undoStack, { before, after: next, textRecord: plan.record }], redoStack: [], canUndo: true, canRedo: false,
          lastUpdateTime: Date.now(), textError: null, textHistoryPreview: null, historyPreview: null });
        return { ok: true, count: plan.record.after.length };
      } catch (error) {
        set({ textError: error instanceof Error ? error.message : String(error) });
        return { ok: false, error: 'conflict' };
      }
    },
    previewTextHistory: id => {
      const record = id ? get().textHistory.find(entry => entry.id === id) ?? null : null;
      set({ textHistoryPreview: record });
    },
    clearTextError: () => set({ textError: null }),
    insertBlankChunks: ranges => cut([], ranges, 'silence'),
    undo: () => travel(false), redo: () => travel(true),
    clearHistory: () => set({ undoStack: [], redoStack: [], canUndo: false, canRedo: false }),
    proposeCuts: ranges => {
      try {
        const s = get(); changeCuts(snapshot(s).edl, ranges);
        const batch: SuggestionBatch = { kind: 'silence', base: keyOf(s), preview: false,
          items: ranges.map((range, index) => ({ id: `silence-${index}-${range.start.toFixed(6)}-${range.end.toFixed(6)}`,
            start: range.start, end: range.end, reason: 'silence', category: 'silence', selected: true })) };
        get().proposeSuggestions(batch);
      } catch (error) { fail(error); }
    },
    proposeSuggestions: batch => {
      try {
        validateSuggestionBatch(batch);
        const current = get().pendingSuggestions;
        if (current && current.kind !== batch.kind) return 'cross-kind';
        changeCuts(snapshot(get()).edl, selectPendingRanges({ pendingSuggestions: batch })?.ranges ?? []);
        const view = selectPendingRanges({ pendingSuggestions: batch });
        set({ pendingSuggestions: structuredClone(batch), pendingCuts: view, audition: null, historyPreview: null, cutError: null });
        return 'ok';
      } catch (error) { fail(error); return 'invalid'; }
    },
    toggleSuggestion: id => {
      const batch = get().pendingSuggestions; if (!batch) return;
      const next = { ...batch, items: batch.items.map(item => item.id === id ? { ...item, selected: !item.selected } : item) };
      set({ pendingSuggestions: next, pendingCuts: selectPendingRanges({ pendingSuggestions: next }),
        audition: get().audition?.id === id ? null : get().audition });
    },
    setSuggestionCategorySelected: (category, selected) => {
      const batch = get().pendingSuggestions; if (!batch) return;
      const next = { ...batch, items: batch.items.map(item => item.category === category ? { ...item, selected } : item) };
      set({ pendingSuggestions: next, pendingCuts: selectPendingRanges({ pendingSuggestions: next }),
        audition: next.items.some(item => item.id === get().audition?.id && item.selected) ? get().audition : null });
    },
    rejectSuggestion: id => {
      const batch = get().pendingSuggestions; if (!batch) return;
      const next = { ...batch, items: batch.items.filter(item => item.id !== id) };
      set({ pendingSuggestions: next, pendingCuts: selectPendingRanges({ pendingSuggestions: next }),
        audition: get().audition?.id === id ? null : get().audition });
    },
    auditionSuggestion: (id, mode) => {
      const batch = get().pendingSuggestions;
      if (!batch?.items.some(item => item.id === id)) return;
      set({ audition: { id, mode } });
    },
    stopAudition: () => set({ audition: null }),
    previewPending: preview => {
      const batch = get().pendingSuggestions;
      if (batch) {
        const next = { ...batch, preview };
        set({ pendingSuggestions: next, pendingCuts: selectPendingRanges({ pendingSuggestions: next }) });
        return;
      }
      const p = get().pendingCuts; if (p) set({ pendingCuts: { ...p, preview } });
    },
    confirmPending: () => {
      const s = get(); const batch = s.pendingSuggestions;
      if (!batch) {
        if (!s.pendingCuts) return;
        if (s.pendingCuts.base !== keyOf(s)) { fail(new Error('Suggestions are outdated. Analyze again.')); return; }
        cut([], s.pendingCuts.ranges, 'suggestions'); if (!get().cutError) set({ pendingCuts: null });
        return;
      }
      if ((batch.stateKey ?? batch.base) !== keyOf(s)) { fail(new Error('Suggestions are outdated. Analyze again.')); return; }
      const selected = batch.items.filter(item => item.selected);
      const ranges = selectPendingRanges({ pendingSuggestions: batch })?.ranges ?? [];
      if (!selected.length || !ranges.length) return;
      set({ cutError: null });
      const wordUpdates: Array<{ id: string; deleted: boolean; layer: 'word' }> = [];
      if (batch.kind === 'filler') {
        for (const word of s.wordChunks) {
          if (word.deleted) continue;
          if (ranges.some(range => range.start <= word.timestamp[0] + 1e-6 && range.end >= word.timestamp[1] - 1e-6)) {
            wordUpdates.push({ id: word.id, deleted: true, layer: 'word' });
          }
        }
      }
      cut(wordUpdates, ranges, batch.kind === 'filler' ? 'filler' : 'suggestions', batch.kind !== 'filler');
      if (!get().cutError) set({ pendingSuggestions: null, pendingCuts: null, audition: null });
    },
    cancelPending: () => set({ pendingCuts: null, pendingSuggestions: null, audition: null, cutError: null }),
    previewHistory: id => set({ historyPreview: id ? get().cutHistory.find(r => r.id === id)?.edl ?? null : null }),
    restoreHistory: id => {
      try {
        const s = get(); const entry = s.cutHistory.find(r => r.id === id); if (!entry) throw new Error('Cut history no longer exists');
        const edl = validateEdl(entry.edl);
        if (edl.sourceDurationUs !== s.edl?.sourceDurationUs) throw new Error('History media duration does not match');
        let chunks = s.chunks.map(c => ({ ...c, deleted: isDeleted(edl, c) }));
        const words = s.wordChunks.map(c => ({ ...c, deleted: isDeleted(edl, c) }));
        chunks = chunks.map(c => c.edlWordProjection && c.wordIds?.length ? { ...c,
          text: joinWordTexts(c.wordIds.map(id => words.find(w => w.id === id)).filter(w => w && !w.deleted).map(w => w!.text)) || c.text } : c);
        // Persisted restore only changes cuts/flags; current text and translations survive.
        commit({ chunks, wordChunks: words, edl }, 'history-restore', true);
      } catch (error) { fail(error); }
    },
    clearCutError: () => set({ cutError: null }), reset: () => set(initialState),
  };
}, { name: 'history-store' }));
export const editingOf = (state: Pick<HistoryState, 'edl' | 'cutHistory'>): Editing | undefined => state.edl ? { edl: state.edl, history: state.cutHistory } : undefined;

// 独立的状态选择器，避免创建新对象引用
export const useCanUndo = () => useHistoryStore(state => state.canUndo && !state.updatingCuts);
export const useCanRedo = () => useHistoryStore(state => state.canRedo && !state.updatingCuts);

// 独立的动作选择器，避免创建新对象引用
export const useSetTranscript = () => useHistoryStore(state => state.setTranscript);
export const useUpdate = () => useHistoryStore(state => state.update);
export const useDelete = () => useHistoryStore(state => state.delete);
export const useUndo = () => useHistoryStore(state => state.undo);
export const useRedo = () => useHistoryStore(state => state.redo);
export const useClearHistory = () => useHistoryStore(state => state.clearHistory);
export const useDeleteSelected = () => useHistoryStore(state => state.deleteSelected);
export const useRestoreSelected = () => useHistoryStore(state => state.restoreSelected);
export const useSetDeletedBatch = () => useHistoryStore(state => state.setDeletedBatch);
export const useConfirmOriginalEditorMarks = () => useHistoryStore(state => state.confirmOriginalEditorMarks);
export const useUpdateChunkText = () => useHistoryStore(state => state.updateChunkText);
export const useBatchUpdateText = () => useHistoryStore(state => state.batchUpdateText);
export const useInsertBlankChunks = () => useHistoryStore(state => state.insertBlankChunks);
export const useResetHistory = () => useHistoryStore(state => state.reset);

// 获取所有chunks（在组件中使用 useMemo 过滤）
export const useChunks = () => useHistoryStore(state => state.chunks);
export const useWordChunks = () => useHistoryStore(state => state.wordChunks);
export const useHasWordTimestamps = () => useHistoryStore(state => state.hasWordTimestamps);
export const useDeleteWord = () => useHistoryStore(state => state.deleteWord);

// 独立的选择器，避免创建新对象引用
export const useHistoryText = () => useHistoryStore(state => state.text);
export const useHistoryLanguage = () => useHistoryStore(state => state.language);
export const useHistoryDuration = () => useHistoryStore(state => state.duration);

export const useHistoryStore = bindRuntimeStore('history');

// F-0005: one atomic editing snapshot; persisted cut history never contains text edits.
import { createStore } from 'zustand/vanilla';
import { devtools } from 'zustand/middleware';
import { bindRuntimeStore } from './runtimeStore';
import type { SubtitleChunk, SubtitleTranscript } from '@/types/subtitle';
import { normalizeAsrTranscript } from '@/utils/asrTranscriptUtils';
import { joinWordTexts } from '../../shared/text/joinWords';
import { changeCuts, createEdl, editingSchema, isDeleted, outputDuration, validateEdl,
  type Edl, type Editing, type CutRecord } from '../../shared/editing/edl';

type ChunkLayer = 'sentence' | 'word';
type Chunk = SubtitleChunk;
interface Snapshot { chunks: Chunk[]; wordChunks: Chunk[]; edl: Edl }
interface Action { before: Snapshot; after: Snapshot }
export interface HistoryState {
  chunks: Chunk[]; wordChunks: Chunk[]; hasWordTimestamps: boolean; language: string;
  sourceDuration: number; edl: Edl | null; cutHistory: CutRecord[];
  cutError: string | null; updatingCuts: boolean;
  pendingCuts: { ranges: Array<{start: number; end: number}>; base: string; preview: boolean } | null;
  historyPreview: Edl | null;
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
  previewPending: (preview: boolean) => void; confirmPending: () => void; cancelPending: () => void;
  previewHistory: (id: string | null) => void; restoreHistory: (id: string) => void;
  clearCutError: () => void; reset: () => void;
}
const initialState: HistoryState = { chunks: [], wordChunks: [], hasWordTimestamps: false, language: 'en',
  sourceDuration: 0, edl: null, cutHistory: [], cutError: null, updatingCuts: false, pendingCuts: null, historyPreview: null,
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
      redoStack: [], canUndo: true, canRedo: false, lastUpdateTime: Date.now(), cutError: null, historyPreview: null, updatingCuts: false });
  };
  const cut = (updates: {id: string; deleted: boolean; layer?: ChunkLayer}[], blanks: {start: number; end: number}[] = [], kind = 'edit') => {
    try {
      const state = get(); if (state.updatingCuts || state.cutError) return;
      let { chunks, wordChunks, edl } = snapshot(state);
      const beforeWords = wordChunks;
      for (const u of updates) {
        const units = u.layer === 'word' ? wordChunks : chunks;
        const target = units.find(c => c.id === u.id); if (!target) continue;
        if (u.layer === 'word') {
          if (!state.hasWordTimestamps) throw new Error('Reliable word timestamps are required');
          const sentence = chunks.find(c => c.id === target.sentenceId);
          const words = wordChunks.filter(w => w.sentenceId === target.sentenceId && !w.deleted);
          if (!target.deleted && sentence && plain(sentence.text) !== plain(joinWordTexts(words.map(w => w.text))))
            throw new Error('Text was edited; use sentence-level cuts');
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
      if (blanks.length) {
        edl = changeCuts(edl, blanks);
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
      const undoStack = redo ? [...s.undoStack, action] : s.undoStack.slice(0, -1);
      const redoStack = redo ? s.redoStack.slice(0, -1) : [...s.redoStack, action];
      set({ ...next, ...derived(next), undoStack, redoStack, canUndo: !!undoStack.length, canRedo: !!redoStack.length,
        cutHistory: changed ? [...s.cutHistory, record(next, redo ? 'redo' : 'undo')] : s.cutHistory,
        historyPreview: null, cutError: null });
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
    insertBlankChunks: ranges => cut([], ranges, 'silence'),
    undo: () => travel(false), redo: () => travel(true),
    clearHistory: () => set({ undoStack: [], redoStack: [], canUndo: false, canRedo: false }),
    proposeCuts: ranges => {
      try { const s = get(); changeCuts(snapshot(s).edl, ranges); set({ pendingCuts: { ranges: structuredClone(ranges), base: keyOf(s), preview: false }, historyPreview: null, cutError: null }); }
      catch (error) { fail(error); }
    },
    previewPending: preview => { const p = get().pendingCuts; if (p) set({ pendingCuts: { ...p, preview } }); },
    confirmPending: () => {
      const s = get(); if (!s.pendingCuts) return;
      if (s.pendingCuts.base !== keyOf(s)) { fail(new Error('Suggestions are outdated. Analyze again.')); return; }
      cut([], s.pendingCuts.ranges, 'suggestions'); if (!get().cutError) set({ pendingCuts: null });
    },
    cancelPending: () => set({ pendingCuts: null, cutError: null }),
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

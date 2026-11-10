import { useCallback, useEffect, useMemo, useState } from 'react';
import { useChunks, useHistoryStore } from '@/stores/historyStore';
import { useRuntimeStoreApi } from '@/stores/runtimeStore';
import { useShowError, useShowSuccess } from '@/stores/messageStore';
import { useTranslation } from '@/contexts/LocaleProvider';
import { findCopy } from '@/locales/findReplace';
import {
  baseForMatches,
  findMatches,
  replaceAllMatches,
  replaceMatch,
  type FindMatch,
} from '../../shared/text/findReplace';

export interface ReplacePreview {
  query: string;
  replacement: string;
  base: string;
  rows: Array<{ chunkId: string; before: string; after: string }>;
  total: number;
}

export type FindReplaceStatus = 'idle' | 'stale' | 'error';

export interface FindReplaceState {
  open: boolean;
  query: string;
  replacement: string;
  matchCase: boolean;
  matches: FindMatch[];
  current: number;
  preview: ReplacePreview | null;
  status: FindReplaceStatus;
  error?: string;
}

export interface FindReplaceActions {
  openFind: () => void;
  closeFind: () => void;
  setQuery: (query: string) => void;
  setReplacement: (replacement: string) => void;
  setMatchCase: (matchCase: boolean) => void;
  next: () => void;
  previous: () => void;
  replaceCurrent: () => void;
  previewAll: () => void;
  confirmAll: () => void;
  cancelPreview: () => void;
}

const empty: FindReplaceState = {
  open: false, query: '', replacement: '', matchCase: false, matches: [], current: -1,
  preview: null, status: 'idle',
};

export function useFindReplace(): FindReplaceState & FindReplaceActions {
  const chunks = useChunks();
  const historyApi = useRuntimeStoreApi('history');
  const updateChunkText = useHistoryStore(state => state.updateChunkText);
  const batchUpdateText = useHistoryStore(state => state.batchUpdateText);
  const cutError = useHistoryStore(state => state.cutError);
  const showSuccess = useShowSuccess();
  const showError = useShowError();
  const { language } = useTranslation();
  const copy = findCopy(language);
  const [state, setState] = useState<FindReplaceState>(empty);

  const matches = useMemo(
    () => state.open ? findMatches(chunks, state.query, state.matchCase) : [],
    [chunks, state.open, state.query, state.matchCase],
  );

  useEffect(() => {
    setState(previous => {
      const current = matches.length === 0 ? -1 : Math.max(0, Math.min(previous.current, matches.length - 1));
      return current === previous.current && matches === previous.matches ? previous : { ...previous, matches, current };
    });
  }, [matches]);

  useEffect(() => {
    if (state.status === 'error' && !cutError) {
      setState(previous => ({ ...previous, status: 'idle', error: undefined }));
    }
  }, [cutError, state.status]);

  const openFind = useCallback(() => setState(previous => ({ ...previous, open: true })), []);
  const closeFind = useCallback(() => setState({ ...empty }), []);
  const setQuery = useCallback((query: string) => setState(previous => ({
    ...previous, query, current: query ? previous.current : -1, preview: null, status: 'idle', error: undefined,
  })), []);
  const setReplacement = useCallback((replacement: string) => setState(previous => ({
    ...previous, replacement, preview: null, status: 'idle',
  })), []);
  const setMatchCase = useCallback((matchCase: boolean) => setState(previous => ({
    ...previous, matchCase, preview: null, status: 'idle',
  })), []);
  const next = useCallback(() => setState(previous => ({
    ...previous, current: previous.matches.length ? (previous.current + 1) % previous.matches.length : -1,
  })), []);
  const previous = useCallback(() => setState(previous => ({
    ...previous, current: previous.matches.length
      ? (previous.current <= 0 ? previous.matches.length - 1 : previous.current - 1) : -1,
  })), []);

  const currentMatch = state.matches[state.current];
  const replacement = state.replacement;
  const previewMatches = state.matches;
  const replaceCurrent = useCallback(() => {
    const match = currentMatch;
    if (!match) return;
    const chunk = chunks.find(item => item.id === match.chunkId);
    if (!chunk || chunk.text.slice(match.start, match.end) !== match.text) {
      setState(previous => ({ ...previous, status: 'stale' }));
      return;
    }
    updateChunkText(match.chunkId, replaceMatch(chunk.text, match, replacement));
    setState(previous => ({ ...previous, status: 'idle', error: undefined }));
    showSuccess(copy.replaceOneDone, copy.replaceOneDone);
  }, [chunks, copy.replaceOneDone, currentMatch, replacement, showSuccess, updateChunkText]);

  const previewAll = useCallback(() => {
    if (!previewMatches.length) return;
    const updates = replaceAllMatches(chunks, previewMatches, replacement);
    const rows = updates.map(update => {
      const before = chunks.find(chunk => chunk.id === update.id)?.text ?? '';
      return { chunkId: update.id, before, after: update.text };
    });
    setState(previous => ({
      ...previous,
      preview: { query: previous.query, replacement, base: baseForMatches(chunks, previewMatches), rows, total: previewMatches.length },
      status: 'idle',
    }));
  }, [chunks, previewMatches, replacement]);

  const confirmAll = useCallback(() => {
    const preview = state.preview;
    if (!preview) return;
    const currentMatches = findMatches(chunks, preview.query, state.matchCase);
    if (currentMatches.length !== preview.total || baseForMatches(chunks, currentMatches) !== preview.base) {
      setState(previous => ({ ...previous, status: 'stale' }));
      return;
    }
    const updates = replaceAllMatches(chunks, currentMatches, preview.replacement);
    if (!updates.length) {
      setState(previous => ({ ...previous, preview: null, status: 'idle' }));
      return;
    }
    batchUpdateText(updates);
    if (historyApi.getState().cutError) {
      const error = historyApi.getState().cutError ?? 'Replace failed';
      setState(previous => ({ ...previous, status: 'error', error }));
      showError(copy.failed, copy.failed);
      return;
    }
    setState(previous => ({ ...previous, preview: null, status: 'idle', current: -1 }));
    showSuccess(copy.replaceAllDone.replace('{count}', String(updates.length)), copy.replaceAllDone.replace('{count}', String(updates.length)));
  }, [batchUpdateText, chunks, copy.failed, copy.replaceAllDone, historyApi, showError, showSuccess, state.matchCase, state.preview]);

  const cancelPreview = useCallback(() => setState(previous => ({ ...previous, preview: null, status: 'idle' })), []);

  return {
    ...state, matches, openFind, closeFind, setQuery, setReplacement, setMatchCase,
    next, previous, replaceCurrent, previewAll, confirmAll, cancelPreview,
  };
}

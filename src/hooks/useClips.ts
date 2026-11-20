import { useCallback, useMemo, useRef, useState } from 'react';
import { useClientRuntime } from '@/runtime/context';
import { useHistoryStore } from '@/stores/historyStore';
import { useProjectStore } from '@/stores/projectStore';
import { snapToSentenceBoundary, type ClipCandidate, type ClipCopy } from '../../shared/clips';
import { useAppStore } from '@/stores/appStore';
import type { JobSnapshot } from '../../shared/protocol';

export interface ClipsController {
  open: boolean;
  phase: 'idle' | 'running' | 'ready' | 'completed' | 'stale' | 'error';
  candidates: ClipCandidate[];
  saved: Array<{ id: string; name: string; start: number; end: number; score: number }>;
  error?: string;
  copy?: ClipCopy;
  copyBusy: boolean;
  generateCopy: (clipId: string) => Promise<void>;
  updateCopy: (patch: Partial<Pick<ClipCopy, 'title' | 'description' | 'hashtags'>>) => void;
  saveCopy: () => Promise<void>;
  start: string;
  end: string;
  name: string;
  setStart: (value: string) => void;
  setEnd: (value: string) => void;
  setName: (value: string) => void;
  select: (candidate: ClipCandidate) => void;
  snap: () => void;
  preview: () => void;
  create: () => Promise<void>;
  remove: (id: string) => Promise<void>;
  analyze: () => Promise<void>;
  openPanel: () => void;
  closePanel: () => void;
}

export function useClips(onSeek?: (time: number) => void): ClipsController {
  const runtime = useClientRuntime();
  const { connection } = runtime;
  const projects = (runtime as { projects?: { reloadCurrentVideo: () => Promise<boolean> } }).projects;
  const current = useProjectStore(s => s.current);
  const chunks = useHistoryStore(s => s.chunks);
  const selectedAIModelId = useAppStore(s => s.selectedAIModelId);
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<ClipsController['phase']>('idle');
  const [candidates, setCandidates] = useState<ClipCandidate[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [start, setStart] = useState('0');
  const [end, setEnd] = useState('30');
  const [name, setName] = useState('短片 1');
  const [copy, setCopy] = useState<ClipCopy | undefined>();
  const [copyBusy, setCopyBusy] = useState(false);
  const baseRef = useRef('');
  const copyBaseClipId = useRef<string | undefined>(undefined);
  const saved = useMemo(() => (current?.clips ?? []).map(clip => ({ id: clip.id, name: clip.name, start: clip.start, end: clip.end, score: clip.score, copy: clip.copy })), [current?.clips]);

  const analyze = useCallback(async () => {
    if (!current) return;
    setPhase('running'); setError(undefined);
    baseRef.current = JSON.stringify(chunks);
    try {
      const job = await connection.call('clips.suggest', { projectId: current.projectId, videoId: current.videoId }) as JobSnapshot;
      const result = await connection.waitJob<{ base: string; candidates: ClipCandidate[] }>(job.id);
      baseRef.current = result.base;
      setCandidates(result.candidates);
      setPhase(result.candidates.length ? 'ready' : 'completed');
      if (result.candidates[0]) {
        setStart(String(result.candidates[0].start)); setEnd(String(result.candidates[0].end));
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); setPhase('error'); }
  }, [chunks, connection, current]);

  const select = useCallback((candidate: ClipCandidate) => {
    setStart(String(candidate.start)); setEnd(String(candidate.end));
    setName(candidate.text.slice(0, 20) || '短片');
  }, []);

  const snap = useCallback(() => {
    const from = snapToSentenceBoundary(chunks, Number(start));
    const to = snapToSentenceBoundary(chunks, Number(end));
    setStart(String(from)); setEnd(String(to));
  }, [chunks, end, start]);

  const create = useCallback(async () => {
    if (!current) return;
    try {
      await connection.call('clips.create', { projectId: current.projectId, videoId: current.videoId,
        start: Number(start), end: Number(end), name, score: candidates.find(candidate => candidate.start === Number(start))?.score ?? 0,
        text: chunks.filter(chunk => chunk.timestamp[1] > Number(start) && chunk.timestamp[0] < Number(end)).map(chunk => chunk.text).join(' '),
        reasons: ['人工确认'] });
      await projects?.reloadCurrentVideo();
      setPhase('completed');
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); setPhase('error'); }
  }, [candidates, chunks, connection, current, end, name, projects, start]);

  const generateCopy = useCallback(async (clipId: string) => {
    if (!current) return;
    if (!selectedAIModelId) { setError('请先配置 AI 模型'); return; }
    copyBaseClipId.current = clipId;
    setCopyBusy(true); setError(undefined);
    try {
      const job = await connection.call('clips.copy', { projectId: current.projectId, videoId: current.videoId, clipId, configId: selectedAIModelId }) as JobSnapshot;
      setCopy(await connection.waitJob<ClipCopy>(job.id));
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setCopyBusy(false); }
  }, [connection, current, selectedAIModelId]);

  const updateCopy = useCallback((patch: Partial<Pick<ClipCopy, 'title' | 'description' | 'hashtags'>>) => {
    setCopy(previous => previous ? { ...previous, ...patch } : previous);
  }, []);

  const saveCopy = useCallback(async () => {
    if (!current || !copy || !copyBaseClipId.current) return;
    try {
      await connection.call('clips.saveCopy', { projectId: current.projectId, videoId: current.videoId, clipId: copyBaseClipId.current, copy });
      await projects?.reloadCurrentVideo();
      setCopy(undefined); setPhase('completed');
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  }, [connection, copy, current, projects]);

  const remove = useCallback(async (id: string) => {
    if (!current) return;
    try {
      await connection.call('clips.delete', { projectId: current.projectId, videoId: current.videoId, id });
      await projects?.reloadCurrentVideo();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); setPhase('error'); }
  }, [connection, current, projects]);

  return { open, phase, candidates, saved, error, copy, copyBusy, generateCopy, updateCopy, saveCopy, start, end, name, setStart, setEnd, setName, select, snap,
    preview: () => onSeek?.(Number(start)), create, remove, analyze,
    openPanel: () => { setOpen(true); setPhase(candidates.length ? 'ready' : 'idle'); },
    closePanel: () => setOpen(false) };
}

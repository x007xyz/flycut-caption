import { useCallback, useMemo, useRef, useState } from 'react';
import { useClientRuntime } from '@/runtime/context';
import { useProjectStore } from '@/stores/projectStore';
import type { ProviderModels } from '../../shared/providers';
import type { JobSnapshot } from '../../shared/protocol';

export interface SeparationController {
  open: boolean;
  phase: 'idle' | 'ready' | 'running' | 'completed' | 'error';
  modelName?: string;
  progress: number;
  error?: string;
  record?: { id: string; durationSeconds: number; sampleRate: number; createdAt: string };
  play: (stem: 'vocals' | 'background') => Promise<void>;
  playing?: string;
  openPanel: () => void;
  closePanel: () => void;
  analyze: () => Promise<void>;
  cancel: () => void;
}

export function useSeparation(modelGroups: ProviderModels[]): SeparationController {
  const { connection } = useClientRuntime();
  const current = useProjectStore(s => s.current);
  const projects = (useClientRuntime() as { projects?: { reloadCurrentVideo: () => Promise<boolean> } }).projects;
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<SeparationController['phase']>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | undefined>();
  const [playing, setPlaying] = useState<string | undefined>();
  const abortRef = useRef<AbortController | null>(null);
  const model = useMemo(() => modelGroups.flatMap(group => group.models.map(item => ({ group, item })))
    .find(({ item }) => item.role === 'separation' && item.status === 'ready'), [modelGroups]);

  const analyze = useCallback(async () => {
    if (!current || !model) { setError('缺少人声分离模型'); setPhase('error'); return; }
    const controller = new AbortController(); abortRef.current = controller;
    setPhase('running'); setProgress(0); setError(undefined);
    try {
      const job = await connection.call('separation.analyze', { projectId: current.projectId, videoId: current.videoId,
        model: { providerId: model.group.provider.id, modelId: model.item.id } }) as JobSnapshot;
      await connection.waitJob<TrackDubResultLike>(job.id, snapshot => { if (snapshot.progress?.progress !== undefined) setProgress(snapshot.progress.progress); }, controller.signal);
      await projects?.reloadCurrentVideo();
      setPhase('completed');
    } catch (caught) {
      if (controller.signal.aborted) { setPhase('idle'); return; }
      setError(caught instanceof Error ? caught.message : String(caught)); setPhase('error');
    }
  }, [connection, current, model, projects]);

  const play = useCallback(async (stem: 'vocals' | 'background') => {
    if (!current?.separation) return;
    try {
      const path = `/projects/${current.projectId}/videos/${current.videoId}/separation/${current.separation.id}/${stem}`;
      const blob = connection.downloadPath ? await connection.downloadPath(path) : await (await fetch(connection.resourceUrl(path), { credentials: 'include' })).blob();
      const url = URL.createObjectURL(blob); setPlaying(stem);
      const audio = new Audio(url); audio.onended = () => { URL.revokeObjectURL(url); setPlaying(undefined); }; await audio.play();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  }, [connection, current]);

  return { open, phase, modelName: model?.item.name, progress, error,
    record: current?.separation ? { id: current.separation.id, durationSeconds: current.separation.durationSeconds,
      sampleRate: current.separation.sampleRate, createdAt: current.separation.createdAt } : undefined,
    play, playing, openPanel: () => { setOpen(true); setPhase(current?.separation ? 'completed' : 'ready'); },
    closePanel: () => { abortRef.current?.abort(); setOpen(false); },
    analyze, cancel: () => { abortRef.current?.abort(); setPhase('idle'); } };
}

type TrackDubResultLike = unknown;

import { useCallback, useMemo, useRef, useState } from 'react';
import { useClientRuntime } from '@/runtime/context';
import { useHistoryStore } from '@/stores/historyStore';
import { useProjectStore } from '@/stores/projectStore';
import { useAppStore } from '@/stores/appStore';
import { speakerForCue } from '../../shared/speakers';
import type { ProviderModels } from '../../shared/providers';
import type { JobSnapshot } from '../../shared/protocol';

export interface SpeakerController {
  open: boolean;
  phase: 'idle' | 'ready' | 'running' | 'completed' | 'error';
  modelName?: string;
  progress: number;
  error?: string;
  speakers: Array<{ id: string; name: string; cueCount: number }>;
  filter: string | null;
  voiceOptions: Array<{ value: string; label: string }>;
  voices: Record<string, string>;
  setVoice: (speaker: string, value: string) => void;
  saveVoices: () => Promise<void>;
  openPanel: () => void;
  closePanel: () => void;
  analyze: () => Promise<void>;
  cancel: () => void;
  rename: (id: string, name: string) => void;
  saveNames: () => Promise<void>;
  setFilter: (id: string | null) => void;
}

export function useSpeakers(modelGroups: ProviderModels[]): SpeakerController {
  const { connection } = useClientRuntime();
  const chunks = useHistoryStore(s => s.chunks);
  const current = useProjectStore(s => s.current);
  const filter = useAppStore(s => s.speakerFilter);
  const setSpeakerFilter = useAppStore(s => s.setSpeakerFilter);
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<SpeakerController['phase']>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | undefined>();
  const [names, setNames] = useState<Record<string, string>>({});
  const [voices, setVoices] = useState<Record<string, string>>({});
  const abortRef = useRef<AbortController | null>(null);
  const model = useMemo(() => modelGroups.flatMap(group => group.models.map(item => ({ group, item })))
    .find(({ item }) => item.role === 'speaker' && item.status === 'ready'), [modelGroups]);
  const ttsModel = useMemo(() => modelGroups.flatMap(group => group.models.map(item => ({ group, item })))
    .find(({ item }) => item.role === 'tts' && item.status === 'ready' && (item.tts?.voices?.length ?? 0) > 0), [modelGroups]);
  const voiceOptions = useMemo(() => [
    ...(current?.voiceProfiles ?? []).map(profile => ({ value: `profile:${profile.id}`, label: `克隆：${profile.name}` })),
    ...(ttsModel?.item.tts?.voices ?? []).map(voice => ({ value: `voice:${voice.id}`, label: `${ttsModel!.item.name}：${voice.name}` })),
  ], [current?.voiceProfiles, ttsModel]);
  const segments = useMemo(() => current?.speakerSegments ?? [], [current?.speakerSegments]);
  const speakers = useMemo(() => {
    const ids = [...new Set(segments.map(segment => segment.speaker))];
    return ids.map(id => ({ id, name: names[id] ?? current?.speakerNames?.[id] ?? `说话人 ${id}`,
      cueCount: chunks.filter(chunk => !chunk.deleted && speakerForCue(segments, chunk.timestamp) === id).length }));
  }, [chunks, current?.speakerNames, names, segments]);

  const openPanel = useCallback(() => { setOpen(true); setNames(current?.speakerNames ?? {}); setVoices(current?.speakerVoices ?? {}); setPhase(segments.length ? 'completed' : 'ready'); }, [current?.speakerNames, segments.length]);

  const analyze = useCallback(async () => {
    if (!current || !model) { setError('没有可用的说话人模型'); return; }
    const controller = new AbortController(); abortRef.current = controller;
    setPhase('running'); setProgress(0); setError(undefined);
    try {
      const job = await connection.call('speakers.analyze', { projectId: current.projectId, videoId: current.videoId,
        model: { providerId: model.group.provider.id, modelId: model.item.id } }) as JobSnapshot;
      await connection.waitJob(job.id, snapshot => { if (snapshot.progress?.progress !== undefined) setProgress(snapshot.progress.progress); }, controller.signal);
      setPhase('completed');
    } catch (caught) {
      if (controller.signal.aborted) { setPhase('idle'); return; }
      setError(caught instanceof Error ? caught.message : String(caught)); setPhase('error');
    }
  }, [connection, current, model]);

  const saveVoices = useCallback(async () => {
    if (!current || !Object.keys(voices).length) return;
    try {
      await connection.call('speakers.saveVoices', { projectId: current.projectId, videoId: current.videoId, voices });
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  }, [connection, current, voices]);

  const saveNames = useCallback(async () => {
    if (!current || !Object.keys(names).length) return;
    try {
      await connection.call('speakers.saveNames', { projectId: current.projectId, videoId: current.videoId, names });
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  }, [connection, current, names]);

  return { open, phase, modelName: model?.item.name, progress, error, speakers,
    filter, openPanel,
    closePanel: () => { abortRef.current?.abort(); setOpen(false); },
    analyze, cancel: () => { abortRef.current?.abort(); setPhase('idle'); },
    rename: (id, name) => setNames(previous => ({ ...previous, [id]: name })),
    saveNames, voiceOptions, voices, setVoice: (speaker, value) => setVoices(previous => ({ ...previous, [speaker]: value })), saveVoices,
    setFilter: setSpeakerFilter };
}

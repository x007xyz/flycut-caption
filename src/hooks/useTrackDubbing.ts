import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useClientRuntime } from '@/runtime/context';
import { useDubbings, useHistoryStore } from '@/stores/historyStore';
import { useAppStore } from '@/stores/appStore';
import { useRuntimeStoreApi } from '@/stores/runtimeStore';
import { useProjectStore } from '@/stores/projectStore';
import { TTSService } from '@/services/ttsService';
import { speakerForCue } from '../../shared/speakers';
import type { ProjectService } from '@/services/projectService';
import type { ProviderModels } from '../../shared/providers';
import type { TrackDubResult } from '../../shared/tts/dubbing';
import type { JobSnapshot } from '../../shared/protocol';

export type TrackDubbingPhase = 'idle' | 'loading' | 'ready' | 'running' | 'completed' | 'error' | 'conflict';

export interface TrackDubbingState {
  open: boolean;
  phase: TrackDubbingPhase;
  modelName?: string;
  voiceProfileId?: string;
  voiceProfiles: Array<{ id: string; name: string }>;
  setVoiceProfileId: (id: string | undefined) => void;
  cueCount: number;
  progress: number;
  statusText?: string;
  savedCount: number;
  unresolved: Array<{ chunkId: string; reason: string; message?: string }>;
  error?: string;
  openPanel: () => void;
  closePanel: () => void;
  start: () => Promise<void>;
  cancel: () => void;
  retry: () => Promise<void>;
  cues: Array<{ id: string; text: string; targetSeconds: number; artifact?: { durationSeconds: number; alignmentMode?: string; speed?: number }; outdated: boolean; unresolvedReason?: string }>;
  suggestions: Record<string, string>;
  shorten: (chunkId: string) => Promise<string | undefined>;
  applyShorten: (chunkId: string) => Promise<void>;
  redo: (chunkId: string) => Promise<void>;
}

export function useTrackDubbing(modelGroups: ProviderModels[], onOpenSettings?: () => void): TrackDubbingState {
  const runtime = useClientRuntime();
  const { connection } = runtime;
  const projects = (runtime as typeof runtime & { projects?: ProjectService }).projects;
  const historyApi = useRuntimeStoreApi('history');
  const ttsService = useMemo(() => new TTSService(connection), [connection]);
  const chunks = useHistoryStore(s => s.chunks);
  const languageTracks = useHistoryStore(s => s.languageTracks);
  const activeTrackId = useHistoryStore(s => s.activeLanguageTrackId);
  const current = useProjectStore(s => s.current);
  const dubbings = useDubbings();
  const selectedAIModelId = useAppStore(s => s.selectedAIModelId);
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<TrackDubbingPhase>('idle');
  const [voiceProfileId, setVoiceProfileId] = useState<string | undefined>();
  const [model, setModel] = useState<{ providerId: string; modelId: string; name: string; voiceId?: string; language: string } | null>(null);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState<string | undefined>();
  const [savedCount, setSavedCount] = useState(0);
  const [unresolved, setUnresolved] = useState<TrackDubbingState['unresolved']>([]);
  const [error, setError] = useState<string | undefined>();
  const [suggestions, setSuggestions] = useState<Record<string, string>>({});
  const abortRef = useRef<AbortController | null>(null);
  const ttsGroups = useMemo(() => modelGroups.map(group => ({ ...group, models: group.models.filter(item => item.role === 'tts') }))
    .filter(group => group.models.length > 0), [modelGroups]);
  const activeTrack = useMemo(() => languageTracks.find(track => track.id === activeTrackId), [activeTrackId, languageTracks]);
  const activeChunks = useMemo(() => chunks.filter(chunk => !chunk.deleted && !chunk.isBlankSpacer && chunk.text.trim() && activeTrack?.entries[chunk.id]?.text.trim()), [chunks, activeTrack]);

  const cues = useMemo(() => activeChunks.map(chunk => {
    const text = activeTrack?.entries[chunk.id]?.text.trim() ?? '';
    const artifact = dubbings.find(item => item.trackId === activeTrack?.id && item.chunkId === chunk.id);
    const unresolvedItem = unresolved.find(item => item.chunkId === chunk.id);
    const speaker = activeTrack ? speakerForCue(current?.speakerSegments ?? [], chunk.timestamp) : null;
    const mapping = speaker ? current?.speakerVoices?.[speaker] : undefined;
    const voiceMismatch = !!artifact && (mapping?.startsWith('profile:') ? artifact.voiceProfileId !== mapping.slice(8)
      : mapping?.startsWith('voice:') ? artifact.voiceId !== mapping.slice(6) : false);
    const outdated = !!artifact && (artifact.text !== text || voiceMismatch);
    return { id: chunk.id, text, targetSeconds: chunk.timestamp[1] - chunk.timestamp[0],
      ...(artifact ? { artifact: { durationSeconds: artifact.durationSeconds,
        ...(artifact.alignment?.mode ? { alignmentMode: artifact.alignment.mode } : {}),
        ...(artifact.alignment?.speed ? { speed: artifact.alignment.speed } : {}) } } : {}),
      outdated, ...(unresolvedItem ? { unresolvedReason: unresolvedItem.reason } : {}) };
  }), [activeChunks, activeTrack, activeTrack?.entries, activeTrack?.id, current?.speakerSegments, current?.speakerVoices, dubbings, unresolved]);

  const applyCueResult = useCallback(async (result: TrackDubResult) => {
    if (result.status !== 'saved') return result;
    setSavedCount(previous => previous + result.artifacts.length);
    setUnresolved(previous => [...previous.filter(item => !result.artifacts.some(artifact => artifact.chunkId === item.chunkId)), ...result.unresolved]);
    await projects?.reloadCurrentVideo();
    return result;
  }, [projects]);

  const runCues = useCallback(async (targets: Array<{ chunkId: string; expectedText: string }>) => {
    if (!current || !activeTrack || !model || !targets.length) return;
    const controller = new AbortController();
    const job = await connection.call('dubbing.alignTrack', { projectId: current.projectId, videoId: current.videoId,
      trackId: activeTrack.id, baseVideoRevision: current.videoRevision, cues: targets, maxSpeed: 1.25,
      request: { providerId: model.providerId, modelId: model.modelId, language: model.language,
        ...(model.voiceId ? { voiceId: model.voiceId } : {}) } }) as JobSnapshot;
    const result = await connection.waitJob<TrackDubResult>(job.id, undefined, controller.signal);
    await applyCueResult(result);
  }, [activeTrack, applyCueResult, connection, current, model]);

  const shorten = useCallback(async (chunkId: string) => {
    if (!selectedAIModelId) { setError('请先配置 AI 模型'); return undefined; }
    const cue = cues.find(item => item.id === chunkId);
    if (!cue) return undefined;
    const maxChars = Math.max(4, Math.floor(cue.text.length * Math.max(0.3, Math.min(1, (cue.targetSeconds / Math.max(0.1, cue.artifact?.durationSeconds ?? cue.targetSeconds))))));
    try {
      const job = await connection.call('text.shorten', { configId: selectedAIModelId,
        items: [{ id: chunkId, text: cue.text, maxChars }] }) as JobSnapshot;
      const result = await connection.waitJob<Array<{ id: string; text: string }>>(job.id);
      const suggestion = result.find(item => item.id === chunkId)?.text;
      if (suggestion) setSuggestions(previous => ({ ...previous, [chunkId]: suggestion }));
      return suggestion;
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); return undefined; }
  }, [connection, cues, selectedAIModelId]);

  const applyShorten = useCallback(async (chunkId: string) => {
    const suggestion = suggestions[chunkId];
    if (!suggestion || !activeTrack) return;
    const history = historyApi.getState();
    history.applyLanguageTranslations({ trackId: activeTrack.id, languageCode: activeTrack.languageCode ?? 'auto',
      name: activeTrack.name, updates: [{ id: chunkId, text: suggestion }] });
    await projects?.flush();
    setSuggestions(previous => { const next = { ...previous }; delete next[chunkId]; return next; });
    await runCues([{ chunkId, expectedText: suggestion }]);
    setPhase('completed');
  }, [activeTrack, historyApi, projects, runCues, suggestions]);

  const redo = useCallback(async (chunkId: string) => {
    const cue = activeChunks.find(item => item.id === chunkId);
    if (!cue || !activeTrack) return;
    const text = activeTrack.entries[chunkId]?.text.trim();
    if (!text) return;
    try {
      await runCues([{ chunkId, expectedText: text }]);
      setPhase('completed');
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); setPhase('error'); }
  }, [activeChunks, activeTrack, runCues]);

  const loadModel = useCallback(async () => {
    setPhase('loading');
    try {
      const settings = await ttsService.getSettings();
      const candidate = settings.selectedModel
        ? ttsGroups.flatMap(group => group.models.map(item => ({ group, item }))).find(({ group, item }) =>
          group.provider.id === settings.selectedModel!.providerId && item.id === settings.selectedModel!.modelId)
        : ttsGroups.flatMap(group => group.models.map(item => ({ group, item }))).find(({ item }) => item.status === 'ready');
      if (!candidate) { setModel(null); setPhase('ready'); return; }
      setModel({
        providerId: candidate.group.provider.id, modelId: candidate.item.id, name: candidate.item.name,
        voiceId: settings.selectedModel?.providerId === candidate.group.provider.id ? settings.voiceId ?? candidate.item.tts?.voices?.[0]?.id : candidate.item.tts?.voices?.[0]?.id,
        language: activeTrack?.languageCode ?? settings.language ?? 'auto',
      });
      setPhase('ready');
    } catch {
      const candidate = ttsGroups.flatMap(group => group.models.map(item => ({ group, item }))).find(({ item }) => item.status === 'ready');
      setModel(candidate ? { providerId: candidate.group.provider.id, modelId: candidate.item.id, name: candidate.item.name,
        voiceId: candidate.item.tts?.voices?.[0]?.id, language: activeTrack?.languageCode ?? 'auto' } : null);
      setPhase('ready');
    }
  }, [activeTrack?.languageCode, ttsGroups, ttsService]);

  useEffect(() => {
    if (!open) return;
    void loadModel();
  }, [open, loadModel]);

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setOpen(false); setPhase('idle'); setSavedCount(0); setUnresolved([]); setError(undefined); setProgress(0);
  }, [current?.videoId, current?.projectId]);

  const run = useCallback(async () => {
    if (!current || !activeTrack || !model) return;
    const segments = current.speakerSegments ?? [];
    const mappings = current.speakerVoices ?? {};
    const currentDubbings = dubbings;
    const voiceMatches = (artifact: typeof dubbings[number], mapping: string | undefined) => mapping?.startsWith('profile:')
      ? artifact.voiceProfileId === mapping.slice(8)
      : mapping?.startsWith('voice:') ? artifact.voiceId === mapping.slice(6) : true;
    const ambiguous: string[] = [];
    const groups = new Map<string, Array<{ chunkId: string; expectedText: string }>>();
    const missingVoice: string[] = [];
    for (const chunk of activeChunks) {
      const text = activeTrack.entries[chunk.id]?.text.trim();
      if (!text) continue;
      const speaker = segments.length ? speakerForCue(segments, chunk.timestamp) : null;
      const key = speaker ?? '';
      if (segments.length) {
        const overlaps = segments.map(segment => ({ speaker: segment.speaker,
          overlap: Math.max(0, Math.min(chunk.timestamp[1], segment.end) - Math.max(chunk.timestamp[0], segment.start)) }))
          .filter(item => item.overlap > 0).sort((a, b) => b.overlap - a.overlap);
        if (overlaps.length > 1 && overlaps[1].overlap >= (chunk.timestamp[1] - chunk.timestamp[0]) * 0.3) {
          ambiguous.push(chunk.id); continue;
        }
        if (!speaker || !mappings[speaker]) { missingVoice.push(chunk.id); continue; }
      }
      const artifact = currentDubbings.find(item => item.trackId === activeTrack.id && item.chunkId === chunk.id);
      if (artifact && artifact.text === text && voiceMatches(artifact, speaker ? mappings[speaker] : undefined)) continue;
      const list = groups.get(key) ?? [];
      list.push({ chunkId: chunk.id, expectedText: text });
      groups.set(key, list);
    }
    if (!groups.size) {
      if (ambiguous.length || missingVoice.length) {
        setUnresolved([...ambiguous.map(chunkId => ({ chunkId, reason: 'ambiguous' })), ...missingVoice.map(chunkId => ({ chunkId, reason: 'no-voice' }))]);
        setPhase('completed'); return;
      }
      setError('没有需要重做的配音'); setPhase('ready'); return;
    }
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setPhase('running'); setProgress(0); setSavedCount(0); setUnresolved([]); setError(undefined);
    let baseRevision = current.videoRevision;
    try {
      for (const [speaker, cues] of groups) {
        if (controller.signal.aborted) return;
        const mapping = speaker ? mappings[speaker] : undefined;
        const profileId = mapping ? (mapping.startsWith('profile:') ? mapping.slice(8) : undefined) : voiceProfileId;
        const builtinVoice = mapping ? (mapping.startsWith('voice:') ? mapping.slice(6) : undefined) : model.voiceId;
        const job = await connection.call('dubbing.alignTrack', { projectId: current.projectId, videoId: current.videoId,
          trackId: activeTrack.id, baseVideoRevision: baseRevision, cues, maxSpeed: 1.25,
          ...(profileId ? { voiceProfileId: profileId } : {}),
          request: { providerId: model.providerId, modelId: model.modelId, language: model.language,
            ...(builtinVoice && !profileId ? { voiceId: builtinVoice } : {}) } }) as JobSnapshot;
        const result = await connection.waitJob<TrackDubResult>(job.id, snapshot => {
          if (snapshot.progress?.progress !== undefined) setProgress(snapshot.progress.progress ?? 0);
          if (snapshot.progress?.data) setStatusText(snapshot.progress.data);
        }, controller.signal);
        if (controller.signal.aborted) return;
        if (result.status === 'conflict') { setPhase('conflict'); setError('内容已更新，请重新检查'); return; }
        baseRevision = result.videoRevision;
        setSavedCount(previous => previous + result.artifacts.length);
        setUnresolved(previous => [...previous, ...result.unresolved.map(item => ({ chunkId: item.chunkId, reason: item.reason, ...(item.message ? { message: item.message } : {}) }))]);
      }
      if (missingVoice.length) setUnresolved(previous => [...previous, ...missingVoice.map(chunkId => ({ chunkId, reason: 'no-voice' }))]);
      if (ambiguous.length) setUnresolved(previous => [...previous, ...ambiguous.map(chunkId => ({ chunkId, reason: 'ambiguous' }))]);
      await projects?.reloadCurrentVideo();
      setPhase('completed');
    } catch (caught) {
      if (controller.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : String(caught));
      setPhase('error');
    }
  }, [activeChunks, activeTrack, connection, current, dubbings, model, projects, voiceProfileId]);

  return {
    open, phase, modelName: model?.name, voiceProfileId, voiceProfiles: current?.voiceProfiles ?? [], setVoiceProfileId, cueCount: activeChunks.length, progress, statusText, savedCount, unresolved, error,
    cues, suggestions, shorten, applyShorten, redo,
    openPanel: () => setOpen(true),
    closePanel: () => { abortRef.current?.abort(); setOpen(false); setPhase('idle'); },
    start: run,
    cancel: () => { abortRef.current?.abort(); setPhase('idle'); },
    retry: run,
    ...(onOpenSettings ? {} : {}),
  };
}

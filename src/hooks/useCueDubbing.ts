import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ModelInfo, ModelRef, OptionValue, ProviderModels, ProviderSummary } from '../../shared/providers';
import {
  evaluateCueDubbingStatus,
  findCueDubbing,
  pickDefaultOfflineTtsModel,
  type CueDubbingArtifact,
  type CueDubbingStatus,
  type DubCueInput,
  type DubCueResult,
} from '../../shared/tts/dubbing';
import { useTranslation } from '@/contexts/LocaleProvider';
import { dubbingCopy } from '@/locales/dubbing';
import { ConnectionUnavailableError, HostRequestError } from '@/runtime/connection';
import { useClientRuntime } from '@/runtime/context';
import { DubbingService } from '@/services/dubbingService';
import type { ProjectService } from '@/services/projectService';
import { TTSService } from '@/services/ttsService';
import { useDubbings, useHistoryStore } from '@/stores/historyStore';
import { useProjectStore } from '@/stores/projectStore';
import { useRuntimeStoreApi } from '@/stores/runtimeStore';
import type { SubtitleChunk } from '@/types/subtitle';

export interface CueDubbingErrorState {
  message: string;
  uncertain: boolean;
}

export interface CueDubbingConflictState {
  reason: string;
  videoRevision?: number;
}

interface PendingOperation {
  operationId: string;
  targetKey: string;
  input: DubCueInput;
}

export interface UseCueDubbingOptions {
  modelGroups?: ProviderModels[];
  modelsLoading?: boolean;
  modelsError?: string;
  onFlushDrafts?: () => void;
}

export interface CueDubbingController {
  open: boolean;
  loading: boolean;
  processing: boolean;
  progressText: string;
  hasProject: boolean;
  ttsGroups: Array<{ provider: ProviderSummary; models: ModelInfo[] }>;
  modelsError?: string;
  selectedChunk: SubtitleChunk | null;
  selectedChunkIndex: number;
  cueDeleted: boolean;
  confirmedTranslation: string;
  cueDurationSeconds: number;
  activeTrackId: string | null;
  activeTrackName: string;
  selectedModel: ModelRef | null;
  activeEntry?: { provider: ProviderSummary; model: ModelInfo };
  voiceId: string | null;
  ttsLanguage: string;
  speed: number;
  options: Record<string, OptionValue>;
  currentArtifact?: CueDubbingArtifact;
  currentStatus: CueDubbingStatus | null;
  justCompleted: boolean;
  errorState: CueDubbingErrorState | null;
  conflictState: CueDubbingConflictState | null;
  panelAudioUrl: string | null;
  playingCueKey: string | null;
  canSubmit: boolean;
  openPanel: () => void;
  openForCue: (chunkId: string) => void;
  closePanel: () => void;
  selectModel: (key: string) => void;
  setVoiceId: (voiceId: string | null) => void;
  setTtsLanguage: (language: string) => void;
  setSpeed: (speed: number) => void;
  setOptions: (options: Record<string, OptionValue>) => void;
  generate: () => Promise<void>;
  cancel: () => void;
  retry: () => Promise<void>;
  clearError: () => void;
  reviewLatest: () => Promise<void>;
  togglePlayArtifact: (artifact: CueDubbingArtifact) => Promise<void>;
  stopPlayback: () => void;
  statusForChunk: (chunk: SubtitleChunk) => { artifact?: CueDubbingArtifact; status: CueDubbingStatus | null };
}

function isUncertainError(error: unknown): boolean {
  if (error instanceof ConnectionUnavailableError) return true;
  if (error instanceof TypeError) return true;
  if (error instanceof DOMException && ['AbortError', 'NetworkError', 'TimeoutError'].includes(error.name)) return true;
  if (error instanceof HostRequestError && error.status >= 500) return true;
  return false;
}

function parseModelKey(key: string): ModelRef {
  const idx = key.lastIndexOf('/');
  return { providerId: key.slice(0, idx), modelId: key.slice(idx + 1) };
}

function pickPreferredLanguage(model: ModelInfo | undefined, trackLanguageCode: string | null | undefined, fallback = 'auto'): string {
  const supported = model?.languages?.length ? model.languages : ['auto'];
  if (trackLanguageCode) {
    const lower = trackLanguageCode.toLowerCase();
    const exact = supported.find(code => code.toLowerCase() === lower);
    if (exact) return exact;
    const base = lower.split(/[-_]/)[0];
    const baseMatch = supported.find(code => code.toLowerCase().split(/[-_]/)[0] === base);
    if (baseMatch) return baseMatch;
  }
  if (supported.includes(fallback)) return fallback;
  return supported[0] ?? 'auto';
}

export function useCueDubbing(hookOptions: UseCueDubbingOptions = {}): CueDubbingController {
  const { modelGroups = [], modelsLoading = false, modelsError, onFlushDrafts } = hookOptions;
  const runtime = useClientRuntime();
  const { connection } = runtime;
  const projects = (runtime as typeof runtime & { projects?: ProjectService }).projects;
  const projectStoreApi = useRuntimeStoreApi('project');
  const historyStoreApi = useRuntimeStoreApi('history');
  const dubbingService = useMemo(() => new DubbingService(connection), [connection]);
  const ttsService = useMemo(() => new TTSService(connection), [connection]);
  const { language: uiLanguage } = useTranslation();
  const copy = dubbingCopy(uiLanguage);

  const chunks = useHistoryStore(s => s.chunks);
  const languageTracks = useHistoryStore(s => s.languageTracks);
  const activeLanguageTrackId = useHistoryStore(s => s.activeLanguageTrackId);
  const dubbings = useDubbings();
  const projectId = useProjectStore(s => s.current?.projectId ?? '');
  const videoId = useProjectStore(s => s.current?.videoId ?? '');

  const [open, setOpen] = useState(false);
  const [selectedChunkId, setSelectedChunkId] = useState<string | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [progressText, setProgressText] = useState('');
  const [justCompleted, setJustCompleted] = useState(false);
  const [errorState, setErrorState] = useState<CueDubbingErrorState | null>(null);
  const [conflictState, setConflictState] = useState<CueDubbingConflictState | null>(null);

  const [selectedModel, setSelectedModel] = useState<ModelRef | null>(null);
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const [ttsLanguage, setTtsLanguage] = useState('auto');
  const [speed, setSpeed] = useState(1);
  const [options, setOptions] = useState<Record<string, OptionValue>>({});
  const [panelAudioUrl, setPanelAudioUrl] = useState<string | null>(null);
  const [playingCueKey, setPlayingCueKey] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const requestEpochRef = useRef(0);
  const settingsEpochRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const activeJobIdRef = useRef<string | null>(null);
  const pendingOperationRef = useRef<PendingOperation | null>(null);
  const panelAudioUrlRef = useRef<string | null>(null);
  const quickAudioRef = useRef<HTMLAudioElement | null>(null);
  const quickAudioUrlRef = useRef<string | null>(null);
  const modelChosenManuallyRef = useRef(false);

  const ttsGroups = useMemo(
    () => modelGroups.map(g => ({ ...g, models: g.models.filter(m => m.role === 'tts') })).filter(g => g.models.length > 0),
    [modelGroups],
  );

  const activeTrack = useMemo(
    () => languageTracks.find(track => track.id === activeLanguageTrackId) ?? null,
    [languageTracks, activeLanguageTrackId],
  );

  const activeChunks = useMemo(
    () => chunks.filter(chunk => !chunk.deleted && !chunk.isBlankSpacer),
    [chunks],
  );

  const rawSelectedChunk = useMemo(
    () => (selectedChunkId ? chunks.find(chunk => chunk.id === selectedChunkId) ?? null : null),
    [chunks, selectedChunkId],
  );

  const cueDeleted = Boolean(rawSelectedChunk?.deleted);
  const selectedChunk = rawSelectedChunk && !rawSelectedChunk.deleted && !rawSelectedChunk.isBlankSpacer ? rawSelectedChunk : null;
  const selectedChunkIndex = selectedChunk ? activeChunks.findIndex(c => c.id === selectedChunk.id) : -1;
  const cueDurationSeconds = selectedChunk ? Math.max(0, selectedChunk.timestamp[1] - selectedChunk.timestamp[0]) : 0;
  const confirmedTranslation = activeTrack && selectedChunk ? (activeTrack.entries[selectedChunk.id]?.text ?? '').trim() : '';

  const targetScopeKey = `${projectId}:${videoId}:${activeLanguageTrackId ?? ''}:${selectedChunk?.id ?? ''}`;
  const latestTargetKeyRef = useRef(targetScopeKey);
  latestTargetKeyRef.current = targetScopeKey;

  const setPanelObjectUrl = useCallback((next: string | null) => {
    if (panelAudioUrlRef.current && panelAudioUrlRef.current !== next) {
      URL.revokeObjectURL(panelAudioUrlRef.current);
    }
    panelAudioUrlRef.current = next;
    setPanelAudioUrl(next);
  }, []);

  const stopPlayback = useCallback(() => {
    if (quickAudioRef.current) {
      quickAudioRef.current.pause();
      quickAudioRef.current.currentTime = 0;
    }
    if (quickAudioUrlRef.current) {
      URL.revokeObjectURL(quickAudioUrlRef.current);
      quickAudioUrlRef.current = null;
    }
    setPlayingCueKey(null);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestEpochRef.current += 1;
      settingsEpochRef.current += 1;
      abortRef.current?.abort();
      stopPlayback();
      if (panelAudioUrlRef.current) URL.revokeObjectURL(panelAudioUrlRef.current);
    };
  }, [stopPlayback]);

  // Invalidate in-flight requests and transient errors whenever project/video/track/cue switches.
  useEffect(() => {
    requestEpochRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    activeJobIdRef.current = null;
    pendingOperationRef.current = null;
    setProcessing(false);
    setProgressText('');
    setJustCompleted(false);
    setErrorState(null);
    setConflictState(null);
    stopPlayback();
  }, [targetScopeKey, stopPlayback]);

  const activeEntry = useMemo(() => {
    if (!selectedModel) return undefined;
    for (const group of ttsGroups) {
      if (group.provider.id !== selectedModel.providerId) continue;
      const model = group.models.find(m => m.id === selectedModel.modelId);
      if (model) return { provider: group.provider, model };
    }
    return undefined;
  }, [selectedModel, ttsGroups]);

  const applyModelDefaults = useCallback((ref: ModelRef | null, preferredVoice?: string | null, preferredLanguage?: string, preferredSpeed?: number, preferredOptions?: Record<string, OptionValue>) => {
    setSelectedModel(ref);
    if (!ref) {
      setVoiceId(null);
      setTtsLanguage('auto');
      setSpeed(1);
      setOptions({});
      return;
    }
    const group = ttsGroups.find(g => g.provider.id === ref.providerId);
    const model = group?.models.find(m => m.id === ref.modelId);
    const voices = model?.tts?.voices ?? [];
    const nextVoice = preferredVoice && voices.some(v => v.id === preferredVoice)
      ? preferredVoice
      : (voices[0]?.id ?? null);
    setVoiceId(nextVoice);
    const lang = preferredLanguage && preferredLanguage !== 'auto' && (!model?.languages?.length || model.languages.includes(preferredLanguage))
      ? preferredLanguage
      : pickPreferredLanguage(model, activeTrack?.languageCode, preferredLanguage ?? 'auto');
    setTtsLanguage(lang);
    setSpeed(preferredSpeed ?? 1);
    const defaults: Record<string, OptionValue> = {};
    if (model?.options) {
      for (const [k, field] of Object.entries(model.options)) {
        if (field.default !== undefined) defaults[k] = field.default;
      }
    }
    setOptions({ ...defaults, ...(preferredOptions ?? {}) });
  }, [activeTrack?.languageCode, ttsGroups]);

  const loadSettings = useCallback(async () => {
    const epoch = ++settingsEpochRef.current;
    setSettingsLoading(true);
    try {
      const snapshot = await ttsService.getSettings();
      if (!mountedRef.current || epoch !== settingsEpochRef.current) return;
      setSettingsLoaded(true);
      if (modelChosenManuallyRef.current) return;
      if (snapshot.selectedModel) {
        applyModelDefaults(
          snapshot.selectedModel,
          snapshot.voiceId,
          snapshot.language,
          snapshot.speed,
          snapshot.options,
        );
      } else {
        const offlineDefault = pickDefaultOfflineTtsModel(ttsGroups);
        applyModelDefaults(offlineDefault);
      }
    } catch {
      if (!mountedRef.current || epoch !== settingsEpochRef.current) return;
      setSettingsLoaded(true);
      if (!modelChosenManuallyRef.current) {
        applyModelDefaults(pickDefaultOfflineTtsModel(ttsGroups));
      }
    } finally {
      if (mountedRef.current && epoch === settingsEpochRef.current) setSettingsLoading(false);
    }
  }, [applyModelDefaults, ttsGroups, ttsService]);

  // Re-evaluate default offline model if ttsGroups finishes loading after settings.
  useEffect(() => {
    if (!open || !settingsLoaded || modelChosenManuallyRef.current || selectedModel) return;
    const offlineDefault = pickDefaultOfflineTtsModel(ttsGroups);
    if (offlineDefault) applyModelDefaults(offlineDefault);
  }, [applyModelDefaults, open, selectedModel, settingsLoaded, ttsGroups]);

  const currentArtifact = useMemo(
    () => (activeTrack && selectedChunk ? findCueDubbing(dubbings, activeTrack.id, selectedChunk.id) : undefined),
    [dubbings, activeTrack, selectedChunk],
  );

  const currentStatus = useMemo(() => {
    if (!currentArtifact || !selectedChunk) return null;
    return evaluateCueDubbingStatus(currentArtifact, {
      currentText: confirmedTranslation,
      cueDurationSeconds,
      selectedModel,
      voiceId,
    });
  }, [confirmedTranslation, cueDurationSeconds, currentArtifact, selectedChunk, selectedModel, voiceId]);

  // Load playable blob URL for the active cue's persisted artifact.
  useEffect(() => {
    if (!open || !projectId || !videoId || !currentArtifact) {
      setPanelObjectUrl(null);
      return;
    }
    const epoch = requestEpochRef.current;
    const targetKey = targetScopeKey;
    const controller = new AbortController();
    void dubbingService.downloadAudioObjectUrl(projectId, videoId, currentArtifact.id, controller.signal).then(
      url => {
        if (!mountedRef.current || epoch !== requestEpochRef.current || targetKey !== latestTargetKeyRef.current) {
          URL.revokeObjectURL(url);
          return;
        }
        setPanelObjectUrl(url);
      },
      () => {
        if (mountedRef.current && epoch === requestEpochRef.current && targetKey === latestTargetKeyRef.current) {
          setPanelObjectUrl(null);
        }
      },
    );
    return () => controller.abort();
  }, [currentArtifact, dubbingService, open, projectId, setPanelObjectUrl, targetScopeKey, videoId]);

  const openPanel = useCallback(() => {
    setOpen(prev => {
      const next = !prev;
      if (next) {
        if (!selectedChunkId && activeChunks.length) {
          const firstWithTranslation = activeTrack
            ? activeChunks.find(c => Boolean(activeTrack.entries[c.id]?.text?.trim()))
            : undefined;
          setSelectedChunkId((firstWithTranslation ?? activeChunks[0]).id);
        }
        void loadSettings();
      } else {
        requestEpochRef.current += 1;
        abortRef.current?.abort();
        stopPlayback();
      }
      return next;
    });
  }, [activeChunks, activeTrack, loadSettings, selectedChunkId, stopPlayback]);

  const openForCue = useCallback((chunkId: string) => {
    setSelectedChunkId(chunkId);
    setOpen(true);
    void loadSettings();
  }, [loadSettings]);

  const closePanel = useCallback(() => {
    requestEpochRef.current += 1;
    settingsEpochRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setSettingsLoading(false);
    setProcessing(false);
    stopPlayback();
    setOpen(false);
  }, [stopPlayback]);

  const selectModel = useCallback((key: string) => {
    modelChosenManuallyRef.current = true;
    setJustCompleted(false);
    setErrorState(null);
    applyModelDefaults(key ? parseModelKey(key) : null);
  }, [applyModelDefaults]);

  const executeSynthesize = useCallback(async (existingOp?: PendingOperation) => {
    onFlushDrafts?.();
    const currentProject = projectStoreApi.getState().current;
    const pId = existingOp ? existingOp.input.projectId : (currentProject?.projectId ?? projectId);
    const vId = existingOp ? existingOp.input.videoId : (currentProject?.videoId ?? videoId);
    if (!pId || !vId || !activeTrack || !selectedChunk || !confirmedTranslation || !selectedModel || activeEntry?.model.status !== 'ready') {
      return;
    }

    const epoch = requestEpochRef.current;
    const targetKey = existingOp?.targetKey ?? latestTargetKeyRef.current;
    setProcessing(true);
    setProgressText('');
    setJustCompleted(false);
    setErrorState(null);
    setConflictState(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      if (!existingOp && projects && projects.hasUnsavedChanges()) {
        const flushed = await projects.flush();
        if (!mountedRef.current || epoch !== requestEpochRef.current || targetKey !== latestTargetKeyRef.current) return;
        if (!flushed) {
          const saveStatus = projectStoreApi.getState().save;
          if (saveStatus.status === 'conflict') {
            setConflictState({ reason: 'revision-mismatch' });
            return;
          }
          setErrorState({ message: saveStatus.error || copy.audioLoadFailed, uncertain: false });
          return;
        }
      }

      const latestProject = projectStoreApi.getState().current;
      const latestHistory = historyStoreApi.getState();
      const latestTrack = latestHistory.languageTracks.find(t => t.id === activeTrack.id);
      const latestText = latestTrack?.entries[selectedChunk.id]?.text?.trim() ?? confirmedTranslation;
      const baseVideoRevision = existingOp?.input.baseVideoRevision ?? latestProject?.videoRevision ?? 0;
      const operationId = existingOp?.operationId ?? crypto.randomUUID();

      const input: DubCueInput = existingOp?.input ?? {
        projectId: pId,
        videoId: vId,
        trackId: activeTrack.id,
        chunkId: selectedChunk.id,
        baseVideoRevision,
        expectedText: latestText,
        operationId,
        request: {
          providerId: selectedModel.providerId,
          modelId: selectedModel.modelId,
          text: latestText,
          ...(voiceId ? { voiceId } : {}),
          language: ttsLanguage,
          ...(activeEntry?.model.tts?.durationControl !== false ? { speed } : {}),
          ...(Object.keys(options).length ? { options } : {}),
        },
      };
      pendingOperationRef.current = { operationId, targetKey, input };

      const result: DubCueResult = await dubbingService.synthesizeCue(input, {
        signal: controller.signal,
        onJobId: id => { activeJobIdRef.current = id; },
        onProgress: progress => {
          if (!mountedRef.current || epoch !== requestEpochRef.current || targetKey !== latestTargetKeyRef.current) return;
          setProgressText(progress.data ?? `${Math.round(progress.progress ?? 0)}%`);
        },
      });

      if (!mountedRef.current || epoch !== requestEpochRef.current || targetKey !== latestTargetKeyRef.current) return;

      pendingOperationRef.current = null;
      if (result.status === 'conflict') {
        setConflictState({ reason: result.reason, videoRevision: result.videoRevision });
        return;
      }

      if (projects) {
        projects.recordDubbingSaved({
          projectId: pId,
          videoId: vId,
          artifact: result.artifact,
          videoRevision: result.videoRevision,
          projectRevision: result.projectRevision,
          updatedAt: result.updatedAt,
        });
      } else {
        historyStoreApi.getState().upsertCueDubbing(result.artifact);
      }
      setJustCompleted(true);
    } catch (error) {
      if (!mountedRef.current || epoch !== requestEpochRef.current || targetKey !== latestTargetKeyRef.current || controller.signal.aborted) {
        return;
      }
      setErrorState({
        message: error instanceof Error ? error.message : String(error),
        uncertain: isUncertainError(error),
      });
    } finally {
      if (mountedRef.current && epoch === requestEpochRef.current) {
        setProcessing(false);
        setProgressText('');
        activeJobIdRef.current = null;
      }
    }
  }, [activeEntry, activeTrack, confirmedTranslation, copy.audioLoadFailed, dubbingService, historyStoreApi, onFlushDrafts, options, projectId, projectStoreApi, projects, selectedChunk, selectedModel, speed, ttsLanguage, videoId, voiceId]);

  const generate = useCallback(async () => {
    await executeSynthesize();
  }, [executeSynthesize]);

  const cancel = useCallback(() => {
    requestEpochRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    const jobId = activeJobIdRef.current;
    activeJobIdRef.current = null;
    if (jobId) void dubbingService.cancelJob(jobId).catch(() => undefined);
    setProcessing(false);
    setProgressText('');
  }, [dubbingService]);

  const retry = useCallback(async () => {
    const pending = pendingOperationRef.current;
    if (!errorState?.uncertain || !pending) {
      await executeSynthesize();
      return;
    }
    const epoch = requestEpochRef.current;
    const targetKey = pending.targetKey;
    setProcessing(true);
    setErrorState(null);
    try {
      const lookup = await dubbingService.findOperationResult(pending.operationId);
      if (!mountedRef.current || epoch !== requestEpochRef.current || targetKey !== latestTargetKeyRef.current) return;
      if (lookup.state === 'complete') {
        pendingOperationRef.current = null;
        if (lookup.result.status === 'conflict') {
          setConflictState({ reason: lookup.result.reason, videoRevision: lookup.result.videoRevision });
          return;
        }
        if (projects) {
          projects.recordDubbingSaved({
            projectId: pending.input.projectId,
            videoId: pending.input.videoId,
            artifact: lookup.result.artifact,
            videoRevision: lookup.result.videoRevision,
            projectRevision: lookup.result.projectRevision,
            updatedAt: lookup.result.updatedAt,
          });
        } else {
          historyStoreApi.getState().upsertCueDubbing(lookup.result.artifact);
        }
        setJustCompleted(true);
        return;
      }
      if (lookup.state === 'running') {
        const controller = new AbortController();
        abortRef.current = controller;
        activeJobIdRef.current = lookup.job.id;
        const result = await connection.waitJob<DubCueResult>(lookup.job.id, undefined, controller.signal);
        if (!mountedRef.current || epoch !== requestEpochRef.current || targetKey !== latestTargetKeyRef.current) return;
        pendingOperationRef.current = null;
        if (result.status === 'conflict') {
          setConflictState({ reason: result.reason, videoRevision: result.videoRevision });
          return;
        }
        projects?.recordDubbingSaved({
          projectId: pending.input.projectId,
          videoId: pending.input.videoId,
          artifact: result.artifact,
          videoRevision: result.videoRevision,
          projectRevision: result.projectRevision,
          updatedAt: result.updatedAt,
        });
        setJustCompleted(true);
        return;
      }
      if (lookup.state === 'missing') {
        const opened = await dubbingService.fetchProjectOpen(pending.input.projectId, pending.input.videoId);
        if (!mountedRef.current || epoch !== requestEpochRef.current || targetKey !== latestTargetKeyRef.current) return;
        if (opened.status === 'ok') {
          const existing = opened.edits?.dubbings?.find(d => d.operationId === pending.operationId);
          if (existing) {
            pendingOperationRef.current = null;
            projects?.recordDubbingSaved({
              projectId: pending.input.projectId,
              videoId: pending.input.videoId,
              artifact: existing,
              videoRevision: opened.video.revision,
              projectRevision: opened.project.revision,
              updatedAt: opened.video.updatedAt ?? opened.project.updatedAt,
            });
            setJustCompleted(true);
            return;
          }
        }
      }
    } catch (error) {
      if (!mountedRef.current || epoch !== requestEpochRef.current || targetKey !== latestTargetKeyRef.current) return;
      setProcessing(false);
      setErrorState({
        message: error instanceof Error ? error.message : String(error),
        uncertain: isUncertainError(error),
      });
      return;
    }
    setProcessing(false);
    await executeSynthesize(pending);
  }, [connection, dubbingService, errorState?.uncertain, executeSynthesize, historyStoreApi, projects]);

  const clearError = useCallback(() => setErrorState(null), []);

  const reviewLatest = useCallback(async () => {
    if (projects) {
      await projects.reloadCurrentVideo();
    }
    setConflictState(null);
    setErrorState(null);
  }, [projects]);

  const togglePlayArtifact = useCallback(async (artifact: CueDubbingArtifact) => {
    const key = `${artifact.trackId}:${artifact.chunkId}`;
    if (playingCueKey === key) {
      stopPlayback();
      return;
    }
    stopPlayback();
    if (!projectId || !videoId) return;
    try {
      const url = await dubbingService.downloadAudioObjectUrl(projectId, videoId, artifact.id);
      quickAudioUrlRef.current = url;
      const audio = new Audio(url);
      quickAudioRef.current = audio;
      setPlayingCueKey(key);
      audio.onended = () => { if (quickAudioRef.current === audio) stopPlayback(); };
      audio.onerror = () => { if (quickAudioRef.current === audio) stopPlayback(); };
      await audio.play().catch(() => undefined);
    } catch (error) {
      setErrorState({ message: error instanceof Error ? error.message : copy.audioLoadFailed, uncertain: false });
    }
  }, [copy.audioLoadFailed, dubbingService, playingCueKey, projectId, stopPlayback, videoId]);

  const statusForChunk = useCallback((chunk: SubtitleChunk) => {
    const artifact = activeTrack ? findCueDubbing(dubbings, activeTrack.id, chunk.id) : undefined;
    if (!artifact) return { artifact: undefined, status: null };
    const currentText = activeTrack?.entries[chunk.id]?.text ?? '';
    const duration = Math.max(0, chunk.timestamp[1] - chunk.timestamp[0]);
    return {
      artifact,
      status: evaluateCueDubbingStatus(artifact, {
        currentText,
        cueDurationSeconds: duration,
        selectedModel,
        voiceId,
      }),
    };
  }, [activeTrack, dubbings, selectedModel, voiceId]);

  const canSubmit = Boolean(
    projectId
    && videoId
    && activeTrack
    && selectedChunk
    && confirmedTranslation
    && selectedModel
    && activeEntry?.model.status === 'ready'
    && !processing
    && !settingsLoading
    && !conflictState,
  );

  return {
    open,
    loading: settingsLoading || (modelsLoading && ttsGroups.length === 0),
    processing,
    progressText,
    hasProject: Boolean(projectId && videoId),
    ttsGroups,
    modelsError,
    selectedChunk,
    selectedChunkIndex,
    cueDeleted,
    confirmedTranslation,
    cueDurationSeconds,
    activeTrackId: activeLanguageTrackId,
    activeTrackName: activeTrack?.name ?? '',
    selectedModel,
    activeEntry,
    voiceId,
    ttsLanguage,
    speed,
    options,
    currentArtifact,
    currentStatus,
    justCompleted,
    errorState,
    conflictState,
    panelAudioUrl,
    playingCueKey,
    canSubmit,
    openPanel,
    openForCue,
    closePanel,
    selectModel,
    setVoiceId,
    setTtsLanguage,
    setSpeed,
    setOptions,
    generate,
    cancel,
    retry,
    clearError,
    reviewLatest,
    togglePlayArtifact,
    stopPlayback,
    statusForChunk,
  };
}

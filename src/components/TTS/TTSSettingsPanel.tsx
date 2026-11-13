import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Download,
  Loader2,
  Play,
  RefreshCw,
  ShieldCheck,
  Square,
  Volume2,
  XCircle,
} from 'lucide-react';
import type { ModelInfo, ModelRef, OptionValue } from '../../../shared/providers';
import type {
  TtsAuditionSummary,
  TtsSettingsData,
  TtsSettingsSnapshot,
} from '../../../shared/tts/settings';
import { newCorrelationId } from '../../../shared/asr/apiProtocol';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ModelOptionsForm } from '@/components/ASR/ModelOptionsForm';
import { useTranslation } from '@/contexts/LocaleProvider';
import { fillTtsCopy, ttsCopy } from '@/locales/tts';
import { notifyProviderModelsChanged, useProviderModels } from '@/hooks/useProviderModels';
import { useClientRuntime } from '@/runtime/context';
import { modelKey } from '@/stores/appStore';
import { TTSService } from '@/services/ttsService';

interface TTSSettingsPanelProps {
  onOpenModels: () => void;
}

type BusyKind = 'loading' | 'saving' | 'synthesizing' | 'downloading' | null;

interface ErrorState {
  action: 'load' | 'save' | 'synthesize' | 'download';
  message: string;
  uncertainSave?: boolean;
}

const parseKey = (key: string): ModelRef => {
  const index = key.lastIndexOf('/');
  return { providerId: key.slice(0, index), modelId: key.slice(index + 1) };
};

export function TTSSettingsPanel({ onOpenModels }: TTSSettingsPanelProps) {
  const { language: uiLanguage } = useTranslation();
  const copy = ttsCopy(uiLanguage);
  const { connection, asr } = useClientRuntime();
  const ttsService = useMemo(() => new TTSService(connection), [connection]);
  const { groups, loading: modelsLoading, error: modelsError, refresh: refreshModels } = useProviderModels();

  const [settingsLoading, setSettingsLoading] = useState(true);
  const [busy, setBusy] = useState<BusyKind>(null);
  const [progressText, setProgressText] = useState<string>('');
  const [hostSnapshot, setHostSnapshot] = useState<TtsSettingsSnapshot | null>(null);

  const [selectedModel, setSelectedModel] = useState<ModelRef | null>(null);
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const [ttsLanguage, setTtsLanguage] = useState<string>('auto');
  const [speed, setSpeed] = useState<number>(1);
  const [options, setOptions] = useState<Record<string, OptionValue>>({});
  const [sampleText, setSampleText] = useState<string>(() => copy.defaultSampleText);
  const sampleDirtyRef = useRef(false);

  const [cloneEnabled, setCloneEnabled] = useState(false);
  const [cloneFile, setCloneFile] = useState<File | null>(null);
  const [cloneAuthorized, setCloneAuthorized] = useState(false);

  const [completedMessage, setCompletedMessage] = useState<string | null>(null);
  const [errorState, setErrorState] = useState<ErrorState | null>(null);
  const [conflictSnapshot, setConflictSnapshot] = useState<TtsSettingsSnapshot | null>(null);
  const [audition, setAudition] = useState<TtsAuditionSummary | null>(null);
  const [auditionCloned, setAuditionCloned] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeJobIdRef = useRef<string | null>(null);
  const requestEpochRef = useRef(0);
  const hostIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pendingSaveRef = useRef<{ operationId: string; expectedRevision: number; settings: TtsSettingsData } | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  const setObjectUrl = useCallback((next: string | null) => {
    if (audioUrlRef.current && audioUrlRef.current !== next) {
      URL.revokeObjectURL(audioUrlRef.current);
    }
    audioUrlRef.current = next;
    setAudioUrl(next);
    setPlaying(false);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestEpochRef.current += 1;
      abortRef.current?.abort();
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, []);

  useEffect(() => {
    if (!sampleDirtyRef.current) {
      setSampleText(copy.defaultSampleText);
    }
  }, [copy.defaultSampleText]);

  const ttsGroups = useMemo(
    () => groups.map(g => ({ ...g, models: g.models.filter(m => m.role === 'tts') })).filter(g => g.models.length > 0),
    [groups],
  );

  const activeEntry = useMemo(() => {
    if (!selectedModel) return undefined;
    for (const group of ttsGroups) {
      if (group.provider.id !== selectedModel.providerId) continue;
      const found = group.models.find(m => m.id === selectedModel.modelId);
      if (found) return { provider: group.provider, model: found };
    }
    return undefined;
  }, [ttsGroups, selectedModel]);

  const applySnapshot = useCallback((snapshot: TtsSettingsSnapshot, preserveForm: boolean) => {
    hostIdRef.current = snapshot.hostId;
    setHostSnapshot(snapshot);
    if (!preserveForm) {
      setSelectedModel(snapshot.selectedModel);
      setVoiceId(snapshot.voiceId);
      setTtsLanguage(snapshot.language);
      setSpeed(snapshot.speed);
      setOptions(snapshot.options ?? {});
    }
    if (snapshot.lastAudition) {
      setAudition(snapshot.lastAudition);
      void ttsService.downloadAudioObjectUrl(snapshot.lastAudition.assetId).then(
        url => { if (mountedRef.current && hostIdRef.current === snapshot.hostId) setObjectUrl(url); },
        () => { /* Asset may have expired; keep verified metadata */ },
      );
    } else if (!preserveForm) {
      setAudition(null);
      setObjectUrl(null);
    }
  }, [setObjectUrl, ttsService]);

  const loadSettings = useCallback(async (preserveForm = false) => {
    const epoch = ++requestEpochRef.current;
    setSettingsLoading(true);
    setErrorState(null);
    try {
      const snapshot = await ttsService.getSettings();
      if (!mountedRef.current || epoch !== requestEpochRef.current) return;
      const hostChanged = hostIdRef.current !== null && hostIdRef.current !== snapshot.hostId;
      if (hostChanged) {
        setConflictSnapshot(null);
        setCompletedMessage(null);
        pendingSaveRef.current = null;
      }
      applySnapshot(snapshot, preserveForm && !hostChanged);
    } catch (error) {
      if (!mountedRef.current || epoch !== requestEpochRef.current) return;
      setErrorState({ action: 'load', message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (mountedRef.current && epoch === requestEpochRef.current) setSettingsLoading(false);
    }
  }, [applySnapshot, ttsService]);

  useEffect(() => {
    void loadSettings(false);
  }, [loadSettings]);

  const handleRefresh = async () => {
    setCompletedMessage(null);
    await Promise.all([refreshModels(), loadSettings(true)]);
  };

  useEffect(() => {
    if (settingsLoading || modelsLoading || selectedModel || ttsGroups.length === 0) return;
    const firstReady = ttsGroups.flatMap(g => g.models.filter(m => m.status === 'ready').map(m => ({ providerId: g.provider.id, model: m })))[0];
    const fallback = ttsGroups[0]?.models[0] ? { providerId: ttsGroups[0].provider.id, model: ttsGroups[0].models[0] } : undefined;
    const pick = firstReady ?? fallback;
    if (!pick) return;
    setSelectedModel({ providerId: pick.providerId, modelId: pick.model.id });
    setVoiceId(pick.model.tts?.voices?.[0]?.id ?? null);
    setTtsLanguage(pick.model.languages?.[0] ?? 'auto');
  }, [settingsLoading, modelsLoading, selectedModel, ttsGroups]);

  const onSelectModel = (key: string) => {
    const ref = parseKey(key);
    setSelectedModel(ref);
    setCompletedMessage(null);
    setErrorState(null);
    setCloneEnabled(false);
    setCloneFile(null);
    setCloneAuthorized(false);
    const group = ttsGroups.find(g => g.provider.id === ref.providerId);
    const model = group?.models.find(m => m.id === ref.modelId);
    if (model) {
      setVoiceId(model.tts?.voices?.[0]?.id ?? null);
      const langs = model.languages?.length ? model.languages : ['auto'];
      if (!langs.includes(ttsLanguage)) setTtsLanguage(langs[0]);
    }
  };

  const currentSettingsData = (): TtsSettingsData => ({
    selectedModel,
    voiceId,
    language: ttsLanguage || 'auto',
    speed,
    options,
  });

  const executeSave = async (payload: { operationId: string; expectedRevision: number; settings: TtsSettingsData }) => {
    const expectedHostId = hostSnapshot?.hostId;
    if (!expectedHostId) return;
    const epoch = ++requestEpochRef.current;
    setBusy('saving');
    setProgressText(copy.savingHint);
    setErrorState(null);
    setCompletedMessage(null);
    pendingSaveRef.current = payload;
    try {
      const result = await ttsService.saveSettings({
        hostId: expectedHostId,
        expectedRevision: payload.expectedRevision,
        operationId: payload.operationId,
        settings: payload.settings,
      });
      if (!mountedRef.current || epoch !== requestEpochRef.current || hostIdRef.current !== expectedHostId) return;
      if (result.status === 'conflict') {
        setHostSnapshot(result.snapshot);
        setConflictSnapshot(result.snapshot);
        pendingSaveRef.current = null;
        return;
      }
      pendingSaveRef.current = null;
      setConflictSnapshot(null);
      setHostSnapshot(result.snapshot);
      setCompletedMessage(copy.completed);
    } catch (error) {
      if (!mountedRef.current || epoch !== requestEpochRef.current) return;
      const message = error instanceof Error ? error.message : String(error);
      const isValidationError = /Host|操作标识|Invalid/i.test(message);
      setErrorState({ action: 'save', message, uncertainSave: !isValidationError });
    } finally {
      if (mountedRef.current && epoch === requestEpochRef.current) {
        setBusy(null);
        setProgressText('');
      }
    }
  };

  const handleSave = () => {
    if (!hostSnapshot || busy || conflictSnapshot) return;
    void executeSave({
      operationId: newCorrelationId(),
      expectedRevision: hostSnapshot.revision,
      settings: currentSettingsData(),
    });
  };

  const handleDownloadModel = async () => {
    if (!selectedModel || busy) return;
    const epoch = ++requestEpochRef.current;
    setBusy('downloading');
    setErrorState(null);
    setCompletedMessage(null);
    setProgressText(copy.processing);
    try {
      await asr.prepareModel(selectedModel, progress => {
        if (!mountedRef.current || epoch !== requestEpochRef.current) return;
        const pct = progress.progress !== undefined ? Math.round(progress.progress) + '%' : '';
        setProgressText([progress.data, pct].filter(Boolean).join(' '));
      });
      if (!mountedRef.current || epoch !== requestEpochRef.current) return;
      notifyProviderModelsChanged();
      setCompletedMessage(copy.completed);
    } catch (error) {
      if (!mountedRef.current || epoch !== requestEpochRef.current) return;
      setErrorState({ action: 'download', message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (mountedRef.current && epoch === requestEpochRef.current) {
        setBusy(null);
        setProgressText('');
      }
    }
  };

  const handleAudition = async () => {
    if (!selectedModel || !activeEntry || busy) return;
    const trimmed = sampleText.trim();
    if (!trimmed) {
      setErrorState({ action: 'synthesize', message: copy.missingTextHint });
      return;
    }
    const voices = activeEntry.model.tts?.voices ?? [];
    if (!cloneEnabled && voices.length > 0 && !voiceId) {
      setErrorState({ action: 'synthesize', message: copy.missingVoiceHint });
      return;
    }
    if (cloneEnabled && (!cloneFile || !cloneAuthorized)) {
      setErrorState({ action: 'synthesize', message: copy.cloneAuthMissing });
      return;
    }

    const expectedHostId = hostSnapshot?.hostId ?? hostIdRef.current;
    const epoch = ++requestEpochRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    activeJobIdRef.current = null;

    setBusy('synthesizing');
    setProgressText(copy.processing);
    setErrorState(null);
    setCompletedMessage(null);

    try {
      let cloneReferenceAssetId: string | undefined;
      if (cloneEnabled && cloneFile) {
        cloneReferenceAssetId = await ttsService.uploadReferenceAudio(cloneFile);
      }
      const result = await ttsService.synthesize(
        {
          providerId: selectedModel.providerId,
          modelId: selectedModel.modelId,
          text: trimmed,
          ...(voiceId ? { voiceId } : {}),
          language: ttsLanguage || 'auto',
          ...(activeEntry.model.tts?.durationControl !== false ? { speed } : {}),
          ...(Object.keys(options).length ? { options } : {}),
          ...(cloneEnabled && cloneReferenceAssetId
            ? {
                cloneReferenceAssetId,
                cloneAuthorization: {
                  confirmed: true as const,
                  statement: copy.cloneAuthStatement,
                  confirmedAt: new Date().toISOString(),
                  sourceLabel: cloneFile?.name || 'reference.wav',
                },
              }
            : {}),
        },
        {
          signal: controller.signal,
          onJobId: jobId => { activeJobIdRef.current = jobId; },
          onProgress: progress => {
            if (!mountedRef.current || epoch !== requestEpochRef.current) return;
            const pct = progress.progress !== undefined ? Math.round(progress.progress) + '%' : '';
            setProgressText([progress.data, pct].filter(Boolean).join(' '));
          },
        },
      );
      if (!mountedRef.current || epoch !== requestEpochRef.current || (expectedHostId && hostIdRef.current !== expectedHostId)) return;
      const objectUrl = await ttsService.downloadAudioObjectUrl(result.assetId);
      if (!mountedRef.current || epoch !== requestEpochRef.current || (expectedHostId && hostIdRef.current !== expectedHostId)) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      setObjectUrl(objectUrl);
      setAudition(result);
      setAuditionCloned(result.cloned);
      setCompletedMessage(copy.completed);
    } catch (error) {
      if (!mountedRef.current || epoch !== requestEpochRef.current) return;
      if (controller.signal.aborted) return;
      setErrorState({ action: 'synthesize', message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      activeJobIdRef.current = null;
      if (mountedRef.current && epoch === requestEpochRef.current) {
        setBusy(null);
        setProgressText('');
      }
    }
  };

  const handleCancelAudition = () => {
    const jobId = activeJobIdRef.current;
    abortRef.current?.abort();
    if (jobId) void ttsService.cancelJob(jobId).catch(() => undefined);
    setBusy(null);
    setProgressText('');
  };

  const handleRetry = async () => {
    if (!errorState) return;
    if (errorState.action === 'load') {
      await handleRefresh();
      return;
    }
    if (errorState.action === 'download') {
      await handleDownloadModel();
      return;
    }
    if (errorState.action === 'synthesize') {
      await handleAudition();
      return;
    }
    if (errorState.action === 'save') {
      const pending = pendingSaveRef.current;
      if (errorState.uncertainSave && pending) {
        const epoch = ++requestEpochRef.current;
        setBusy('loading');
        setErrorState(null);
        try {
          const latest = await ttsService.getSettings();
          if (!mountedRef.current || epoch !== requestEpochRef.current) return;
          setHostSnapshot(latest);
          if (latest.lastOperationId === pending.operationId) {
            pendingSaveRef.current = null;
            setConflictSnapshot(null);
            setCompletedMessage(copy.completed);
            setBusy(null);
            return;
          }
          if (latest.revision !== pending.expectedRevision) {
            pendingSaveRef.current = null;
            setConflictSnapshot(latest);
            setBusy(null);
            return;
          }
          setBusy(null);
          await executeSave(pending);
        } catch (error) {
          if (!mountedRef.current || epoch !== requestEpochRef.current) return;
          setBusy(null);
          setErrorState({ action: 'save', message: error instanceof Error ? error.message : String(error), uncertainSave: true });
        }
        return;
      }
      handleSave();
    }
  };

  const handleBackFromError = () => {
    setErrorState(null);
    pendingSaveRef.current = null;
  };

  const togglePlay = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
      el.currentTime = 0;
      setPlaying(false);
    } else {
      void el.play().then(() => setPlaying(true), () => setPlaying(false));
    }
  };

  const isLoading = settingsLoading || (modelsLoading && groups.length === 0) || busy === 'loading';
  const activeModel: ModelInfo | undefined = activeEntry?.model;
  const activeTts = activeModel?.tts;
  const voices = activeTts?.voices ?? [];
  const languages = activeModel?.languages?.length ? activeModel.languages : ['auto'];
  const canSynthesize = Boolean(
    activeModel
    && activeModel.status === 'ready'
    && !busy
    && !isLoading
    && sampleText.trim().length > 0
    && (!cloneEnabled || (cloneFile && cloneAuthorized)),
  );

  return (
    <div className="space-y-4 pt-4" data-testid="tts-settings-panel">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-aimu-text-primary">{copy.title}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{copy.subtitle}</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 text-xs"
          data-testid="tts-refresh"
          onClick={() => void handleRefresh()}
          disabled={isLoading || busy !== null}
        >
          <RefreshCw className={'mr-1 h-3 w-3 ' + (isLoading ? 'animate-spin' : '')} />
          {copy.refresh}
        </Button>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 rounded-md border border-aimu-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground" data-testid="tts-loading">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>{copy.loading}</span>
        </div>
      )}

      {busy && busy !== 'loading' && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-aimu-border bg-muted/30 px-3 py-2 text-xs" data-testid="tts-processing">
          <div className="min-w-0 space-y-0.5">
            <div className="flex items-center gap-2 font-medium text-aimu-text-primary">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>{copy.processing}</span>
            </div>
            {progressText && <p className="truncate text-[11px] text-muted-foreground">{progressText}</p>}
            {busy === 'synthesizing' && <p className="text-[11px] text-muted-foreground">{copy.cancelHint}</p>}
          </div>
          {busy === 'synthesizing' && (
            <Button type="button" variant="outline" size="sm" className="h-7 shrink-0 text-xs" data-testid="tts-cancel" onClick={handleCancelAudition}>
              <XCircle className="mr-1 h-3 w-3" />
              {copy.cancel}
            </Button>
          )}
        </div>
      )}

      {conflictSnapshot && (
        <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs" data-testid="tts-conflict">
          <div className="flex items-start gap-2 font-medium text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="space-y-1">
              <p>{copy.conflict}</p>
              <p className="text-[11px] font-normal text-muted-foreground">
                {fillTtsCopy(copy.conflictDetail, { revision: conflictSnapshot.revision })}
              </p>
              <p className="font-mono text-[11px] text-muted-foreground">
                {(conflictSnapshot.selectedModel ? conflictSnapshot.selectedModel.providerId + '/' + conflictSnapshot.selectedModel.modelId : '—')
                  + (conflictSnapshot.voiceId ? ' · ' + conflictSnapshot.voiceId : '')
                  + ' · ' + conflictSnapshot.language + ' · ' + conflictSnapshot.speed + 'x'}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" className="h-7 text-xs" data-testid="tts-conflict-ack" onClick={() => setConflictSnapshot(null)}>
              {copy.acknowledgeConflict}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              data-testid="tts-conflict-adopt"
              onClick={() => {
                applySnapshot(conflictSnapshot, false);
                setConflictSnapshot(null);
              }}
            >
              {copy.adoptHostDefaults}
            </Button>
          </div>
        </div>
      )}

      {errorState && (
        <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs" role="alert" data-testid="tts-error">
          <div className="flex items-start gap-2 text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="space-y-1">
              <p className="font-medium">{errorState.message}</p>
              {errorState.uncertainSave && <p className="text-[11px] text-muted-foreground">{copy.uncertainSaveHint}</p>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="outline" className="h-7 text-xs" data-testid="tts-retry" onClick={() => void handleRetry()}>
              {copy.retry}
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" data-testid="tts-back" onClick={handleBackFromError}>
              {copy.back}
            </Button>
          </div>
        </div>
      )}

      {modelsError && !errorState && (
        <p className="text-xs text-destructive">{modelsError}</p>
      )}

      {!isLoading && ttsGroups.length === 0 ? (
        <div className="space-y-3 rounded-md border border-dashed border-aimu-border p-4 text-xs" data-testid="tts-empty">
          <p className="font-medium text-aimu-text-primary">{copy.empty}</p>
          <p className="text-muted-foreground">{copy.emptyHint}</p>
          <Button type="button" size="sm" variant="outline" className="h-8 text-xs" data-testid="tts-go-models" onClick={onOpenModels}>
            {copy.configureModels}
          </Button>
        </div>
      ) : ttsGroups.length > 0 && (
        <>
          <section className="space-y-3 rounded-md border border-aimu-border p-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="space-y-1 text-xs">
                <span className="font-medium text-muted-foreground">{copy.modelLabel}</span>
                <Select
                  value={selectedModel ? modelKey(selectedModel) : undefined}
                  onValueChange={onSelectModel}
                  disabled={busy !== null}
                >
                  <SelectTrigger size="sm" className="h-8 w-full text-xs" data-testid="tts-model-select">
                    <SelectValue placeholder={copy.selectModelPlaceholder} />
                  </SelectTrigger>
                  <SelectContent>
                    {ttsGroups.map(group => (
                      <SelectGroup key={group.provider.id}>
                        <SelectLabel className="text-[11px]">{group.provider.name}</SelectLabel>
                        {group.models.map(model => (
                          <SelectItem
                            key={model.id}
                            value={modelKey({ providerId: group.provider.id, modelId: model.id })}
                            disabled={model.status === 'unavailable'}
                          >
                            {model.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
              </label>

              <label className="space-y-1 text-xs">
                <span className="font-medium text-muted-foreground">{copy.voiceLabel}</span>
                {voices.length > 0 ? (
                  <Select value={voiceId ?? undefined} onValueChange={v => { setVoiceId(v); setCompletedMessage(null); }} disabled={busy !== null || cloneEnabled}>
                    <SelectTrigger size="sm" className="h-8 w-full text-xs" data-testid="tts-voice-select">
                      <SelectValue placeholder={copy.voiceLabel} />
                    </SelectTrigger>
                    <SelectContent>
                      {voices.map(voice => (
                        <SelectItem key={voice.id} value={voice.id}>
                          {voice.name}{voice.languages?.length ? ' (' + voice.languages.join('/') + ')' : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <div className="flex h-8 items-center rounded-md border border-aimu-border bg-muted/30 px-2.5 text-muted-foreground">
                    {copy.noBuiltInVoices}
                  </div>
                )}
              </label>

              <label className="space-y-1 text-xs">
                <span className="font-medium text-muted-foreground">{copy.languageLabel}</span>
                <Select value={ttsLanguage} onValueChange={v => { setTtsLanguage(v); setCompletedMessage(null); }} disabled={busy !== null}>
                  <SelectTrigger size="sm" className="h-8 w-full text-xs" data-testid="tts-language-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {languages.map(code => (
                      <SelectItem key={code} value={code}>{code}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>

              <label className="space-y-1 text-xs">
                <span className="font-medium text-muted-foreground">{copy.speedLabel}</span>
                <Input
                  className="h-8 text-xs"
                  type="number"
                  min={0.25}
                  max={4}
                  step={0.05}
                  disabled={busy !== null || activeTts?.durationControl === false}
                  value={speed}
                  data-testid="tts-speed-input"
                  onChange={e => {
                    const val = Number(e.target.value);
                    if (Number.isFinite(val)) setSpeed(val);
                  }}
                />
              </label>
            </div>

            {activeModel?.options && (
              <div className="space-y-1.5 border-t border-aimu-border pt-2">
                <p className="text-[11px] font-medium text-muted-foreground">{copy.optionsLabel}</p>
                <ModelOptionsForm
                  fields={activeModel.options}
                  values={options}
                  disabled={busy !== null}
                  onChange={next => { setOptions(next); setCompletedMessage(null); }}
                />
              </div>
            )}

            {activeModel && (
              <div className="space-y-2 rounded bg-muted/30 p-2.5 text-[11px]" data-testid="tts-capabilities">
                <p className="font-medium text-aimu-text-primary">{copy.capabilitiesLabel}</p>
                <div className="flex flex-wrap gap-1.5">
                  <span
                    className={'rounded border px-2 py-0.5 ' + (activeTts?.voiceCloning ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300' : 'border-aimu-border text-muted-foreground')}
                    data-testid="tts-cloning-status"
                  >
                    {activeTts?.voiceCloning ? copy.voiceCloningSupported : copy.voiceCloningUnsupported}
                  </span>
                  <span className="rounded border border-aimu-border px-2 py-0.5 text-muted-foreground">
                    {activeTts?.streaming ? copy.streamingSupported : copy.streamingUnsupported}
                  </span>
                  <span className="rounded border border-aimu-border px-2 py-0.5 text-muted-foreground">
                    {activeTts?.durationControl === false ? copy.durationControlUnsupported : copy.durationControlSupported}
                  </span>
                  {activeTts?.outputFormats?.length ? (
                    <span className="rounded border border-aimu-border px-2 py-0.5 text-muted-foreground">
                      {copy.formatsLabel}: {activeTts.outputFormats.join(', ')}
                    </span>
                  ) : null}
                </div>
                {activeTts?.cloningTerms && (
                  <p className="text-muted-foreground">{activeTts.cloningTerms}</p>
                )}
                {activeModel.status === 'download' && (
                  <div className="flex items-center justify-between gap-2 pt-1">
                    <span className="text-amber-700 dark:text-amber-300">{copy.downloadRequired}</span>
                    <Button type="button" size="sm" variant="outline" className="h-7 text-xs" disabled={busy !== null} onClick={() => void handleDownloadModel()}>
                      <Download className="mr-1 h-3 w-3" />
                      {copy.downloadModel}
                    </Button>
                  </div>
                )}
                {activeModel.status === 'unavailable' && (
                  <p className="text-destructive">{copy.modelUnavailable}: {activeModel.reason ?? ''}</p>
                )}
              </div>
            )}

            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="text-[11px] text-muted-foreground">{copy.keySafetyNote}</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0 text-xs"
                data-testid="tts-save"
                disabled={!hostSnapshot || busy !== null || conflictSnapshot !== null || isLoading}
                onClick={handleSave}
              >
                {copy.saveDefaults}
              </Button>
            </div>
          </section>

          <section className="space-y-3 rounded-md border border-aimu-border p-3">
            <div className="flex items-center gap-2">
              <Volume2 className="h-4 w-4 text-aimu-coral" />
              <h3 className="text-xs font-medium text-aimu-text-primary">{copy.auditionSection}</h3>
            </div>

            <textarea
              className="min-h-[72px] w-full rounded-md border border-input bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              value={sampleText}
              placeholder={copy.auditionPlaceholder}
              disabled={busy !== null}
              data-testid="tts-audition-text"
              onChange={e => {
                sampleDirtyRef.current = true;
                setSampleText(e.target.value);
              }}
            />

            {activeTts?.voiceCloning && (
              <div className="space-y-2 rounded-md border border-aimu-border bg-muted/20 p-2.5 text-xs" data-testid="tts-clone-section">
                <label className="flex items-center justify-between gap-2">
                  <span className="font-medium">{copy.cloneToggle}</span>
                  <Switch
                    checked={cloneEnabled}
                    disabled={busy !== null}
                    data-testid="tts-clone-toggle"
                    onCheckedChange={checked => {
                      setCloneEnabled(checked);
                      if (!checked) {
                        setCloneFile(null);
                        setCloneAuthorized(false);
                      }
                    }}
                  />
                </label>
                {cloneEnabled && (
                  <div className="space-y-2 pt-1">
                    <label className="block space-y-1">
                      <span className="text-[11px] text-muted-foreground">{copy.cloneFileLabel}</span>
                      <input
                        type="file"
                        accept="audio/wav,.wav"
                        disabled={busy !== null}
                        data-testid="tts-clone-file"
                        className="block w-full text-[11px] text-muted-foreground file:mr-2 file:rounded file:border file:border-aimu-border file:bg-background file:px-2 file:py-1 file:text-xs"
                        onChange={e => setCloneFile(e.target.files?.[0] ?? null)}
                      />
                    </label>
                    <label className="flex items-start gap-2 text-[11px]">
                      <input
                        type="checkbox"
                        checked={cloneAuthorized}
                        disabled={busy !== null}
                        data-testid="tts-clone-auth"
                        className="mt-0.5"
                        onChange={e => setCloneAuthorized(e.target.checked)}
                      />
                      <span className="flex items-center gap-1 text-aimu-text-primary">
                        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-aimu-coral" />
                        {copy.cloneAuthStatement}
                      </span>
                    </label>
                    {(!cloneFile || !cloneAuthorized) && (
                      <p className="text-[11px] text-muted-foreground">{copy.cloneAuthMissing}</p>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                size="sm"
                className="h-8 text-xs"
                data-testid="tts-audition"
                disabled={!canSynthesize}
                onClick={() => void handleAudition()}
              >
                <Volume2 className="mr-1 h-3.5 w-3.5" />
                {copy.auditionButton}
              </Button>
            </div>
          </section>

          {(completedMessage || audition) && (
            <section className="space-y-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs" data-testid="tts-completed">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span>{completedMessage ?? copy.completed}</span>
                  {audition && <span className="font-normal text-muted-foreground">· {copy.auditionResultTitle}</span>}
                </div>
                {auditionCloned && (
                  <span className="rounded border border-emerald-500/40 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-300">
                    {copy.clonedBadge}
                  </span>
                )}
              </div>
              {audition && (
                <div className="space-y-2">
                  <p className="text-[11px] text-muted-foreground">
                    {audition.model.providerId}/{audition.model.modelId}
                    {audition.voiceId ? ' · ' + audition.voiceId : ''}
                    {' · ' + fillTtsCopy(copy.audioMeta, { format: audition.format.toUpperCase(), bytes: audition.byteLength })}
                    {audition.durationSeconds !== undefined ? ' · ' + fillTtsCopy(copy.durationSeconds, { seconds: audition.durationSeconds.toFixed(2) }) : ''}
                  </p>
                  {audioUrl && (
                    <div className="flex items-center gap-2">
                      <Button type="button" size="sm" variant="outline" className="h-7 text-xs" data-testid="tts-play-toggle" onClick={togglePlay}>
                        {playing ? <Square className="mr-1 h-3 w-3" /> : <Play className="mr-1 h-3 w-3" />}
                        {playing ? copy.stop : copy.play}
                      </Button>
                      <audio
                        ref={audioRef}
                        controls
                        src={audioUrl}
                        data-testid="tts-audition-audio"
                        className="h-8 flex-1"
                        onPlay={() => setPlaying(true)}
                        onPause={() => setPlaying(false)}
                        onEnded={() => setPlaying(false)}
                      />
                    </div>
                  )}
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}

// UI orchestration only: all model execution goes through the Host connection.
import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useAppStore } from '@/stores/appStore';
import { useTranslation } from '@/contexts/LocaleProvider';
import type { ASRProgress, SubtitleChunk } from '@/types/subtitle';
import type { VideoFile } from '@/types/video';
import { useClientRuntime } from '@/runtime/context';

export interface UseASRReturn { isASRLoading: boolean; asrProgress: ASRProgress | null; startASR: (videoFile: VideoFile) => Promise<void> }
export function useASR(options: { onSubtitleGenerated?: (subtitles: SubtitleChunk[]) => void } = {}): UseASRReturn {
  const { onSubtitleGenerated } = options;
  const { asr: asrService, stores } = useClientRuntime();
  const { t } = useTranslation();
  const progress = useAppStore(state => state.asrProgress);
  const loading = useAppStore(state => state.isLoading);
  const active = useRef(false);
  useEffect(() => asrService.addProgressCallback(value => {
    if (active.current && value.purpose !== 'download') stores.app.getState().setASRProgress(value);
  }), [asrService, stores]);
  const startASR = useCallback(async (videoFile: VideoFile) => {
    const app = stores.app.getState();
    if (active.current) return;
    active.current = true; app.setLoading(true);
    try {
      asrService.setEngineType(app.asrEngineType);
      asrService.setDevice(app.deviceType);
      asrService.setWebModel(app.webModelId);
      asrService.setPipeline(stores.pipeline.getState().activePipeline.steps);
      if (app.asrEngineType === 'api') {
        const api = stores.asrApi.getState(); const config = api.configs.find(item => item.id === api.selectedId);
        if (!config) throw new Error('请先选择 ASR API');
        asrService.configureApi(config);
      }
      const modelId = app.asrEngineType === 'transformers' ? app.webModelId : app.asrModelId;
      const provider = stores.providerConfig.getState().configs.find(item => item.modelIds.asr === modelId);
      const executionConfig = provider ? {
        vadModelId: provider.features.vad?.useNative ? undefined : provider.features.vad?.externalModelId ?? provider.modelIds.vad,
        alignModelId: provider.features.timestamps?.useNative ? undefined : provider.features.timestamps?.externalModelId ?? provider.modelIds.align,
      } : undefined;
      await asrService.prepareModel(modelId);
      let buffer: ArrayBuffer;
      if (videoFile.path && !videoFile.file.size) {
        const { convertFileSrc } = await import('@tauri-apps/api/core');
        const response = await fetch(convertFileSrc(videoFile.path));
        if (!response.ok) throw new Error('无法读取本地媒体');
        buffer = await response.arrayBuffer();
      } else buffer = await videoFile.file.arrayBuffer();
      const transcript = await asrService.transcribeAudio(buffer, app.language, modelId, executionConfig);
      stores.history.getState().setTranscript(transcript); app.setStage('edit');
      onSubtitleGenerated?.(stores.history.getState().chunks.filter(chunk => !chunk.deleted));
    } catch (error) {
      const message = error instanceof Error ? error.message : t('messages.asr.asrFailed');
      app.setError(message); app.setASRProgress({ status: 'error', error: message });
      toast.error(t('messages.asr.asrFailed'), { id: 'asr-error', description: message });
    } finally { app.setLoading(false); active.current = false; }
  }, [t, asrService, stores, onSubtitleGenerated]);
  return { isASRLoading: loading, asrProgress: progress, startASR };
}

// UI orchestration only: all model execution goes through the Host connection.
import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { modelKey, useAppStore } from '@/stores/appStore';
import { useTranslation } from '@/contexts/LocaleProvider';
import { asrModelsCopy } from '@/locales/models';
import type { ASRProgress, SubtitleChunk } from '@/types/subtitle';
import type { VideoFile } from '@/types/video';
import { useClientRuntime } from '@/runtime/context';
import { loadMediaBuffer } from '@/utils/mediaSource';
import { taskOperationKey } from '@/services/taskOperation';
import { hashBytes } from '@/upload/sha256';
import { inferHotwordCapabilities } from '../../shared/providers';
import { selectActiveHotwords } from '../../shared/terminology';
import { findModel } from './useProviderModels';

export interface UseASRReturn { isASRLoading: boolean; asrProgress: ASRProgress | null; startASR: (videoFile: VideoFile) => Promise<void> }
export function useASR(options: { onSubtitleGenerated?: (subtitles: SubtitleChunk[]) => void } = {}): UseASRReturn {
  const { onSubtitleGenerated } = options;
  const runtime = useClientRuntime();
  const { asr: asrService, connection, stores } = runtime;
  const { t, language } = useTranslation();
  const mc = asrModelsCopy(language);
  const progress = useAppStore(state => state.asrProgress);
  const loading = useAppStore(state => state.isLoading);
  const active = useRef(false);
  useEffect(() => asrService.addProgressCallback(value => {
    if (active.current && value.purpose !== 'download') stores.app.getState().setASRProgress(value);
  }), [asrService, stores]);

  const startASR = useCallback(async (videoFile: VideoFile) => {
    const app = stores.app.getState();
    if (active.current) return;
    active.current = true;
    app.setLoading(true);
    const startProject = runtime.stores.project.getState().current;
    const isSameTarget = () => {
      const currentApp = stores.app.getState();
      const currentProject = runtime.stores.project.getState().current;
      return currentApp.videoFile === videoFile
        && currentProject?.projectId === startProject?.projectId
        && currentProject?.videoId === startProject?.videoId;
    };
    try {
      if (!app.asrModel) throw new Error(mc.missingModelBeforeStart);
      const groups = await connection.call('providers.models');
      const found = findModel(groups, app.asrModel);
      if (!found || found.model.status !== 'ready') {
        throw new Error(found?.model.reason || mc.cannotTranscribeBeforeVerify);
      }
      if (!isSameTarget()) return;

      // Browser files, desktop paths and Host project media (F-0002)
      const buffer = await loadMediaBuffer(videoFile);
      const sourceSha256 = await hashBytes(new Uint8Array(buffer));
      const hotwords = selectActiveHotwords(startProject?.terminology ?? [], inferHotwordCapabilities(found.model));
      const operationKey = taskOperationKey('asr', startProject?.projectId, startProject?.videoId,
        videoFile.remotePath ?? videoFile.path ?? videoFile.name, videoFile.size, app.asrModel.providerId, app.asrModel.modelId,
        app.language, JSON.stringify(app.asrOptions[modelKey(app.asrModel)] ?? {}), JSON.stringify(hotwords), sourceSha256);
      const transcript = await asrService.transcribeAudio(buffer, { ...app.asrModel, language: app.language,
        options: app.asrOptions[modelKey(app.asrModel)], ...(hotwords.length ? { hotwords } : {}) }, { key: operationKey, verifyingMessage: t('messages.asr.taskVerifying') });
      // The user may have opened something else while recognition ran; never overwrite that editor.
      if (isSameTarget()) {
        stores.history.getState().setTranscript(transcript);
        app.setStage('edit');
        onSubtitleGenerated?.(stores.history.getState().chunks.filter(chunk => !chunk.deleted));
      }
      // Project mode saves the result to the project the video belongs to (F-0002/AC-2).
      let persisted = true;
      try {
        await runtime.events.parallel('flycut/transcribed', { videoFile, transcript, model: app.asrModel });
      } catch (error) {
        persisted = false;
        console.warn('转写结果尚未写入项目，保留任务恢复定位', error);
      }
      // A completed Host job is not enough: retain its locator until the project save is confirmed.
      await asrService.completeOperation(operationKey, persisted)
        .catch(error => console.warn('清理 ASR 操作定位失败', error));
    } catch (error) {
      if (isSameTarget()) {
        const message = error instanceof Error ? error.message : t('messages.asr.asrFailed');
        app.setError(message);
        app.setASRProgress({ status: 'error', error: message });
        toast.error(t('messages.asr.asrFailed'), { id: 'asr-error', description: message });
      }
    } finally {
      app.setLoading(false);
      active.current = false;
    }
  }, [t, mc, runtime, asrService, connection, stores, onSubtitleGenerated]);

  return { isASRLoading: loading, asrProgress: progress, startASR };
}

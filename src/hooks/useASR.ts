// UI orchestration only: all model execution goes through the Host connection.
import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { modelKey, useAppStore } from '@/stores/appStore';
import { useTranslation } from '@/contexts/LocaleProvider';
import type { ASRProgress, SubtitleChunk } from '@/types/subtitle';
import type { VideoFile } from '@/types/video';
import { useClientRuntime } from '@/runtime/context';
import { loadMediaBuffer } from '@/utils/mediaSource';

export interface UseASRReturn { isASRLoading: boolean; asrProgress: ASRProgress | null; startASR: (videoFile: VideoFile) => Promise<void> }
export function useASR(options: { onSubtitleGenerated?: (subtitles: SubtitleChunk[]) => void } = {}): UseASRReturn {
  const { onSubtitleGenerated } = options;
  const runtime = useClientRuntime();
  const { asr: asrService, stores } = runtime;
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
      if (!app.asrModel) throw new Error('请先在「设置 → 模型」中下载或添加一个识别模型');
      // Browser files, desktop paths and Host project media (F-0002)
      const buffer = await loadMediaBuffer(videoFile);
      const transcript = await asrService.transcribeAudio(buffer, { ...app.asrModel, language: app.language,
        options: app.asrOptions[modelKey(app.asrModel)] });
      // Project mode saves the result to the project the video belongs to (F-0002/AC-2).
      runtime.emit('flycut/transcribed', { videoFile, transcript, model: app.asrModel });
      // The user may have opened something else while recognition ran; never overwrite that editor.
      if (stores.app.getState().videoFile !== videoFile) return;
      stores.history.getState().setTranscript(transcript); app.setStage('edit');
      onSubtitleGenerated?.(stores.history.getState().chunks.filter(chunk => !chunk.deleted));
    } catch (error) {
      const message = error instanceof Error ? error.message : t('messages.asr.asrFailed');
      app.setError(message); app.setASRProgress({ status: 'error', error: message });
      toast.error(t('messages.asr.asrFailed'), { id: 'asr-error', description: message });
    } finally { app.setLoading(false); active.current = false; }
  }, [t, runtime, asrService, stores, onSubtitleGenerated]);
  return { isASRLoading: loading, asrProgress: progress, startASR };
}

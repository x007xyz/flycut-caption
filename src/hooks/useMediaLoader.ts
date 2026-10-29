// 媒体加载：本地文件（浏览器 <input> / 桌面原生对话框）、URL、示例视频
import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from '@/contexts/LocaleProvider';
import { useClientRuntime } from '@/runtime/context';
import { useAppStore } from '@/stores/appStore';
import { calcDownloadProgress, MEDIA_LOAD_PHASE } from '@/utils/mediaLoadProgress';
import { fetchBlobWithProgress, loadMediaFromUrl } from '@/utils/fileUtils';
import type { VideoFile } from '@/types/video';
import type { FlyCutCaptionProps } from '@/types';

// 示例视频：云端托管（本地 src/assets/demo.mp4 仅保留给集成测试）
const SAMPLE_VIDEO_URL = 'https://fly-cut.oss-cn-hangzhou.aliyuncs.com/demo/sample-video.mp4';
const SAMPLE_VIDEO_NAME = 'sample-video.mp4';

export function useMediaLoader({ onFileSelected }: Pick<FlyCutCaptionProps, 'onFileSelected'>) {
  const { t } = useTranslation();
  const { stores } = useClientRuntime();
  const setError = useAppStore(state => state.setError);

  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [urlInput, setUrlInput] = useState('');
  const [isUrlLoading, setIsUrlLoading] = useState(false);
  const [urlLoadProgress, setUrlLoadProgress] = useState<number | null>(null);
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [fileLoadProgress, setFileLoadProgress] = useState<number | null>(null);
  const [isSampleLoading, setIsSampleLoading] = useState(false);
  const [sampleLoadProgress, setSampleLoadProgress] = useState<number | null>(null);

  const isMediaLoading = isFileLoading || isSampleLoading || isUrlLoading;

  const handleFileSelect = useCallback((selectedVideoFile: VideoFile) => {
    console.log('文件选择完成:', selectedVideoFile);
    // 清除演示字幕与历史，避免与真实 ASR 流程冲突
    stores.history.getState().reset();
    // 清除上次的 ASR 进度/错误状态
    stores.app.getState().clearASRProgress();
    // 使用 appStore 的 setVideoFile 方法，它会自动切换到 'transcribe' 阶段
    const setVideoFile = stores.app.getState().setVideoFile;
    setVideoFile(selectedVideoFile);
    onFileSelected?.(selectedVideoFile);
  }, [onFileSelected, stores]);

  // 加载示例视频：拉取真实视频数据后走标准 ASR 流程（与手动上传一致），
  // 由模型识别生成字幕，而不是显示 mock 内容。
  const handleLoadSampleVideo = useCallback(async () => {
    if (isSampleLoading) return;

    stores.history.getState().reset();
    stores.app.getState().clearASRProgress();
    setIsSampleLoading(true);
    setSampleLoadProgress(MEDIA_LOAD_PHASE.START);

    try {
      const { blob } = await fetchBlobWithProgress(SAMPLE_VIDEO_URL, (loaded, total) => {
        setSampleLoadProgress(calcDownloadProgress(loaded, total));
      });
      const file = new File([blob], SAMPLE_VIDEO_NAME, { type: 'video/mp4' });
      const objectUrl = URL.createObjectURL(file);

      setSampleLoadProgress(MEDIA_LOAD_PHASE.METADATA);
      const duration = await new Promise<number>((resolve) => {
        const probe = document.createElement('video');
        probe.preload = 'metadata';
        probe.onloadedmetadata = () => resolve(Number.isFinite(probe.duration) ? probe.duration : 0);
        probe.onerror = () => resolve(0);
        probe.src = objectUrl;
      });

      setSampleLoadProgress(MEDIA_LOAD_PHASE.FINALIZING);
      const sampleVideoFile: VideoFile = {
        file,
        url: objectUrl,
        size: blob.size,
        type: 'video/mp4',
        name: SAMPLE_VIDEO_NAME,
        duration,
      };
      stores.app.getState().setVideoFile(sampleVideoFile);
      onFileSelected?.(sampleVideoFile);
      setSampleLoadProgress(MEDIA_LOAD_PHASE.COMPLETE);
    } catch (error) {
      console.error('加载示例视频失败:', error);
      toast.error(t('messages.asr.loadSampleFailed'));
    } finally {
      setIsSampleLoading(false);
      setSampleLoadProgress(null);
    }
  }, [isSampleLoading, onFileSelected, t, stores]);

  // Tauri 环境下通过原生文件选择器选择本地文件，拿到本地路径
  const handleTauriFileSelect = useCallback(async () => {
    const isTauri = '__TAURI_INTERNALS__' in window;
    if (!isTauri) return false;

    setIsFileLoading(true);
    setFileLoadProgress(MEDIA_LOAD_PHASE.START);

    try {
      const { invoke, convertFileSrc } = await import('@tauri-apps/api/core');
      const filePath = await invoke<string | null>('pick_media_file');
      if (!filePath) return true; // 用户取消

      setFileLoadProgress(MEDIA_LOAD_PHASE.METADATA);
      const fileName = filePath.split(/[/\\]/).pop() || 'video';
      const ext = fileName.split('.').pop()?.toLowerCase() || '';
      const mimeMap: Record<string, string> = {
        mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
        avi: 'video/x-msvideo', mkv: 'video/x-matroska', ogg: 'video/ogg',
        mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
        flac: 'audio/flac', aac: 'audio/aac',
      };
      const selectedVideoFile: VideoFile = {
        file: new File([], fileName, { type: mimeMap[ext] || '' }),
        url: convertFileSrc(filePath),
        duration: 0,
        size: 0,
        type: mimeMap[ext] || '',
        name: fileName,
        path: filePath,
      };

      setFileLoadProgress(MEDIA_LOAD_PHASE.FINALIZING);
      handleFileSelect(selectedVideoFile);
      setFileLoadProgress(MEDIA_LOAD_PHASE.COMPLETE);
      return true;
    } catch (err) {
      console.error('Tauri 文件选择失败:', err);
      return false;
    } finally {
      setIsFileLoading(false);
      setFileLoadProgress(null);
    }
  }, [handleFileSelect]);

  const handleNativeFileSelect = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    // Tauri 环境由按钮直接调用原生对话框，此处仅处理浏览器 <input> 选择
    const isTauri = '__TAURI_INTERNALS__' in window;
    if (isTauri) {
      event.target.value = '';
      return;
    }

    const file = event.target.files?.[0];
    if (!file) return;

    setIsFileLoading(true);
    setFileLoadProgress(MEDIA_LOAD_PHASE.START);

    try {
      const objectUrl = URL.createObjectURL(file);
      setFileLoadProgress(MEDIA_LOAD_PHASE.METADATA);

      let duration = 0;
      if (file.type.startsWith('video/') || file.type.startsWith('audio/')) {
        duration = await new Promise<number>((resolve) => {
          const probe = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio');
          probe.preload = 'metadata';
          probe.onloadedmetadata = () => resolve(Number.isFinite(probe.duration) ? probe.duration : 0);
          probe.onerror = () => resolve(0);
          probe.src = objectUrl;
        });
      }

      setFileLoadProgress(MEDIA_LOAD_PHASE.FINALIZING);
      const selectedVideoFile: VideoFile = {
        file,
        url: objectUrl,
        duration,
        size: file.size,
        type: file.type,
        name: file.name,
      };

      handleFileSelect(selectedVideoFile);
      setFileLoadProgress(MEDIA_LOAD_PHASE.COMPLETE);
    } finally {
      setIsFileLoading(false);
      setFileLoadProgress(null);
      event.target.value = '';
    }
  }, [handleFileSelect]);

  // 点击上传按钮：Tauri 环境用原生对话框（直接拿文件路径），浏览器环境用 <input>
  const handleUploadClick = useCallback(() => {
    const isTauri = '__TAURI_INTERNALS__' in window;
    if (isTauri) {
      handleTauriFileSelect();
    } else {
      uploadInputRef.current?.click();
    }
  }, [handleTauriFileSelect]);

  const handleUrlLoad = useCallback(async () => {
    const url = urlInput.trim();
    if (!url || isUrlLoading) return;

    setIsUrlLoading(true);
    setUrlLoadProgress(MEDIA_LOAD_PHASE.START);
    try {
      const selectedVideoFile = await loadMediaFromUrl(url, (loaded, total) => {
        setUrlLoadProgress(calcDownloadProgress(loaded, total));
      });
      setUrlLoadProgress(MEDIA_LOAD_PHASE.FINALIZING);
      handleFileSelect(selectedVideoFile);
      setUrlLoadProgress(MEDIA_LOAD_PHASE.COMPLETE);
      setUrlInput('');
    } catch (error) {
      console.error('URL 加载失败:', error);
      const errorMessage = t('messages.fileUpload.urlLoadFailed');
      setError(errorMessage);
      toast.error(errorMessage);
    } finally {
      setIsUrlLoading(false);
      setUrlLoadProgress(null);
    }
  }, [urlInput, isUrlLoading, handleFileSelect, setError, t]);

  return { uploadInputRef, urlInput, setUrlInput, isUrlLoading, urlLoadProgress, isFileLoading, fileLoadProgress, isSampleLoading, sampleLoadProgress, isMediaLoading, handleLoadSampleVideo, handleNativeFileSelect, handleUploadClick, handleUrlLoad };
}

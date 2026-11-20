import { isTauriRuntime } from '@/utils/runtime';
import { saveFile } from '@/utils/createFileWriter';

export interface WebExportFileHandle {
  readonly name: string;
  createWritable(): Promise<FileSystemWritableFileStream>;
}

export interface VideoExportSaveTarget {
  /** Tauri 环境下的绝对输出路径 */
  outputPath?: string;
  /** Web File System Access API 文件句柄 */
  fileHandle?: WebExportFileHandle;
  filename: string;
}

function buildDefaultFilename(format: 'mp4' | 'webm' | 'mkv', sourceName?: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -1);
  if (sourceName) {
    const base = sourceName.replace(/\.[^.]+$/, '');
    return `${base}_cut_${timestamp}.${format}`;
  }
  return `cut_video_${timestamp}.${format}`;
}

const videoSaveTypes = (format: 'mp4' | 'webm' | 'mkv') => [{
  description: 'Video files',
  accept: {
    [format === 'mp4' ? 'video/mp4' : format === 'webm' ? 'video/webm' : 'video/x-matroska']: [`.${format}`],
  },
}];

/** 导出前让用户选择保存位置（Web 文件选择器 / Tauri 原生对话框） */
export async function pickVideoExportSaveTarget(
  format: 'mp4' | 'webm' | 'mkv',
  sourceName?: string,
): Promise<VideoExportSaveTarget | null> {
  const filename = buildDefaultFilename(format, sourceName);

  if (isTauriRuntime()) {
    const { invoke } = await import('@tauri-apps/api/core');
    const path = await invoke<string | null>('pick_save_media_file', { defaultName: filename });
    if (!path) return null;
    const savedName = path.split(/[/\\]/).pop() || filename;
    return { outputPath: path, filename: savedName };
  }

  if ('showSaveFilePicker' in window && window.showSaveFilePicker) {
    try {
      const fileHandle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: videoSaveTypes(format),
      }) as WebExportFileHandle;
      return { fileHandle, filename: fileHandle.name };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return null;
      }
      throw error;
    }
  }

  return { filename };
}

/** 将处理完成的视频写入用户事先选定的位置 */
export async function writeProcessedVideo(
  blob: Blob,
  target: VideoExportSaveTarget,
): Promise<string> {
  if (target.outputPath) {
    return target.outputPath;
  }

  if (target.fileHandle) {
    const writable = await target.fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    return target.filename;
  }

  const ext = target.filename.split('.').pop()?.toLowerCase();
  const format = ext === 'webm' ? 'webm' : 'mp4';
  await saveFile(blob, target.filename, videoSaveTypes(format));
  return target.filename;
}
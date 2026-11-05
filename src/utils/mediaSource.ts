// 读取当前媒体的字节。媒体有三种来源：浏览器里选的文件（`file` 有内容）、
// 桌面端原生选择器给的本地路径（`path`，`file` 是空占位）、存在 Host 项目里的媒体（`remotePath`，F-0002）。
import type { VideoFile } from '@/types/video';
import { isTauriRuntime } from '@/utils/runtime';

/** 媒体是否只有占位 `File`，字节要从别处读。 */
export const isPlaceholderMedia = (videoFile: VideoFile) => !videoFile.file.size && (!!videoFile.remotePath || !!videoFile.path);

export async function loadMediaBlob(videoFile: VideoFile): Promise<Blob> {
  if (videoFile.file.size || !isPlaceholderMedia(videoFile)) return videoFile.file;
  let url = videoFile.url;
  if (!videoFile.remotePath && videoFile.path && isTauriRuntime()) {
    const { convertFileSrc } = await import('@tauri-apps/api/core');
    url = convertFileSrc(videoFile.path);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(videoFile.remotePath ? '无法读取项目媒体' : '无法读取本地媒体');
  return response.blob();
}

export async function loadMediaBuffer(videoFile: VideoFile): Promise<ArrayBuffer> {
  return (await loadMediaBlob(videoFile)).arrayBuffer();
}

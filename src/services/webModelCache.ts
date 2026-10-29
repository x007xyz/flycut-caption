// 浏览器端 Web ASR 模型下载状态（对齐 Host models.status）
// transformers.js 将模型文件缓存在 Cache API 的 transformers-cache 中。

import { WEB_ASR_MODELS, getWebAsrModel, type WebAsrModel } from '../../shared/asr/webModels';

export const WEB_MODELS_DOWNLOADED_EVENT = 'flycut:web-models-downloaded';

const STORAGE_KEY = 'flycut-downloaded-web-models';

function readStoredIds(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function writeStoredIds(ids: string[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...new Set(ids)]));
}

function addStoredId(webModelId: string) {
  const ids = readStoredIds();
  if (!ids.includes(webModelId)) {
    writeStoredIds([...ids, webModelId]);
  }
}

/** 标记模型已下载并通知各面板刷新 */
export function markWebModelDownloaded(webModelId: string) {
  addStoredId(webModelId);
  window.dispatchEvent(new CustomEvent(WEB_MODELS_DOWNLOADED_EVENT));
}

/** 探测 transformers.js 浏览器缓存中是否存在该模型的文件 */
export async function probeWebModelInCache(meta: WebAsrModel): Promise<boolean> {
  if (typeof caches === 'undefined') return false;
  try {
    const cache = await caches.open('transformers-cache');
    const keys = await cache.keys();
    return keys.some((req) => req.url.includes(meta.modelId));
  } catch {
    return false;
  }
}

/** 检查指定 Web 模型是否已下载到浏览器缓存 */
export async function isWebModelDownloaded(webModelId: string): Promise<boolean> {
  const meta = getWebAsrModel(webModelId);
  if (!meta) return false;

  const inCache = await probeWebModelInCache(meta);
  if (inCache) {
    addStoredId(webModelId);
    return true;
  }

  if (readStoredIds().includes(webModelId)) {
    writeStoredIds(readStoredIds().filter((id) => id !== webModelId));
  }
  return false;
}

/** 返回所有已下载的 Web 模型短 id 列表 */
export async function checkAllWebModelsDownloaded(): Promise<string[]> {
  const results = await Promise.all(
    WEB_ASR_MODELS.map(async (m) => ((await isWebModelDownloaded(m.id)) ? m.id : null)),
  );
  return results.filter((id): id is string => id !== null);
}
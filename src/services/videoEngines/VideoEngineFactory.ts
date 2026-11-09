// 视频处理引擎注册表：每个前端 Cordis Context 一份（`ctx.videoEngines`），由插件注册引擎

import type { IVideoProcessingEngine, VideoEngineType } from '@/types/videoEngine';

interface EngineEntry { create: () => IVideoProcessingEngine }

export class VideoEngineRegistry {
  private engines = new Map<VideoEngineType, EngineEntry>();

  /** 注册引擎；返回注销函数，供插件在 `ctx.effect` 中使用。 */
  register(type: VideoEngineType, create: () => IVideoProcessingEngine) {
    if (this.engines.has(type)) throw new Error(`Duplicate video engine: ${type}`);
    const entry = { create };
    this.engines.set(type, entry);
    return () => { if (this.engines.get(type) === entry) this.engines.delete(type); };
  }

  /** 创建并检查指定引擎 */
  async createEngine(type: VideoEngineType): Promise<IVideoProcessingEngine> {
    const entry = this.engines.get(type);
    if (!entry) throw new Error(`不支持的视频处理引擎类型: ${type}`);
    const engine = entry.create();
    const capabilities = await engine.checkCapabilities();
    if (!capabilities.supported) throw new Error(`引擎 ${type} 不可用: ${capabilities.reason}`);
    return engine;
  }

}

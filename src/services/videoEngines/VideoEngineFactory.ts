// 视频处理引擎注册表：每个前端 Cordis Context 一份（`ctx.videoEngines`），由插件注册引擎

import type { IVideoProcessingEngine, VideoEngineType, EngineCapabilities } from '@/types/videoEngine';

interface EngineEntry { create: () => IVideoProcessingEngine; priority: number }

const unsupported = (reason: string): EngineCapabilities => ({
  supported: false, reason, formats: [],
  features: { trimming: false, concatenation: false, audioProcessing: false, subtitleBurning: false, qualityControl: false },
});

export class VideoEngineRegistry {
  private engines = new Map<VideoEngineType, EngineEntry>();

  /** 注册引擎；priority 越小越优先。返回注销函数，供插件在 `ctx.effect` 中使用。 */
  register(type: VideoEngineType, create: () => IVideoProcessingEngine, priority = 100) {
    if (this.engines.has(type)) throw new Error(`Duplicate video engine: ${type}`);
    const entry = { create, priority };
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

  /** 按注册优先级排列的引擎顺序 */
  getDefaultEngineOrder(): VideoEngineType[] {
    return [...this.engines.entries()].sort((a, b) => a[1].priority - b[1].priority).map(([type]) => type);
  }

  async getBestAvailableEngine(preferredOrder?: VideoEngineType[]): Promise<{ engine: IVideoProcessingEngine; type: VideoEngineType }> {
    for (const type of preferredOrder ?? this.getDefaultEngineOrder()) {
      try {
        const engine = await this.createEngine(type);
        console.log(`选择视频处理引擎: ${type}`);
        return { engine, type };
      } catch (error) {
        console.warn(`引擎 ${type} 不可用:`, error);
      }
    }
    throw new Error('没有可用的视频处理引擎');
  }

  async checkAllEngines(): Promise<Record<VideoEngineType, EngineCapabilities>> {
    const results = {} as Record<VideoEngineType, EngineCapabilities>;
    for (const [type, entry] of this.engines) {
      try { results[type] = await entry.create().checkCapabilities(); }
      catch (error) { results[type] = unsupported(error instanceof Error ? error.message : '未知错误'); }
    }
    return results;
  }

  getSupportedEngines(): VideoEngineType[] { return [...this.engines.keys()]; }
}

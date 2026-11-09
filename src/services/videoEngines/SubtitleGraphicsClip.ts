import type { IClip } from '@webav/av-cliper';
import {
  drawFrame,
  layoutScene,
  subtitleBand,
  type SubtitleGraphicScene,
} from '../../../shared/subtitle-graphics';

type ClipMeta = { width: number; height: number; duration: number };

/** WebAV fallback: draw the shared graphics layer into a band-sized bitmap per cue. */
export class SubtitleGraphicsClip implements IClip {
  readonly ready: Promise<ClipMeta>;
  readonly meta: ClipMeta;
  readonly band: { x: number; y: number; width: number; height: number };
  private readonly scene: SubtitleGraphicScene;
  private readonly canvas: OffscreenCanvas | HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private readonly layouts: ReturnType<typeof layoutScene>;
  private readonly durationUs: number;

  constructor(scene: SubtitleGraphicScene) {
    this.scene = scene;
    const measure = document.createElement('canvas').getContext('2d');
    if (!measure) throw new Error('字幕渲染不可用：浏览器无法创建 Canvas 2D 上下文');
    this.layouts = layoutScene(measure, scene);
    this.band = subtitleBand(scene, this.layouts);
    this.canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(this.band.width, this.band.height)
      : Object.assign(document.createElement('canvas'), { width: this.band.width, height: this.band.height });
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('字幕渲染不可用：浏览器无法创建字幕画布');
    this.context = context as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
    this.durationUs = Math.round(scene.duration * 1e6);
    this.meta = { width: this.band.width, height: this.band.height, duration: this.durationUs };
    this.ready = Promise.resolve(this.meta);
  }

  async tick(timeUs: number): Promise<{ video: ImageBitmap; state: 'success' | 'done' }> {
    drawFrame(this.context as CanvasRenderingContext2D, this.scene, timeUs / 1e6, {
      layer: this.band,
      layouts: this.layouts,
    });
    return { video: await createImageBitmap(this.canvas), state: 'success' };
  }

  async clone(): Promise<this> {
    return new SubtitleGraphicsClip(this.scene) as this;
  }

  async split(): Promise<[this, this]> {
    return [await this.clone(), await this.clone()];
  }

  destroy(): void {
    // OffscreenCanvas / ImageBitmap are released by the browser after the sprite is destroyed.
  }
}

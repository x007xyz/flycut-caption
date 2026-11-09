import {
  drawFrame,
  layoutScene,
  subtitleBand,
  type SubtitleGraphicScene,
} from '../../../shared/subtitle-graphics';

export interface SubtitleOverlayFfmpeg {
  writeFile(name: string, data: Uint8Array): Promise<void>;
  exec(args: string[]): Promise<void>;
  deleteFile(name: string): Promise<void>;
  readFile(name: string): Promise<Uint8Array>;
}

export interface SubtitleOverlayVideo {
  file: string;
  y: number;
  fps: number;
}

async function canvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('字幕渲染不可用：无法生成字幕图片');
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * ffmpeg.wasm fallback: render one transparent band PNG per cue, build a concat
 * timeline, then encode a VP9 layer with alpha for the main overlay.
 */
export async function createSubtitleOverlayVideo(
  ffmpeg: SubtitleOverlayFfmpeg,
  scene: SubtitleGraphicScene,
): Promise<SubtitleOverlayVideo> {
  const measure = document.createElement('canvas').getContext('2d');
  if (!measure) throw new Error('字幕渲染不可用：浏览器无法创建 Canvas 2D 上下文');
  const layouts = layoutScene(measure, scene);
  const band = subtitleBand(scene, layouts);
  const gapCanvas = document.createElement('canvas');
  gapCanvas.width = band.width; gapCanvas.height = band.height;
  const gapName = 'subtitle-gap.png';
  const gapBytes = await canvasPng(gapCanvas);
  await ffmpeg.writeFile(gapName, gapBytes);

  const files: string[] = [];
  const timeline: string[] = ['ffconcat version 1.0'];
  let current = 0;
  const add = (file: string, duration: number) => {
    if (duration <= 1e-4) return;
    timeline.push(`file '${file}'`, `duration ${duration.toFixed(6)}`);
  };
  const cues = [...scene.cues].sort((a, b) => a.start - b.start);
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    const start = Math.max(current, cue.start);
    const end = Math.min(scene.duration, cue.end);
    if (end <= start) continue;
    if (start > current + 1e-4) {
      add(gapName, start - current);
      current = start;
    }
    const canvas = document.createElement('canvas');
    canvas.width = band.width; canvas.height = band.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('字幕渲染不可用：无法创建字幕画布');
    drawFrame(ctx, scene, (start + end) / 2, { layer: band, layouts });
    const name = `subtitle-cue-${String(index).padStart(5, '0')}.png`;
    await ffmpeg.writeFile(name, await canvasPng(canvas));
    files.push(name);
    add(name, end - start);
    current = end;
  }
  if (current < scene.duration - 1e-4) add(gapName, scene.duration - current);
  // concat demuxer ignores the last duration unless another file follows it.
  timeline.push(`file '${gapName}'`);
  await ffmpeg.writeFile('subtitle.ffconcat', new TextEncoder().encode(`${timeline.join('\n')}\n`));

  const fps = Math.max(1, Math.round(scene.fps));
  try {
    await ffmpeg.exec([
      '-y', '-f', 'concat', '-safe', '0', '-i', 'subtitle.ffconcat',
      '-vf', `fps=${fps},format=rgba`,
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '32',
      'subtitle-overlay.webm',
    ]);
    const encoded = await ffmpeg.readFile('subtitle-overlay.webm');
    if (!encoded.length) throw new Error('empty overlay');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`字幕渲染不可用：ffmpeg.wasm 无法编码透明字幕层（VP9 alpha）：${reason}`);
  } finally {
    await Promise.all([...files, gapName, 'subtitle.ffconcat'].map((name) => ffmpeg.deleteFile(name).catch(() => undefined)));
  }
  return { file: 'subtitle-overlay.webm', y: band.y, fps };
}

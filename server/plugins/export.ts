import { exportSegments, validateEdl, outputDuration, ffmpegVideoFilter } from '../../shared/editing/edl';
import type { Context } from '@deepseek-ai/cordis';
import { spawn } from 'node:child_process';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { exportInputSchema, type ExportInput, type ExportResult } from '../../shared/protocol';
import { createSubtitleBandRenderer, type SubtitleBandRenderer } from '../subtitle-render';
import type { SubtitleGraphicScene } from '../../shared/subtitle-graphics';

const qualityCrf = { high: '18', medium: '23', low: '28' } as const;

function probeVideo(info: string): { width?: number; height?: number; fps?: number } {
  const size = /Video:.*?,\s*(\d{2,5})x(\d{2,5})[\s,]/.exec(info);
  const fps = /(\d+(?:\.\d+)?)\s*fps/.exec(info);
  return { width: size ? Number(size[1]) : undefined, height: size ? Number(size[2]) : undefined,
    fps: fps ? Number(fps[1]) : undefined };
}

function normalizeScene(scene: SubtitleGraphicScene, probe: ReturnType<typeof probeVideo>, duration: number): SubtitleGraphicScene {
  if (probe.width && probe.height && (scene.width !== probe.width || scene.height !== probe.height)) {
    throw new Error(`字幕场景尺寸 ${scene.width}x${scene.height} 与视频 ${probe.width}x${probe.height} 不一致`);
  }
  return { ...scene, fps: probe.fps ?? scene.fps, duration };
}

async function writeFrames(
  stdin: NodeJS.WritableStream,
  renderer: SubtitleBandRenderer,
  fps: number,
  frames: number,
  signal: AbortSignal,
  report: (progress: { status: 'progress'; purpose: 'transcribe'; progress: number; data: string }) => void,
): Promise<void> {
  let lastPercent = -1;
  for (let frame = 0; frame < frames; frame += 1) {
    if (signal.aborted) break;
    const { buffer } = renderer.render(frame / fps);
    if (!stdin.write(buffer)) {
      await new Promise<void>((resolve, reject) => {
        const done = () => { stdin.off('drain', done); stdin.off('error', fail); resolve(); };
        const fail = (error: Error) => { stdin.off('drain', done); stdin.off('error', fail); reject(error); };
        stdin.once('drain', done); stdin.once('error', fail);
      });
    }
    const percent = 5 + Math.round(85 * (frame + 1) / frames);
    if (percent !== lastPercent && (frame % Math.max(1, Math.round(fps)) === 0 || frame === frames - 1)) {
      lastPercent = percent;
      report({ status: 'progress', purpose: 'transcribe', progress: percent, data: '正在渲染字幕' });
    }
  }
  stdin.end();
}

/** Host-owned FFmpeg export capability. The UI submits an immutable edit plan; this plugin owns execution and cancellation. */
export const exportPlugin = { name: 'flycut-export', inject: ['hostConfig', 'jobs', 'assets', 'rpc'], apply(ctx: Context) {
  const exportRoot = join(ctx.hostConfig.home, 'exports');
  const bundledFfmpeg = join(ctx.hostConfig.resourceRoot, 'binaries', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

  async function run(input: ExportInput, signal: AbortSignal, report: (progress: { status: 'progress'; purpose: 'transcribe'; progress: number; data: string }) => void): Promise<ExportResult> {
    await mkdir(exportRoot, { recursive: true });
    const source = ctx.assets.path(input.assetId);
    const id = randomUUID();
    const extension = input.options.format;
    const output = join(exportRoot, `${id}.${extension}`);
    const tempFiles: string[] = [];
    let kept = input.segments.filter(segment => segment.keep && segment.end > segment.start);
    if (input.edl) {
      const edl = validateEdl(input.edl);
      const derived = exportSegments(edl);
      if (JSON.stringify(kept.map(s => [s.start, s.end])) !== JSON.stringify(derived.map(s => [s.start, s.end])))
        throw new Error('The supplied segments disagree with the EDL');
      kept = derived;
    }
    if (!kept.length) throw new Error('没有选择要保留的视频片段');

    const args = ['-y', '-i', source];
    const ffmpeg = process.env.FFMPEG_PATH || await access(bundledFfmpeg).then(() => bundledFfmpeg).catch(() => 'ffmpeg');
    // Probe through the bundled FFmpeg; ffprobe is not assumed to be installed.
    const info = await new Promise<string>((resolve, reject) => {
      const child = spawn(ffmpeg, ['-hide_banner', '-i', source, '-t', '0', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = ''; const abort = () => child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      signal.addEventListener('abort', abort, { once: true });
      child.stderr.on('data', data => { if (stderr.length < 65536) stderr += String(data); });
      child.on('error', reject); child.on('close', () => {
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        if (signal.aborted) reject(new Error('Export cancelled')); else resolve(stderr);
      });
    });
    const durationMatch = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(info);
    const sourceDuration = durationMatch ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]) : undefined;
    if (input.edl && (!sourceDuration || Math.abs(sourceDuration - input.edl.sourceDurationUs / 1e6) > 0.05))
      throw new Error('The EDL duration does not match the source media');
    const probe = probeVideo(info);
    const withAudio = input.options.preserveAudio && /Stream.*Audio:/.test(info);
    // Preserve the old request semantics. Every versioned plan is explicitly trimmed, including a tail-only cut.
    const hasCuts = !!input.edl || kept.length !== 1 || kept[0].start > 0.001;
    const outputSeconds = input.edl ? outputDuration(input.edl) : kept.reduce((total, segment) => total + segment.end - segment.start, 0);
    const joinFadeMs = input.options.joinFadeMs ?? 0;
    const audioPart = (segment: { start: number; end: number }, index: number) => {
      const duration = segment.end - segment.start;
      const fade = joinFadeMs > 0 ? Math.min(joinFadeMs / 1000, duration / 2) : 0;
      const fades = [
        ...(fade > 0 && index > 0 ? [`afade=t=in:st=0:d=${fade}`] : []),
        ...(fade > 0 && index < kept.length - 1 ? [`afade=t=out:st=${Math.max(0, duration - fade)}:d=${fade}`] : []),
      ];
      return `[0:a:0]atrim=start=${segment.start}:end=${segment.end},asetpts=PTS-STARTPTS${fades.length ? ',' + fades.join(',') : ''}[a${index}]`;
    };

    let renderer: SubtitleBandRenderer | undefined;
    let subtitleScene: SubtitleGraphicScene | undefined;
    if (input.options.subtitleProcessing === 'hard' && input.options.subtitleScene) {
      subtitleScene = normalizeScene(input.options.subtitleScene, probe, outputSeconds);
      renderer = await createSubtitleBandRenderer(subtitleScene, ctx.hostConfig.resourceRoot);
      args.push('-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${renderer.band.width}x${renderer.band.height}`,
        '-r', String(subtitleScene.fps), '-i', 'pipe:0');
    } else if (input.options.subtitleProcessing === 'hard') {
      throw new Error('字幕渲染不可用：导出请求没有字幕场景');
    }

    const filterParts: string[] = [];
    let videoLabel = '0:v:0';
    let audioLabel = '0:a:0?';
    if (hasCuts) {
      if (input.edl) {
        // Map source frame timestamps onto the complete output clock. Resetting each trimmed video
        // independently rounds every join to a frame and accumulates drift on silent videos.
        filterParts.push(ffmpegVideoFilter(input.edl));
        videoLabel = '[vout]';
        if (withAudio) {
          const audioParts = kept.map(audioPart).join(';');
          const concatInputs = kept.map((_, index) => `[a${index}]`).join('');
          filterParts.push(audioParts, `${concatInputs}concat=n=${kept.length}:v=0:a=1[aout]`);
          audioLabel = '[aout]';
        }
        args.push('-t', String(outputSeconds), '-fps_mode', 'cfr');
      } else {
        const videoParts = kept.map((segment, index) => `[0:v:0]trim=start=${segment.start}:end=${segment.end},setpts=PTS-STARTPTS[v${index}]`).join(';');
        const audioParts = withAudio ? kept.map(audioPart).join(';') : '';
        const concatInputs = withAudio ? kept.flatMap((_, index) => `[v${index}][a${index}]`).join('') : kept.map((_, index) => `[v${index}]`).join('');
        filterParts.push(videoParts);
        if (withAudio) filterParts.push(audioParts);
        filterParts.push(withAudio
          ? `${concatInputs}concat=n=${kept.length}:v=1:a=1[vout][aout]`
          : `${concatInputs}concat=n=${kept.length}:v=1:a=0[vout]`);
        videoLabel = '[vout]';
        if (withAudio) audioLabel = '[aout]';
      }
    } else if (renderer && subtitleScene) {
      filterParts.push(`[0:v:0]fps=${subtitleScene.fps},setpts=PTS-STARTPTS[vout]`);
      videoLabel = '[vout]';
    }

    if (renderer) {
      const band = renderer.band;
      filterParts.push('[1:v]format=rgba[sub]', `${videoLabel}[sub]overlay=x=0:y=${band.y}:format=yuv420:eof_action=pass[vsub]`);
      videoLabel = '[vsub]';
    }

    if (filterParts.length > 0) args.push('-filter_complex', filterParts.join(';'));
    if (input.options.subtitleProcessing === 'soft' && input.options.subtitleTextContent) {
      const subtitlePath = join(exportRoot, `${id}.vtt`); await writeFile(subtitlePath, input.options.subtitleTextContent); tempFiles.push(subtitlePath);
      args.push('-i', subtitlePath, '-map', videoLabel);
      if (withAudio) args.push('-map', audioLabel);
      args.push('-map', '1:0', '-c:s', extension === 'webm' ? 'webvtt' : 'mov_text');
    } else {
      args.push('-map', videoLabel);
      if (withAudio) args.push('-map', audioLabel);
    }
    if (extension === 'webm') args.push('-c:v', 'libvpx-vp9', '-crf', qualityCrf[input.options.quality], '-b:v', '0', '-c:a', 'libopus');
    else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', qualityCrf[input.options.quality], '-c:a', withAudio ? 'aac' : 'none');
    args.push('-progress', 'pipe:2', output);
    report({ status: 'progress', purpose: 'transcribe', progress: 5, data: 'FFmpeg 导出已开始' });
    let assetId: string;
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(ffmpeg, args, { stdio: [renderer ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
        let stderrTail = '';
        let pumpError: unknown;
        const fps = subtitleScene?.fps ?? 30;
        const frames = renderer ? Math.max(1, Math.ceil(outputSeconds * fps)) : 0;
        const pump = renderer && child.stdin
          ? writeFrames(child.stdin, renderer, fps, frames, signal, report)
            .catch(error => { pumpError = error; child.kill('SIGTERM'); })
          : Promise.resolve();
        const abort = () => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 1500).unref(); reject(new Error('导出已取消')); };
        signal.addEventListener('abort', abort, { once: true });
        child.stderr?.on('data', data => {
          const text = String(data);
          stderrTail = (stderrTail + text).slice(-4096);
        });
        child.once('error', error => { signal.removeEventListener('abort', abort); reject(new Error(`无法启动 FFmpeg: ${error.message}`)); });
        child.once('exit', code => {
          signal.removeEventListener('abort', abort);
          void pump.then(() => {
            if (signal.aborted) { reject(new Error('导出已取消')); return; }
            if (pumpError) { reject(pumpError instanceof Error ? pumpError : new Error(String(pumpError))); return; }
            if (code === 0) resolve();
            else reject(new Error(`FFmpeg 导出失败（退出码 ${code ?? 'unknown'}）${stderrTail ? `：${stderrTail.slice(-600)}` : ''}`));
          });
        });
      });
      assetId = await ctx.assets.adopt(output);
    } finally {
      // Failed or cancelled exports leave neither partial output nor subtitle temp files behind.
      await Promise.all([...tempFiles, output].map(file => rm(file, { force: true })));
    }
    report({ status: 'progress', purpose: 'transcribe', progress: 100, data: '导出完成' });
    return { assetId, filename: `cut_video_${id}.${extension}`, mimeType: extension === 'webm' ? 'video/webm' : 'video/mp4' };
  }
  const service = { start(input: ExportInput) { return ctx.jobs.create((signal, report) => run(input, signal, progress => report(progress)),
    { operationId: input.operationId }); } };
  ctx.provide('export', service);
  ctx.effect(() => ctx.rpc.register('export.start', exportInputSchema, input => service.start(input)));
  ctx.effect(() => ctx.rpc.capability('export'));
} };

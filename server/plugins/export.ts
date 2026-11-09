import { exportSegments, validateEdl, outputDuration, ffmpegVideoFilter } from '../../shared/editing/edl';
import type { Context } from '@deepseek-ai/cordis';
import { spawn } from 'node:child_process';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { exportInputSchema, type ExportInput, type ExportResult } from '../../shared/protocol';

const qualityCrf = { high: '18', medium: '23', low: '28' } as const;

function escapeFilterPath(path: string) {
  return path.replaceAll('\\', '/').replaceAll(':', '\\:').replaceAll("'", "\\'");
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
    const withAudio = input.options.preserveAudio && /Stream.*Audio:/.test(info);
    // Preserve the old request semantics. Every versioned plan is explicitly trimmed, including a tail-only cut.
    const hasCuts = !!input.edl || kept.length !== 1 || kept[0].start > 0.001;
    let videoMap = '0:v:0';
    let audioMap = '0:a:0?';
    if (hasCuts) {
      const videoParts = kept.map((segment, index) => `[0:v:0]trim=start=${segment.start}:end=${segment.end},setpts=PTS-STARTPTS[v${index}]`).join(';');
      const audioParts = withAudio ? kept.map((segment, index) => `[0:a:0]atrim=start=${segment.start}:end=${segment.end},asetpts=PTS-STARTPTS[a${index}]`).join(';') : '';
      const concatInputs = withAudio
        ? kept.flatMap((_, index) => `[v${index}][a${index}]`).join('')
        : kept.map((_, index) => `[v${index}]`).join('');
      let filter: string;
      if (input.edl) {
        // Map source frame timestamps onto the complete output clock. Resetting each trimmed video
        // independently rounds every join to a frame and accumulates drift on silent videos.
        filter = ffmpegVideoFilter(input.edl);
        if (withAudio) filter += `;${audioParts};${kept.map((_, i) => `[a${i}]`).join('')}concat=n=${kept.length}:v=0:a=1[aout]`;
        args.push('-t', String(outputDuration(input.edl)), '-fps_mode', 'cfr');
      } else {
        filter = withAudio
          ? `${videoParts};${audioParts};${concatInputs}concat=n=${kept.length}:v=1:a=1[vout][aout]`
          : `${videoParts};${concatInputs}concat=n=${kept.length}:v=1:a=0[vout]`;
      }
      if (input.options.subtitleProcessing === 'hard' && input.options.assContent) {
        const assPath = join(exportRoot, `${id}.ass`); await writeFile(assPath, input.options.assContent); tempFiles.push(assPath);
        filter += `;[vout]subtitles='${escapeFilterPath(assPath)}'[vsub]`; videoMap = '[vsub]';
      } else videoMap = '[vout]';
      audioMap = '[aout]'; args.push('-filter_complex', filter);
    } else if (input.options.subtitleProcessing === 'hard' && input.options.assContent) {
      const assPath = join(exportRoot, `${id}.ass`); await writeFile(assPath, input.options.assContent); tempFiles.push(assPath);
      args.push('-vf', `subtitles='${escapeFilterPath(assPath)}'`);
    }
    if (input.options.subtitleProcessing === 'soft' && input.options.subtitleTextContent) {
      const subtitlePath = join(exportRoot, `${id}.vtt`); await writeFile(subtitlePath, input.options.subtitleTextContent); tempFiles.push(subtitlePath);
      args.push('-i', subtitlePath, '-map', videoMap);
      if (withAudio) args.push('-map', audioMap);
      args.push('-map', '1:0', '-c:s', extension === 'webm' ? 'webvtt' : 'mov_text');
    } else {
      args.push('-map', videoMap);
      if (withAudio) args.push('-map', audioMap);
    }
    if (extension === 'webm') args.push('-c:v', 'libvpx-vp9', '-crf', qualityCrf[input.options.quality], '-b:v', '0', '-c:a', 'libopus');
    else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', qualityCrf[input.options.quality], '-c:a', withAudio ? 'aac' : 'none');
    args.push('-progress', 'pipe:2', output);
    report({ status: 'progress', purpose: 'transcribe', progress: 5, data: 'FFmpeg 导出已开始' });
    let assetId: string;
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let last = 5;
        const abort = () => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 1500).unref(); reject(new Error('导出已取消')); };
        signal.addEventListener('abort', abort, { once: true });
        child.stderr.on('data', data => { const text = String(data); if (text.includes('out_time=')) { last = Math.min(95, last + 2); report({ status: 'progress', purpose: 'transcribe', progress: last, data: '正在编码视频' }); } });
        child.once('error', error => { signal.removeEventListener('abort', abort); reject(new Error(`无法启动 FFmpeg: ${error.message}`)); });
        child.once('exit', code => { signal.removeEventListener('abort', abort); if (code === 0) resolve(); else reject(new Error(`FFmpeg 导出失败（退出码 ${code ?? 'unknown'}）`)); });
      });
      assetId = await ctx.assets.adopt(output);
    } finally {
      // Failed or cancelled exports leave neither partial output nor subtitle temp files behind.
      await Promise.all([...tempFiles, output].map(file => rm(file, { force: true })));
    }
    report({ status: 'progress', purpose: 'transcribe', progress: 100, data: '导出完成' });
    return { assetId, filename: `cut_video_${id}.${extension}`, mimeType: extension === 'webm' ? 'video/webm' : 'video/mp4' };
  }
  const service = { start(input: ExportInput) { return ctx.jobs.create((signal, report) => run(input, signal, progress => report(progress))); } };
  ctx.provide('export', service);
  ctx.effect(() => ctx.rpc.register('export.start', exportInputSchema, input => service.start(input)));
  ctx.effect(() => ctx.rpc.capability('export'));
} };

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
    const kept = input.segments.filter(segment => segment.keep && segment.end > segment.start);
    if (!kept.length) throw new Error('没有选择要保留的视频片段');

    const args = ['-y', '-i', source];
    const ffmpeg = process.env.FFMPEG_PATH || await access(bundledFfmpeg).then(() => bundledFfmpeg).catch(() => 'ffmpeg');
    const hasCuts = kept.length !== 1 || kept[0].start > 0.001;
    let videoMap = '0:v:0';
    let audioMap = '0:a:0?';
    if (hasCuts) {
      const videoParts = kept.map((segment, index) => `[0:v:0]trim=start=${segment.start}:end=${segment.end},setpts=PTS-STARTPTS[v${index}]`).join(';');
      const audioParts = kept.map((segment, index) => `[0:a:0]atrim=start=${segment.start}:end=${segment.end},asetpts=PTS-STARTPTS[a${index}]`).join(';');
      const concatInputs = input.options.preserveAudio
        ? kept.flatMap((_, index) => `[v${index}][a${index}]`).join('')
        : kept.map((_, index) => `[v${index}]`).join('');
      let filter = input.options.preserveAudio
        ? `${videoParts};${audioParts};${concatInputs}concat=n=${kept.length}:v=1:a=1[vout][aout]`
        : `${videoParts};${concatInputs}concat=n=${kept.length}:v=1:a=0[vout]`;
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
      if (input.options.preserveAudio) args.push('-map', audioMap);
      args.push('-map', '1:0', '-c:s', extension === 'webm' ? 'webvtt' : 'mov_text');
    } else {
      args.push('-map', videoMap);
      if (input.options.preserveAudio) args.push('-map', audioMap);
    }
    if (extension === 'webm') args.push('-c:v', 'libvpx-vp9', '-crf', qualityCrf[input.options.quality], '-b:v', '0', '-c:a', 'libopus');
    else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', qualityCrf[input.options.quality], '-c:a', input.options.preserveAudio ? 'aac' : 'none');
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

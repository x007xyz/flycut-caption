import type { Context } from '@deepseek-ai/cordis';
import { execFile } from 'node:child_process';
import { access, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { TtsAudioFormat } from '../../shared/providers';
import type { Provider, TtsSynthesizeProviderInput, TtsProviderAudio } from '../services';

const execFileAsync = promisify(execFile);
const BASE = process.env.FLYCUT_302_BASE_URL ?? 'https://api.302.ai';

async function readApiKey(): Promise<string | undefined> {
  if (process.env.FLYCUT_302_API_KEY) return process.env.FLYCUT_302_API_KEY;
  if (process.platform !== 'darwin') return undefined;
  try {
    const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', 'flycut-302ai', '-w'], { timeout: 5000 });
    return stdout.trim() || undefined;
  } catch { return undefined; }
}

const formatOf = (contentType: string | null, url: string): TtsAudioFormat => {
  if (contentType?.includes('wav')) return 'wav';
  if (contentType?.includes('ogg')) return 'ogg';
  if (/\.wav($|\?)/i.test(url)) return 'wav';
  if (/\.ogg($|\?)/i.test(url)) return 'ogg';
  return 'mp3';
};

/** 302.ai IndexTTS-2.5: upload the reference sample, create a task and poll for the generated audio. */
export const indexTts302Plugin = { name: 'flycut-index-tts-302', inject: ['providers', 'hostConfig'], apply(ctx: Context) {
  const ffmpegPath = async () => {
    const bundled = join(ctx.hostConfig.resourceRoot, 'binaries', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    const dev = join(ctx.hostConfig.resourceRoot, 'src-tauri', 'binaries', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    for (const candidate of [process.env.FFMPEG_PATH, bundled, dev]) {
      if (candidate && await access(candidate).then(() => true).catch(() => false)) return candidate;
    }
    return 'ffmpeg';
  };
  const provider: Provider = {
    id: 'index-tts-302', name: '302.ai IndexTTS', kind: 'builtin',
    async models() {
      const key = await readApiKey();
      return [{
        id: 'index-tts-2.5', name: 'IndexTTS 2.5（302.ai）', role: 'tts',
        description: '上传参考音频进行声音克隆；需要 302.ai API Key',
        languages: ['zh', 'en'], status: key ? 'ready' : 'unavailable',
        ...(key ? {} : { reason: '缺少 302.ai API Key：设置 FLYCUT_302_API_KEY 或写入钥匙串 flycut-302ai' }),
        tts: { voices: [{ id: 'clone', name: '克隆音色' }], voiceCloning: true, durationControl: false, outputFormats: ['mp3', 'wav'] },
      }];
    },
    async synthesize(request: TtsSynthesizeProviderInput, signal: AbortSignal, report): Promise<TtsProviderAudio> {
      const key = await readApiKey();
      if (!key) throw new Error('缺少 302.ai API Key');
      if (!request.referenceAudioPath) throw new Error('IndexTTS 声音克隆需要参考音频样本');
      signal.throwIfAborted();
      report({ status: 'running', purpose: 'synthesize', progress: 5, data: '上传参考音频…' });
      const prepared = join(tmpdir(), `flycut-index-tts-${randomUUID()}.wav`);
      try {
        await execFileAsync(await ffmpegPath(), ['-v', 'error', '-y', '-i', request.referenceAudioPath, '-t', '15', '-ar', '16000', '-ac', '1', prepared], { timeout: 60000 });
      } catch (error) {
        await rm(prepared, { force: true }).catch(() => undefined);
        throw new Error(`参考音频转换失败：${error instanceof Error ? error.message : String(error)}`);
      }
      const sample = await readFile(prepared);
      await rm(prepared, { force: true }).catch(() => undefined);
      const form = new FormData();
      form.append('file', new Blob([sample], { type: 'audio/wav' }), 'reference.wav');
      const upload = await fetch(`${BASE}/302/upload-file`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal });
      if (!upload.ok) throw new Error(`302 参考音频上传失败（HTTP ${upload.status}）`);
      const uploadJson = await upload.json() as { code?: number; data?: string; message?: string };
      if (uploadJson.code !== 200 || !uploadJson.data) throw new Error(`302 参考音频上传失败：${uploadJson.message ?? 'unknown'}`);
      signal.throwIfAborted();
      report({ status: 'running', purpose: 'synthesize', progress: 20, data: '创建 IndexTTS 任务…' });
      const create = await fetch(`${BASE}/302/index_tts2/task`, { method: 'POST', signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: request.text.slice(0, 2048), speaker_audio_url: uploadJson.data, version: '2.0' }) });
      if (!create.ok) throw new Error(`302 IndexTTS 创建任务失败（HTTP ${create.status}）`);
      const task = await create.json() as { task_id?: string };
      if (!task.task_id) throw new Error('302 IndexTTS 未返回 task_id');
      for (let attempt = 0; attempt < 120; attempt += 1) {
        signal.throwIfAborted();
        const response = await fetch(`${BASE}/302/index_tts2/task?task_id=${encodeURIComponent(task.task_id)}`, { headers: { Authorization: `Bearer ${key}` }, signal });
        if (!response.ok) throw new Error(`302 IndexTTS 查询失败（HTTP ${response.status}）`);
        const status = await response.json() as { state?: string; audio_url?: string; duration?: number; sample_rate?: number; error?: { message?: string } };
        if (status.state === 'SUCCESS' && status.audio_url) {
          report({ status: 'running', purpose: 'synthesize', progress: 80, data: '下载生成音频…' });
          const audio = await fetch(status.audio_url, { signal });
          if (!audio.ok) throw new Error(`302 音频下载失败（HTTP ${audio.status}）`);
          const bytes = Buffer.from(await audio.arrayBuffer());
          const contentType = audio.headers.get('content-type');
          return { bytes, mimeType: contentType ?? undefined, format: formatOf(contentType, status.audio_url),
            ...(typeof status.duration === 'number' ? { durationSeconds: status.duration } : {}),
            ...(typeof status.sample_rate === 'number' ? { sampleRate: status.sample_rate } : {}) };
        }
        if (status.state === 'FAILURE') throw new Error(`302 IndexTTS 失败：${status.error?.message ?? 'unknown'}`);
        report({ status: 'running', purpose: 'synthesize', progress: Math.min(75, 25 + attempt), data: 'IndexTTS 合成中…' });
        await new Promise(done => setTimeout(done, 2000));
      }
      throw new Error('302 IndexTTS 超时，请稍后在 302 控制台检查任务');
    },
  };
  ctx.effect(() => ctx.providers.register(provider));
} };

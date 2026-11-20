import type { Context } from '@deepseek-ai/cordis';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as ort from 'onnxruntime-node';
import { reframeAnalyzeInputSchema } from '../../shared/reframe/reframe';
import { decodeYunet } from '../../shared/reframe/yunet';
import { selectPrimaryFaces, smoothCropPath, type FrameFaces } from '../../shared/reframe/tracking';

const SIZE = 640; const FRAME_BYTES = SIZE * SIZE * 3;
const toTensor = (frame: Buffer) => {
  const plane = SIZE * SIZE; const data = new Float32Array(plane * 3);
  for (let i = 0; i < plane; i += 1) {
    data[i] = frame[i * 3]; data[plane + i] = frame[i * 3 + 1]; data[plane * 2 + i] = frame[i * 3 + 2];
  }
  return new ort.Tensor('float32', data, [1, 3, SIZE, SIZE]);
};

export const reframePlugin = { name: 'flycut-reframe', inject: ['hostConfig', 'rpc', 'jobs', 'projectStore'], apply(ctx: Context) {
  const store = ctx.projectStore;
  const modelPath = process.env.FLYCUT_REFRAME_MODEL ?? join(homedir(), '.cache/flycut-reframe/models/face_detection_yunet_2023mar.onnx');
  const resolveFfmpeg = async () => {
    const bundled = join(ctx.hostConfig.resourceRoot, 'binaries', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    const dev = join(ctx.hostConfig.resourceRoot, 'src-tauri', 'binaries', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    for (const candidate of [process.env.FFMPEG_PATH, bundled, dev]) {
      if (candidate && await access(candidate).then(() => true).catch(() => false)) return candidate;
    }
    return 'ffmpeg';
  };

  ctx.effect(() => ctx.rpc.register('reframe.analyze', reframeAnalyzeInputSchema, input =>
    ctx.jobs.create(async (signal, report) => {
      if (!await access(modelPath).then(() => true).catch(() => false)) throw new Error(`缺少 YuNet 模型：${modelPath}`);
      const project = await store.read(input.projectId).catch(() => undefined);
      if (!project || project.deletedAt) throw new Error('项目不存在或已删除');
      const video = project.videos.find(item => item.id === input.videoId);
      if (!video) throw new Error('视频不存在');
      const edits = await store.readEdits(input.projectId, input.videoId);
      if (!edits) throw new Error('字幕轨道不存在');
      const media = video.media.kind === 'stored' ? store.mediaFile(input.projectId, video.media.file) : video.media.path;
      const fps = input.fps ?? 2;
      const session = await ort.InferenceSession.create(modelPath);
      const child = spawn(await resolveFfmpeg(), ['-v', 'error', '-i', media, '-vf', `fps=${fps},scale=${SIZE}:${SIZE}`, '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-']);
      let buffer = Buffer.alloc(0); let index = 0; const frames: FrameFaces[] = [];
      try {
        for await (const chunk of child.stdout) {
          signal.throwIfAborted();
          buffer = Buffer.concat([buffer, chunk as Buffer]);
          while (buffer.length >= FRAME_BYTES) {
            const frame = buffer.subarray(0, FRAME_BYTES); buffer = buffer.subarray(FRAME_BYTES);
            const result = await session.run({ input: toTensor(frame) });
            const outputs: Record<string, Float32Array> = {};
            for (const name of session.outputNames) outputs[name] = result[name].data as Float32Array;
            const faces = decodeYunet(outputs, { scoreThreshold: 0.5 });
            frames.push({ time: index / fps, faces });
            index += 1;
            if (index % 10 === 0) report({ status: 'running', progress: Math.min(90, Math.round(index / Math.max(1, video.durationSeconds * fps) * 90)), data: `分析主体 ${index} 帧` });
          }
        }
        if (child.exitCode && child.exitCode !== 0) throw new Error(`抽帧失败（exit ${child.exitCode}）`);
        const samples = smoothCropPath(selectPrimaryFaces(frames));
        if (!samples.length) throw new Error('没有检测到可用于跟随的主体');
        const now = new Date().toISOString();
        const record = { model: 'yunet-2023mar', fps, samples, sourceFingerprint: JSON.stringify([video.media, video.durationSeconds]), createdAt: now };
        await store.exclusive(input.projectId, async () => {
          const current = await store.read(input.projectId);
          const currentVideo = current.videos.find(item => item.id === input.videoId)!;
          const currentEdits = await store.readEdits(input.projectId, input.videoId) ?? edits;
          await store.writeEdits(input.projectId, input.videoId, { ...currentEdits, reframe: record });
          currentVideo.revision += 1; currentVideo.updatedAt = now;
          current.revision += 1; current.updatedAt = now;
          await store.writeProject(current);
        });
        report({ status: 'complete', progress: 100, data: `主体跟随路径 ${samples.length} 点` });
        return record;
      } finally { child.kill(); }
    })));
} };

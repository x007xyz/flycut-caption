import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createHost } from '../../server/app';
import type { JobSnapshot } from '../../shared/protocol';

const sample = process.env.FLYCUT_INDEX_TTS_SAMPLE ?? join(process.env.HOME ?? '', 'Downloads/音色.m4a');
if (!existsSync(sample)) { console.log('SKIP F-0038 real IndexTTS: sample missing'); process.exit(0); }
const home = await mkdtemp(join(tmpdir(), 'flycut-f0038-real-'));
const token = randomUUID();
const ctx = await createHost({ home, appData: home, bind: '127.0.0.1', port: 0, token, resourceRoot: resolve('.') }, { profile: 'desktop' });
const base = `http://127.0.0.1:${(ctx.httpServer.address() as { port: number }).port}`;
const call = async <T>(method: string, payload: unknown = {}): Promise<T> => {
  const response = await fetch(`${base}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }) });
  const envelope = await response.json() as { result: { ok: boolean; value: T; error?: { message: string } } };
  if (!envelope.result.ok) throw new Error(`${method}: ${envelope.result.error?.message}`);
  return envelope.result.value;
};
try {
  const models = await call<Array<{ provider: { id: string }; models: Array<{ id: string; status: string; reason?: string }> }>>('providers.models');
  const model = models.flatMap(group => group.models.map(item => ({ providerId: group.provider.id, ...item })))
    .find(item => item.providerId === 'index-tts-302');
  if (!model || model.status !== 'ready') throw new Error(`IndexTTS model not ready: ${model?.reason ?? 'missing'}`);
  const upload = await fetch(`${base}/assets`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'audio/mp4' },
    body: new Uint8Array(await readFile(sample)) });
  const assetId = ((await upload.json()) as { assetId: string }).assetId;
  const job = await call<JobSnapshot>('tts.synthesize', { request: { providerId: 'index-tts-302', modelId: 'index-tts-2.5',
    text: '你好，这是 FlyCut 的声音克隆测试。', language: 'zh', cloneReferenceAssetId: assetId,
    cloneAuthorization: { confirmed: true, statement: '本人授权 FlyCut 使用该参考音频进行声音克隆测试', confirmedAt: new Date().toISOString(),
      sourceLabel: '本机参考样本' } } });
  let result: { assetId: string; durationSeconds?: number; cloned: boolean } | undefined;
  for (let i = 0; i < 240; i += 1) {
    const current = await call<JobSnapshot>('jobs.get', { id: job.id });
    if (current.status === 'complete') { result = current.result as typeof result; break; }
    if (current.status === 'error' || current.status === 'cancelled') throw new Error(`${current.status}: ${current.error}`);
    if (i % 10 === 0) console.log('waiting', current.progress?.data ?? current.status);
    await new Promise(done => setTimeout(done, 2000));
  }
  if (!result) throw new Error('IndexTTS timed out');
  const audio = await fetch(`${base}/assets/${result.assetId}`, { headers: { Authorization: `Bearer ${token}` } });
  const bytes = Buffer.from(await audio.arrayBuffer());
  console.log(`cloned=${result.cloned} duration=${result.durationSeconds ?? '?'} bytes=${bytes.length} magic=${bytes.subarray(0, 4).toString('hex')}`);
  console.log('F-0038 real IndexTTS acceptance passed');
} finally {
  await ctx.fiber.dispose();
  await rm(home, { recursive: true, force: true });
}

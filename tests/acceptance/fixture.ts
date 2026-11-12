import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { ProjectOpenResult } from '../../shared/projects';

export const title = 'F-0058 字幕验收项目';
export const initial = '这是原字幕';
export const changed = '这条字幕已保存';
export const duration = 3;
export const width = 640;
export const height = 360;

export function media(path: string) {
  execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=30:d=${duration}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${duration}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path], { stdio: 'pipe' });
}

export type Connection = { url: string; token: string };

export function host(connection: Connection) {
  const url = new URL(connection.url);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
  const auth = { Authorization: `Bearer ${connection.token}` };
  async function request(path: string, init: RequestInit) {
    const response = await fetch(new URL(path, url), {
      ...init, headers: { ...auth, ...init.headers }, signal: AbortSignal.timeout(5000),
    });
    assert.ok(response.ok, `${path}: HTTP ${response.status}`);
    return response;
  }
  async function call<T>(method: string, payload: unknown = {}): Promise<T> {
    const response = await request('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }) });
    const { result } = await response.json();
    assert.equal(result.ok, true, `${method}: ${result.error?.message ?? 'RPC failed'}`);
    return result.value;
  }
  async function upload(source: string): Promise<string> {
    const response = await request('/assets', { method: 'POST', headers: { 'Content-Type': 'video/mp4' },
      body: new Uint8Array(await readFile(source)) });
    return (await response.json()).assetId;
  }
  async function download(assetId: string): Promise<Buffer> {
    const response = await request(`/assets/${assetId}`, { method: 'GET' });
    return Buffer.from(await response.arrayBuffer());
  }
  async function seed(source: string) {
    const assetId = await upload(source);
    const ids = await call<{ projectId: string; videoId: string }>('projects.create', {
      name: title, videoName: 'fixture.mp4', durationSeconds: duration, media: { assetId, mimeType: 'video/mp4' },
    });
    await call('projects.saveTranscript', {
      ...ids, durationSeconds: duration,
      transcript: { text: initial, language: 'zh', duration, hasWordTimestamps: false,
        chunks: [{ id: 'fixture-cue', text: initial, timestamp: [0.25, 2] }] },
    });
    return ids;
  }
  async function saved(ids: Awaited<ReturnType<typeof seed>>) {
    const snapshot = await call<ProjectOpenResult>('projects.open', ids);
    return snapshot.status === 'ok' && snapshot.edits?.chunks.some(cue => cue.id === 'fixture-cue' && cue.text === changed);
  }
  return { call, upload, download, seed, saved };
}

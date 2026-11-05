// 下载 B 站视频作为本地测试素材（yt-dlp 会被 B 站风控拦截，这里直接用公开 API）。
// 未登录最高 480P；选 AVC 视频 + 最高码率音频，用 ffmpeg 无损合并为 mp4，并写一份 .info.json。
//
//   node scripts/fetch-bilibili.mjs <BV号> <输出.mp4>
//
// 素材版权归原作者，只放在已 gitignore 的 tests/media/ 下做本地测试，不要入库或再分发。
import { spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const [bvid, output] = process.argv.slice(2);
if (!/^BV\w{10}$/.test(bvid ?? '') || !output?.endsWith('.mp4')) {
  console.error('用法：node scripts/fetch-bilibili.mjs <BV号> <输出.mp4>');
  process.exit(1);
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const headers = { 'User-Agent': UA, Referer: `https://www.bilibili.com/video/${bvid}/` };

async function api(url) {
  const body = await (await fetch(url, { headers })).json();
  if (body.code !== 0) throw new Error(`${url}：${body.code} ${body.message}`);
  return body.data;
}

const view = await api(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
if (view.pages.length !== 1) throw new Error(`${bvid} 有 ${view.pages.length} 个分P，暂只支持单P`);
const { cid } = view.pages[0];
const play = await api(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16&fourk=0`);

// 同清晰度下优先 AVC，兼容性最好
const video = [...play.dash.video].sort((a, b) => b.id - a.id || Number(b.codecs.startsWith('avc')) - Number(a.codecs.startsWith('avc')))[0];
const audio = [...play.dash.audio].sort((a, b) => b.bandwidth - a.bandwidth)[0];
console.log(`${view.title}（${view.owner.name}，${view.duration} 秒）`);
console.log(`视频 ${video.width}x${video.height} ${video.codecs}，音频 ${audio.codecs} ${Math.round(audio.bandwidth / 1000)} kbps`);

const work = mkdtempSync(join(tmpdir(), 'fetch-bilibili-'));
try {
  for (const [name, stream] of [['video.m4s', video], ['audio.m4s', audio]]) {
    const response = await fetch(stream.baseUrl, { headers });
    if (!response.ok) throw new Error(`下载 ${name} 失败：HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(join(work, name)));
    console.log(`✓ ${name}`);
  }
  mkdirSync(dirname(output), { recursive: true });
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const merged = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', join(work, 'video.m4s'), '-i', join(work, 'audio.m4s'),
    '-c', 'copy', '-movflags', '+faststart', output], { stdio: 'inherit' });
  if (merged.status) throw new Error('ffmpeg 合并失败');
  writeFileSync(output.replace(/\.mp4$/, '.info.json'), JSON.stringify({
    bvid, title: view.title, owner: view.owner.name, duration: view.duration, pubdate: view.pubdate,
    source: `https://www.bilibili.com/video/${bvid}/`, video: `${video.width}x${video.height} ${video.codecs}`, audio: audio.codecs,
    fetchedAt: new Date().toISOString(),
  }, null, 2) + '\n');
  console.log(`✓ ${output}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

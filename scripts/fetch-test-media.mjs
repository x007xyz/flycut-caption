#!/usr/bin/env node
/**
 * 下载 tests/media.manifest.json 中列出的真实场景测试视频到 tests/media/，再按 clips 切出测试片段。
 * 来源均为 Wikimedia Commons，下载后生成 tests/media/SOURCES.md 记录出处与许可。
 * external 条目（如 X 视频）不自动下载，缺失时依赖它的片段会跳过。
 * 用法：node scripts/fetch-test-media.mjs [--force] [--only=<id>[,<id>]]
 */
import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MEDIA_DIR = join(ROOT, 'tests', 'media');
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const USER_AGENT = 'flycut-caption-test-media/0.1 (https://github.com/x007xyz/flycut-caption)';

const FFMPEG = process.env.FFMPEG_PATH
  ?? (existsSync(join(ROOT, 'src-tauri', 'binaries', 'ffmpeg')) ? join(ROOT, 'src-tauri', 'binaries', 'ffmpeg') : 'ffmpeg');

const force = process.argv.includes('--force');
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',')) : null;

const manifest = JSON.parse(readFileSync(join(ROOT, 'tests', 'media.manifest.json'), 'utf8'));
const items = manifest.items.filter((item) => !only || only.has(item.id));

/** 查询 Commons 文件信息：原始地址、大小、作者，以及可选的转码版本 */
async function resolve(item) {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    titles: item.title,
    prop: 'videoinfo',
    viprop: 'url|size|extmetadata|derivatives',
  });
  const res = await fetch(`${COMMONS_API}?${params}`, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Commons API ${res.status}`);
  const page = Object.values((await res.json()).query.pages)[0];
  const info = page.videoinfo?.[0];
  if (!info) throw new Error(`Commons 上找不到 ${item.title}`);

  let url = info.url;
  if (item.derivative) {
    const derived = info.derivatives?.find((d) => d.transcodekey?.startsWith(`${item.derivative}.`) && d.type?.startsWith('video/webm'));
    if (!derived) throw new Error(`没有 ${item.derivative} 转码版本`);
    url = derived.src;
  }
  const meta = info.extmetadata ?? {};
  const strip = (html) => (html ?? '').replace(/<[^>]+>/g, '').trim();
  return {
    url,
    page: info.descriptionurl,
    size: item.derivative ? null : info.size,
    duration: info.duration,
    license: strip(meta.LicenseShortName?.value),
    artist: strip(meta.Artist?.value),
  };
}

async function download(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok || !res.body) throw new Error(`下载失败 ${res.status} ${url}`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  renameSync(tmp, dest);
}

const sources = [];
let failed = 0;
for (const item of items) {
  const dest = join(MEDIA_DIR, item.dir, `${item.id}.webm`);
  mkdirSync(dirname(dest), { recursive: true });
  try {
    const info = await resolve(item);
    if (info.license !== item.license) {
      throw new Error(`许可与清单不一致：Commons=${info.license}，清单=${item.license}`);
    }
    if (!force && existsSync(dest) && statSync(dest).size > 0) {
      console.log(`[skip] ${item.id} 已存在`);
    } else {
      const sizeLabel = info.size ? `${(info.size / 1e6).toFixed(0)}MB` : '转码';
      console.log(`[get ] ${item.id} (${sizeLabel}) <- ${info.url}`);
      await download(info.url, dest);
    }
    sources.push({ item, info, file: join(item.dir, `${item.id}.webm`) });
  } catch (err) {
    failed += 1;
    console.error(`[fail] ${item.id}: ${err.message}`);
  }
}

const lines = [
  '# 测试视频来源',
  '',
  '由 `scripts/fetch-test-media.mjs` 生成，文件不入库。',
  '',
  '| 文件 | 语言 | 场景 | 时长 | 许可 | 作者 | 来源 |',
  '|---|---|---|---|---|---|---|',
  ...sources.map(({ item, info, file }) =>
    `| ${file} | ${item.lang} | ${item.scene} | ${(info.duration / 60).toFixed(1)} min | ${info.license} | ${info.artist || '-'} | ${info.page} |`),
  '',
];
writeFileSync(join(MEDIA_DIR, 'SOURCES.md'), lines.join('\n'));
console.log(`完成：${sources.length} 个可用，${failed} 个失败。来源记录见 tests/media/SOURCES.md`);

/** 从源文件切出测试片段：视频用流复制保留原始编码，参考音频转 24k 单声道 WAV */
function cutClip(clip) {
  const src = join(MEDIA_DIR, clip.source);
  const dest = join(MEDIA_DIR, clip.path);
  if (!existsSync(src)) return `缺少源文件 ${clip.source}`;
  if (!force && existsSync(dest) && statSync(dest).size > 0) return null;
  mkdirSync(dirname(dest), { recursive: true });
  const output = clip.kind === 'ref-wav'
    ? ['-vn', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le']
    : ['-c', 'copy', '-avoid_negative_ts', 'make_zero'];
  const res = spawnSync(FFMPEG, ['-nostdin', '-v', 'error', '-y', '-ss', String(clip.start), '-i', src, '-t', String(clip.duration), ...output, dest], { encoding: 'utf8' });
  return res.status === 0 ? null : `ffmpeg 失败：${res.stderr || res.error?.message}`;
}

if (!only) {
  for (const clip of manifest.clips ?? []) {
    const problem = cutClip(clip);
    if (problem) console.warn(`[clip] 跳过 ${clip.path}: ${problem}`);
  }
  console.log(`片段已就绪：tests/media/clips/（用途分组见 docs/test-media.md）`);
}
process.exitCode = failed ? 1 : 0;

#!/usr/bin/env node
/**
 * 下载 ASR family 集成测试所需的代表模型到 app data 目录。
 * 优先从 https://huggingface.co/ 按文件下载。
 * 用法：node scripts/download-test-models.mjs [--force] [--models <id>,<id>]
 *   --models：只下载 models.json 里指定的模型（例如 F-0001 评测要比较同一 family 的多个模型）
 */
import { spawnSync } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { representativeModelsByFamily, loadManifest } from '../tests/lib/asrPaths.mjs';

const APP_ID = 'com.flycut.caption';
const HF_ORIGIN = 'https://huggingface.co';
const force = process.argv.includes('--force');
const modelsArg = process.argv.indexOf('--models');
const onlyIds = modelsArg >= 0 ? process.argv[modelsArg + 1]?.split(',').map((s) => s.trim()).filter(Boolean) : null;

function appModelsDir() {
  const home = homedir();
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', APP_ID, 'models');
  }
  if (process.platform === 'win32' && process.env.APPDATA) {
    return join(process.env.APPDATA, 'FlyCut Caption', 'models');
  }
  const base = process.env.XDG_DATA_HOME ?? join(home, '.local', 'share');
  return join(base, APP_ID, 'models');
}

function modelReady(model, dir) {
  return model.files.every((f) => existsSync(join(dir, f.path)) && statSync(join(dir, f.path)).size > 0);
}

/** 将 hf-mirror / modelscope 等镜像 URL 转为 huggingface.co */
function toHuggingFaceBase(url) {
  if (!url) return null;
  if (url.startsWith(`${HF_ORIGIN}/`)) {
    return url.endsWith('/') ? url : `${url}/`;
  }
  if (url.includes('hf-mirror.com/')) {
    const path = url.replace(/^https?:\/\/hf-mirror\.com\//, '');
    return `${HF_ORIGIN}/${path}`.replace(/(?<!\/)$/, '/');
  }
  return null;
}

/** 为每个模型构造 HuggingFace 按文件下载源 */
function huggingFaceFileSources(model) {
  const bases = new Set();

  for (const source of model.download_sources ?? []) {
    const hf = toHuggingFaceBase(source.url);
    if (hf && (source.download_mode === 'files' || !source.url.endsWith('.tar.bz2'))) {
      bases.add(hf);
    }
  }

  // moonshine 等仅有 GitHub 归档的模型：用 artifact.extract_dir 推断 HF 仓库
  if (bases.size === 0 && model.artifact?.extract_dir) {
    bases.add(`${HF_ORIGIN}/csukuangfj/${model.artifact.extract_dir}/resolve/main/`);
  }

  return [...bases].map((url) => ({
    provider: 'huggingface',
    url,
    download_mode: 'files',
  }));
}

async function downloadUrl(url, dest, { resume = true } = {}) {
  const headers = { 'User-Agent': 'flycut-caption-test-downloader' };
  if (resume && existsSync(dest)) {
    const size = statSync(dest).size;
    if (size > 0) headers.Range = `bytes=${size}-`;
  }

  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok && res.status !== 206) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }

  const writeFlags = res.status === 206 ? 'a' : 'w';
  if (writeFlags === 'w' && existsSync(dest)) rmSync(dest, { force: true });

  await pipeline(res.body, createWriteStream(dest, { flags: writeFlags }));
}

async function downloadFilesFromBase(source, files, destDir) {
  const base = source.url.endsWith('/') ? source.url : `${source.url}/`;
  for (const file of files) {
    const dest = join(destDir, file.path);
    mkdirSync(destDir, { recursive: true });
    const url = `${base}${file.path}`;
    process.stdout.write(`  ${file.path} ... `);
    await downloadUrl(url, `${dest}.part`);
    renameSyncSafe(`${dest}.part`, dest);
    const mb = (statSync(dest).size / 1_000_000).toFixed(1);
    console.log(`ok (${mb} MB)`);
  }
}

function renameSyncSafe(from, to) {
  if (existsSync(to)) rmSync(to, { force: true });
  renameSync(from, to);
}

function extractTarBz2(archivePath, destDir, extractDir) {
  const tempDir = join(destDir, '.extract_tmp');
  rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(tempDir, { recursive: true });

  const tar = spawnSync('tar', ['-xjf', archivePath, '-C', tempDir], { encoding: 'utf8' });
  if (tar.status !== 0) {
    throw new Error(`tar extract failed: ${tar.stderr || tar.stdout}`);
  }

  const extractedRoot = join(tempDir, extractDir);
  const sourceDir = existsSync(extractedRoot) ? extractedRoot : tempDir;
  mkdirSync(destDir, { recursive: true });

  for (const entry of readdirSync(sourceDir)) {
    const from = join(sourceDir, entry);
    const to = join(destDir, entry);
    if (existsSync(to)) rmSync(to, { recursive: true, force: true });
    spawnSync('cp', ['-R', from, to], { stdio: 'inherit' });
  }

  rmSync(tempDir, { recursive: true, force: true });
}

async function downloadArchive(source, model, destDir) {
  const archivePath = join(destDir, `${model.id}.tar.bz2.part`);
  mkdirSync(destDir, { recursive: true });
  process.stdout.write(`  archive ${source.url} ... `);
  await downloadUrl(source.url, archivePath);
  console.log('ok');
  process.stdout.write('  extracting ... ');
  extractTarBz2(archivePath, destDir, model.artifact.extract_dir);
  rmSync(archivePath, { force: true });
  console.log('ok');
}

async function downloadModel(model) {
  const destDir = join(appModelsDir(), model.id);
  if (!force && modelReady(model, destDir)) {
    console.log(`[skip] ${model.id} already present`);
    return { id: model.id, status: 'skipped' };
  }

  console.log(`[download] ${model.id} (${model.family})`);
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });

  const hfSources = huggingFaceFileSources(model);
  for (const source of hfSources) {
    try {
      console.log(`  huggingface: ${source.url}`);
      await downloadFilesFromBase(source, model.files, destDir);
      if (modelReady(model, destDir)) {
        console.log(`[done] ${model.id} via huggingface.co`);
        return { id: model.id, status: 'ok', via: 'huggingface.co' };
      }
    } catch (err) {
      console.warn(`  huggingface failed: ${err.message}`);
      rmSync(destDir, { recursive: true, force: true });
      mkdirSync(destDir, { recursive: true });
    }
  }

  // 兜底：GitHub 归档（仍非 HF，仅当 HF 无仓库时）
  const archiveSources = (model.download_sources ?? []).filter((s) => s.url?.endsWith('.tar.bz2'));
  for (const source of archiveSources) {
    try {
      console.log(`  fallback archive: ${source.url}`);
      await downloadArchive(source, model, destDir);
      if (modelReady(model, destDir)) {
        console.log(`[done] ${model.id} via ${source.provider}`);
        return { id: model.id, status: 'ok', via: source.provider };
      }
    } catch (err) {
      console.warn(`  archive failed (${source.provider}): ${err.message}`);
      rmSync(destDir, { recursive: true, force: true });
      mkdirSync(destDir, { recursive: true });
    }
  }

  throw new Error(`All sources failed for ${model.id}`);
}

async function main() {
  const manifest = loadManifest();
  const chosen = onlyIds
    ? onlyIds.map((id) => {
      const model = manifest.models.find((m) => m.id === id);
      if (!model) throw new Error(`models.json 里没有 ${id}`);
      return { family: model.family, model };
    })
    : representativeModelsByFamily();
  const targets = chosen.sort((a, b) => {
    const sa = a.model.artifact?.size_mb_estimate ?? 9999;
    const sb = b.model.artifact?.size_mb_estimate ?? 9999;
    return sa - sb;
  });

  console.log(`Target models (${targets.length} families) -> ${appModelsDir()}`);
  console.log(`Source: ${HF_ORIGIN} (smallest first)\n`);

  const results = [];
  for (const { family, model } of targets) {
    try {
      const result = await downloadModel(model);
      results.push({ family, ...result });
    } catch (err) {
      console.error(`[fail] ${model.id}: ${err.message}`);
      results.push({ family, id: model.id, status: 'failed', error: err.message });
    }
  }

  console.log('\n=== Download summary ===');
  for (const r of results) {
    console.log(`${r.family.padEnd(16)} ${r.id.padEnd(48)} ${r.status}${r.via ? ` (${r.via})` : ''}${r.error ? ` — ${r.error}` : ''}`);
  }

  const failed = results.filter((r) => r.status === 'failed');
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
// 发版闸门：通过全部检查后才创建并推送 v<version> tag（推送 tag 会触发 release.yml）。
// 规则见 docs/code-standards.md 第 6 条。
//
// 用法：
//   pnpm release            检查并打 tag、推送
//   pnpm release --dry-run  只检查，不打 tag
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const dryRun = process.argv.includes('--dry-run');
const failures = [];

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

function check(name, fn) {
  try {
    const detail = fn();
    console.log(`✅ ${name}${detail ? `：${detail}` : ''}`);
  } catch (error) {
    // 子进程失败时优先显示它的 stderr，而不是整条命令行
    console.log(`❌ ${name}：${error.stderr?.trim() || error.message}`);
    failures.push(name);
  }
}

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const tag = `v${version}`;
const sha = run('git', ['rev-parse', 'HEAD']);
console.log(`发版 ${tag} @ ${sha.slice(0, 8)}${dryRun ? '（dry run）' : ''}\n`);

check('在 main 分支', () => {
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main') throw new Error(`当前分支是 ${branch}`);
});

check('工作区干净', () => {
  const status = run('git', ['status', '--porcelain']);
  if (status) throw new Error(`有 ${status.split('\n').length} 个未提交的改动`);
});

check('HEAD 已推送到 origin/main', () => {
  run('git', ['fetch', 'origin', 'main', '--quiet']);
  const remote = run('git', ['rev-parse', 'origin/main']);
  if (remote !== sha) throw new Error(`origin/main 是 ${remote.slice(0, 8)}`);
});

check(`tag ${tag} 尚不存在`, () => {
  if (run('git', ['tag', '--list', tag])) throw new Error('本地已有该 tag');
  if (run('git', ['ls-remote', '--tags', 'origin', tag])) throw new Error('远端已有该 tag');
});

// src/index.ts 的 version 由 vite.config.ts 从 package.json 注入，不需要单独检查
check('版本号一致', () => {
  const versions = {
    'src-tauri/tauri.conf.json': JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).version,
    'src-tauri/Cargo.toml': readFileSync('src-tauri/Cargo.toml', 'utf8').match(/^version\s*=\s*"([^"]+)"/m)?.[1],
  };
  const mismatched = Object.entries(versions).filter(([, v]) => v !== version);
  if (mismatched.length) throw new Error(mismatched.map(([file, v]) => `${file} 是 ${v ?? '未找到'}`).join('，') + `，package.json 是 ${version}`);
  return version;
});

// Cargo.toml 写坏只会在构建时暴露（见 LESSONS.md），这里提前解析一次
check('Cargo.toml 可解析', () => {
  run('cargo', ['metadata', '--no-deps', '--format-version', '1', '--manifest-path', 'src-tauri/Cargo.toml']);
});

check('该 commit 的 CI 已完成且全绿', () => {
  const runs = JSON.parse(run('gh', ['run', 'list', '--workflow', 'ci.yml', '--commit', sha,
    '--json', 'status,conclusion,url', '--limit', '20']));
  const passed = runs.find((r) => r.status === 'completed' && r.conclusion === 'success');
  if (passed) return passed.url;
  if (!runs.length) throw new Error('没有找到 ci.yml 的运行');
  // 被取消的运行不算通过
  throw new Error(runs.map((r) => `${r.status}/${r.conclusion || '-'}`).join('，'));
});

if (failures.length) {
  console.log(`\n${failures.length} 项检查未通过，不打 tag。`);
  process.exit(1);
}

if (dryRun) {
  console.log(`\n全部通过。去掉 --dry-run 即可创建并推送 ${tag}。`);
  process.exit(0);
}

run('git', ['tag', '-a', tag, '-m', tag]);
run('git', ['push', 'origin', tag], { stdio: 'inherit' });
console.log(`\n已推送 ${tag}，release.yml 开始打包。`);

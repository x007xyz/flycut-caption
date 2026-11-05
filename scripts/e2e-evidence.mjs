// 生成需求验收的界面证据：跑 tests/e2e/features/<F-编号>.spec.ts，截图和录屏写进需求目录。
//
//   pnpm e2e:evidence F-0002
//
// - 截图：测试里用 tests/e2e/lib/evidence.ts 的 shot()，写到 docs/features/<需求>/screenshots/
// - 录屏：每个测试一段 .webm，写到 docs/features/<需求>/recordings/（不进 git）
// - 结果摘要：docs/features/<需求>/recordings/summary.json，测试报告引用它
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const id = process.argv[2];
if (!/^F-\d{4}$/.test(id ?? '')) {
  console.error('用法：pnpm e2e:evidence F-0002');
  process.exit(1);
}
const dirName = readdirSync('docs/features').find((name) => name.startsWith(`${id}-`));
if (!dirName) {
  console.error(`找不到需求目录 docs/features/${id}-*`);
  process.exit(1);
}
const featureDir = join('docs/features', dirName);
const spec = `tests/e2e/features/${id}.spec.ts`;
if (!existsSync(spec)) {
  console.error(`没有 ${spec}。涉及界面的 AC 要先写端到端测试`);
  process.exit(1);
}

// 录屏要用 Playwright 自带的 ffmpeg（版本由 playwright-core 的 browsers.json 决定）；没装就只截图，并提示安装命令
function hasPlaywrightFfmpeg() {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve('playwright-core/package.json', { paths: [require.resolve('@playwright/test')] });
    const { browsers } = JSON.parse(readFileSync(join(dirname(pkg), 'browsers.json'), 'utf8'));
    const revision = browsers.find((b) => b.name === 'ffmpeg')?.revision;
    const cache = process.env.PLAYWRIGHT_BROWSERS_PATH
      ?? (platform() === 'darwin' ? join(homedir(), 'Library/Caches/ms-playwright')
        : platform() === 'win32' ? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
          : join(homedir(), '.cache/ms-playwright'));
    return Boolean(revision) && existsSync(join(cache, `ffmpeg-${revision}`, 'INSTALLATION_COMPLETE'));
  } catch {
    return false;
  }
}
const record = hasPlaywrightFfmpeg();
if (!record) console.warn('⚠ 没有找到 Playwright 的 ffmpeg，这次只截图不录屏。安装：pnpm exec playwright install ffmpeg');

const recordings = join(featureDir, 'recordings');
rmSync(recordings, { recursive: true, force: true });
mkdirSync(recordings, { recursive: true });
const reportFile = join('test-results', `${id}-evidence.json`);
mkdirSync('test-results', { recursive: true });

const run = spawnSync('pnpm', ['exec', 'playwright', 'test', spec, '--reporter=list,json'], {
  stdio: 'inherit',
  env: { ...process.env, UPDATE_SHOTS: '1', ...(record ? { PW_VIDEO: '1' } : {}), PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile },
});
if (!existsSync(reportFile)) {
  console.error('Playwright 没有生成结果文件，看上面的输出');
  process.exit(run.status ?? 1);
}

const report = JSON.parse(readFileSync(reportFile, 'utf8'));
const tests = [];
const walk = (suite, titles) => {
  for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
  for (const s of suite.specs ?? []) {
    for (const t of s.tests ?? []) {
      const result = t.results?.at(-1);
      const title = [...titles, s.title].filter(Boolean).join(' › ');
      const video = result?.attachments?.find((a) => a.name === 'video' && a.path);
      let recording = null;
      if (video && existsSync(video.path)) {
        const name = `${title.replace(/[^\p{L}\p{N}-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 120)}-${t.projectName || 'default'}.webm`;
        copyFileSync(video.path, join(recordings, name));
        recording = join('recordings', name);
      }
      tests.push({ title, project: t.projectName, status: result?.status ?? 'skipped', recording });
    }
  }
};
for (const suite of report.suites ?? []) walk(suite, [suite.title.endsWith('.spec.ts') ? '' : suite.title]);

const shotsDir = join(featureDir, 'screenshots');
const screenshots = existsSync(shotsDir) ? readdirSync(shotsDir).filter((f) => /\.(png|jpe?g)$/.test(f)).sort() : [];
const summary = {
  feature: id,
  commit: spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
  passed: tests.filter((t) => t.status === 'passed').length,
  failed: tests.filter((t) => !['passed', 'skipped'].includes(t.status)).length,
  tests,
  screenshots: screenshots.map((f) => join('screenshots', f)),
};
writeFileSync(join(recordings, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`\n${id}：${summary.passed} 通过，${summary.failed} 失败；截图 ${screenshots.length} 张，录屏 ${tests.filter((t) => t.recording).length} 段`);
console.log(`证据在 ${featureDir}/screenshots/ 和 ${featureDir}/recordings/`);
process.exit(run.status ?? 0);

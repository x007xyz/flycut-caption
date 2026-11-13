#!/usr/bin/env node
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { createHost } from '../server/app';
import { F0017_REAL_SOURCES, makeF0017RealTranscript, type F0017Transcript as Transcript } from '../tests/e2e/lib/longTranscript';

const root = resolve('.');
const token = 'f0017-bench-token';
const shellToken = 'f0017-bench-shell';
const port = 8797;
const runs = Number(process.env.F0017_RUNS ?? 5);
const outputDir = join(root, 'test-results/f0017-bench');
interface Measurement {
  elapsedMs: number;
  maxLongTaskMs: number;
  actionMaxLongTaskMs: number;
}

interface LongTaskSample { startTime: number; duration: number }

interface BenchWindow extends Window {
  __f0017LongTasks?: LongTaskSample[];
  __f0017MeasureStart?: number;
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
}

async function rpc<T>(method: string, payload: unknown = {}): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
  });
  const envelope = await response.json() as { result: { ok: boolean; value?: T; error?: { message: string } } };
  if (!envelope.result.ok) throw new Error(envelope.result.error?.message ?? `${method} failed`);
  return envelope.result.value as T;
}

async function linkMedia(path: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/shell/projects/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${shellToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!response.ok) throw new Error(`register media failed: ${response.status}`);
  return (await response.json() as { mediaRef: string }).mediaRef;
}

async function createProject(name: string, media: string, transcript: Transcript, durationSeconds: number,
  videoName = `${name}.mp4`) {
  const mediaRef = await linkMedia(media);
  const created = await rpc<{ projectId: string; videoId: string }>('projects.create', {
    name,
    videoName,
    durationSeconds,
    media: { mediaRef },
  });
  await rpc('projects.saveTranscript', { projectId: created.projectId, videoId: created.videoId, transcript, durationSeconds });
  return created;
}

async function addVideo(projectId: string, media: string, transcript: Transcript, durationSeconds: number) {
  const mediaRef = await linkMedia(media);
  const added = await rpc<{ videoId: string }>('projects.addVideo', {
    projectId,
    videoName: '短视频.mp4',
    durationSeconds,
    media: { mediaRef },
  });
  await rpc('projects.saveTranscript', { projectId, videoId: added.videoId, transcript, durationSeconds });
  return added.videoId;
}

async function waitForThumbnail(projectId: string, videoId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await rpc<{ dataUrl: string | null }>('projects.thumbnail', { projectId, videoId });
    if (result.dataUrl) return;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error('project cover was not generated within 10 seconds');
}

async function waitForFrontend(): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const response = await fetch('http://localhost:5173/');
      if (response.ok) return;
    } catch { /* Vite is still starting. */ }
    await new Promise(done => setTimeout(done, 500));
  }
  throw new Error('Vite did not start on 5173 within 120 seconds');
}

async function resetMeasurement(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as BenchWindow;
    state.__f0017LongTasks = [];
    state.__f0017MeasureStart = performance.now();
  });
}

async function finishMeasurement(page: Page, action: () => Promise<void>, settleMs = 1000,
  onlyAfterEditable = true): Promise<Measurement> {
  await action();
  const elapsedMs = await page.evaluate(() => performance.now() - (window as BenchWindow).__f0017MeasureStart!);
  await page.waitForTimeout(settleMs);
  const samples = await page.evaluate(() => (window as BenchWindow).__f0017LongTasks ?? []);
  const measureStart = await page.evaluate(() => (window as BenchWindow).__f0017MeasureStart!);
  const editableAt = measureStart + elapsedMs;
  // AC-1–3 allow loading work before the first row is editable, then cap tasks in the following
  // second. keep `actionMaxLongTaskMs` so the complete loading interval is still visible in the JSON.
  const relevant = onlyAfterEditable ? samples.filter(sample => sample.startTime >= editableAt + elapsedMs) : samples;
  const maxLongTaskMs = Math.max(0, ...relevant.map(sample => sample.duration));
  const actionMaxLongTaskMs = Math.max(0, ...samples.map(sample => sample.duration));
  return { elapsedMs: Math.round(elapsedMs), maxLongTaskMs: Math.round(maxLongTaskMs),
    actionMaxLongTaskMs: Math.round(actionMaxLongTaskMs) };
}

async function measureEditClick(page: Page, button: Locator, expected: string): Promise<number> {
  // Record inside Chrome: capture the actual input event and stop after the
  // expected DOM update, excluding Playwright polling and IPC overhead.
  const observation = await button.evaluateHandle((element, text) => ({ result: new Promise<number>((resolve, reject) => {
    const state = {
      started: undefined as number | undefined,
      normalize(value: string) { return value.replace(/\s+/g, ' ').trim(); },
      onClick() { state.started = performance.now(); },
      cleanup() {
        clearTimeout(timer);
        observer.disconnect();
        element.removeEventListener('click', state.onClick, true);
      },
    };
    const observer = new MutationObserver(() => {
      if (state.started === undefined) return;
      const matched = [...document.querySelectorAll('button, div.font-mono')].some(node =>
        state.normalize(node.textContent ?? '') === text);
      if (!matched) return;
      const elapsed = performance.now() - state.started;
      state.cleanup();
      resolve(elapsed);
    });
    const timer = setTimeout(() => {
      state.cleanup();
      reject(new Error(`F-0017/AC-6: click did not produce "${text}"`));
    }, 5000);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    element.addEventListener('click', state.onClick, { capture: true, once: true });
  }) }), expected);
  try {
    await button.click();
    return Math.round((await page.evaluate(async handle => await handle.result, observation)) * 10) / 10;
  } finally {
    await observation.dispose();
  }
}

async function measureEditActions(page: Page, total: number): Promise<Record<string, number>> {
  const action = (name: string) => page.getByRole('button', { name, exact: true });
  const row = page.locator('[data-virtual-row-index]');
  const stats = (active: number) => `总计: ${total} | 有效: ${active}`;
  const selectAll = await measureEditClick(page, action('全选'), `删除选中 (${total})`);
  const clearSelection = await measureEditClick(page, action('清除选择'), '删除选中 (0)');
  const singleDelete = await measureEditClick(page, row.first().getByTitle('删除片段'), stats(total - 1));
  await action('恢复 (1)').click();
  await expect(page.getByText(stats(total), { exact: true })).toBeVisible();
  await row.nth(0).getByRole('checkbox').check();
  await row.nth(1).getByRole('checkbox').check();
  const batchDelete = await measureEditClick(page, action('删除选中 (2)'), stats(total - 2));
  const restore = await measureEditClick(page, action('恢复 (2)'), stats(total));
  return { selectAll, clearSelection, singleDelete, batchDelete, restore };
}

async function waitForEditable(page: Page, includes?: string): Promise<void> {
  const first = page.getByTestId('subtitle-main-text').first();
  await expect(first).toBeVisible();
  if (includes) await expect(first).toHaveValue(new RegExp(includes));
  await first.focus();
  await page.keyboard.press('End');
  await page.keyboard.type('测');
  await expect(first).toHaveValue(/测/);
}

async function openProject(page: Page, name: string): Promise<Measurement> {
  await page.goto('/#/projects');
  const card = page.getByRole('button', { name: new RegExp(name) }).first();
  await expect(card).toBeVisible();
  await resetMeasurement(page);
  return finishMeasurement(page, async () => {
    await card.click();
    await waitForEditable(page);
  });
}

async function switchVideo(page: Page, name: string, expectedText: string): Promise<Measurement> {
  await resetMeasurement(page);
  await page.getByRole('button', { name: /切换视频/ }).click();
  return finishMeasurement(page, async () => {
    await page.getByRole('menuitem').filter({ hasText: name }).click();
    await waitForEditable(page, expectedText);
  });
}

async function main(): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'flycut-f0017-bench-'));
  const home = join(temp, 'host');
  const appData = join(temp, 'app-data');
  const longMedia = join(temp, 'coscup-60min.mp4');
  const shortMedia = join(temp, 'coscup-short.mp4');
  let vite: ChildProcess | undefined;
  let browser: Browser | undefined;
  await mkdir(home, { recursive: true });
  await mkdir(appData, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  const ffmpeg = process.env.FFMPEG_PATH ?? join(root, 'src-tauri/binaries/ffmpeg');
  try {
    for (const source of F0017_REAL_SOURCES) await access(join(root, `${source}.mp4`));
    const list = join(temp, 'concat.txt');
    await writeFile(list, F0017_REAL_SOURCES.map((source, index) => {
      const path = join(root, `${source}.mp4`).replaceAll("'", "'\\''");
      return `file '${path}'${index === F0017_REAL_SOURCES.length - 1 ? '' : '\n'}`;
    }).join(''));
    run(ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', longMedia]);
    run(ffmpeg, ['-y', '-v', 'error', '-ss', '0', '-t', '10', '-i', longMedia, '-c', 'copy', shortMedia]);

    const transcript = await makeF0017RealTranscript(root);
    const shortTranscript: Transcript = {
      text: '短视频第一句', chunks: [{ id: 'short-1', text: '短视频第一句', timestamp: [0, 4] }],
      hasWordTimestamps: false, language: 'zh', duration: 4,
    };
    process.env.FFMPEG_PATH = ffmpeg;
    const host = await createHost({
      home, appData, token, port, resourceRoot: root, shellToken, bind: '127.0.0.1', assetTtlHours: 1,
    }, { profile: 'desktop', providers: [] });
    try {
      const single = await createProject('六十分钟真实长项目', longMedia, transcript, transcript.duration);
      const mixed = await createProject('长短视频切换', longMedia, transcript, transcript.duration, '六十分钟.mp4');
      const shortVideoId = await addVideo(mixed.projectId, shortMedia, shortTranscript, 4);
      await writeFile(join(home, 'connection.json'), JSON.stringify({ url: `http://127.0.0.1:${port}`, token, pid: process.pid }), { mode: 0o600 });
      await Promise.all([
        waitForThumbnail(single.projectId, single.videoId),
        waitForThumbnail(mixed.projectId, mixed.videoId),
        waitForThumbnail(mixed.projectId, shortVideoId),
      ]);

      vite = spawn('pnpm', ['dev:web', '--port', '5173', '--strictPort'], {
        cwd: root, env: { ...process.env, FLYCUT_HOST_HOME: home }, stdio: ['ignore', 'ignore', 'inherit'],
      });
      await waitForFrontend();
      browser = await chromium.launch({ channel: 'chrome', headless: false });
      const context = await browser.newContext({ baseURL: 'http://localhost:5173', locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
      await context.addInitScript(() => {
        localStorage.setItem('theme-storage', JSON.stringify({ state: { theme: 'light', resolvedTheme: 'light' }, version: 0 }));
        const state = window as BenchWindow;
        state.__f0017LongTasks = [];
        new PerformanceObserver(list => {
          for (const entry of list.getEntries()) state.__f0017LongTasks!.push({ startTime: entry.startTime, duration: entry.duration });
        }).observe({ type: 'longtask', buffered: true });
      });
      const page = await context.newPage();

      if (process.env.F0017_EDIT_ONLY === '1') {
        await page.goto(`/#/projects/${single.projectId}/videos/${single.videoId}`);
        await expect(page.getByTestId('subtitle-main-text').first()).toBeEditable();
        const samples = [];
        for (let index = 0; index < runs; index += 1) {
          samples.push(await measureEditActions(page, transcript.chunks.length));
        }
        const result = { platform: process.platform, arch: process.arch, chrome: browser.version(),
          chunks: transcript.chunks.length, durationSeconds: transcript.duration, loadAverage: loadavg(), samples };
        await writeFile(join(outputDir, 'edit-actions.json'), `${JSON.stringify(result, null, 2)}\n`);
        console.log(JSON.stringify(result, null, 2));
        if (samples.some(sample => Object.values(sample).some(elapsed => elapsed > 300))) {
          throw new Error('F-0017/AC-6: an edit action exceeded 300 ms');
        }
        return;
      }

      const opens: Measurement[] = [];
      for (let index = 0; index < runs; index += 1) {
        opens.push(await openProject(page, '六十分钟真实长项目'));
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
        await page.getByRole('button', { name: '我的项目' }).click();
        await expect(page.getByRole('button', { name: /六十分钟真实长项目/ }).first()).toBeVisible();
      }

      await page.goto(`/#/projects/${mixed.projectId}/videos/${mixed.videoId}`);
      await waitForEditable(page, '嗨各位好。');
      const longSwitches: Measurement[] = [];
      const shortSwitches: Measurement[] = [];
      for (let index = 0; index < runs; index += 1) {
        shortSwitches.push(await switchVideo(page, '短视频.mp4', '短视频第一句'));
        longSwitches.push(await switchVideo(page, '六十分钟.mp4', '嗨各位好。'));
      }

      await resetMeasurement(page);
      const scroll = page.getByTestId('subtitle-virtual-scroll');
      const box = await scroll.boundingBox();
      if (!box) throw new Error('subtitle list is not visible');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let index = 0; index < 30; index += 1) {
        await page.mouse.wheel(0, 1200);
        await page.waitForTimeout(16);
      }
      const wheelTravel = await finishMeasurement(page, async () => undefined, 250, false);
      await resetMeasurement(page);
      const jump = await finishMeasurement(page, async () => {
        await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
        await expect(page.locator(`[data-chunk-id="${transcript.chunks.at(-1)!.id}"]`)).toBeVisible({ timeout: 5000 });
      }, 250, false);

      await resetMeasurement(page);
      const original = await finishMeasurement(page, async () => {
        await page.getByRole('button', { name: '原语言' }).click();
        await expect(page.getByRole('button', { name: /编辑/ })).toBeVisible();
        await expect(page.getByText(transcript.wordChunks?.[0]?.text ?? '', { exact: true }).first())
          .toBeVisible({ timeout: 20_000 });
      }, 250, false);

      const result = {
        measuredAt: new Date().toISOString(),
        environment: { platform: process.platform, arch: process.arch, cpuCount: cpus().length,
          loadAverage: loadavg(), port: 5173, chromeHeaded: true },
        data: { chunks: transcript.chunks.length, words: transcript.wordChunks?.length ?? 0, durationSeconds: transcript.duration },
        opens, longSwitches, shortSwitches, scroll: { wheel: wheelTravel, jumpToBottom: jump }, originalView: original,
      };
      await writeFile(join(outputDir, 'after.json'), `${JSON.stringify(result, null, 2)}\n`);
      const table = [
        `# F-0017 after benchmark (${new Date().toISOString()})`, '',
        `- 数据：${transcript.chunks.length} 句 / ${transcript.wordChunks?.length ?? 0} 字词 / ${transcript.duration.toFixed(3)} 秒`,
        `- 端口：5173；前台 Chrome；${process.platform}/${process.arch}`,
        '', '| 项目 | 次数 | 耗时 ms | 最大 long task ms |', '|---|---:|---|---:|',
        `| 打开长项目 | ${opens.length} | ${opens.map(item => item.elapsedMs).join(' / ')} | ${opens.map(item => item.maxLongTaskMs).join(' / ')} |`,
        `| 切到长视频 | ${longSwitches.length} | ${longSwitches.map(item => item.elapsedMs).join(' / ')} | ${longSwitches.map(item => item.maxLongTaskMs).join(' / ')} |`,
        `| 切回短视频 | ${shortSwitches.length} | ${shortSwitches.map(item => item.elapsedMs).join(' / ')} | ${shortSwitches.map(item => item.maxLongTaskMs).join(' / ')} |`,
        `| 连续滚轮 | 30 | ${wheelTravel.elapsedMs} | ${wheelTravel.maxLongTaskMs} |`,
        `| 拖到底部 | 1 | ${jump.elapsedMs} | ${jump.maxLongTaskMs} |`,
        `| 切到原语言 | 1 | ${original.elapsedMs} | ${original.maxLongTaskMs} |`, '',
      ].join('\n');
      await writeFile(join(outputDir, 'after.md'), table);
      process.stdout.write(table);

      const failures = [
        ...opens.filter(item => item.elapsedMs > 3000).map(item => `open ${item.elapsedMs}ms`),
        ...longSwitches.filter(item => item.elapsedMs > 3000).map(item => `long switch ${item.elapsedMs}ms`),
        ...shortSwitches.filter(item => item.elapsedMs > 1000).map(item => `short switch ${item.elapsedMs}ms`),
        ...[...opens, ...longSwitches, ...shortSwitches, wheelTravel, jump]
          .filter(item => item.maxLongTaskMs > 200).map(item => `long task ${item.maxLongTaskMs}ms`),
      ];
      if (failures.length) throw new Error(`F-0017 thresholds failed: ${failures.join(', ')}`);
    } finally {
      await host.fiber.dispose();
    }
  } finally {
    await browser?.close().catch(() => undefined);
    vite?.kill('SIGTERM');
    await rm(temp, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptySubtitleGraphicStyle, type SubtitleGraphicScene } from '../../shared/subtitle-graphics';
import { duration, height, media, width } from './fixture';
import { bundleInfo, launchApp, waitFor } from './mac-app';

const sourceBundle = process.argv[2];
assert.ok(sourceBundle, 'Usage: pnpm acceptance:bundle /absolute/path/to/FlyCut Caption.app');
assert.notEqual(bundleInfo(sourceBundle).identifier, 'com.flycut.caption.acceptance', 'Use a bundle without the driver');
const output = 'test-results/f0058-bundle';
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), 'flycut-f0058-smoke-'));

const style = { ...emptySubtitleGraphicStyle(), fontFamily: 'FlyCutNotoSansSC', fontSizeRatio: 0.1, bottomOffsetRatio: 0.08 };
const scene: SubtitleGraphicScene = {
  version: 1, width, height, fps: 30, duration,
  fontId: 'noto-sans-sc', fontFamily: 'FlyCutNotoSansSC', displayMode: 'Bilingual', maxWidthRatio: 0.9,
  primary: style, secondary: style, cues: [{ id: 'cue', start: 0.5, end: 2, text: '字幕验收' }],
};
type Job = { id: string; status: string; error?: string; result?: { assetId: string } };

try {
  const source = join(root, 'fixture.mp4');
  media(source);
  for (const scenario of ['normal', 'missing-node', 'missing-font'] as const) {
    const dir = join(root, scenario);
    await mkdir(dir);
    const bundle = join(dir, 'Candidate.app');
    execFileSync('/usr/bin/ditto', [sourceBundle, bundle]);
    const resources = join(bundle, 'Contents/Resources');
    const bundledNode = join(resources, 'binaries/flycut-node');
    const fonts = join(resources, 'shared_assets/subtitle-fonts');
    const ffmpeg = join(resources, 'binaries/ffmpeg');
    await Promise.all([access(bundledNode), access(fonts), access(ffmpeg), access(join(resources, 'host/lib/main.mjs'))]);
    if (scenario === 'missing-node') await rm(bundledNode);
    if (scenario === 'missing-font') await rm(fonts, { recursive: true });
    const logPath = join(output, `${scenario}.log`);
    const app = await launchApp(bundle, dir, logPath, scenario === 'normal' ? 4445 : undefined);
    try {
      if (scenario === 'missing-node') {
        await waitFor('missing bundled Node diagnostic', async () => {
          const log = await readFile(logPath, 'utf8');
          return log.includes('FlyCut Host startup failed: 随包 Node 不可用') ? true : undefined;
        });
        await assert.rejects(access(join(app.hostDir, 'connection.json')), { code: 'ENOENT' });
        console.log('PASS F-0058/AC-3: missing Node fails at startup');
        continue;
      }
      const api = await app.ready();
      const assetId = await api.upload(source);
      const job = await api.call<Job>('export.start', {
        assetId, segments: [{ start: 0, end: duration, keep: true }],
        options: { format: 'mp4', quality: 'low', preserveAudio: true, subtitleProcessing: 'hard',
          subtitleTransport: 'skia-band', subtitleScene: scene },
      });
      const state = await waitFor('hard subtitle export', async () => {
        const current = await api.call<Job>('jobs.get', { id: job.id });
        return ['complete', 'error', 'cancelled'].includes(current.status) ? current : undefined;
      }, 60_000);
      if (scenario === 'missing-font') {
        assert.equal(state.status, 'error');
        assert.match(state.error ?? '', /字幕渲染不可用/);
        console.log('PASS F-0058/AC-3: missing font fails during hard subtitle export');
        continue;
      }
      assert.equal(state.status, 'complete', state.error);
      assert.match(state.result?.assetId ?? '', /^[a-f0-9-]{36}$/);
      const file = join(app.hostDir, 'assets', state.result!.assetId);
      const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
        'stream=codec_type:format=duration', '-of', 'json', file], { encoding: 'utf8' }));
      assert.deepEqual(info.streams.map((stream: { codec_type: string }) => stream.codec_type).sort(), ['audio', 'video']);
      assert.ok(Math.abs(Number(info.format.duration) - duration) < 0.15, 'unexpected export duration');
      const bright = (at: string) => {
        const frame = execFileSync(ffmpeg, ['-v', 'error', '-ss', at, '-i', file,
          '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-']);
        assert.equal(frame.length, width * height);
        return frame.reduce((pixels, value) => pixels + Number(value > 220), 0);
      };
      assert.ok(bright('1') > 100, 'expected visible hard subtitles within cue');
      assert.ok(bright('2.5') < 10, 'expected black background after cue');
      // The App process itself must not expose a listening driver. The Host
      // is a separate process and owns its own listener.
      assert.throws(() => execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(app.child.pid),
        '-iTCP', '-sTCP:LISTEN'], { stdio: 'ignore' }), { status: 1 });
      console.log('PASS F-0058/AC-2/AC-3: driver-free bundled Host exported video, audio and visible subtitles');
    } finally {
      await app.stop();
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

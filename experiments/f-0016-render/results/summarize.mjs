// 把 results/*.jsonl 汇总成 Markdown 表格（贴进 02-research.md）。
// 用法：node results/summarize.mjs
import { readFileSync, existsSync } from 'node:fs';

const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const dir = new URL('.', import.meta.url).pathname;

const preview = read(`${dir}preview-bench.jsonl`);
if (preview.length) {
  console.log('### 预览性能\n');
  console.log('| 浏览器 | 场景 | rVFC 回调 / 期望帧 | 跳过的帧 | 绘制 p95 / p99 / 最大（ms） | 拖动 p50 / p95 / 最大（ms） | 拖动超时 |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of preview) {
    const fps = r.scenario.endsWith('-60') ? 60 : 30;
    const expected = r.sec * fps;
    const draw = r.drawP95 == null ? '—' : `${r.drawP95} / ${r.drawP99} / ${(+r.drawMax).toFixed(1)}`;
    const seek = r.seek?.n ? `${r.seek.p50} / ${r.seek.p95} / ${r.seek.max}` : '—';
    console.log(`| ${r.browser.startsWith('chrome') ? 'Chrome' : 'WKWebView'} | ${r.scenario} | ${r.rvfcCallbacks} / ${expected} | ${r.skippedPresented} (${((r.skippedPresented / expected) * 100).toFixed(1)}%) | ${draw} | ${seek} | ${r.seek?.timeouts ?? 0} |`);
  }
  console.log();
}

const exp = read(`${dir}export-bench.jsonl`);
if (exp.length) {
  console.log('### 导出性能\n');
  console.log('| 方案 | 时长 | 重画帧 / 总帧 | 总耗时（s） | 实时倍数 | Node CPU（s） | Node 峰值内存（MB） | FFmpeg CPU（s） | FFmpeg 峰值内存（MB） |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const r of exp) {
    console.log(`| ${r.engine}${r.fullFrame ? '（整帧）' : ''} | ${r.duration / 60} 分钟 | ${r.drawnFrames} / ${r.frames} | ${r.wallSec} | ${r.speedX}× | ${r.nodeCpuSec} | ${r.nodePeakMB} | ${r.ffmpegCpuSec} | ${r.ffmpegPeakMB} |`);
  }
}

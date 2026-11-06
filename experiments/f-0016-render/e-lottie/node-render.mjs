// 方案 E 可行性：同一个 Lottie 动画（e-lottie/badge.json），Node 端用 dotLottie（ThorVG WASM）画到 @napi-rs/canvas 上。
// 用法：node e-lottie/node-render.mjs（需先 node serve.mjs，WASM 从本地服务器加载，不走 CDN）
import { DotLottie } from '@lottiefiles/dotlottie-web';
import { createCanvas } from '@napi-rs/canvas';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
DotLottie.setWasmUrl('http://127.0.0.1:4716/node_modules/@lottiefiles/dotlottie-web/dist/dotlottie-player.wasm');
const canvas = createCanvas(256, 256);
const anim = new DotLottie({ canvas, data: readFileSync(new URL('./badge.json', import.meta.url), 'utf8'), autoplay: false });
await new Promise((resolve, reject) => { anim.addEventListener('load', resolve); anim.addEventListener('loadError', (e) => reject(e.error)); setTimeout(() => reject(new Error('load timeout')), 15000); });
mkdirSync('out/lottie-node', { recursive: true });
const t0 = performance.now();
for (const f of [3, 6, 9, 20]) {
  anim.setFrame(f);
  await new Promise((r) => setTimeout(r, 30));
  writeFileSync(`out/lottie-node/${f}.png`, canvas.toBuffer('image/png'));
}
console.log('ok', anim.totalFrames, (performance.now() - t0).toFixed(0), 'ms');
anim.destroy();

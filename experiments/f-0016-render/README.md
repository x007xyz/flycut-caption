# F-0016 字幕渲染方案原型

一次性原型，不进构建、不进测试。结论见 docs/features/archive/F-0016-subtitle-render-research/02-research.md。

测试环境：macOS 26.6.2（Apple Silicon，10 核），Node 24.6.0，FFmpeg 8.0.1（`src-tauri/binaries/ffmpeg`），Chrome for Testing 151.0.7922.34（Playwright 缓存的 chromium-1234），系统 WKWebView（WebKit 605.1.15）。

## 目录

| 路径 | 内容 |
|---|---|
| `shared/scene.mjs` | 测试场景：伪随机生成的中英混排字幕 + 字词时间戳、3 种静态样式、动画参数（数据）、3 种画幅 |
| `shared/draw.mjs` | 图形层原型：`drawFrame(ctx, scene, t)`、`frameKey`、`layoutCue`、`subtitleBand`，浏览器和 Node 共用 |
| `shared/to-ass.mjs` | 同一场景转 ASS（方案 D 基线） |
| `shared/variants.mjs` | 一致性测试的场景组合 |
| `harness/index.html` | 浏览器测试页：取样截图（snap）、方案 B 导出（export）、预览性能（play） |
| `a-skia/` | 方案 A 后端：Skia（`@napi-rs/canvas`）取样截图、贴图生成 |
| `consistency/` | 一致性：Chromium 截图、libass / JASSUB 截图、比较脚本 |
| `wkwebview/runner.swift` | 在系统 WKWebView 里跑测试页并取回结果 |
| `preview/` | 预览性能基准（Chrome、WKWebView） |
| `export/` | 导出性能基准（none / ass / skia / chromium / chromium-post） |
| `e-lottie/` | 方案 E 可行性：同一 Lottie 在 Node 和 Chromium 中渲染 |
| `results/` | 原始结果（JSON / JSONL）和证据截图（`img/`） |

## 复现

```bash
cd experiments/f-0016-render
pnpm install --ignore-workspace
# 字体（OFL）：前后端共用同一份完整字体文件
mkdir -p fonts && for w in Regular Bold; do curl -sSfL -o fonts/NotoSansSC-$w.otf "https://github.com/notofonts/noto-cjk/raw/main/Sans/SubsetOTF/SC/NotoSansSC-$w.otf"; done
# 浏览器端用的 JASSUB / dotLottie 打包
E=../../node_modules/.bin/esbuild; mkdir -p harness/vendor/jassub harness/vendor/dotlottie
$E node_modules/jassub/dist/jassub.js --bundle --format=esm --outfile=harness/vendor/jassub/jassub.js
$E node_modules/jassub/dist/worker/worker.js --bundle --format=esm --outfile=harness/vendor/jassub/worker.js
cp node_modules/jassub/dist/wasm/jassub-worker{,-modern}.{js,wasm} node_modules/jassub/dist/default.woff2 harness/vendor/jassub/
$E node_modules/@lottiefiles/dotlottie-web/dist/index.js --bundle --format=esm --outfile=harness/vendor/dotlottie/index.js
node a-skia/make-sticker.mjs
swiftc -O wkwebview/runner.swift -o out/wkrunner
node serve.mjs &   # http://127.0.0.1:4716
```

一致性：

```bash
node a-skia/snapshots.mjs && node consistency/snap-chromium.mjs
out/wkrunner "http://127.0.0.1:4716/?mode=snap" wkwebview/snap.js out/wk-snap.json   # 再用 02-research.md 里的命令拆成 PNG
node consistency/compare.mjs out/snap-skia out/snap-webkit out/layouts-skia out/layouts-webkit
```

性能：

```bash
node preview/bench-chrome.mjs && zsh preview/bench-wkwebview.sh   # 需要 out/clip30.mp4、out/clip60.mp4
zsh export/run-all.sh
# 第二轮优化：--yuv（overlay format=yuv420）、--tight（收紧字幕条带）、--premul、--threads N、--enc vt、--sink
BENCH_OUT=export-opt.jsonl node export/bench.mjs skia 1200 anim-landscape --yuv --tight
node results/summarize.mjs
```

测试素材来自 `tests/media/external/x-isnail-2115609565043597572.mp4`（1920×1080，25 fps，46 分钟）；60 分钟导出用 `-stream_loop` 循环输入。

## 注意

- WKWebView 测试窗口如果不在当前 Space（例如前台是全屏应用），WebKit 会把页面当成 `hidden`、停掉 `requestAnimationFrame`。`runner.swift` 通过 WebKit 内部开关 `_setWindowOcclusionDetectionEnabled:` 关掉遮挡检测，只用于测试。
- `fonts/`、`harness/vendor/`、`node_modules/`、`out/` 不进仓库。

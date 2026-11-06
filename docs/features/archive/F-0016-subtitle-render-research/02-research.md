---
id: F-0016
stage: 02-research
status: approved
approved_by: zhangxiang.chen
approved_at: 2026-11-06
---

# F-0016 字幕渲染方案调研：调研报告

> 结论先说：**采用方案 A**，前端和 Host 共用一份 Canvas 2D 绘制代码，Host 用 Skia（`@napi-rs/canvas`）画字幕层，再交给 FFmpeg 叠加。决定写在 [ADR-0006](../../../20-architecture/adr/0006-subtitle-graphics-layer.md)（accepted，维护者 2026-11-06 确认）。全部数据只在当前 Mac 上测得，Windows、Linux / Cloud 没有实测。

## 测试环境

| 项目 | 值 |
|---|---|
| 机器 | macOS 26.6.2，Apple Silicon（arm64，10 核） |
| 后端 | Node 24.6.0（与随包的 `flycut-node` 同版本），FFmpeg 8.0.1（`src-tauri/binaries/ffmpeg`），`@napi-rs/canvas` 1.1.0 |
| 前端 | Chrome for Testing 151.0.7922.34（Playwright 缓存）；系统 WKWebView（WebKit 605.1.15，与 Tauri macOS 端同一个 WebKit），用 `experiments/f-0016-render/wkwebview/runner.swift` 驱动 |
| 字体 | Noto Sans SC Regular / Bold（notofonts/noto-cjk SubsetOTF，OFL，2026-11-05 下载），前后端读同一份文件 |
| 素材 | `tests/media/external/x-isnail-2115609565043597572.mp4`（1920×1080，25 fps，46 分钟中文口播）；60 分钟导出用循环输入；预览用从中截取的 150 秒片段，转成 30 fps 和 60 fps 两个版本 |
| 测试字幕 | `shared/scene.mjs` 生成的中英混排口播句子（含英文术语、emoji），每条 1.6–3.2 秒，带字词时间戳 |

原型、脚本和原始结果都在 [`experiments/f-0016-render/`](../../../../experiments/f-0016-render/README.md)，复现步骤写在该目录的 README 里。

## 要回答的问题

来自 [01-spec.md](01-spec.md)：

1. **Q1 前端展示性能**：叠加到 1080p 视频播放时能否跟上帧率，掉帧、CPU、内存；拖动进度条后多久显示正确的帧；暂停时的单帧是否和播放时一致。
2. **Q2 两端一致性**：前端截图与 Host 导出帧的差异；中英混排的字宽、换行；WKWebView 和 Chrome 之间的差异。
3. **Q3 后端导出性能**：20 / 60 分钟 1080p 的导出耗时、实时倍数、CPU、内存，和现有 ASS 硬烧相比如何。
4. **Q4 无界面导出**：能否只由 Host 完成导出，需要什么依赖。
5. **Q5 打包**：安装包增加多少，原生依赖能否打进 Tauri 包。
6. **Q6 动画能力**：逐字弹出、逐字高亮、关键词放大、渐变、图片 / emoji。
7. **Q7 转场可扩展性**。
8. **Q8 许可与已有决定**。
9. **Q9 推荐方案与接口**。
10. **Q10 后续拆分**。

已确认的判断标准（01-spec 待澄清问题）：Q-C 一致性——文字包围盒偏移 ≤ 2 px（1080p）且换行位置完全相同，抗锯齿差异只记录；Q-G 流畅度——1080p 视频播放时字幕层跟上 30 fps、掉帧 < 1%，拖动后 100 ms 内显示正确帧，60 fps 只记录。

## 评估标准

| 维度 | 怎么衡量 |
|---|---|
| 一致性 | 同一时间点，各引擎画出的字幕层逐像素比较：包围盒偏移、换行位置、字词 x 位置差、明显差异像素比例 |
| 预览性能 | 真实视频播放 30 秒：`requestVideoFrameCallback` 的帧序号是否跳号（跳过的帧）、JS 侧每帧绘制耗时；20 次拖动的耗时 |
| 导出性能 | 与 Host 导出相同的编码参数（libx264 veryfast crf 23 + aac）：总耗时、实时倍数、CPU 时间、峰值内存 |
| 无界面 / 打包 | 能否在 Node 里独立运行；原生依赖、体积 |
| 能力 | 能否在两端都实现测试动画 |
| 许可 | 许可证及收费条款，来源和日期 |
| 隐私 | 所有方案都在本地渲染，不上传素材；没有差别，不单独比较 |

## 候选方案

| 方案 | 说明 | 原型 | 资料来源（读取日期 2026-11-05 / 06） |
|---|---|---|---|
| A. 共用 Canvas 2D，Host 用 Skia | `shared/draw.mjs` 在浏览器画到盖在 `<video>` 上的 Canvas；Host 用 `@napi-rs/canvas` 画字幕条带，rawvideo 管道交给 FFmpeg `overlay` | `a-skia/`、`export/bench.mjs skia` | `@napi-rs/canvas` npm 包（MIT，1.1.0） |
| B. 导出也用网页渲染 | Host 用 Playwright 驱动无头 Chrome 跑同一份绘制代码，逐帧取像素交给 FFmpeg | `export/bench.mjs chromium`、`chromium-post` | Playwright（Apache-2.0）；Remotion、Revideo 未实测，许可条款**待核实** |
| C. Host 端 WebGL 整帧合成 | headless-gl | 只试了安装 | `gl` 8.1.6 npm 包 |
| D. libass 两端 | 预览用 JASSUB（libass WASM），导出用 FFmpeg `ass` 滤镜；同一份 ASS 由 `shared/to-ass.mjs` 从场景生成 | `consistency/snap-ass.mjs`、`snap-jassub.mjs` | `jassub` 2.5.35（LGPL-2.1-or-later 等，见 package.json） |
| E. Lottie 模板 | dotLottie（ThorVG WASM）在 Node 和浏览器渲染同一个 Lottie | `e-lottie/` | `@lottiefiles/dotlottie-web` 0.82.1（MIT） |
| 不实测 | Rust 自研引擎编译到 WASM（工作量过大，作为远期方向）；MLT / GStreamer GES（浏览器无法预览，违背两端一致）；纯 FFmpeg 滤镜（动画能力弱） | — | Epic E-03 |

## 实验

### 1. 一致性（Q2）

同一份场景数据，在 12 个取样时间点（一半在动画进行中，一半在一条字幕末尾）画出字幕层，两两比较。命令见 README；结果在 `results/consistency-*.json`。

**Canvas 2D 三个引擎（方案 A / B 的基础）**

| 比较 | 场景 | 包围盒最大偏移（px） | 换行不同的字幕条 | 字词 x 最大差（px） | 明显差异像素比例 | 是否达标 |
|---|---|---|---|---|---|---|
| Skia vs Chrome | 3 种静态样式 + 3 种画幅动画 | 0–2 | 0 / 21 | 0.01 | 6.9%–15.4% | 全部达标 |
| Skia vs WKWebView | 同上，原生阴影 | 6 | 0 | 0.01 | 10.1% | **不达标** |
| Skia vs WKWebView | 同上，其他（含手绘阴影） | 0–2 | 0 | 0.01 | 6.4%–14.5% | 达标 |
| Chrome vs WKWebView | 原生阴影 | 6 | 0 | 0.01 | 4.0% | **不达标** |
| Chrome vs WKWebView | 其他（含手绘阴影） | 0–1 | 0 | 0.01 | 3.4%–6.4% | 达标 |

- **换行和排版三端完全一致**：同一份字体文件下，三个引擎的 `measureText` 结果相同（字词 x 最多差 0.01 px），换行位置没有任何不同。用另一端算好的排版数据来画，结果也一样。
- **「明显差异像素」集中在文字边缘**：差值 > 96（0–255）的像素占字幕像素的 3%–15%。放大对比看不出区别（`experiments/f-0016-render/results/img/outline-skia-vs-chromium-zoom.png`）；在 ±2 px 范围内平移对齐后仍有约 4%–6%，说明是字形光栅化和抗锯齿不同，不是位置偏移。按 Q-C，这一项只记录。
- **WKWebView 的 Canvas 原生阴影不一致**：`shadowBlur` 的模糊范围约是 Skia / Chrome 的 2 倍（`results/img/shadow-skia-chromium-webkit.png`），重跑结果相同。改成手绘阴影（同一字形按三圈偏移叠画 21 次）后三端都达标。

**libass 两端（方案 D）**

| 比较 | 场景 | 包围盒最大偏移（px） | 明显差异像素比例 | 是否达标 |
|---|---|---|---|---|
| FFmpeg libass vs JASSUB（Chrome） | 3 种静态样式 | 1 | 0.4%–1.5% | 达标 |
| FFmpeg libass vs JASSUB（Chrome） | 动画 | 13 | 59.9% | 不达标（见下） |
| 指定字体目录 vs 不指定（都是 FFmpeg） | 4 种 | 0–1 | 1.9%–3.2% | — |

- 静态样式两端用的是同一个光栅化器，比 Canvas 2D 三端更接近。
- 动画帧的差异是时间相位不同：JASSUB 按 `video.currentTime` 计算动画进度，FFmpeg 按帧时间戳，两者差约一帧；字幕条末尾（动画结束后）的帧是一致的（`results/img/libass-ffmpeg-vs-jassub-anim.png`）。
- **现有导出的问题**：`server/plugins/export.ts` 调用 `subtitles` 滤镜时没有传 `fontsdir`，而这台 Mac 没有安装 Noto Sans SC，libass 实际用了系统替代字体（与指定字体目录相比有 2%–3% 的明显差异像素）。
- **Canvas 预览与 ASS 导出本身对不上**：同一组样式参数，ASS 的字号含义、底边距和关键词缩放方式都与 Canvas 不同（`results/img/export-frame-skia-chromium-ass.png`，第三行为 ASS），这就是现有「Canvas 预览 + ASS 硬烧」两套实现的问题。

**Lottie（方案 E）**：同一个 Lottie 动画、同一个 ThorVG WASM，在 Node（画到 `@napi-rs/canvas`）和 Chrome 里渲染 4 帧，**逐像素完全相同**（`results/consistency-lottie-node-vs-chromium.json`）。

### 2. 前端预览性能（Q1）

`preview/bench-chrome.mjs`（有窗口的 Chrome）和 `preview/bench-wkwebview.sh`（系统 WKWebView），每个场景播放 30 秒，再拖动 20 次。字幕层画布为 1920×1080，显示为 960 CSS 像素宽。「跳过的帧」= `requestVideoFrameCallback` 的 `presentedFrames` 跳号数，WebKit 的 `getVideoPlaybackQuality()` 口径与 Chrome 不同，不用它。原始数据：`results/preview-bench.jsonl`。

| 浏览器 | 场景 | 跳过的帧 | JS 绘制 p95 / 最大（ms） | 拖动 p50 / p95（ms） |
|---|---|---|---|---|
| Chrome | 30 fps，不叠字幕（基线） | 0 | — | 48 / 81 |
| Chrome | 30 fps，Canvas 动画 | 0 | 0.42 / 11.5 | 48 / 74 |
| Chrome | 30 fps，Canvas 动画，每帧都重画 | 0 | 0.38 / 6.8 | 41 / 82 |
| Chrome | 30 fps，Canvas 原生阴影，每帧都重画 | 0 | 0.38 / 6.4 | 49 / 82 |
| Chrome | 30 fps，JASSUB 动画 | 0 | — | 48 / 82 |
| Chrome | 60 fps，基线 | 0 | — | 50 / 98 |
| Chrome | 60 fps，Canvas 动画 | 2（0.1%） | 0.30 / 6.9 | 49 / 98 |
| Chrome | 60 fps，Canvas 动画，每帧都重画 | 0 | 0.28 / 13.9 | 49 / 91 |
| Chrome | 60 fps，JASSUB 动画 | 0 | — | 57 / 92 |
| WKWebView | 30 fps，基线 | 4（0.4%） | — | 49 / 84 |
| WKWebView | 30 fps，Canvas 动画 | 12（1.3%） | 1.04 / 22.6 | 49 / 90 |
| WKWebView | 30 fps，Canvas 动画，每帧都重画 | 31（3.4%） | 1.24 / 21.5 | 49 / 98 |
| WKWebView | 30 fps，Canvas 原生阴影，每帧都重画 | 4（0.4%） | 0.82 / 20.0 | 50 / 83 |
| WKWebView | 30 fps，JASSUB 动画 | 1（0.1%） | — | 52 / 90 |
| WKWebView | 60 fps，基线 | 54（3.0%） | — | 51 / 109 |
| WKWebView | 60 fps，Canvas 动画 | 101（5.6%） | 0.80 / 22.3 | 55 / 100 |
| WKWebView | 60 fps，Canvas 动画，每帧都重画 | 75（4.2%） | 0.76 / 22.5 | 65 / 114 |
| WKWebView | 60 fps，JASSUB 动画 | 17（0.9%） | — | 63 / 101 |

- **Chrome 全部达标**：30 fps 下 Canvas 方案不跳帧；拖动 p95 在 74–82 ms，与不叠字幕的基线相同，耗时主要是视频解码。
- **WKWebView 的 Canvas 方案在 30 fps 下略超标**：跳帧 1.3%（标准 < 1%），每帧都重画时 3.4%；同条件下基线是 0.4%，JASSUB 是 0.1%（JASSUB 在 Worker 里渲染，不占主线程）。拖动 p95 83–98 ms，达标。
- **WKWebView 的波动很大**：同一设置（30 fps、Canvas 动画、1920×1080 画布）连跑 4 次，跳过的帧分别是 27、4、0、3（满 900 帧，即 0%–3%；`results/preview-bench-res.jsonl`）。上表的 1.3% 落在这个波动范围内，不能据此判定达标或不达标。本想对比「按显示尺寸绘制」，但测试窗口在 Retina 屏上（设备像素比 2），显示尺寸画布同样是 1920×1080，两种设置实际相同，没有得到对比结论。
- **WKWebView 数据的局限**：测试时前台是全屏应用，测试窗口不在当前 Space。为让 WebKit 按可见页面渲染，runner 通过 WebKit 内部开关关掉了窗口遮挡检测；这与用户正在看的 Tauri 窗口不完全一样，60 fps 时连基线都跳了 3%。WKWebView 的数据应在落地需求里用真实的 Tauri 窗口复测。
- **兼容性发现**：WKWebView 在视频暂停时拖动进度条，**不触发** `requestVideoFrameCallback`（`seeked` 事件正常）。预览必须在 `seeked` 里补画一帧，否则拖动后字幕停在旧时间。本测试的拖动耗时就是按「`seeked` → 画字幕 → 下一次 `requestAnimationFrame`」计算的。
- 暂停时的单帧和播放时一致：绘制只依赖时间点，同一时间点画出的字幕层相同（一致性测试就是按时间点取样的）。
- 内存：Chrome 的 `performance.memory` 在这个页面上只报约 2 MB，不可信；没有单独测预览内存。

### 3. 后端导出性能（Q3）

`export/bench.mjs`：同一段视频、与 Host 导出相同的编码参数（libx264 veryfast crf 23 + aac）。`none` 是不加字幕的编码基线；`ass` 是方案 D（现有做法，加上 `fontsdir`）；`skia` 是方案 A，只画字幕条带，重复帧复用缓冲区；`chromium` 是方案 B（`page.evaluate` 批量取帧，base64 回传）；`chromium-post` 是方案 B 的另一种传输方式（页面用 HTTP POST 发二进制帧）。场景为动画字幕（最坏情况：60 秒里 1500 帧有 1267 帧需要重画）。

**60 秒素材（冒烟测试，`results/export-bench-smoke*.jsonl`）**

| 方案 | 总耗时（s） | 实时倍数 | Node CPU（s） | Node 峰值内存（MB） | FFmpeg CPU（s） | FFmpeg 峰值内存（MB） |
|---|---|---|---|---|---|---|
| 不加字幕 | 3.3 | 18.4× | 0 | 48 | 17.9 | 621 |
| D：ASS 硬烧 | 3.1 | 19.5× | 0 | 49 | 19.0 | 790 |
| A：Skia 字幕条带 | 6.0–6.2 | 9.7–10.0× | 3.1–3.2 | 325 | 34.2–34.5 | 1220–1239 |
| B：Chrome，evaluate + base64 | 76.4 | 0.78× | 14.2 | 1806 | 34.3 | 1215 |
| B：Chrome，HTTP POST 二进制 | 203.4 | 0.30× | 110.2 | 721 | 31.8 | 2038 |

**20 / 60 分钟素材**（`export/run-all.sh`，`results/export-bench.jsonl`，2026-11-06）

| 方案 | 时长 | 重画帧 / 总帧 | 总耗时（s） | 实时倍数 | Node CPU（s） | Node 峰值内存（MB） | FFmpeg CPU（s） | FFmpeg 峰值内存（MB） |
|---|---|---|---|---|---|---|---|---|
| 不加字幕 | 20 分钟 | — | 44.7 | 26.8× | 0 | 50 | 342.5 | 633 |
| D：ASS 硬烧 | 20 分钟 | — | 53.5 | 22.4× | 0.3 | 67 | 376.5 | 895 |
| A：Skia 字幕条带，动画 | 20 分钟 | 26267 / 30000 | 103.7 | 11.6× | 58.2 | 327 | 683.6 | 1265 |
| A：Skia 整帧，动画 | 20 分钟 | 26267 / 30000 | 152.6 | 7.9× | 109.2 | 288 | 735.5 | 1200 |
| A：Skia 字幕条带，静态描边样式 | 20 分钟 | 873 / 30000 | 100.3 | 12.0× | 28.5 | 293 | 676.5 | 1257 |
| 不加字幕 | 60 分钟 | — | 137.8 | 26.1× | 0 | 59 | 1024.6 | 667 |
| D：ASS 硬烧 | 60 分钟 | — | 154.7 | 23.3× | 0.7 | 86 | 1121.7 | 909 |
| A：Skia 字幕条带，动画 | 60 分钟 | 79182 / 90000 | 323.1 | 11.1× | 183.2 | 328 | 2048.4 | 1231 |

- 方案 A 导出 60 分钟 1080p 口播约 5.4 分钟（11.1× 实时），ASS 硬烧约 2.6 分钟（23.3×）；耗时随时长线性增长，内存不随时长增长（Node 约 330 MB，FFmpeg 约 1.2 GB）。
- **只画字幕条带比画整帧快约 1/3**（11.6× vs 7.9×）。
- **瓶颈在 FFmpeg 叠加，不在 Skia 绘制**：静态样式只需重画 873 帧，耗时却和动画（重画 26267 帧）几乎相同；FFmpeg 的 CPU 时间是不加字幕时的约 2 倍。

**优化（第二轮，2026-11-06，`results/export-opt.jsonl`）**

先在 2 分钟素材上拆开各环节（`export/bench.mjs` 的 `--sink`、`--yuv`、`--tight`、`--premul`、`--threads`、`--enc vt` 开关），再用 FFmpeg 自己生成的透明层单独测叠加：

| 2 分钟素材 | 实时倍数 | FFmpeg CPU（s） | FFmpeg 峰值内存（MB） |
|---|---|---|---|
| 不加字幕 | 24.7× | 34.8 | 621 |
| ASS 硬烧 | 22.5× | 38.0 | 844 |
| Skia，原做法（条带高 432 px，`overlay format=auto`） | 9.6× | 68.5 | 1232 |
| 只把字幕层送进 FFmpeg、不叠加（测管道和 Node 绘制） | 26.2× | 1.9 | 30 |
| Skia，收紧条带到 206 px | 12.3× | 67.2 | 1230 |
| Skia，预乘 alpha（`canvas.data()` + `alpha=premultiplied`） | 10.9× | 68.6 | 1228 |
| Skia，滤镜 8 线程 | 11.2× | 68.2 | 1219 |
| **Skia，`overlay format=yuv420`** | 13.8× | 49.4 | 646 |
| **Skia，`format=yuv420` + 收紧条带** | **18.3×** | 43.4 | 674 |
| 同上，静态描边样式 | 20.4× | 41.2 | 703 |
| VideoToolbox 硬件编码：不加字幕 / ASS / Skia | 7.9× / 7.9× / 7.8× | 11.8 / 12.5 / 28.6 | 247 / 479 / 483 |

- **根因**：`overlay` 的 `format=auto` 遇到 RGBA 字幕层时，会把**整个 1080p 主画面**从 yuv420p 转成 RGBA 再叠加、再转回 YUV（`-v verbose` 日志：`auto_scale_0 … fmt:yuv420p -> fmt:rgba`）。所以 FFmpeg 多出的 CPU 与字幕层面积无关。用 FFmpeg 生成的透明 RGBA 层单独测：`format=auto` 66.4 s CPU，`format=yuv420` 46.6 s。强制 `format=yuv420` 后只需转换字幕条带本身。
- **收紧条带**：按所有字幕条的最大行数 × 行高，加上动画放大、贴图和描边的余量算出条带（206 px，原来固定 432 px），配合 `yuv420` 后才有明显收益。
- **没有收益的**：预乘 alpha（Skia 读回耗时相同，约 0.75 ms/帧）、滤镜多线程。
- **VideoToolbox 硬件编码**：这台机器上编码器本身就是瓶颈（约 7.8×，比 libx264 veryfast 慢），但加字幕不增加耗时，CPU 只有 libx264 的约 40%。是否改用硬件编码与字幕方案无关，留给导出设置另行决定。
- **画质**：在 YUV 里叠加，字幕边缘按 4:2:0 色度采样处理（ASS 硬烧也是这样）。与原来的 RGB 叠加相比，字幕区域 PSNR 44.7 dB、整帧 46.2 dB，属于编码噪声量级，肉眼看不出区别（`results/img/export-opt-rgb-vs-yuv.png`）。

优化后的长素材（`format=yuv420` + 收紧条带）：

| 方案 | 时长 | 总耗时（s） | 实时倍数 | Node CPU（s） | Node 峰值内存（MB） | FFmpeg CPU（s） | FFmpeg 峰值内存（MB） |
|---|---|---|---|---|---|---|---|
| A：Skia，动画 | 20 分钟 | 65.4 | 18.3× | 36.7 | 326 | 428.1 | 701 |
| A：Skia，动画 | 60 分钟 | 207.4 | 17.4× | 116.8 | 329 | 1297.5 | 694 |
| A：Skia，静态描边样式 | 20 分钟 | 54.1 | 22.2× | 9.4 | 263 | 406.5 | 724 |
| D：ASS 硬烧（对照，上表） | 20 / 60 分钟 | 53.5 / 154.7 | 22.4× / 23.3× | — | — | 376.5 / 1121.7 | 895 / 909 |

优化后，静态样式与 ASS 硬烧一样快；动画字幕 60 分钟 1080p 约 3.5 分钟，比 ASS 慢约 1/3（原来慢一倍）。还可以继续尝试（本次未测）：没有字幕的时间段不叠加、字幕层不变时不重复传帧。

方案 B 只做了上面的 60 秒测试，没有跑 20 / 60 分钟：按 0.78× 实时推算，60 分钟素材要 75 分钟以上，已经不可用。维护者 2026-11-06 决定停掉方案 B 的长素材测试（原话：「浏览器导出（方案 B） 直接停掉吧，不用测了」）。

- 方案 A 的额外开销主要在 FFmpeg（CPU 时间约为基线的 1.9 倍）：RGBA 字幕层要转成 YUV 再叠加。Skia 绘制本身每 60 秒素材约 3 秒 CPU。
- 方案 B 的瓶颈是把帧从浏览器传回 Host：页面内「绘制 + 读回像素」每帧只要约 1.5 ms（`export/probe-browser.mjs`），但两种传输方式都远低于实时。

### 4. 无界面导出与打包（Q4、Q5）

| 方案 | 无界面导出 | 新增依赖与体积（macOS arm64） |
|---|---|---|
| A | 可以：纯 Node + FFmpeg，不需要窗口、GPU 或浏览器 | `@napi-rs/canvas` 原生模块 28 MB（N-API，不绑定 Node 版本；npm 上有 macOS / Windows / Linux 的预编译包，本次只验证了 macOS arm64）；完整字体 17 MB（两个字重） |
| B | 可以，但要带一个浏览器 | Chrome for Testing 356 MB 或 headless shell 196 MB（Playwright 缓存实测）；如改用桌面端隐藏 WebView，就不再是「只由 Host 导出」 |
| C | 未能验证 | `gl` 8.1.6 在 Node 24 / arm64 上没有预编译包，源码构建在 ANGLE 的 gyp 配置阶段失败；Linux 还需要 Xvfb（Epic 记录，未实测） |
| D | 可以（现状） | 无新增；预览端 JASSUB 约 4.5 MB（含两个 WASM） |
| E | 可以（Node 里用 WASM） | dotLottie 约 7 MB（dist 目录） |

Host 随 Tauri 打包在 `src-tauri/host/**` 资源里；原生 `.node` 文件需要和 Host 一起放进资源目录并能被加载，落地时要验证打包后的路径和 macOS 签名。Windows、Linux 未验证（推测：`@napi-rs/canvas` 有对应预编译包；Linux 下字体要随 Host 一起提供，不能依赖系统字体）。

### 5. 动画能力（Q6）

| 效果 | A / B（Canvas 2D） | D（ASS / libass） | E（Lottie） |
|---|---|---|---|
| 逐字弹出（回弹缓动） | ✅ 任意缓动函数 | ⚠️ `\t` 只有幂次加速，用两段近似；逐字缩放会挤开后面的字 | ✅（适合固定内容） |
| 逐字高亮 | ✅ | ✅（`\t` 换色或 `\k`） | ❌ 文字内容每条不同，不适合模板 |
| 关键词放大换色 | ✅ 绕字中心缩放，排版时预留宽度 | ⚠️ 缩放会重排整行 | ❌ 同上 |
| 渐变填充 | ✅ | ❌ 只能单色 | ✅ |
| 图片贴图 | ✅ | ❌ 只能用矢量绘图近似 | ✅ |
| emoji | ✅ 走系统字体回退，三端都能画出（未逐像素比较 emoji） | 依赖字体 | — |

### 6. 转场可扩展性（Q7）

本次没有实现转场原型。判断：方案 A 的图形层只负责字幕层；转场作用在视频画面上，按「剪辑由 FFmpeg 完成」的分层，导出端可用 FFmpeg `xfade` 或 gl-transitions 的 FFmpeg 滤镜，预览端用 WebGL 实现同一份 GLSL。这需要单独验证两端一致性，归到剪辑线（E-06 / E-07）立项时做。方案 B 理论上最容易共用（同一个浏览器），但被导出性能否决；方案 C 共用 GLSL 最直接，但无法构建。

## 结论

**Q1 前端展示性能**：Canvas 方案在 Chrome 中达标（30 fps 下 0 跳帧，拖动 p95 ≤ 82 ms）。在 WKWebView 中，拖动达标（p95 83–98 ms）；跳帧在同一设置下 4 次重复测得 0%–3%（一次测量为 1.3%），波动大到无法判断是否满足 < 1%。这些数据是在测试窗口不在当前屏幕的条件下测的，需要在真实的 Tauri 窗口里复测；如果仍不达标，再尝试在 Worker 里用 OffscreenCanvas 绘制（JASSUB 就是这样做的，它在 WKWebView 中只跳 0.1%）。暂停时的单帧和播放时一致。WKWebView 暂停时拖动不触发 `requestVideoFrameCallback`，预览要监听 `seeked`。

**Q2 两端一致性**：同一份字体文件下，Skia、Chrome、WKWebView 的换行位置完全相同，包围盒偏移 ≤ 2 px，达到 Q-C 标准；边缘抗锯齿不同（只记录）。WKWebView 的 Canvas 原生阴影不一致，必须自己画阴影。libass 两端静态一致性更好，但不能表达方案 A 的效果。

**Q3 后端导出性能**：优化后（`overlay format=yuv420` + 按排版收紧字幕条带），方案 A 导出 20 分钟 1080p 口播需 65 秒（18.3× 实时），60 分钟需 207 秒（17.4×）；静态样式 20 分钟 54 秒（22.2×），与 ASS 硬烧（54 秒，22.4×）持平；动画字幕比 ASS 慢约 1/3。Node 峰值内存约 330 MB，FFmpeg 约 0.7 GB（ASS 约 0.9 GB），都不随时长增长。优化前的做法（`format=auto`）会把整个主画面转成 RGBA，慢一倍（104 秒 / 323 秒），落地时必须用 `format=yuv420`。方案 B 只测了 60 秒（0.3–0.78×），已不可用，长素材未测。

**Q4 无界面导出**：方案 A、D、E 只需 Node + FFmpeg；方案 B 需要随包带浏览器；方案 C 无法构建。Linux / Cloud 推测还要随 Host 提供字体文件（未验证）。

**Q5 打包**：方案 A 在 macOS arm64 上增加约 28 MB 原生模块 + 17 MB 字体；打包进 Tauri 后的加载和签名未验证。Windows 构建风险推测较低（有预编译包），未验证。

**Q6 动画能力**：方案 A 能实现全部测试效果；方案 D 不支持渐变、图片，缩放和缓动只能近似。

**Q7 转场**：方案 A 不覆盖转场，转场由 FFmpeg（导出）+ WebGL（预览）实现，剪辑线立项时单独验证。

**Q8 许可与已有决定**：`@napi-rs/canvas` MIT；Playwright Apache-2.0；dotLottie MIT；JASSUB 含 LGPL-2.1-or-later 等多个许可证；Noto Sans SC 为 OFL，允许随软件分发；Remotion 对公司用户收费（条款待核实，未采用）。方案 A 与「桌面导出只走 Host」「Tauri 只做桌面外壳」一致；方案 B 如果用桌面端隐藏 WebView 渲染会与这两条冲突，用 Host 驱动无头浏览器的变体不冲突，但性能不可用。

**Q9 推荐方案与接口**：采用方案 A，见 [ADR-0006](../../../20-architecture/adr/0006-subtitle-graphics-layer.md)。维护者提出的「按样式混合 ASS 与 Skia」作为备选记在 ADR 里，不采用：要维护两套渲染并保证两者一致，而 Skia 路径优化后静态样式已与 ASS 一样快。接口草案：

```ts
// 图形层：前后端共用，只依赖 Canvas 2D API
drawFrame(ctx: CanvasRenderingContext2D, scene: SubtitleScene, t: number, opts?: { layer?: { y: number; height: number }; images?: Record<string, CanvasImageSource> }): void
frameKey(scene: SubtitleScene, t: number): string          // 键相同 → 像素相同，用于跳过重画
layoutCue(ctx, scene, cue): CueLayout                       // 排版结果是数据：每个字词的行号和 x

// 场景数据（草案）
interface SubtitleScene {
  width: number; height: number; fps: number; fontFamily: string;
  style: { fontWeight; fontSizeRatio; fill; stroke; strokeRatio; shadow?; box?; gradient? };
  animation?: {
    enter: { duration: number; easing: 'backOut' | 'cubicOut' | 'linear'; from: { scale; opacity; dy }; to: { scale; opacity; dy } };
    karaoke?: { fill: string };             // 正在读的字词换色
    keyword?: { scale: number; fill: string };
    sticker?: { every: number; size: number; duration: number; easing: string };
  };
  cues: { start: number; end: number; words: { text: string; start: number; end: number; keyword?: boolean }[] }[];
  layouts?: CueLayout[];                     // 可选：一端算好的排版
}
```

「前后端」的含义：前端是页面（桌面端的 WKWebView、Web 端的浏览器），负责预览；后端是 Host（桌面端随安装包在本机运行，Web 端连 FlyCut Cloud 或自部署 Host），负责正式导出。同一个 `drawFrame` 在页面里画到浏览器的 Canvas 上，在 Host 里画到 Skia 的 Canvas 上。

前端导出：浏览器本地的回退导出引擎现在各画各的字幕（WebAV 用它自带的 `EmbedSubtitlesClip`，`src/services/videoEngines/WebAVEngine.ts`；ffmpeg.wasm 用 libass，`src/services/videoEngines/FFmpegEngine.ts`），加上预览和 Host 导出，一共 4 套字幕渲染。按 01-spec，前端导出不在本次评估范围内，没有实测；但图形层同样可以在浏览器里画到 OffscreenCanvas，再交给 WebAV / WebCodecs 合成（Chrome 里每帧「绘制 + 读回像素」约 1.5 ms）。建议回退导出以后也改用共用图形层，放进 E-03/6 的范围。

迁移：预览把 `src/subtitle/subtitleRenderer.ts` 改为调用共用图形层；导出在 `server/plugins/export.ts` 增加「字幕条带 rawvideo → `overlay`」路径，替换 `subtitles` 硬烧；样式预设（`subtitlePresets.ts`、`subtitleStyle.ts`）转换为场景数据。SRT / VTT / ASS 文件导出和软字幕轨不变（Q-F）。

**Q10 后续拆分**：见下一节。

## 对后续需求的影响

已更新 Epic [E-03](../../../10-product/epics/E-03-subtitle-effects.md) 的候选表：

| 候选 | 变化 |
|---|---|
| **新增 E-03/6** 共用字幕图形层落地 | 按 ADR-0006 把现有静态样式迁到共用图形层：前端预览改用图形层（含 `seeked` 补画、手绘阴影、完整字体文件），Host 导出改为 Skia 字幕条带 + FFmpeg 叠加，修复导出不传字体目录的问题；浏览器回退导出（WebAV / ffmpeg.wasm）也改用图形层；在真实 Tauri 窗口复测 WKWebView 流畅度；macOS 打包验证。依赖 F-0016 |
| **新增 E-03/7** Windows 与 Cloud 渲染补测 | WebView2 预览一致性和流畅度、Windows 版 Skia 预编译包打包、Linux 无界面 Host 导出与字体；依赖 E-03/6 |
| E-03/2 逐字高亮 | 依赖改为 E-03/6、E-01/1（原为 E-03/1、E-01/1） |
| E-03/3 关键词强调 | 依赖改为 E-03/6；排版时为放大的关键词预留宽度 |
| E-03/5 自定义样式 | 依赖改为 E-03/6、E-02/6 |

E-03/4（平台风格预设库）依赖 E-03/2、E-03/3，不变。[路线图](../../../10-product/roadmap.md)阶段二在 E-03/1 之后插入 E-03/6；E-03/7 放入「未排期」。转场（Q7）不在 E-03，剪辑线立项时引用本报告。

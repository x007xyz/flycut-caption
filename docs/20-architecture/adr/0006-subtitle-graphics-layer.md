---
id: ADR-0006
status: accepted     # proposed → accepted → superseded / deprecated
date: 2026-11-06
deciders: zhangxiang.chen（2026-11-06 确认 F-0016 调研报告）
feature: F-0016
superseded_by:
---

# ADR-0006 字幕图形层：前后端共用 Canvas 2D 绘制代码，Host 用 Skia 导出

## 背景

现在预览和导出是两套渲染：播放器预览用 Canvas 2D 绘制（`src/subtitle/subtitleRenderer.ts`），导出时生成 ASS 交给 FFmpeg 的 libass 硬烧（`src/subtitle/burnAss.ts`，`server/plugins/export.ts`）。静态样式靠两边各写一遍保持一致；E-03 要做的逐字高亮、关键词强调、弹出动画、渐变、贴图，用两套实现无法逐帧对齐。`docs/decisions.md` 已规定「只做了预览的特效不算完成」，并要求桌面端、Web 端、CLI / MCP、Cloud 都能导出。

F-0016 在当前环境（macOS 26.6.2，Apple Silicon）实测了 Epic E-03 的方案 A–E，数据见 [F-0016 调研报告](../../features/archive/F-0016-subtitle-render-research/02-research.md)，原型在 `experiments/f-0016-render/`。

## 决策

采用 **方案 A：两层渲染，图形层一份 Canvas 2D 代码，前端在浏览器画、Host 在 Node 里用 Skia（`@napi-rs/canvas`）画**；视频剪切、编码仍由 FFmpeg 完成，字幕层以透明 RGBA 原始帧叠加（`overlay` 滤镜）。

具体约定：

1. **图形层接口**：`drawFrame(ctx, scene, t, opts)`——输入场景数据（字幕、字词时间戳、样式、动画参数）和时间点，在一个 Canvas 2D 上下文上画出这一帧的透明字幕层。只用两端都有的 Canvas 2D API（`measureText`、`fillText`、`strokeText`、`createLinearGradient`、`drawImage`、路径）。另提供 `frameKey(scene, t)`：键相同的两帧像素相同，用于跳过重画。
2. **动画参数是数据**：入场（时长、缓动、起止的缩放 / 透明度 / 位移）、逐字高亮、关键词强调、贴图都写在场景数据里，不写死在绘制代码中，以后可以换渲染引擎或接 Lottie 模板。
3. **排版只依赖 `measureText`，结果是数据**（每个字词的行号和 x）。三端实测排版结果完全相同；如果以后某个平台出现差异，可以由一端算好、作为数据传给另一端。
4. **两端读同一份完整字体文件**（例如 `NotoSansSC-Regular/Bold.otf`）。前端不再依赖 `@fontsource` 的分片 woff2 来画字幕，导出端不再依赖系统字体。
5. **不用 Canvas 原生阴影（`shadowBlur`）**：WKWebView 的模糊半径约是 Skia / Chromium 的 2 倍。阴影用多次偏移叠画的方式自己画。新增效果前，先在三个引擎上跑一致性比较。
6. **导出端只渲染字幕所在的条带**（按所有字幕条的最大行数 × 行高，加动画放大、贴图、描边的余量算出，不画整帧），重复帧直接复用上一帧的缓冲区；FFmpeg 叠加**必须写 `overlay=…:format=yuv420`**。默认的 `format=auto` 遇到 RGBA 字幕层会把整个主画面转成 RGBA 再转回，导出慢一倍。
7. **预览**：字幕层是盖在 `<video>` 上的 Canvas，按 `requestVideoFrameCallback` 的 `mediaTime` 绘制；拖动进度条后在 `seeked` 事件里补画一帧（WKWebView 暂停时拖动不触发 `requestVideoFrameCallback`）。
8. **前端回退导出也用图形层**：浏览器本地的回退导出（WebAV、ffmpeg.wasm）不再使用 WebAV 自带字幕或 libass，改为把图形层画到 OffscreenCanvas 再合成。这仍是回退路径，桌面端不使用；本次未实测，落地时验证。
9. **软字幕不变**：SRT / VTT / ASS 文件导出和 mov_text 软字幕轨保持现状；本决定只替换硬烧（烧录进画面）的渲染。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| A. 共用 Canvas 2D，Host 用 Skia | 一份绘制代码；三端（Skia / Chromium / WKWebView）换行完全相同，包围盒偏移 ≤ 2 px；导出不需要浏览器；`@napi-rs/canvas` 为 MIT、有 macOS / Windows / Linux 预编译包 | Host 多一个约 28 MB 的原生模块；文字光栅化不同，边缘有抗锯齿级差异；阴影等少数 API 各引擎实现不同，需要自己画 | **采用** |
| B. 导出也用网页渲染（Host 驱动无头浏览器逐帧截图） | 预览和导出是同一个渲染器 | 实测瓶颈在把帧从浏览器传回 Host：evaluate + base64 只有 0.78× 实时，HTTP POST 只有 0.3×；需要随包带 Chromium（约 200–350 MB）；如果改用桌面端隐藏 WebView 渲染，又会违反「桌面导出只走 Host」「Tauri 只做桌面外壳」 | 不采用 |
| C. Host 端 WebGL 整帧合成（headless-gl） | 预览和导出可以共用 GLSL | `gl@8.1.6` 在 Node 24 / arm64 上没有预编译包，源码构建失败；Linux 还需要 Xvfb | 不采用 |
| D. libass 两端（预览用 JASSUB） | 静态样式两端几乎一致（同一个光栅化器）；导出最快 | 不支持渐变填充、图片；逐字缩放会挤开后面的字；没有回弹缓动；JASSUB 是 LGPL-2.1 | 不采用；ASS 继续用于软字幕文件 |
| A + D 混合：按样式选择，ASS 能表达的走 ASS 硬烧，否则走 Skia | 优化前，简单样式导出快一倍（60 分钟 1080p：ASS 155 秒 vs Skia 323 秒）；Skia 路径优化后，静态样式已与 ASS 一样快（20 分钟均约 54 秒），混合方案的收益基本消失 | 又回到两套渲染：每个样式参数要在 Canvas 和 ASS 两边各写一遍、各校准一遍（实测 ASS 的字号含义、底边距与 Canvas 不同）；「ASS 能否表达」要逐个样式、逐个组合判断，判断错了成片就和预览不一致；一致性测试翻倍；E-03 的特效越多，能走 ASS 的样式越少 | 不采用（维护者 2026-11-06 提出，记录为备选）。重新考虑的条件：Skia 路径优化后，导出速度仍是用户的主要抱怨。届时只允许通过「ASS 导出 vs Canvas 预览」逐像素一致性测试的样式走 ASS，其余一律走 Skia |
| E. Lottie 模板（dotLottie / ThorVG WASM） | 同一个 WASM 光栅化器，Node 和 Chromium 输出逐像素相同 | 动态文字（每条字幕内容不同）不适合用 Lottie 模板表达 | 以后作为方案 A 之上的装饰层（贴图、角标），需要时另立需求 |

## 后果

- 后续特效需求（E-03/2 逐字高亮、E-03/3 关键词强调、E-03/4 平台预设）只写一份绘制代码，加上三端一致性测试。
- Host 导出插件新增「字幕层渲染 → rawvideo 管道 → FFmpeg overlay」路径。按第 6 条优化后：静态样式与 ASS 硬烧一样快（20 分钟 1080p 均约 54 秒）；动画字幕 60 分钟 1080p 口播 207 秒（17.4× 实时），比 ASS 硬烧（155 秒，23.3×）慢约 1/3。
- 安装包增加 `@napi-rs/canvas` 原生模块（macOS arm64 约 28 MB）和完整字体文件（Noto Sans SC 常规 + 粗体约 17 MB）。
- **只在 macOS 上验证过**：Windows（WebView2、Windows 版 Skia 预编译包）和 Linux / Cloud（无界面 Host）的一致性与打包都还没测，落地需求要先补测这两端，再宣称三端一致。
- 以后如果需要逐像素一致，可以评估前端也用 Skia 的 WASM 版（CanvasKit），与 Host 用同一个光栅化器（参考方案 E 的逐像素一致结果），代价是前端多下载一个 WASM（体积待核实）。

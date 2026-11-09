---
id: F-0028
stage: 03-implementation
status: approved
approved_by: auto
approved_at: 2026-11-09
---

# F-0028 共用字幕图形层落地：开发记录

## 分支与 PR

- 分支：`codex/f0028-shared-subtitle-graphics`
- PR：未创建；按当前工作区直接提交，等待维护者在测试与验收阶段审阅。

## 进度

| 日期 | 清单项 | 提交 | 检查 |
|---|---|---|---|
| 2026-11-09 | 1. 共用图形层核心 | 2638cba | `pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`；`tsx --test tests/architecture/subtitle-graphics-f0028.test.ts` 5 通过（Schema、CJK 换行、条带裁剪 bbox ≤ 2px、三画幅 / 主副 / 全部样式、frameKey） |
| 2026-11-09 | 2. 字体资源与前端加载 | 2638cba | 完整 Noto Sans SC OTF / Inter TTF 写入 `public/fonts/subtitle` 与 `src-tauri/shared_assets/subtitle-fonts`，`cmp` 一致；`FontFace` 加载 / 失败 / 重试 E2E 通过 |
| 2026-11-09 | 3. 预览接入 | 2638cba | Playwright F-0028 预览 7 项通过：rVFC、seeked 补画、间隙透明、空字幕、加载、失败重试、中英文、明暗主题；构建通过 |
| 2026-11-09 | 4. Host 导出 | fcff937 | `subtitle-export-f0028.test.ts` 2 项通过：真实 Host 640×360 导出有字幕像素、间隙透明、无 ASS 临时文件；缺字体报错；`pnpm package:host` 带上 `@napi-rs/canvas-darwin-arm64` |
| 2026-11-09 | 5. 移除 WebAV 回退 | 32e7523 | 删除 WebAVEngine / SubtitleGraphicsClip / `@webav/*`，前端只注册 Host；F-0028 Playwright 剩余 7 项通过 |
| 2026-11-09 | 6. 移除 ffmpeg.wasm 回退 | 32e7523 | 删除 FFmpegEngine / subtitleOverlayVideo / 注册；`pnpm tsc -b --noEmit`、`pnpm check:host` 通过 |
| 2026-11-09 | 7. 打包与真实验收 | 本记录提交 | `pnpm tauri:build` 成功；安装包内 `.node` 与 OTF 字体存在；打包后的 `@napi-rs/canvas` 注册字体并画出 3749 个 alpha 像素 |
| 2026-11-09 | 8. 移除 ASS 硬烧兼容 | 32e7523 | 删除 `assContent` / Host 分支 / `buildBurnAssContent`；新增 `subtitle-file-export.test.ts`，ASS 文件导出 2 项通过 |

## 性能与真实使用记录

### Host 20 / 60 分钟 1080p 导出（本机 Apple Silicon，macOS，FFmpeg 8.0.1）

同一份 1920×1080、30 fps、口播式字幕（每 3 秒一条，静态主字幕），编码 libx264 veryfast crf 23 + aac，`overlay format=yuv420`，只渲染字幕条带：

| 场景 | 时长 | 字幕条数 | Skia 总耗时 | 实时倍数 | ASS 基线（历史） | 比值 | Node 峰值 RSS |
|---|---:|---:|---:|---:|---:|---:|---:|
| 20 分钟 | 1200 s | 399 | 52.7 s | 22.8× | 47.5 s | 1.11× | 493 MB（含基准进程上传缓冲） |
| 60 分钟 | 3600 s | 1199 | 163.2 s | 22.1× | 139.1 s | 1.17× | 543 MB（复用已有资产，独立进程） |

- 静态样式门槛为不慢于 ASS 的 1.2 倍，20 / 60 分钟均通过。ASS 基线是在移除旧 Host 兼容分支前测得的；现在产品不再有 ASS 硬烧路径，这个数字只作历史对照。
- 60 分钟第一次基准在同一进程里先跑了 20 分钟并上传 56 MB 素材，Node RSS 达到 754 MB；上表 543 MB 是复用已上传资产的干净进程结果。峰值高于 F-0016 的 329 MB，主要来自 60 分钟场景排版缓存和每次 cue 变化的 Skia `getImageData` 临时缓冲；耗时已达标，内存优化留作后续。
- 取消和失败路径：Host 导出取消会终止 FFmpeg 并删除输出；缺字体用例返回「字幕渲染不可用」且不留半成品。

### 系统 WKWebView 预览（非验收数据）

用 F-0016 的 `wkrunner`（系统 WKWebView 605.1.15）加载生产图形层，1080p30、30 秒、画布 1920×1080、同一字幕条按 `frameKey` 缓存：

| 次数 | 帧数 | 跳过帧 | 掉帧率 | 20 次拖动 p95 |
|---|---:|---:|---:|---:|
| 1 | 596 | 2 | 0.33% | 102 ms |
| 2 | 582 | 16 | 2.68% | 89 ms |
| 3 | 589 | 9 | 1.50% | 102 ms |
| 最终版 | 592 | 7 | 1.17% | 104 ms |

窗口报告 `window visible: false, onActiveSpace: false`，与 F-0016 记录的「测试窗口不在当前 Space」一致。数据波动大，**不作为 AC-2 的验收证据**；真实 Tauri 前台窗口的掉帧和 100 ms 补画仍需维护者在有活动桌面的环境重测。

### 打包

- `pnpm tauri:build` 产出 `FlyCut Caption.app`（342 MB）和 `FlyCut Caption_2.0.2_aarch64.dmg`（128 MB）。
- App 的 `Contents/Resources/host/node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node` 存在；`Contents/Resources/shared_assets/subtitle-fonts/` 含 OTF / TTF。
- 在打包资源目录中直接运行打包后的 `@napi-rs/canvas`，注册 Noto OTF 并绘制「离线字幕测试」，alpha 像素 3749，证明资源路径和原生模块可加载。
- 用 App 内的 `binaries/flycut-node`、`host/lib/main.mjs`、内置 FFmpeg 和 Resources 字体启动打包后的 Host，离线导出一段 2 秒 320×180 硬字幕视频：输出 4,880 字节、时长 2 秒、1 秒帧检出 1,429 个高亮字幕像素。

## 自行决定的事项

- 场景 v1 只覆盖现有静态样式；没有提前加入动画字段。`frameKey` 在同一 cue 内稳定，预览和 Host 都可跳过重复绘制。
- 预览画布按 DPR（上限 2）绘制；同一 cue 只重画一次。真实 Tauri 窗口的掉帧数据不足，暂不引入 Worker。
- 完整字体替换原来的 `@fontsource` 分片 woff2；同时删除未再引用的 `@fontsource/noto-sans-sc`、`@fontsource/inter` 依赖和旧 woff2 / Noto TTF，避免同一字体有两套来源。
- Arial / Georgia 保留为系统字体选项；Host 用 `GlobalFonts.has` 检查，缺失时明确报错，不静默替代。
- 按维护者 2026-11-09 的决定，WebAV / ffmpeg.wasm 本地回退整体移除，Host 是唯一导出路径；没有 Host 时导出入口显示 Host 不可用。
- ASS 只用于字幕文件导出；`assContent`、Host 的 ASS 硬烧分支和 `buildBurnAssContent` 已删除。

## 与设计的偏差

- Host 单片段 + 硬字幕回退路径改用 `trim/atrim` + `fps` 滤镜，而不是 `-ss` 输出选项。原因是叠加字幕层需要输出时间轴从 0 开始，`-ss` 与 `overlay` 组合会让字幕相位错位。
- `server/subtitle-render.ts` 在 Host 进程里为 Pretext 安装了一个基于 `@napi-rs/canvas` 的 `OffscreenCanvas` 测量垫片；Pretext 只接受 OffscreenCanvas 或 DOM canvas，Node 里没有前者。该垫片只在 Host 进程生效。
- 场景通过 RPC 发送的是投影后的 cue 数据，不含原始 transcript；60 分钟场景约 1199 条，消息大小和导出耗时已记录。
- 本地回退删除后，`VideoEngineType` 只剩 `host`；导出对话框直接显示 Host 检查结果，不再按 Tauri / Web 分支显示 WebAV 或 FFmpeg 文案。

## 遗留问题

- **真实 Tauri 窗口性能未验收**：当前会话没有活动桌面，WKWebView 窗口不可见；掉帧率在 0.33%–2.68% 间波动，拖动 p95 89–102 ms。需要在维护者前台 Tauri 窗口重测 1080p30 多次，并把结果补进 04。
- **本地回退已移除**：ffmpeg.wasm 的真实编码不再需要验收；WebAV 也不再是交付路径。
- **Windows / Linux / Cloud**：按 F-0029 处理，未在本需求宣称三端一致。
- **签名 / 公证**：安装包可构建，但未做开发者签名和 notary；属于 F-0057。


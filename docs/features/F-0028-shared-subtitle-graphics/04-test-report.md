---
id: F-0028
stage: 04-test-report
status: review
approved_by:
approved_at:
---

# F-0028 共用字幕图形层落地：测试与验收

## 结论

功能主线已完成并通过本机能做的检查：共用图形层、完整字体、预览的 rVFC / seeked、Host 的 Skia 条带导出和 macOS 安装包内的完整 Host 离线导出。按维护者 2026-11-09 的决定，WebAV / ffmpeg.wasm 本地回退和 ASS 硬烧兼容路径已移除，Host 是唯一导出路径；ASS 字幕文件导出保留。**AC-2 的真实 Tauri 前台窗口性能没有在本会话完成**，原因见 AC-2 和「未执行项」。

## 验证环境

| 项目 | 值 |
|---|---|
| 机器 | macOS 26.6.2，Apple Silicon（arm64，10 核） |
| Node | 24.6.0 |
| FFmpeg | 项目内置 `src-tauri/binaries/ffmpeg`，8.0.1 |
| 浏览器 | Google Chrome（Playwright 默认本机 Chrome）；系统 WKWebView 605.1.15 |
| 字体 | Noto Sans SC Regular / Bold OTF，Inter Regular / Bold TTF（OFL） |
| 素材 | 640×360 / 1920×1080 的本地生成暗色视频；Host 基准使用 20 / 60 分钟 1080p30 合成口播素材 |
| 分支 | `codex/f0028-shared-subtitle-graphics` |

## 验收标准

### AC-1 静态样式迁移、1080p 换行和包围盒

**结果：通过（本机 Node + Chromium 图形层）。**

- `tests/architecture/subtitle-graphics-f0028.test.ts` 5 项通过：场景 schema、中文标点清理 / 换行、主副字幕位置、三种画幅、全部现有样式字段、`frameKey`。
- 同一条幕在整帧渲染与条带裁剪渲染的 alpha 包围盒偏移 ≤ 2 px，见测试「band crop keeps the same bbox as a full-frame render」。
- 画面标点清理沿用现有 `stripSubtitleDisplayPunctuation`，主副字幕样式、背景框、描边、下划线、字间距、左中右对齐和手绘阴影都有渲染测试。
- 未覆盖：把旧版预览的截图与新版预览逐像素直接对比；本需求验证的是预览 / Host 共用同一场景，以及条带与整帧一致。

### AC-2 完整字体、按帧绘制、拖动补画、真实 Tauri 流畅度

**结果：功能与字体通过；真实 Tauri 性能门槛未完成。**

- 前后端读取同一份 Noto / Inter 字体文件；`cmp` 确认 `public/fonts/subtitle` 与 `src-tauri/shared_assets/subtitle-fonts` 字节一致。
- 预览用 `requestVideoFrameCallback` 的 `mediaTime` 绘制；暂停拖动监听 `seeked` 补画。E2E 在 120 ms 内读取到正确帧。
- 同一 cue 的 `frameKey` 不变；20 秒播放中每条 cue 只在进入和离开时各画一次（最终版 14 次 / 20 秒），无字幕区间 alpha 为 0。
- 系统 WKWebView 四次测量：掉帧 0.33% / 2.68% / 1.50% / 1.17%，拖动 p95 102 / 89 / 102 / 104 ms。窗口报告 `visible: false, onActiveSpace: false`，数据不作为验收证据。
- **真实 Tauri 前台窗口 1080p30 多次测量：Not run（当前会话没有活动桌面）。**

### AC-3 Host Skia 条带、FFmpeg overlay 与性能

**结果：通过（20 / 60 分钟静态样式）。**

- 真实 Host 640×360 导出：cue 帧检出字幕像素，字幕间隙完全透明，没有 ASS 临时文件；缺字体时报「字幕渲染不可用」。
- 20 分钟 1080p30：Skia 52.7 s（22.8×），ASS 47.5 s（25.2×），比值 1.11；Node 峰值 493 MB（基准进程含上传缓冲）。
- 60 分钟 1080p30：Skia 163.2 s（22.1×），ASS 139.1 s（25.9×），比值 1.17；复用已上传资产的独立进程 Node 峰值 543 MB。
- 静态样式门槛 1.2 倍通过。动画场景本轮未实现，1.5 倍门槛留作架构余量。
- 取消沿用 Host Job 的 AbortSignal；既有的 Export 取消 / 失败测试仍通过。新路径失败不会留下输出或临时 ASS。

### AC-4 Host 唯一导出、ASS 文件导出与 macOS 包

**结果：Host 与 macOS 资源通过；安装包内完整 Host 导出未完成。**

- 本地回退：WebAVEngine、FFmpegEngine、SubtitleGraphicsClip、subtitleOverlayVideo 和 `@webav/*` 依赖已删除；`VideoEngineType` 只剩 `host`，前端只注册 Host。
- ASS 硬烧：`assContent`、Host 的 ASS 硬烧分支和 `buildBurnAssContent` 已删除；新硬字幕只接受 `subtitleScene`。
- ASS 文件导出：`serializeSubtitleExport('ass', …)` 仍走 `chunksToAss`，生成 `[Script Info] / [V4+ Styles] / [Events]`；新增 `subtitle-file-export.test.ts` 2 项通过，覆盖 Bilingual / Main / Second 和标点清理。SRT / VTT / JSON / ASS 文件导出及 mov_text / WebVTT 软轨不变。
- macOS 包：`pnpm tauri:build` 成功；App 内存在 `skia.darwin-arm64.node` 和 OTF 字体；用 App 内的 `flycut-node` 启动完整 Host，离线导出 2 秒 320×180 硬字幕视频，输出 4,880 字节、时长 2 秒、1 秒帧 1,429 个高亮字幕像素。

### AC-5 入口、空态、字体载入中

**结果：通过。**

- 不新增技术入口，沿用播放器 / 样式面板 / 导出入口。
- 空字幕和字幕间隙画布 alpha 为 0，不显示加载提示。
- 字体加载中显示「正在加载字幕字体… / Loading subtitle fonts…」，不在加载完成前用替代字体画最终字幕。
- 截图：`subtitle-empty-light.png`、`subtitle-empty-dark.png`、`subtitle-loading-en.png`。

### AC-6 载入与导出中、旧任务隔离

**结果：通过（功能）；导出取消沿用既有 Host 测试。**

- 字体就绪后才绘制首帧；字体加载完成会触发一次补画。
- 预览不阻塞其他视频操作；旧视频 / 旧 cue 的异步绘制由当前场景与 `frameKey` 校验，旧任务不会覆盖新画面。
- 导出继续使用 Host Job 进度和取消；Host 取消时停止 rawvideo 写入并终止 FFmpeg。
- 未单独新增「旧视频快速切换」E2E；现有切换视频测试仍通过。

### AC-7 样式字段兼容、重开外观、字体与场景版本

**结果：通过（未改变持久化格式）。**

- `SubtitleStylePair` 字段和预设没有改；场景适配只读取现有字段。
- 场景包含 `version: 1`、`fontId`、`fontFamily`；预览 canvas 暴露 `data-subtitle-scene-version="1"`。
- 旧项目 / 恢复副本不需要迁移；现有项目保存、重开、恢复测试全部通过。
- 新增字体文件不改变项目里的样式字段，重开时由字体 id 重新解析。

### AC-8 失败与重试

**结果：通过。**

- 字体请求失败显示「字幕渲染不可用」、失败原因和「重试」；重试成功后恢复绘制。
- Host 缺字体返回「字幕渲染不可用：Host 找不到随包完整字体目录」，导出进入 error，不写半成品。
- 原生模块缺失 / 注册失败同样抛可读错误；新场景路径不自动改用 ASS 或系统替代字体。
- E2E：`subtitle-error-light.png`、`subtitle-error-dark.png`；架构测试覆盖缺字体。

### AC-9 中英文、明暗主题、真实使用与回归

**结果：本机能覆盖的界面通过；真实 Tauri / 其他平台未完成。**

- E2E 7 项通过：预览、空字幕、失败重试、中英文、明暗主题。
- 截图 7 张、录屏 7 段，位于本需求目录的 `screenshots/` 和 `recordings/`。
- 真实 Mac 安装包资源加载通过；安装包内完整 Host 导出 Not run。
- Windows / Linux / Cloud 按 F-0029，未在本需求宣称。

## 执行过的检查

- `pnpm lint` ✅
- `pnpm tsc -b --noEmit` ✅
- `pnpm check:host` ✅
- `pnpm test` ✅（68 通过，3 跳过：未下载的模型）
- `pnpm test:architecture` ✅（66 通过，含 F-0028 图形层 / Host 导出 / ASS 文件导出）
- `pnpm build` ✅
- `pnpm package:host` ✅（31 个 Host 依赖，含 `@napi-rs/canvas-darwin-arm64`）
- `pnpm tauri:build` ✅（App 342 MB，DMG 128 MB）
- `pnpm e2e:evidence F-0028` ✅（7 通过，截图 7，录屏 7）
- `cargo check --manifest-path src-tauri/Cargo.toml` ✅（构建过程中通过）

## 设计与实现摘要

- 新增 `shared/subtitle-graphics/`：场景 schema、Pretext 排版、`drawFrame`、`frameKey`、`subtitleBand`、字体资产清单。
- 预览改走共用场景，`requestVideoFrameCallback` + `seeked`，DPR 上限 2，静态 cue 缓存。
- Host 新增 `server/subtitle-render.ts`：动态加载 Skia、注册完整字体、计算条带；`export.start` 新增 `subtitleScene` / `subtitleTransport: 'skia-band'`，rawvideo 走 stdin，overlay 强制 `format=yuv420`。
- WebAV / ffmpeg.wasm 本地回退已按维护者决定删除；Host 是唯一导出引擎。
- 字体资源统一到完整 OTF / TTF，删除旧 `@fontsource` 分片依赖和未使用 woff2 / Noto TTF。
- 具体决策和偏差见 `03-implementation.md`。

## 自行决定的事项

见 `03-implementation.md` 的「自行决定的事项」：场景只做静态样式、DPR 上限 2、完整字体替换分片字体、Arial / Georgia 保留系统字体并在 Host 检查、Host 唯一导出、ASS 只用于文件导出。

## 与设计的偏差

见 `03-implementation.md` 的「与设计的偏差」：单片段 + 硬字幕改用 trim/atrim、Host 为 Pretext 安装 OffscreenCanvas 垫片、通过 RPC 只传投影后的 cue、移除本地回退和 ASS 硬烧兼容路径。

## 未执行项

- 真实 Tauri 前台窗口 1080p30 多次掉帧 / 拖动 100 ms 测量（当前会话窗口不可见）。
- Windows / WebView2 / Linux / Cloud。
- 开发者签名与 notary（F-0057）。


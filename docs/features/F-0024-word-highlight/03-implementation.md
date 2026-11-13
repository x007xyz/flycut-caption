---
id: F-0024
stage: 03-implementation
status: approved
approved_by: auto
approved_at: 2026-11-12
---

# F-0024 逐字高亮字幕：开发记录

## 分支与 PR

- 分支：`codex/f0024-word-highlight`
- PR：仓库流程要求由父代理协调；本 worker 不 push、不创建 PR。

## 进度

| 日期 | 清单项 | 提交 | 检查 |
|---|---|---|---|
| 2026-11-12 | 技术设计 | 本提交 | `pnpm feature review F-0024` 自动确认 02 并创建 03 |
| 2026-11-12 | 1. 共用场景与词元渲染 | 本提交 | `word-highlight-f0024.test.ts` 4 通过；`pnpm exec eslint shared/subtitle-graphics tests/architecture/word-highlight-f0024.test.ts`、`pnpm tsc -b --noEmit`、`pnpm check:host` 通过；Red check 移除词感知 key 后 frameKey 测试失败 |
| 2026-11-12 | 2. 预览与样式 UI | 本提交 | 架构测试 5 通过；F-0024 Playwright 7 通过（中英、明暗、改色、词间空隙、倍速 seek、无词降级、字体加载）；`pnpm tsc -b --noEmit`、`pnpm check:host`、targeted eslint 通过；Red check 错误隐藏降级提示时 E2E 失败 |
| 2026-11-12 | 3. Host 导出与 EDL 投影 | 本提交 | 架构测试 8 通过；真实 Host / FFmpeg 成片逐词红字中心移动、词间无伪高亮、无词整句降级、无 ASS 临时文件；静态检查通过；Red check 漏传词元时 export.request 测试失败 |
| 2026-11-12 | 4. 持久化、重开与生命周期证据 | 本提交 | `pnpm e2e:evidence F-0024` 13 通过、截图 15 张、录屏 13 段；高亮样式保存后重开保持普通色/高亮色；空字幕不绘制、不误报降级；中英文与明暗主题 loading/error/retry 通过；`pnpm tsc -b --noEmit`、`pnpm check:host`、targeted eslint 通过 |
| 2026-11-12 | 5. 真实媒体验收与文档 | 本提交 | Web 真实口播预览与 Host 成片通过；macOS Tauri 隔离包真实预览、Host 导出和媒体加载通过；`pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`、`pnpm test`（90 通过 / 8 前置缺项跳过）、`pnpm test:architecture`（100 通过）、`pnpm build`、临时 target 的 `cargo check` 通过 |
| 2026-11-12 | 验收期 E2E 稳定化 | 本提交 | 先等 mock 首页 RPC 完成再切换编辑器 hash；字体失败先断言全局错误再应用预设；持久化用可见的“立即保存”；`pnpm test:e2e tests/e2e/features/F-0024.spec.ts --workers=1` 13/13，`pnpm e2e:evidence F-0024` 13/13、截图 17、录屏 13 |

## 自行决定的事项

- 逐字高亮按样式保存，主副字幕可分别启用；副字幕译文没有对齐词元时明确按整句降级。
- 场景继续使用 v1，新增样式字段均为可选，旧项目与恢复副本无需迁移。
- WKWebView 可能在 React 订阅前已完成视频元数据加载，且 `ResizeObserver` 可能没有初始条目；播放器先读取已就绪元素，再以容器 DOM 尺寸补足首个可绘制尺寸。
- 真实素材验收使用仓库已验收的 Bilibili 口播视频与 `transcript.json` 字词时间，不重新做 ASR；视频切出前 8 秒并保留真实音轨。
- F-0024 的桌面验收复用 F-0058 的 WebDriver 包流程，但提供 `FLYCUT_ACCEPTANCE_ONLY=f0024` 以便只跑本需求且不依赖共用 5173。
- 完整架构测试暴露 F-0014 的 WebSocket 引导帧断言在 `open` 后立即 terminate，存在测试自身竞态；改为等 `host/ready` 和 `jobs/snapshot` 都到齐后再关闭，不改变产品代码。

## 与设计的偏差

- 预览额外修复了 F-0028 在 WKWebView 的两个时序缺口：已就绪元数据没有被重新读取，以及容器尺寸没有初始 `ResizeObserver` 值时字幕层不挂载。两者均不改场景或项目数据。
- 播放器验证在浏览器 / Tauri 媒体元素中加载成片并核对时长与尺寸；“用系统 QuickTime 打开”因当前 macOS 会话锁定未执行，见测试报告 Not run。
- 仓库目前没有独立的 CLI / MCP 客户端入口；已验证其必须复用的 `export.start` 场景契约和真实 Host 处理，不能据此宣称 CLI / MCP 端到端已运行。

## 遗留问题

- Windows、WebView2、Linux、Cloud 与远程 Host 未验收；Windows / Cloud 属于 F-0029 范围。
- 真实 Tauri 包内的 `@napi-rs/canvas`、FFmpeg 和字体均可用，但本机 Homebrew Node 26 的 `flycut-node` 需要手工把 `libnode.147.dylib` 放进临时验收包后才能启动。该文件只存在于 `/private/tmp` 验收包，未改打包脚本，也不代表发布包已修复。
- 最终代码提交后受维护者协调约束，未再次占用 5173 重跑 Playwright；15 张截图与 13 段录屏来自提交 `9889e63`，之后仅增加播放器尺寸回退与验收脚本，真实 Tauri 已复测。

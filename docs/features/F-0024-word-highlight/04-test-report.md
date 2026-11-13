---
id: F-0024
stage: 04-test-report
status: review
approved_by:
approved_at:
---

# F-0024 逐字高亮字幕：测试与验收

验收在代码与测试 commit `ea9a088` 上进行；本报告后续提交只包含需求文档与已生成截图。

> 技术设计和开发阶段由 agent 连续推进、自动确认；维护者在这里一并审阅。

## 设计与实现摘要

沿用 F-0028 的唯一 Canvas 2D 图形层，在场景 v1 中消费已有的可选 `cues[].words`，并增加向后兼容的逐字高亮模式和颜色。客户端只从通过校验、文本可映射且时间位于句内的词元生成高亮；缺失、错序、越界、文本不一致或副字幕译文都明确使用整句高亮，不按字数估算。`frameKey` 纳入当前词索引，预览和 Host 的 Skia 条带都调用同一个 `drawFrame`。

预览使用原始媒体时间，导出在开始时冻结字幕和词元，再按既有 EDL 投影到成片时间并通过原有 `export.start.options.subtitleScene` 发送。没有新增 RPC、项目格式或存储迁移；本项目没有新的 ADR，继续执行 ADR-0006。

Tauri 实机发现并修复了 F-0028 的两个嵌入式 WebView 时序缺口：视频元数据早于 React effect 就绪时要主动读取一次尺寸；`ResizeObserver` 没有初始条目时用容器 DOM 尺寸回退。另修复了 F-0014 架构测试在 WebSocket `open` 后立即关闭、偶尔收不到 `jobs/snapshot` 的测试竞态。

## 自行决定的事项

<!-- 技术设计和开发阶段 agent 自己决定的事，逐条：决定了什么、为什么、影响哪条 AC。需要维护者拍板的标「请确认」 -->

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| 启用粒度 | 高亮配置跟随主/副字幕样式 | 复用现有预设、样式存储和项目样式来源；副字幕没有独立对齐词元时整句降级 | AC-1、AC-3、AC-7 |
| 场景兼容 | 继续使用 v1，新字段均为可选 | F-0028 已预留 `words`；旧项目、恢复副本和未知旧客户端无需迁移 | AC-4、AC-7 |
| 高亮外观 | 首版只换不透明文字填充，保留原描边、背景和阴影 | 满足可调普通色/高亮色，避免引入未要求的透明度或动画参数 | AC-1 |
| 坏词元处理 | 任一词元无法证明映射时，该句整句降级 | 不把缺失数据伪装成逐字精确高亮 | AC-2、AC-8 |
| WKWebView 尺寸 | 元数据已就绪时补读；观察值为空时用容器 rect | 修真实 Tauri 中字幕 canvas 不挂载的问题，不改变正常浏览器路径 | AC-1、AC-5、AC-9 |
| F-0014 测试 | 等 `host/ready` 与 `jobs/snapshot` 都到齐后再 terminate | 原测试在并行架构套件下存在自身竞态；产品行为不变 | AC-9 回归 |
| F-0024 E2E 入口 | 等待 mock 首页 RPC 完成后再切换编辑器 hash；字体失败先断言全局 overlay；持久化点击“立即保存” | 串行复跑暴露的是测试启动/可点击性竞态；保留真实按钮可见、启用和最终保存断言，不延长超时掩盖 | AC-4、AC-6、AC-7、AC-8、AC-9 |

## 验收标准逐条结果

| AC | 验证方式 | 证据 | 结果 |
|---|---|---|---|
| AC-1 | 架构、真实编辑器、真实媒体 | `word-highlight-f0024.test.ts` 当前词/词间空隙/三画幅/主副显示；F-0024 E2E 改色、暂停、2× 后 seek；真实 Web/Tauri 两词红字中心前移 | ✅ |
| AC-2 | 架构 + 中英文 E2E | 缺词、错序、越界、文本不一致均关闭词元；界面显示「使用整句高亮 / Using sentence highlighting」；无词画面整句换色 | ✅ |
| AC-3 | 共用场景、条带、真实截图 | 1080p 三画幅 × 主/副/双语可见；同场景完整画布与 Skia 条带颜色包围盒差 ≤2px；真实 Web/Tauri 使用同一场景 | ✅ 共享语义与条带；⏸ 未单独编写 Chromium↔Skia 1080p 像素抽样 |
| AC-4 | 真实 Web/Tauri + 重开 | 真实 Bilibili 口播 8 秒、真实 `transcript.json` 词元完成预览、Host 成片、媒体元素加载；E2E 保存后重开保持高亮颜色；未改正文/词时间 | ✅ 桌面/Web；⏸ CLI/MCP 可执行入口（仓库无该客户端，已验证共用 `export.start` 契约） |
| AC-5 | E2E + 现有项目状态 | 空字幕画布 alpha=0 且不误报降级；字体加载中、失败、重试均保留；无新增假入口 | ✅ |
| AC-6 | E2E + F-0028/Host | 字体加载时 canvas 不画替代字体；真实 Host 任务进度/取消/旧任务隔离继续走现有实现 | ✅ |
| AC-7 | E2E + Host | 样式保存为 Host 不透明记录，刷新重开保持 `#00FF00` 普通色和 `#FF0000` 高亮色；失败不提示完成 | ✅ |
| AC-8 | E2E + 架构 | 字体失败显示原因和「重试」，重试后恢复；无词降级；缺字体 Host 导出失败且无半成品 | ✅ |
| AC-9 | E2E 截图/录屏 + 真机 | 中英文、明暗主题 normal/gap/loading/error/fallback/empty/reopen 共 15 张 Playwright 截图；另有真实 Web/Tauri 2 张；桌面和 Web 均通过 | ✅ 桌面/Web；⏸ Windows/Linux/Cloud 与系统 QuickTime UI（见 Not run） |

## 界面证据

| 界面 | 状态 | AC | 截图 | 录屏 |
|---|---|---|---|---|
| 字幕样式 / 播放器 | 当前词、词间空隙，明暗 | AC-1、AC-9 | `screenshots/word-highlight-current-{light,dark}.png`、`screenshots/word-highlight-gap-{light,dark}.png` | `recordings/` 对应 13 段本地录屏 |
| 字幕样式 / 播放器 | 无可靠词元，中英、明暗 | AC-2、AC-9 | `screenshots/word-highlight-fallback-{light,dark}.png`、`word-highlight-fallback-en-{light,dark}.png` | 同上 |
| 字幕样式 / 播放器 | 空字幕，明暗 | AC-5、AC-9 | `screenshots/word-highlight-empty-{light,dark}.png` | 同上 |
| 字幕样式 / 播放器 | 字体加载中，明暗 | AC-6、AC-9 | `screenshots/word-highlight-loading-{light,dark}.png` | 同上 |
| 字幕样式 / 播放器 | 字体失败与重试，明暗 | AC-8、AC-9 | `screenshots/word-highlight-error-{light,dark}.png` | 同上 |
| 字幕样式 / 播放器 | 保存后重开 | AC-4、AC-7 | `screenshots/word-highlight-reopened-light.png` | 同上 |
| 真实 Web / Tauri | 真实口播预览 | AC-4、AC-9 | `screenshots/word-highlight-real-web.png`、`word-highlight-real-tauri.png` | 录屏只在本地 |

Playwright 证据已在修复后的 commit `ea9a088` 上由 `pnpm e2e:evidence F-0024` 重新生成：13 通过、15 张 Playwright 截图、13 段本机录屏；加上真实 Web/Tauri 截图共 17 张。

## 回归检查

- `pnpm lint` ✅
- `pnpm tsc -b --noEmit` ✅
- `pnpm check:host` ✅
- `CARGO_TARGET_DIR=/private/tmp/f0024-cargo-check cargo check --manifest-path src-tauri/Cargo.toml` ✅（不污染工作树 target）
- `pnpm test` ✅（90 通过，8 跳过：缺少 SenseVoice ASR 模型目录）
- `pnpm test:architecture` ✅（100 通过）
- `pnpm build` ✅
- `pnpm feature check` ✅（58 个需求，依赖正常）
- `pnpm acceptance:web` ✅（真实 8 秒口播与真实词时间戳；预览、Host 成片；运行于最终 WKWebView 专用修复前）
- `FLYCUT_ACCEPTANCE_ONLY=f0024 pnpm acceptance:tauri <临时 App>` ✅（最终代码；真实预览、Host 成片、媒体元素加载）
- `pnpm test:e2e tests/e2e/features/F-0024.spec.ts --workers=1` ✅（13/13，最终测试提交）
- `pnpm e2e:evidence F-0024` ✅（13 通过、15 张 Playwright 截图、13 段本地录屏）

Red check 三次均命中预期：移除 `frameKey` 当前词状态时词边界测试失败；把缺失词元误判为可靠时整句降级 E2E 失败；`HostExportEngine` 漏传冻结词元时导出请求测试失败。

## 发现的问题

- 已修复：WKWebView 可在 React 订阅前完成 `loadedmetadata`，且嵌入式无头会话可能拿不到 `ResizeObserver` 初始尺寸，导致字幕 canvas 不挂载。最终 Tauri 验收通过。
- 已修复测试竞态：F-0014 WebSocket 测试在收到两个引导帧前就 terminate；现在等待 `host/ready` 与 `jobs/snapshot` 后断言。
- 已修复 F-0024 E2E 时序：直接深链会在 mock 首页初始化完成前偶发回退；字体失败是全局 overlay 状态，原测试却先等待预设可点击；持久化依赖自动保存计时。现在改为等待首页 RPC、先断言字体错误并重试、显式点击保存，再做全部业务断言。
- 环境限制：本机 Homebrew Node 26 的 `flycut-node` 动态依赖 `libnode.147.dylib`；仅把该库补进 `/private/tmp` 的验收 App 后才完成 Tauri 验证。发布打包仍需单独处理这一本机环境差异。
- 环境限制：当前 macOS 会话锁定，无法用系统 QuickTime Player 做人工 UI 打开；已用 Tauri 媒体元素加载同一导出文件并核对 8.01 秒、852×480、音视频流。
- 调整：`src-tauri/target-acceptance` 已清理；所有 Cargo 构建和检查使用 `/private/tmp`。`tests/media` 未提交。

## Not run

- 独立 Chromium↔Skia 1080p 渲染截图逐像素包围盒对比：本轮未单独编写该跨引擎采样；共用场景的 Skia 完整画布 vs 条带 ≤2px 已通过。
- CLI/MCP 实际入口：仓库当前没有独立 CLI/MCP 客户端可执行；已验证两者必须复用的场景/RPC 契约与真实 Host 导出。
- Windows / WebView2 / Linux / Cloud / 远程 Host：无对应环境；跨平台由 F-0029 跟踪。
- 系统 QuickTime Player 人工打开：macOS 会话锁定；Tauri 媒体元素加载与 FFmpeg 解码已通过。

## 结论

功能实现和本机可运行的验收均已完成，桌面与 Web 使用同一真实素材和词时间戳通过；没有需要返工的已知产品缺陷。当前仍有 AC-3 的独立跨引擎 1080p 像素抽样、AC-4 的 CLI/MCP 可执行入口和其他平台未跑，不能把它们写成通过。请维护者据此完成最终验收；本 worker 不批准、不 push、不发布。

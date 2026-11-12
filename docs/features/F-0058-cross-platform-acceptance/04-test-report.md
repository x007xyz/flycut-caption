---
id: F-0058
stage: 04-test-report
status: review
approved_by:
approved_at:
---

# F-0058 Web 与桌面共用自动化验收：测试与验收

验收在实现提交 `11c5a49` 上进行；本报告作为随后的文档提交。

> 技术设计和开发阶段由 agent 连续推进、自动确认；维护者在这里一并审阅。

## 设计与实现摘要

Web Chrome 与真实 macOS WKWebView 共用一份字幕保存用例。两端各自创建隔离的固定项目，从界面修改字幕并失焦，读取真实 Host 的正式编辑快照，再返回项目列表重新打开并断言文字仍存在。

macOS 测试驱动由默认关闭的 `acceptance-webdriver` Cargo feature 注册，只编译进独立标识的 debug 测试包。测试按本次构建的绝对路径和独立 HOME 启动应用，并用应用 PID 确认 WebDriver 端口属于本次实例；常规安装包没有测试驱动或测试权限。

无驱动包冒烟会启动本次构建的普通 macOS 应用，等待随包 Host，通过现有上传和导出接口生成 3 秒中文字幕 MP4，并检查音视频轨、时长、cue 内亮像素和 cue 外黑场。复制候选包后移除随包 Node 或字幕字体，分别断言启动和导出失败。

本次还修复了两个由真实包检查暴露的问题：Host 包漏声明 `@chenglou/pretext`，以及 Tauri 的 `_up_` 资源根无法找到相邻字幕字体。没有新增 ADR。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| 桌面测试构建 | 使用 `acceptance-webdriver` feature 和独立 `com.flycut.caption.acceptance` 标识 | 驱动必须只存在于显式测试产物，且不能连接到旧安装版 | AC-1、AC-2 |
| 提交字幕修改 | 两端都点击真实「全选」按钮使文本框失焦 | macOS 嵌入驱动不执行 Tab 的原生焦点切换；按钮点击仍走产品交互 | AC-1 |
| 无驱动语义 | 把「不带驱动」单独编译并用应用 PID 检查监听端口 | 单纯关掉连接不能证明测试包没有注册驱动 | AC-2、AC-3 |
| 字幕画面断言 | 固定黑底短片，比较 cue 内亮像素与 cue 外黑场 | 不依赖截图识别或实时 ASR，断言可复跑 | AC-3 |
| Host 字体路径 | 仅当资源根为 `_up_` 时增加相邻 `shared_assets` 候选 | 保持开发与普通资源根行为，不扩大文件搜索范围 | AC-3 |
| 随包 Node | 普通包缺少 `flycut-node` 时直接失败并写诊断，不再回退到系统 Node | 防止测试机碰巧装有 Node 而让缺失资源的包假通过 | AC-3 |

## 验收标准逐条结果

| AC | 目标平台 / 环境 | 验证方式、用例与命令 | 证据或未跑原因 | 结果 |
|---|---|---|---|---|
| AC-1 | Web Chrome + 真实 Host | `pnpm acceptance:web` | 输出 `PASS F-0058/AC-1: subtitle persisted on Host and survived reopening` | ✅ |
| AC-1 | macOS 26 / 真实 WKWebView + 真实 Host | `pnpm acceptance:tauri <本次构建的 FlyCut Acceptance.app>` | 同一 `subtitle-persistence.ts` 输出 `PASS F-0058/AC-1`；无旧安装版串连 | ✅ |
| AC-2 | 本次 macOS 测试构建 | 独立标识、绝对可执行路径、隔离 HOME；创建临时端口后检查应用 PID 持有监听 | `PASS F-0058/AC-2: independent macOS Tauri bundle and WebDriver session` | ✅ |
| AC-2 | 普通 macOS 候选包 | 不带 feature 构建；脚本断言应用 PID 没有监听测试端口 | 普通包冒烟通过，默认包未注册驱动 | ✅ |
| AC-3 | 无驱动 macOS 包 / 随包 Host | `pnpm acceptance:bundle <FlyCut Caption.app>` | 输出 `PASS ... exported video, audio and visible subtitles`；ffprobe 为 3 秒、含 video/audio | ✅ |
| AC-3 | 缺随包 Node | 对候选包副本移除 `binaries/flycut-node` 后启动 | 输出 `PASS ... missing Node fails at startup`；日志含“随包 Node 不可用”，未生成连接文件 | ✅ |
| AC-3 | 缺字幕字体 | 对候选包副本移除 `shared_assets/subtitle-fonts` 后导出 | 输出 `PASS ... missing font fails during hard subtitle export`；错误含“字幕渲染不可用” | ✅ |
| AC-4 | 本机 | [自动化验收方案](../../../30-engineering/acceptance-testing.md) 列出 Web、桌面和普通包三条命令 | 命令已写入文档；现有 Playwright 入口仍在 | ✅ |
| AC-4 | macOS CI | `.github/workflows/acceptance-macos.yml`，三个目标各自记录日志并在失败时上传 | 本分支尚未推送，CI 实际运行 ⏸ Not run | ⏸ |

## 界面证据

无界面改动。验收通过真实 Chrome/WKWebView 操作既有项目、字幕文本框和项目列表；失败截图与日志在本地 `test-results/`。

## 回归检查

- `pnpm lint` ✅
- `pnpm tsc -b --noEmit` ✅
- `pnpm check:host` ✅
- `cargo check --manifest-path src-tauri/Cargo.toml` ✅
- `cargo check --manifest-path src-tauri/Cargo.toml --features acceptance-webdriver` ✅
- `pnpm test` ✅：90 passed，8 skipped（本机未配置 ASR 模型）
- `pnpm test:architecture` ✅：92/92，含 `F-0058/AC-3 packaged Host finds fonts...`
- `pnpm acceptance:web` ✅
- `pnpm acceptance:tauri <absolute app path>` ✅
- `pnpm acceptance:bundle <absolute app path>` ✅
- `pnpm test:e2e tests/e2e/features/F-0002.spec.ts --workers=1` ✅：36/36，既有 Playwright 入口保持可用
- 普通包和测试包分别用独立 Cargo 输出目录构建，避免互相覆盖。

## 发现的问题

- Host 打包遗漏运行依赖 `@chenglou/pretext`，最初两个 macOS 候选包都无法启动随包 Host；补进 `server/package.json` 并按普通依赖打包后通过。
- 本机资源目录中的 FFmpeg 是 Homebrew 动态链接版本，不能作为其他机器的静态分发证据；本报告只声明候选包内的本机真实导出。CI 会重新执行 `pnpm fetch:ffmpeg`。
- macOS 后续一次自动权限审批超时，未影响已经完成的三项运行；收尾时使用已通过的最终实现提交并复跑不依赖 GUI 的全量检查。

## 结论

AC-1 至 AC-3 已通过，AC-4 的本机命令与 CI 定义已完成；CI 的实际运行尚未执行。本报告可以提交维护者评审，暂不自行批准或发布。

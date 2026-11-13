---
id: F-0030
stage: 03-implementation
status: approved
approved_by: auto
approved_at: 2026-11-12
---

# F-0030 多语言字幕轨道与兼容迁移：开发记录

## 分支与 PR

- 分支：`codex/f0030-multilingual-tracks`
- PR：

## 进度

<!-- 每完成实现清单的一项，在 02-design.md 勾选，并在这里追加一行：日期、清单项、提交 sha、跑过的检查。
换会话接着做时，先读 02-design.md 和这里。 -->

| 日期 | 清单项 | 提交 | 检查 |
|---|---|---|---|
| 2026-11-12 | 1. 语言轨契约、格式 4 与 Host 迁移 | `32f8141` | `pnpm check:host` ✅；`pnpm tsc -b --noEmit` ✅；F-0030/F-0003/F-0013 架构测试 18/18 ✅；全量架构 91/94，F-0006 两项缺 FSMN 本地资源，F-0003 旧断言已修正并重跑通过 |
| 2026-11-12 | 2. history、自动保存、恢复副本与另存 | `3076037` | `pnpm tsc -b --noEmit` ✅；`pnpm check:host` ✅；`pnpm test` 87 通过、11 个既有前置条件跳过；F-0030 架构测试 4/4 ✅ |
| 2026-11-12 | 3. 轨道管理界面与保存生命周期 | `75ec972` | `pnpm lint` ✅；`pnpm tsc -b --noEmit` ✅；`pnpm build` ✅；交互证据留到第 5 项统一跑 Playwright |
| 2026-11-12 | 4. 译文编辑、原文过期与 AI 目标轨 | `1240249` | `pnpm lint` ✅；`pnpm tsc -b --noEmit` ✅；F-0030 架构测试 4/4 ✅；EDL 共享源时间断言通过 |
| 2026-11-12 | 5. 架构、单元与中英文/明暗 E2E 证据 | `dd9466e` | `pnpm test:e2e tests/e2e/features/F-0030.spec.ts --workers=1` 24/24 ✅；`pnpm e2e:evidence F-0030` 24/24 ✅，56 张截图、24 段录屏；`pnpm lint` ✅；`pnpm tsc -b --noEmit` ✅ |
| 2026-11-12 | 6. 最终回归、Red check 与真实 Web/Tauri | `cb15dc3` | `pnpm lint` / `tsc` / `check:host` ✅；`pnpm test` 90 通过、8 个 ASR 前置条件跳过；`pnpm test:architecture` 96/96 ✅；`cargo check` ✅；`pnpm build` ✅；`pnpm acceptance:f0030` ✅；`pnpm acceptance:f0030:tauri` ✅；迁移与过期判定 Red check 均按预期失败 |

## 自行决定的事项

<!-- 开发中自己决定的事：决定了什么、为什么、影响哪条 AC。验收时汇总进测试报告 -->

- 为覆盖加载阶段没有语言切换按钮的情况，demo 入口支持用 `?ui=en` 选择初始界面语言；既有 `?lang` 路径没有改变。影响 AC-9。
- 语言选择使用显式 BCP-47 风格代码，旧轨允许 `null` 表示未指定；切换、编辑和保留都会同步活动轨的 `secondText` 投影。影响 AC-1、AC-2。
- 真实 Tauri 构建输出放在 `/private/tmp`，未提交构建目录；本机 Homebrew Node 缺少随包 `libnode.147.dylib`，仅在临时验收包中补齐并 ad-hoc 重签，未改产品打包脚本。影响 AC-9。

## 与设计的偏差

<!-- 实现时改变了设计的地方及原因；重大偏差回到 02-design.md 修改，并记进测试报告 -->

- 增加正式入口 `acceptance:f0030` 和 `acceptance:f0030:tauri`，用真实 Host 与真实 Chrome / WKWebView 验证，而不只依赖 mock E2E。
- 为了让测试稳定地进入“已完成”或冲突状态，验收脚本会显式触发保存；产品自动保存逻辑未改。
- 设计中的“全部语言条目必须来自当前 chunks”在写入时校验；读取仍保留孤立条目以避免迁移时丢未知旧数据。

## 遗留问题

- ASR 模型集成测试因本机没有 `sensevoice-small-int8...` 模型目录跳过 8 项；F-0030 的手动轨道流程不依赖 ASR 推理。
- 当前发布打包脚本复制 Homebrew Node 后没有一并复制 `libnode.147.dylib`；本次桌面验收仅在 `/private/tmp` 的临时副本补齐。该问题不属于 F-0030，需父代理在发布/打包需求中处理。

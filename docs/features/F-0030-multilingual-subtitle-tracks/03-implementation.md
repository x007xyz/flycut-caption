---
id: F-0030
stage: 03-implementation
status: draft
approved_by:
approved_at:
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

## 自行决定的事项

<!-- 开发中自己决定的事：决定了什么、为什么、影响哪条 AC。验收时汇总进测试报告 -->

## 与设计的偏差

<!-- 实现时改变了设计的地方及原因；重大偏差回到 02-design.md 修改，并记进测试报告 -->

## 遗留问题

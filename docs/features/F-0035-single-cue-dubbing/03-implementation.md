---
id: F-0035
stage: 03-implementation
status: draft
approved_by:
approved_at:
---

# F-0035 单条译文配音与试听：开发记录

## 分支与 PR

- 分支：codex/f0035-single-cue-dubbing
- PR：

## 进度

<!-- 每完成实现清单的一项，在 02-design.md 勾选，并在这里追加一行：日期、清单项、提交 sha、跑过的检查。
换会话接着做时，先读 02-design.md 和这里。 -->

| 日期 | 清单项 | 提交 | 检查 |
|---|---|---|---|
| 2026-11-13 | 清单 1：共享契约、状态评估与单元测试 | 1a50554 | pnpm tsc -b --noEmit ✅, pnpm check:host ✅, node --test tests/cue-dubbing.test.mjs ✅ |
| 2026-11-13 | 清单 2：Host 配音插件、项目产物落盘、并发锁与架构测试 | 284d325 | pnpm check:host ✅, tsx --test tests/architecture/dubbing-f0035.test.ts ✅ (2/2) |
| 2026-11-13 | 清单 3：前端 historyStore/ProjectService/recovery 与 DubbingService 同步 | a1c52e7 | pnpm tsc -b --noEmit ✅, pnpm check:host ✅, tsx --test tests/architecture/dubbing-client-f0035.test.ts ✅ (2/2) |
| 2026-11-13 | 清单 4：配音文案、useCueDubbing、SingleCueDubbingPanel 与字幕行入口 UI | pending | pnpm lint ✅, pnpm tsc -b --noEmit ✅, pnpm check:host ✅ |

## 自行决定的事项

<!-- 开发中自己决定的事：决定了什么、为什么、影响哪条 AC。验收时汇总进测试报告 -->

## 与设计的偏差

<!-- 实现时改变了设计的地方及原因；重大偏差回到 02-design.md 修改，并记进测试报告 -->

## 遗留问题

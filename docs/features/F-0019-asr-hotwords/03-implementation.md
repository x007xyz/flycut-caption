---
id: F-0019
stage: 03-implementation
status: draft
approved_by:
approved_at:
---

# F-0019 热词与专有名词识别：开发记录

## 分支与 PR

- 分支：codex/f0019-asr-hotwords
- PR：

## 进度

<!-- 每完成实现清单的一项，在 02-design.md 勾选，并在这里追加一行：日期、清单项、提交 sha、跑过的检查。
换会话接着做时，先读 02-design.md 和这里。 -->

| 日期 | 清单项 | 提交 | 检查 |
|---|---|---|---|
| 2026-11-13 | 1. 共享术语实体与 ASR 热词能力契约 | 172d190 | pnpm check:host, pnpm tsc -b --noEmit, pnpm test, terminology-f0019.test.ts (2/2) |
| 2026-11-13 | 2. Host 术语存储、Provider 校验与转发通道 | 7102d07 | pnpm check:host, pnpm tsc -b --noEmit, pnpm eslint, hotwords-f0019.test.ts (2/2) |
| 2026-11-13 | 3–4. 客户端热词状态、条件发送与管理弹窗 UI | aa899f9 | pnpm tsc -b --noEmit, pnpm check:host, pnpm eslint |
| 2026-11-13 | 5. E2E 回归与视觉证据 | 94dc50a | PW_PORT=5301 pnpm e2e:evidence F-0019 (4/4) |

## 自行决定的事项

<!-- 开发中自己决定的事：决定了什么、为什么、影响哪条 AC。验收时汇总进测试报告 -->

## 与设计的偏差

<!-- 实现时改变了设计的地方及原因；重大偏差回到 02-design.md 修改，并记进测试报告 -->

## 遗留问题

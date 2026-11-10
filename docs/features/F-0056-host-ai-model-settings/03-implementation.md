---
id: F-0056
stage: 03-implementation
status: draft
approved_by:
approved_at:
---

# F-0056 AI模型配置与密钥保存到Host：开发记录

## 分支与 PR

- 分支：`codex/f0056-host-ai-settings`
- PR：

## 进度

<!-- 每完成实现清单的一项，在 02-design.md 勾选，并在这里追加一行：日期、清单项、提交 sha、跑过的检查。
换会话接着做时，先读 02-design.md 和这里。 -->

| 日期 | 清单项 | 提交 | 检查 |
|---|---|---|---|
| 2026-11-09 | 1. shared 契约与 Host 元数据/迁移/revision | 待回填 | `pnpm check:host` ✅；F-0056 架构测试 5/5 ✅（含 lost response、metadata/secret 一致性） |
| 2026-11-09 | 2. secret backend、遮罩与脱敏 | 待回填 | `pnpm exec tsx --tsconfig server/tsconfig.json --test tests/architecture/ai-settings-f0056.test.ts` ✅；加密文件串行/0600/tmp、元数据失败保留旧 ref、server 私网拒绝 ✅ |
| 2026-11-09 | 3. configId 消费链路与兼容 | 待回填 | `pnpm tsc -b --noEmit` ✅；真实本机 OpenAI 兼容 fixture 的 text/agent 请求 ✅ |

## 自行决定的事项

<!-- 开发中自己决定的事：决定了什么、为什么、影响哪条 AC。验收时汇总进测试报告 -->

## 与设计的偏差

<!-- 实现时改变了设计的地方及原因；重大偏差回到 02-design.md 修改，并记进测试报告 -->

## 遗留问题

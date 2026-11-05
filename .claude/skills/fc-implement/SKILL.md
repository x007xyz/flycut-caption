---
name: fc-implement
description: FlyCut 需求流程阶段 5：按已确认的技术设计和实现清单把整个需求一次做完，记录到 05-implementation.md。设计确认后，用户说「开始开发」时使用。
---

# 阶段 5：开发

1. 确认 `02-prd`、`03-design` 都是 `approved`，并且需求依赖都已完成（`pnpm feature status <F-编号>`；`pnpm feature next` 进入开发阶段时脚本已检查），否则不要开始写代码。
2. 整个需求在一个分支、一个 PR 里做完，不拆任务。先读完 `02-prd.md`、`03-design.md`、`05-implementation.md`（换会话接着做时从进度表接上），按 `AGENTS.md` 路由读子系统文档，遵守 `docs/code-standards.md` 全部验收标准。
3. 按 `03-design.md` 的实现清单推进，每完成一项：
   - 跑验证计划里这一项的检查；
   - 提交一次，commit 正文带 Verification 段，并加一行 `Refs: <F-编号>/AC-n`；
   - 在 `03-design.md` 勾选这一项，在 `05-implementation.md` 的进度表追加一行（日期、清单项、提交、检查）。
   - 测试名称带 AC 编号，例如 `F-0001/AC-3 ……`。
   - 界面直接写真实代码，接真实的 stores 和 Host，不另做原型或假数据版本。涉及界面的 AC，端到端测试和代码一起提交（`tests/e2e/features/<F-编号>.spec.ts`）。
   - 清单的顺序和粒度、设计里的实现细节可以按实际情况调整，写进「与设计的偏差」。
4. 遇到下面的情况才**停下来问维护者**，其他问题自己决定，记进「自行决定的事项」，在测试报告里交给维护者一并审阅：
   - 要改 PRD 的范围或 AC（加、删、改语义）；
   - 要推翻 `docs/decisions.md` 的决定，或改前面需求已经定好的共用契约（数据格式、RPC、存储结构）；
   - 需求一次做不完，需要分几次发布（应该回 Epic 拆需求）；
   - 要做不可逆或对外的操作（发版、推送到公共渠道、删除用户数据）。
5. 实现清单全部勾选后运行 `pnpm feature review <F-编号>`（脚本检查清单，通过即自动确认），再 `pnpm feature next <F-编号>`，用 `fc-verify` 接着验收。

## 通用规则

- 先读 `docs/00-process/README.md`（阶段、编号、闸门）和 `AGENTS.md`。
- 用 `pnpm feature status <F-编号>` 确认当前阶段就是本阶段且状态是 `draft`；不是就停下，告诉维护者当前状态和下一步。
- **技术设计 → 开发 → 测试与验收由 agent 连续推进，中间不等维护者确认。** 本阶段写完后运行 `pnpm feature review <F-编号>`：检查通过会自动确认（`approved_by: auto`），接着运行 `pnpm feature next <F-编号>` 进入下一阶段，继续用对应的 Skill 做下去。维护者在「测试与验收」时一并审阅设计、实现和测试结果。
- 不要用 `approve` 或 `skip`；`skip` 只在维护者明确说本阶段不需要时使用。
- 「自行决定的事项」逐条记下（决定了什么、为什么、影响哪条 AC），测试报告会汇总给维护者。

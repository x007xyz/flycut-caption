---
name: fc-status
description: 查看 FlyCut 需求流程的进度：列出 docs/features 里每个需求的当前阶段、状态和下一步，以及待发布的需求。用户问「需求进度」「现在做到哪了」「F-0001 到哪一步了」时使用。
---

# 需求进度

1. 运行 `pnpm feature status`（或 `pnpm feature status <F-编号>` 看单个需求的每个阶段，`pnpm feature status E-05` 只看一个 Epic）。
2. 用表格汇报：每个需求的编号、所属 Epic、当前阶段、状态、下一步；被依赖阻塞的写明在等什么；「待发布（已验收）」的单独列出。
3. 把等维护者处理的事放在最前面：状态是 `review` 的需求说明和测试报告（给出文件路径），可以一次确认的放在一起。
4. 不修改任何文件。

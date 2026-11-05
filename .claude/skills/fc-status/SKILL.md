---
name: fc-status
description: 查看 FlyCut 需求流程的进度：列出 docs/features 里每个需求的当前阶段、状态和下一步。用户问「需求进度」「现在做到哪了」「F-0001 到哪一步了」时使用。
---

# 需求进度

1. 运行 `pnpm feature status`（或 `pnpm feature status <F-编号>` 看单个需求的每个阶段）。
2. 用表格汇报：产品规划文档和 Epic 的确认状态；每个需求的编号、所属 Epic、当前阶段、状态、下一步；被依赖阻塞的写明在等什么。`pnpm feature status E-05` 可以只看一个 Epic。
3. 状态是 `review` 的，提醒维护者有待确认的文档，并给出文件路径。
4. 不修改任何文件。

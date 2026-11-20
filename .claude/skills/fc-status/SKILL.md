---
name: fc-status
description: 查看 FlyCut 需求流程的进度：列出批次（执行图、波次、是否在等维护者）、docs/features 里每个需求的当前阶段、状态和下一步，以及待发布的需求。用户问「需求进度」「现在做到哪了」「B-02 到哪了」「F-0001 到哪一步了」时使用。
---

# 需求进度

1. 运行 `pnpm feature status`（或 `pnpm feature batch status <B-NN>` 看一个批次的波次和可以并行开始的需求，`pnpm feature status <F-编号>` 看单个需求的每个阶段，`pnpm feature status E-05` 只看一个 Epic）。
2. 先报**等维护者处理的事**：状态是 `plan-review`（节点一：方案确认）和 `acceptance-review`（节点二：验收）的批次，给出批次文件路径，一个批次就是一次确认；不在批次里但处于 `review` 的文件单独列出，并建议放进哪个批次。
3. 再报进行中的批次：当前波次、正在做的需求、被什么阻塞、现在可以并行开始的需求。需要看图时直接给批次文件里的执行图。
4. 用表格汇报需求：编号、所属批次 / Epic、当前阶段、状态、AI 审查、下一步；「待发布（已验收）」的单独列出。
5. 不修改任何文件（`batch sync` 也不跑；发现执行图和实际状态不一致时，指出来，建议运行 `pnpm feature batch sync`）。

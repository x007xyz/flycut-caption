---
name: fc-research
description: FlyCut 技术调研（spike）类需求的调研报告：方案确认后，按批次执行图回答需求说明里的问题，写 02-research.md，必要时新建 ADR；调研报告由独立 AI 审查员确认，结论汇总进批次文件，在下一个人工节点给维护者看，不单独停下来。用户说「做调研」「技术选型」时使用。
---

# 调研报告（spike 的 02-research）

先读 `docs/00-process/README.md`、`docs/00-process/ai-review.md` 和 `AGENTS.md`。用 `pnpm feature status <F-编号>` 确认当前阶段是 `02-research`、状态是 `draft`；依赖未满足时脚本不会创建这个文件，在批次文件里记下在等什么，先做别的可以并行的需求。

1. 读 `01-spec.md`，把要回答的问题抄到 `02-research.md`。
2. 定好评估标准（质量、速度、成本、许可证、桌面端 / Web 支持、隐私），再列候选方案；资料写明来源和日期，查不到的写「待核实」。
3. 能实验的就实验：测试数据、命令和脚本放进仓库并写明路径，结果要可复现。
4. 「结论」逐条回答问题；需要长期遵守的决定用 `pnpm feature adr <slug> "<标题>" --feature <F-编号>` 写成 ADR（状态 proposed）。
5. 「对后续需求的影响」：哪些候选需求可以开始、要调整或取消；直接更新所属 Epic 的候选表和依赖它的需求说明。
6. 独立 AI 审查员按 `ai-review.md` 的「02-research」清单审，通过后 `pnpm feature ai-review <F> --by <审查员>`，再 `pnpm feature review <F>`：脚本直接确认（`approved_by: ai:<审查员>`），依赖它的需求可以开始。`pnpm feature batch sync <B-NN>`。
7. 把结论一句话写进批次文件「节点二：验收 / AI 已确认的事项」。**改了其他需求的范围或 AC、写了新 ADR、或要推翻 `docs/decisions.md` 的**，写进下一个人工节点（还没做方案确认的批次写节点一，否则写节点二的「请确认的事项」）；受影响的需求说明状态改回 `review`，只暂停这些需求。
8. 不单独停下来请维护者确认。批次验收通过后 `pnpm feature archive <F-编号> --release none` 归档。

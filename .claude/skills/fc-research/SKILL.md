---
name: fc-research
description: FlyCut 技术调研（spike）类需求的调研报告：回答需求说明里的问题，写 02-research.md，必要时新建 ADR；调研报告是 spike 的第二个、也是最后一个确认点。用户说「做调研」「技术选型」时使用。
---

# 调研报告（spike 的 02-research）

先读 `docs/00-process/README.md` 和 `AGENTS.md`。用 `pnpm feature status <F-编号>` 确认当前阶段是 `02-research`、状态是 `draft`；依赖未完成时脚本不会创建这个文件，告诉维护者在等什么。

1. 读 `01-spec.md`，把要回答的问题抄到 `02-research.md`。
2. 定好评估标准（质量、速度、成本、许可证、桌面端 / Web 支持、隐私），再列候选方案；资料写明来源和日期，查不到的写「待核实」。
3. 能实验的就实验：测试数据、命令和脚本放进仓库并写明路径，结果要可复现。
4. 「结论」逐条回答问题；需要长期遵守的决定用 `pnpm feature adr <slug> "<标题>" --feature <F-编号>` 写成 ADR（状态 proposed，维护者确认报告时一并 accepted）。
5. 「对后续需求的影响」：哪些候选需求可以开始、要调整或取消；直接更新所属 Epic 的候选表和依赖它的需求说明，改动在总结里列给维护者。
6. `pnpm feature review <F-编号>`，**停下来请维护者确认**。不要自己运行 `approve`；维护者确认后运行 `pnpm feature approve <F-编号> --by <维护者>`，再 `pnpm feature archive <F-编号> --release none` 归档。

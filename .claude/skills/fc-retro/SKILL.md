---
name: fc-retro
description: FlyCut 需求流程阶段 9：需求复盘，对照成功指标、记录教训、把规格合并回项目级文档，写 09-retro.md。用户说「复盘」时使用。
---

# 阶段 9：复盘

1. 对照 `02-prd.md` 的成功指标逐条填写实际结果；拿不到数据的写明原因。
2. 回看 `05-implementation.md`、`06-test-report.md`、`08-ops.md` 和相关提交，找返工、验证不足和做得好的地方；可复用的教训按 `LESSONS.md` 的格式写进去（附真实的 Evidence）。
3. 把本需求带来的变化合并进项目级文档：`docs/10-product/`（能力规格）、`docs/20-architecture/`（架构、ADR 状态）、`docs/decisions.md`（如有新决定，需维护者确认）。在复盘文档里逐项勾选。
4. 后续需求用 `fc-intake` 立项，把编号写进「后续需求」。
5. 维护者确认复盘后，运行 `pnpm feature archive <F-编号>` 归档。

## 通用规则

- 先读 `docs/00-process/README.md`（阶段、编号、闸门）和 `AGENTS.md`。
- 用 `pnpm feature status <F-编号>` 确认当前阶段就是本阶段且状态是 `draft`；不是就停下，告诉维护者当前状态和下一步。
- 只编辑本阶段的文件。发现前面阶段的文档有错，停下来告诉维护者，由维护者决定是否退回修改。
- 写完后运行 `pnpm feature review <F-编号>`，然后**停下来请维护者确认**，用几句话总结本阶段的要点和待决问题。
- **不要自己运行 `approve` 或 `skip`。** 只有维护者在对话里明确确认（例如「确认」「通过」「可以进入下一步」）后，才运行 `pnpm feature approve <F-编号> --by <维护者>`，再运行 `pnpm feature next <F-编号>`。维护者说本阶段不需要时，才用 `skip`，并写明原因。

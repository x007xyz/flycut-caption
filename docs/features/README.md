# 需求

每个需求一个目录 `F-NNNN-<slug>/`：

- 功能：`01-spec.md` + `02-design.md`（批次「方案确认」）→ `03-implementation.md` → `04-test-report.md`（批次「验收」）
- 调研：`01-spec.md`（批次「方案确认」）→ `02-research.md`（AI 审查员确认）

一起推进的一批需求有一份批次文件 [batches/B-NN-<slug>.md](batches/)：任务执行图、进度和两个人工节点的审阅材料。维护者只看批次文件。

流程、编号和闸门见 [00-process/README.md](../00-process/README.md)。

```bash
pnpm feature new <slug> "<标题>" --epic E-NN
pnpm feature status
pnpm feature batch new <slug> "<标题>" F-NNNN …
pnpm feature batch sync
```

随版本发布后的需求、确认完的调研在 [archive/](archive/)；版本发布文档在 [40-ops/releases/](../40-ops/releases/)。

# 需求

每个需求一个目录 `F-NNNN-<slug>/`：

- 功能：`01-spec.md`（需求说明，维护者确认）→ `02-design.md` → `03-implementation.md` → `04-test-report.md`（维护者验收）
- 调研：`01-spec.md` → `02-research.md`（维护者确认）

流程、编号和闸门见 [00-process/README.md](../00-process/README.md)。

```bash
pnpm feature new <slug> "<标题>" --epic E-NN
pnpm feature status
```

随版本发布后的需求、确认完的调研在 [archive/](archive/)；版本发布文档在 [40-ops/releases/](../40-ops/releases/)。

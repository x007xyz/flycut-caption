# 20 架构

系统**当前**的架构说明和架构决策记录（ADR）。当前架构总览暂时仍在 [architecture-current.md](../architecture-current.md)，子系统规则在 [subsystems/](../subsystems/)。

## ADR

`adr/NNNN-<slug>.md`，编号只增不减。新建：

```bash
pnpm feature adr <slug> "<标题>" --feature F-0001
```

状态：`proposed`（设计阶段提出）→ `accepted`（维护者确认）→ `superseded` / `deprecated`（被新决定替代时填 `superseded_by`，不删除旧文件）。

| 编号 | 标题 | 状态 |
|---|---|---|

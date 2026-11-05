# 10 产品

系统**当前**的产品规划。单个需求的变更写在 `docs/features/F-NNNN-*/02-prd.md`，需求复盘（阶段 9）时把结果合并到这里。

| 文件 | 编号 | 内容 |
|---|---|---|
| [vision.md](vision.md) | VISION | 产品定位、目标用户（口播创作者）、平台、竞品分析、获客方式、成功指标 |
| [capability-map.md](capability-map.md) | CAPABILITY-MAP | 8 个 Epic、两条线、依赖关系 |
| [roadmap.md](roadmap.md) | ROADMAP | 分阶段排期 |
| [epics/](epics/) | E-01 … E-08 | 每块能力的问题、范围、候选需求和依赖 |

这些文档同样要维护者确认（`pnpm feature review` / `approve`）；Epic 要在 VISION 和 CAPABILITY-MAP 确认之后才能确认，需求要在所属 Epic 确认之后才能立项。维护用 `fc-plan`。

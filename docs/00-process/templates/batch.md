---
id: {{id}}
title: {{title}}
status: planning     # planning → plan-review → executing → acceptance-review → done（由 pnpm feature batch sync 计算）
features: []
docs: []             # 本批次一起确认的产品文档 / Epic，例如 [E-05, ROADMAP]
plan_approved_by:
plan_approved_at:
accepted_by:
accepted_at:
---

# {{id}} {{title}}：批次执行计划

> 这个文件是维护者在两个节点唯一需要审阅的地方：「方案确认」（本批次所有需求说明和技术设计一次看完）和「验收」（所有测试报告一次看完）。其余阶段由独立 AI 审查员或脚本检查确认。

## 目标与范围

<!-- 这一批要达成什么、包含哪些需求、明确不包含什么 -->

## 执行图

<!-- 由 pnpm feature batch sync 生成，不要手改 -->
<!-- batch:graph:start -->
<!-- batch:graph:end -->

## 进度

<!-- batch:progress:start -->
<!-- batch:progress:end -->

## 并发与分派

| 波次 | 需求 | 分支 / worktree | 执行者 | 合入顺序 | 备注 |
|---|---|---|---|---|---|
| | | | | | |

## 节点一：方案确认

### 每个需求一句话方案

<!-- 每个需求：一句话说清要做什么、怎么做 -->

### 待澄清的问题与建议答案

<!-- 需要维护者回答的问题，每个都附建议答案；维护者可以直接同意 -->

### 产品文档与 Epic 改动

<!-- 本批次要一起确认的 VISION / ROADMAP / Epic 改动摘要 -->

### 新写的 ADR（proposed）

<!-- 本批次新写的 ADR 链接；方案确认时一并 accepted -->

### AI 审查结论

<!-- 每个需求的 ai-review 结论，以及没有解决的审查意见 -->

## 节点二：验收

### 每个需求的结论

<!-- 每个需求：可以发布 / 需要修复后重测，来自测试报告 -->

### Not run 与原因

<!-- 没有跑的检查、原因和补验步骤 -->

### 请确认的事项

<!-- 需要维护者拍板的事项 -->

### AI 已确认的事项（调研结论、自行决定的事项）

<!-- 调研结论、开发和测试阶段 agent 自己决定的事，逐条：决定了什么、为什么、影响哪条 AC -->

## 同步日志

| 日期 | 事件 |
|---|---|

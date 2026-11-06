---
version: {{version}}
date: {{date}}
status: draft        # draft → released
tag:
---

# {{version}} 发布

> 发布、运维观察和复盘按版本做，不在单个需求里。发布说明由 fc-release 写，观察和复盘由 fc-retro 补。

## 包含的需求

| 需求 | 标题 | Epic |
|---|---|---|
{{features}}

另外包含的修复和小改动（从上一个 tag 以来的提交整理）：

- 

## 发布说明

<!-- 面向用户：新增了什么、怎么用、已知限制。中英文 -->

## 发版闸门

<!-- pnpm release --dry-run 的输出；平台（macOS / Windows / Web / npm 组件库）；回滚方案 -->

## 发布后观察

<!-- 发布后 1–2 周：用户反馈（原话原样引用）、崩溃、错误。严重问题用 pnpm feature incident 建事故记录 -->

| 日期 | 来源 | 问题 | 处理（issue / 新需求编号） |
|---|---|---|---|

## 复盘

<!-- 对照各需求说明的成功指标；返工、验证不足和做得好的地方写进 LESSONS.md（附 Evidence） -->

| 需求 | 成功指标 | 实际 | 达成 |
|---|---|---|---|

### 合并到项目级文档

- [ ] docs/10-product/（能力地图、Epic 候选状态）：
- [ ] docs/20-architecture/（架构、ADR 状态）：
- [ ] docs/decisions.md（新决定需维护者确认）：

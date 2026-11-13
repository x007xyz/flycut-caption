---
id: F-0025
stage: 03-implementation
status: draft
approved_by:
approved_at:
---

# F-0025 字幕关键词强调：开发记录

## 分支与 PR

- 分支：codex/f0025-keyword-emphasis
- PR：

## 进度

| 日期 | 清单项 | 提交 | 检查 |
|---|---|---|---|
| 2026-11-13 | 1. 关键词数据模型、偏移安全与图形层混排渲染 | 3596ee2 | `pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`、F-0025/F-0028/F-0024 架构测试 (18/18) |
| 2026-11-13 | 2. Host AI 推荐接口与协议校验 | 8b92fc1 | `pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`、F-0025/F-0009/F-0056 架构测试 (15/15) |
| 2026-11-13 | 3. 前端样式、预览、历史与持久化接线 | 760de84 | `pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`、F-0025/F-0002 架构测试 (19/19) |
| 2026-11-13 | 4. 字幕行内手动标注与 AI 推荐审阅 UI | 50723ee | `pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host` |
| 2026-11-13 | 5. 端到端验收、真实 Host 导出验证与文档更新 | 待提交 | `pnpm test` 107 passed/5 skipped ✅、`pnpm test:architecture` 147/147 ✅、`cargo check` ✅、`PW_PORT=5292 pnpm e2e:evidence F-0025` 12/12 ✅（20 张截图） |

## 自行决定的事项

- **推荐结果只进临时审阅层**：AI 候选保留在 `useKeywordRecommendation` 的 `candidates` 状态，确认前不写 `historyStore`、不进入导出；关闭面板即丢弃。影响 AC-3、AC-7。
- **批量与上下文**：按每批 20 条 / 2400 字符切批，逐批校验并累计进度；`base` 用 `createKeywordBase` 对 id+原文做确定性指纹，审阅期间原文变化即置 stale 并阻止应用。影响 AC-3、AC-4、AC-8。
- **行内标记不改时间与 EDL**：`historyStore.setChunkKeywords/batchSetKeywords` 只写 `keywords` 字段并以 `cuts = false` 提交，原文、时间戳与 EDL 不变，可撤销/重做。影响 AC-1。
- **保存失败回滚**：`applyKeywordBatchWithPersistence` 在 Host 保存失败且无后续改动时回滚 chunks 与撤销栈，保留审阅结果供重试。影响 AC-8。

## 与设计的偏差

- 设计里提到的「三分词点选 + 划选直标」都实现了；额外把「AI 推荐入口」同时挂到字幕样式面板（`flycut:open-keyword-recommend` 事件）和编辑器工具条，方便从任一处进入。无接口或数据格式偏差。

## 遗留问题

- 真实外部 AI 服务（OpenAI 兼容）推荐质量与成本未在本环境实测，测试报告中如实记为 `⏸ Not run`；协议与校验链路已由真实 Host 架构测试覆盖。


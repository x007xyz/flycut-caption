---
id: F-0024
stage: 03-implementation
status: draft
approved_by:
approved_at:
---

# F-0024 逐字高亮字幕：开发记录

## 分支与 PR

- 分支：`codex/f0024-word-highlight`
- PR：仓库流程要求由父代理协调；本 worker 不 push、不创建 PR。

## 进度

| 日期 | 清单项 | 提交 | 检查 |
|---|---|---|---|
| 2026-11-12 | 技术设计 | 本提交 | `pnpm feature review F-0024` 自动确认 02 并创建 03 |
| 2026-11-12 | 1. 共用场景与词元渲染 | 本提交 | `word-highlight-f0024.test.ts` 4 通过；`pnpm exec eslint shared/subtitle-graphics tests/architecture/word-highlight-f0024.test.ts`、`pnpm tsc -b --noEmit`、`pnpm check:host` 通过；Red check 移除词感知 key 后 frameKey 测试失败 |
| 2026-11-12 | 2. 预览与样式 UI | 本提交 | 架构测试 5 通过；F-0024 Playwright 7 通过（中英、明暗、改色、词间空隙、倍速 seek、无词降级、字体加载）；`pnpm tsc -b --noEmit`、`pnpm check:host`、targeted eslint 通过；Red check 错误隐藏降级提示时 E2E 失败 |

## 自行决定的事项

- 逐字高亮按样式保存，主副字幕可分别启用；副字幕译文没有对齐词元时明确按整句降级。
- 场景继续使用 v1，新增样式字段均为可选，旧项目与恢复副本无需迁移。

## 与设计的偏差

- 暂无。

## 遗留问题

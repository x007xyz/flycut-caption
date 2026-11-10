---
id: F-0012
stage: 04-test-report
status: approved
approved_by: zhangxiang.chen
approved_at: 2026-11-09
---

# F-0012 校对体验：测试与验收

验收在未提交的工作区上进行（维护者要求跳过 commit；便于审阅时按 diff 复核）。

> 技术设计和开发阶段由 agent 连续推进、自动确认；维护者在这里一并审阅。

## 设计与实现摘要

查找/替换在客户端对当前视频未删除字幕执行，纯函数在 `shared/text/findReplace.ts`：查询按普通文本解释，默认不区分英文大小写；命中不跨句；替换只改 `chunks[].text`，时间戳、ID、译文、字词关联和 EDL 不变。全部替换先预览受影响字幕，确认前比较受影响字幕的原文基准；确认时一次 `batchUpdateText`，撤销一次恢复整批。界面用只读命中片段 + `<mark>` 呈现高亮，保留 textarea 的输入法和编辑行为。无新增 RPC、无项目格式变化、无 ADR。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| 命中高亮方式 | 只读命中片段 + 行标记，不替换 textarea | 保持输入法、光标和现有编辑行为 | AC-3 |
| 全部替换冲突范围 | 只比较受影响字幕的原文 | 避免无关编辑使预览过期 | AC-5、AC-6 |
| 原语言视图快捷键 | Cmd/Ctrl+F 切到编辑模式再打开查找 | 覆盖「字幕编辑场景」 | AC-1 |

## 验收标准逐条结果

| AC | 验证方式 | 证据 | 结果 |
|---|---|---|---|
| AC-1 查找入口 | E2E + 代码检查 | F-0012 Playwright 4/4；Cmd/Ctrl+F 打开；空查询 0/0 | ✅ |
| AC-2 匹配规则 | 单元测试 + E2E | `tests/find-replace.test.mjs` 8/8：大小写、中文、特殊字符、跨句不匹配 | ✅ |
| AC-3 命中定位 | E2E + 单元测试 | 4/4 E2E：计数、上一/下一处、滚动、无结果文案；`<mark>` 有 aria-label | ✅ |
| AC-4 单处替换 | E2E | 单处替换后时间戳/ID/译文不变；撤销恢复 | ✅ |
| AC-5 全部替换预览 | E2E | 预览弹窗、命中数、确认后两条字幕更新 | ✅ |
| AC-6 提交与冲突 | 单元测试 + 代码检查 | `baseForMatches` 只覆盖受影响句子；确认前比较；E2E 未单独构造过期场景 | ⏸ 部分：实现与单测通过，专门 E2E 未写 |
| AC-7 撤销与保存 | E2E | 全部替换一次撤销恢复；`projects.saveVideoEdits` 收到更新文本 | ✅ |
| AC-8 输入焦点 | 代码检查 | 查找框 `data-find-input`；播放器快捷键只在 `target === body` 时触发；E2E 未单独按 Space/Delete | ⏸ 部分：实现通过，专门 E2E 未写 |
| AC-9 已删除与字词关联 | 单元测试 + 代码检查 | 已删除/空白行不参加；不重排 wordChunks；保持 `edlWordProjection` 门禁 | ✅ |
| AC-10 两端与性能 | 单元测试 + E2E | 3000 句查找 <500ms；切换视频/关闭清空；明暗/中英文 4 组通过 | ✅ |

## 界面证据

`pnpm e2e:evidence F-0012`：4 通过、0 失败，12 张截图、4 段录屏。

| 界面 | 状态 | AC | 截图 | 录屏 |
|---|---|---|---|---|
| 字幕编辑器 | 查找条 + 命中 | AC-1、AC-3 | `find-{light,dark}-{zh,en}.png` | `recordings/` |
| 字幕编辑器 | 全部替换预览 | AC-5 | `replace-preview-{light,dark}-{zh,en}.png` | `recordings/` |
| 字幕编辑器 | 无匹配 | AC-3 | `no-matches-{light,dark}-{zh,en}.png` | `recordings/` |

## 回归检查

`pnpm test` ✅ 87/87（3 skipped）；`pnpm test:architecture` ✅ 66/66；`pnpm check:host` ✅；`pnpm lint` ✅；`pnpm tsc -b --noEmit` ✅；`pnpm build` ✅。F-0005/0006/0007/0012 联合 E2E 60/60 ✅。

## 发现的问题

- AC-6 的过期场景和 AC-8 的 Space/Delete 焦点保护只有实现与代码检查，没有专门 E2E；建议验收前补两个用例。
- 60 分钟性能用 3000 句纯函数基准确认（<500ms），未在真实 60 分钟项目上做浏览器交互计时。

## 结论

功能闭环已实现并通过主要自动化检查；需要维护者确认。建议补 AC-6/AC-8 的专门 E2E 后再标记为可发布。

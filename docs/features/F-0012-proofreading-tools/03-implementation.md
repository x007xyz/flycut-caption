---
id: F-0012
stage: 03-implementation
status: approved
approved_by: auto
approved_at: 2026-11-09
---

# F-0012 校对体验：开发记录

## 分支与 PR

- 分支：
- PR：

## 进度

<!-- 每完成实现清单的一项，在 02-design.md 勾选，并在这里追加一行：日期、清单项、提交 sha、跑过的检查。
换会话接着做时，先读 02-design.md 和这里。 -->

| 日期 | 清单项 | 提交 | 检查 |
|---|---|---|---|
| 2026-11-09 | 1. 纯函数与单元测试 | 未提交（维护者要求跳过 commit） | `node --test tests/find-replace.test.mjs` ✅ 7/7 |
| 2026-11-09 | 2. 查找条与快捷键 | 未提交（维护者要求跳过 commit） | `pnpm lint` ✅、`pnpm tsc -b --noEmit` ✅、F-0012 Playwright 4/4 ✅ |
| 2026-11-09 | 3. 命中高亮与定位 | 未提交（维护者要求跳过 commit） | F-0012 Playwright 4/4 ✅（明暗主题、中英文） |
| 2026-11-09 | 4. 单处/全部替换与撤销 | 未提交（维护者要求跳过 commit） | F-0012 Playwright 4/4 ✅；保存与撤销断言通过 |
| 2026-11-09 | 5. 文案、主题、性能与证据 | 未提交（维护者要求跳过 commit） | `node --test tests/find-replace.test.mjs` ✅ 8/8（含 3000 句 <500ms）；`pnpm lint` ✅、`pnpm tsc -b --noEmit` ✅、`pnpm build` ✅、`pnpm test` ✅ 87/87（3 skipped）；`pnpm e2e:evidence F-0012` ✅ 4/4、12 张截图、4 段录屏 |

## 自行决定的事项

<!-- 开发中自己决定的事：决定了什么、为什么、影响哪条 AC。验收时汇总进测试报告 -->

- 命中高亮用字幕行上方的只读片段，不替换 textarea 的可编辑文本；避免破坏输入法组合和现有编辑行为（AC-3）。
- 全部替换预览只比较受影响字幕的原文；无关字幕的修改不使预览过期（AC-5、AC-6）。
- Cmd/Ctrl+F 在原语言视图会切到编辑模式，不改变原文或选中状态（AC-1）。

## 与设计的偏差

<!-- 实现时改变了设计的地方及原因；重大偏差回到 02-design.md 修改，并记进测试报告 -->

- 设计初稿写「焦点在字幕输入框时不抢占 Cmd/Ctrl+F」，实现改为只避开输入法组合；字幕输入框内也打开应用内查找，以符合 AC-1 的编辑场景。设计文档已同步。

## 遗留问题

- 已通过 `pnpm test` 87/87（3 skipped）、`pnpm test:architecture` 66/66、`pnpm check:host`、lint、tsc 和 build。

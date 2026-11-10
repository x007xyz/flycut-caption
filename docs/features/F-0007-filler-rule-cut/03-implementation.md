---
id: F-0007
stage: 03-implementation
status: approved
approved_by: auto
approved_at: 2026-11-09
---

# F-0007 去口癖规则层：开发记录

## 分支与 PR

- 分支：
- PR：

## 进度

<!-- 每完成实现清单的一项，在 02-design.md 勾选，并在这里追加一行：日期、清单项、提交 sha、跑过的检查。
换会话接着做时，先读 02-design.md 和这里。 -->

| 日期 | 清单项 | 提交 | 检查 |
|---|---|---|---|
| 2026-11-09 | 1. 共享建议契约与 store 迁移 | 未提交（维护者要求跳过 commit） | `pnpm test:architecture` ✅ 66/66 |
| 2026-11-09 | 2. 规则核心与门禁 | 未提交 | `node --test tests/filler-rules.test.mjs` ✅ 6/6 |
| 2026-11-09 | 3. 客户端分析与入口 | 未提交 | F-0007 Playwright 8/8 ✅ |
| 2026-11-09 | 4. 候选列表与选择 | 未提交 | F-0007 Playwright 8/8 ✅ |
| 2026-11-09 | 5. 播放器预览与 audition（部分） | 未提交 | F-0007 Playwright 8/8 ✅（预览/剪前/剪后按钮）；`pnpm e2e:evidence F-0007` ✅ 8 张截图、8 段录屏；时间轴原因浮层待补 |
| 2026-11-09 | 6. 原子应用与历史（部分） | 未提交 | F-0007 Playwright 8/8 ✅；一次确认一条历史、撤销恢复；保存失败回滚待补 |
| 2026-11-09 | 7. Host 插件与 Workflow/Agent | 未提交 | `pnpm tsc -b --noEmit` ✅、`pnpm test:architecture` ✅ 66/66 |

## 自行决定的事项

<!-- 开发中自己决定的事：决定了什么、为什么、影响哪条 AC。验收时汇总进测试报告 -->

- 为不破坏 F-0005 的现有 UI/测试，historyStore 同时保留 pendingSuggestions 和 pendingCuts 派生视图；候选面板统一读 pendingSuggestions，pendingCuts 只服务兼容调用方。
- base 使用现有 `keyOf(edl/chunks/wordChunks)` 快照，而不是新增 editRevision 计数器；选择/预览/audition 不改变正式快照，因此过期判断仍正确。
- 保存失败时目前只显示失败并保留候选，尚未实现完整的读回/回滚事务；这项留给验收前补齐。

## 与设计的偏差

<!-- 实现时改变了设计的地方及原因；重大偏差回到 02-design.md 修改，并记进测试报告 -->

- 设计写「移除 pendingCuts」，实现保留为兼容派生视图；这是为避免一次改动破坏 F-0005 已验收的智能剪空白和历史面板。
- 设计写 editRevision，实现复用 keyOf 快照；行为等价于正式数据变化才过期。

## 遗留问题

- 两段 F-0001 原始口播的真实误报/漏报/切点听感尚未执行。
- 真实导出、重开项目历史回退、60 分钟性能尚未在最终代码上验收。
- 保存失败读回/回滚已实现：src/services/cutPersistence.ts + F-0007 save failure E2E。

已运行：`pnpm test` 87/87（3 skipped）、`pnpm test:architecture` 66/66、`pnpm check:host`、lint、tsc、build；F-0005/0006/0007/0012 联合 E2E 60/60；F-0007 时间轴红标/原因浮层和保存失败回滚 E2E ✅。
- 最终页面回归：F-0007 E2E 9/9；pnpm e2e:evidence F-0007 9/9（8 张截图、9 段录屏）；全量 E2E 189/189。
- 真实转写对照：coscup-BWgFrY91F_I 384 个合格句、12 个独立语气词候选；coscup-3UegVxMFyeo 476 个合格句、16 个候选。两段分别有 224/88 句因 sentence 文本与 wordChunks 文本不一致被保守跳过。
- 边界状态：F-0007 E2E 现为 10/10，新增过期用例；取消/失败/无字词门禁/明暗/中英文已有覆盖。
- 性能：60 分钟 1000 句规则分析 66ms（单元测试断言 <1000ms）。
- 真实导出：tests/architecture/filler-export-f0007.test.ts 1/1，Host FFmpeg + joinFade 导出成功。
- Not run：两段原始口播的逐条人工听校；真实疑点/误报样本只能由维护者最终确认。

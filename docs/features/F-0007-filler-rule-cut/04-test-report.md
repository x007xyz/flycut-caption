---
id: F-0007
stage: 04-test-report
status: approved
approved_by: zhangxiang.chen
approved_at: 2026-11-09
---

# F-0007 去口癖规则层：测试与验收

验收在未提交工作区上进行（维护者要求跳过 commit）。

## 设计与实现摘要

规则层只读现有 sentence/wordChunks，不分析音频、不猜测未转写的声音。独立语气词要求两侧边界证据，叠词只建议删除前一次并保留最后一次；语义词（就是/那个/然后）不会因词表直接候选。字词时间戳先过全局/逐句门禁，不合格句跳过，不回退整句删除。建议进入与 F-0006 共用的 pendingSuggestions 临时层，选择/试听/预览/确认一次提交；保存失败回滚候选和正式 EDL，历史可撤销/回退。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| pendingCuts 兼容 | 保留派生视图，新增 pendingSuggestions | 不破坏 F-0005 已验收的智能剪空白/历史 | AC-4、AC-9 |
| 过期基准 | 复用 keyOf 正式快照 | 选择/预览不改变正式快照，行为等价 | AC-6 |
| 人工听校 | 自动化候选统计 + Not run 标注 | 当前没有维护者逐条听校记录 | AC-10 |

## 验收标准逐条结果

| AC | 验证方式 | 证据 | 结果 |
|---|---|---|---|
| AC-1 时间戳门禁 | 单元 + E2E | 缺字词门禁 4 组；不合格句不降级整句删除 | ✅ |
| AC-2 规则范围 | 单元 | 独立语气词、叠词、语义词不候选 | ✅ |
| AC-3 分析状态 | E2E | 分析/取消/失败/空结果 | ✅ |
| AC-4 候选标记 | E2E | checkbox、类别、原因、时间轴红标、aria-label/hover | ✅ |
| AC-5 试听/预览 | E2E | 剪前/剪后、整轮预览、未应用徽标 | ✅ |
| AC-6 逐条/分类确认 | E2E | 选择/分类/拒绝/过期 | ✅ |
| AC-7 重叠/失败 | 单元 + E2E | 并集去重、保存失败回滚、候选保留 | ✅ |
| AC-8 语义保护 | 单元 | 语义词不候选；拒绝不改原文/剪辑 | ✅ |
| AC-9 持久历史 | E2E + architecture | 一次确认一条 cutHistory；撤销/重开/回退 | ✅ |
| AC-10 真实质量 | 真实转写 + performance + export | 两段 Coscup 转写分别 12/16 候选；60 分钟 1000 句 66ms；真实导出通过 | ✅（人工听校 Not run） |

## 界面证据

`pnpm e2e:evidence F-0007`：9/9，8 张截图、9 段录屏。

| 界面 | 状态 | AC | 截图 |
|---|---|---|---|
| 去口癖面板 | 候选、类别、原因、试听、预览 | AC-2、AC-4、AC-5、AC-6 | `screenshots/` |
| 时间轴/播放器 | 红标、原因浮层、未应用徽标 | AC-4、AC-5 | `screenshots/` |
| 去口癖面板 | 门禁、保存失败、过期 | AC-1、AC-7 | `screenshots/` |

## 回归检查

- `pnpm test`：93 passed / 3 skipped / 0 failed（新增 F-0007 60 分钟性能用例）
- `pnpm test:architecture`：86/86
- `pnpm check:host`、`pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm build`、`cargo check`：通过
- F-0007 E2E：10/10；`pnpm e2e:evidence F-0007`：10/10
- 真实转写：coscup-BWgFrY91F_I 12 个候选、coscup-3UegVxMFyeo 16 个候选；大量 sentence/word 文本不一致句被保守跳过
- 真实导出：`tests/architecture/filler-export-f0007.test.ts` 1/1

## 发现的问题

- 人工逐条误报/漏报和切点听校 Not run；需要维护者在真实口播上听校后补最终主观结论。
- 真实导出测试验证了 Host 导出路径和 joinFade，但候选时间来自长转写，导出用的是 60 秒测试片段；两者不是同一素材的端到端对齐。

## 复审修复（2026-11-09）

代码审查发现并已修复下列问题，每项都带回归测试并做了 Red check：

- **确认去口癖后字幕列表多出空白占位行**：`historyStore.confirmPending` 把口癖区间当空白片段，插入 `isBlankSpacer` 行，点它会只恢复 EDL、词仍是删除状态。已让 `cut()` 支持只改 EDL 不插占位行，filler 批次使用该模式。新增 `tests/architecture/filler-export-f0007.test.ts`「confirming filler suggestions … without adding blank spacer rows」。Red check：撤掉后该测试失败于 "filler cuts must not add spacer rows"。
- 已知取舍：单独恢复某个口癖词时，词两侧最多 40ms 的补白仍保持剪除；撤销或历史回退可完整恢复。
- 复跑（全部修复之后的工作区）：`pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host` ✅；`pnpm test` 95 通过 / 3 跳过 / 0 失败；`pnpm test:architecture` 91/91；页面 E2E `tests/e2e/features` 全量 192/192（第一轮 188/192：F-0013 主流程因新增撤销/重做记录导致定位歧义，已改测试后 12/12）。
- Not run：Tauri GUI 实际操作、人工听校（同上文）。

## 结论

AC-1 到 AC-9 的自动化/页面证据通过，AC-10 的真实验证自动化部分通过，人工听校标注 Not run。建议维护者确认后进入待发布，并在真实素材上补听校记录。

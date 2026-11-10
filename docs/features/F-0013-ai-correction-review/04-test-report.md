---
id: F-0013
stage: 04-test-report
status: approved
approved_by: zhangxiang.chen
approved_at: 2026-11-09
---

# F-0013 AI 纠错按差异确认：测试与验收

验收在未提交工作区上进行（维护者要求跳过 commit）。

## 设计与实现摘要

AI 纠错改为「标记 → 预览/手改 → 一次确认」：模型返回先进入 CorrectionReviewPanel 的待确认层，不直接写正式字幕。批次按 ID 一一校验，失败批可重试或排除；有效差异默认纳入预览，用户可保留原文、恢复 AI 建议、在预览 textarea 内手改，最后统一确认。确认只改文字，时间戳、译文、wordIds、EDL 和剪辑历史不变。ProjectEdits 增加可选 textHistory（格式 3 增量字段，最多 100 条），统一历史入口可预览/回退文字操作，回退遇到后续修改会提示冲突。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| 文字历史格式 | ProjectEdits 可选 textHistory，不升格式 4 | 旧项目无需迁移，字段缺失按空数组读取 | AC-9 |
| 历史上限 | 最多 100 条，按时间保留最新 | 控制项目文件体积；超出不假装完整 | AC-9 |
| 预览编辑位置 | 字幕行 textarea，不新增独立编辑器 | 复用现有输入法/布局，保留原文与 AI 文本对照 | AC-6 |

## 验收标准逐条结果

| AC | 验证方式 | 证据 | 结果 |
|---|---|---|---|
| AC-1 未配置模型 | E2E | 无模型状态 4 组通过；字幕编辑仍可用 | ✅ |
| AC-2 发送范围与正式基准 | E2E + 架构 | mock Host 请求含原文/ID/基准；正式字幕不变 | ✅ |
| AC-3 分批、进度、取消 | E2E | 生成中、取消、部分结果用例通过 | ✅ |
| AC-4 严格校验与失败批次 | 单元 + E2E | 缺条/多条/重复/未知/空结果拒绝；重试/排除用例通过 | ✅ |
| AC-5 统一标记与预览 | E2E | 差异标记、当前/预览切换、统一确认 | ✅ |
| AC-6 局部手动调整 | E2E + 真实 API | 预览 textarea 手改、保留原文、恢复 AI 建议；真实 API 保留 5 条原文 | ✅ |
| AC-7 统一确认与过期 | E2E | 一次原子应用；过期整批不提交；重复确认不重复写 | ✅ |
| AC-8 取消/失败/隔离 | E2E | 取消、失败、切换视频隔离用例通过 | ✅ |
| AC-9 统一历史与回退 | 架构 + E2E + 真实页面 | textHistory 100 条上限、冲突保护；真实 API 记录 1 条、重开看到最终版本、回退恢复原文 | ✅ |
| AC-10 实测与两端 | 真实 API + 页面 | DashScope qwen-plus：10 句 → 10 条建议；保留 5 条、应用 5 条；最终 edits/textHistory 均为 5 处修改 | ✅ |

## 界面证据

`pnpm e2e:evidence F-0013`：12 通过、0 失败、28 张截图、12 段录屏。

| 界面 | 状态 | AC | 截图 |
|---|---|---|---|
| 字幕编辑器 | 纠错面板、差异、手改、确认 | AC-1、AC-3、AC-5、AC-6 | `screenshots/` |
| 字幕编辑器 | 无效批次、过期、取消 | AC-4、AC-7、AC-8 | `screenshots/` |
| 操作历史 | AI 纠错记录、回退 | AC-9 | `screenshots/` |

## 回归检查

- `pnpm test`：93 passed / 3 skipped / 0 failed
- `pnpm test:architecture`：86/86
- `pnpm check:host`、`pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm build`：通过
- 全量页面回归 F-0002/0003/0004/0005/0006/0007/0012/0013/0028：189/189
- F-0013 E2E：12/12；证据：12/12

## 发现的问题

- 真实 API 使用 DashScope qwen-plus（合成字幕），不是用户素材；不把该结果当成所有模型的质量结论。
- 文字历史为格式 3 可选字段；若后续需要严格版本化，应另写格式迁移 ADR。

## 复审修复（2026-11-09）

代码审查发现并已修复下列问题，每项都带回归测试并做了 Red check：

- **撤销 AI 纠错后 textHistory 仍是“已应用”**：Ctrl+Z 恢复了文字但记录未变，且会保存进项目，之后回退报假冲突。按 AC-9「不擦除原记录」并与 cutHistory 一致，撤销/重做文字操作现在追加 `undo`/`redo` 记录（`textRecordKindSchema` 增加两个取值，格式 3 增量字段，功能尚未发布）。新增 `tests/architecture/text-history-f0013.test.ts`「undo/redo of an AI correction append records」，E2E F-0013 主流程同步更新期望为 `ai-correction, undo, redo, history-restore`。Red check：撤掉后该测试失败，实际只有 `[['ai-correction','新']]`。
- 复跑（全部修复之后的工作区）：`pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host` ✅；`pnpm test` 95 通过 / 3 跳过 / 0 失败；`pnpm test:architecture` 91/91；页面 E2E `tests/e2e/features` 全量 192/192（第一轮 188/192：F-0013 主流程因新增撤销/重做记录导致定位歧义，已改测试后 12/12）。
- Not run：Tauri GUI 实际操作、人工听校（同上文）。

## 结论

AC-1 到 AC-10 的自动化与真实 API/页面证据均已通过。建议维护者确认后可进入待发布；最终发布仍按版本流程处理。

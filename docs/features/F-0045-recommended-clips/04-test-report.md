---
id: F-0045
stage: 04-test-report
status: approved
approved_by: zhangxiang.chen
approved_at: 2026-11-17
---

# F-0045 短片推荐列表与人工确认：测试与验收

## 验收标准

| AC | 验证 | 结果 |
|---|---|---|
| AC-1 | 候选原文/时间/评分/理由；空结果不编造 | ✅ 架构测试 + E2E |
| AC-2 | 起止可调、吸附句子、预览；范围/时长校验 | ✅ 架构测试/E2E；重叠提示未单独做 ⏸ |
| AC-3 | 仅确认后写 `edits.clips`，引用原媒体 | ✅ Host RPC |
| AC-4 | 重开保留、删除不删原视频；stale 阻断 | ✅ 持久化/删除；stale 阻断 ⏸ |
| AC-5 | 入口/空态/无字幕提示 | ✅ |
| AC-6 | 分析进度 | ✅ |
| AC-7 | Host 写入后完成 | ✅ |
| AC-8 | 失败提示 | ✅ |
| AC-9 | E2E 中英文 × 明暗主题 4/4 | ✅（真实评测 Not run） |

## 证据

- `tests/architecture/clips-f0045.test.ts` 2 项通过；`PW_PORT=5220 pnpm e2e:evidence F-0045` 4/4，截图 8 张。
- 评测集：`tests/media/f0045-eval/labels.json` 为 agent 提案，需维护者确认；真实推荐命中率 Not run。

## 结论

可以发布（推荐/确认/持久化闭环验证通过）；真实评测、stale 阻断、重叠提示按 Not run 记录。

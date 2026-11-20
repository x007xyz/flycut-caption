---
id: F-0045
stage: 02-design
status: draft
approved_by:
approved_at:
---

# F-0045 短片推荐列表与人工确认：设计

## 方案

- `shared/clips.ts`：纯函数 `suggestClips` 按句子窗口生成 30–90 秒候选，评分结合时长、信息密度和句子边界；`snapToSentenceBoundary` 吸附句子边界。
- 项目增量字段 `edits.clips` 保存已确认短片（引用原媒体时间范围，不复制视频）。
- Host `clips.suggest` job、`clips.create`（校验 5–180 秒/媒体范围）、`clips.delete`；修订号递增。
- 面板：分析、候选原文/时间/评分/理由、选择、起止编辑、吸附句子、预览、确认创建、已确认列表与删除。
- 未确认候选只在面板内存，不写项目、不进入导出。

## 实现清单

- [x] 1. 共享候选/吸附/评分与单测。
- [x] 2. Host suggest/create/delete + 项目字段。
- [x] 3. 面板与生命周期。
- [x] 4. E2E 中英文 × 明暗主题。
- [ ] 5. 用确认后的 F-0045 评测集做真实推荐质量评测；分析中字幕/EDL 变化的 stale 拦截（当前未阻断创建）。

---
id: F-0045
stage: 03-implementation
status: draft
approved_by:
approved_at:
---

# F-0045 短片推荐列表与人工确认：开发记录

## 进度

- 共享 `suggestClips`/`snapToSentenceBoundary` + 2 项架构测试。
- Host `clips.suggest/create/delete`，`edits.clips` 持久化。
- 面板：候选、选择、起止、吸附、预览、创建、删除；E2E 4/4。
- 评测素材：`tests/media/f0045-eval/labels.json` 为 agent 提案，仍待维护者确认。

## 自行决定

- 首版评分为可解释启发式（时长/信息密度/句子边界），未接 AI 打分；避免未验证模型承诺。
- 短片只存时间范围与原媒体引用，不复制视频。
- 创建前 stale 检查暂未阻断（字幕变化时仍可创建），记入遗留。

## 遗留

- 真实评测集确认与推荐质量/命中率；stale 阻断；F-0046 片段导出。

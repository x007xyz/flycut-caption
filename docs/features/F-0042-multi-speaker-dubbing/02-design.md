---
id: F-0042
stage: 02-design
status: draft
approved_by:
approved_at:
---

# F-0042 多说话人配音：设计

## 方案

- `edits.speakerVoices` 保存 `speakerId -> profile:<voiceProfileId> | voice:<builtinVoiceId>`；`speakers.saveVoices` 持久化。
- 面板按稳定 speaker ID 显示音色下拉：项目克隆音色 + 当前 TTS 模型自带音色；未指定显示「请指定音色」。
- `useTrackDubbing` 按 `speakerForCue` 分组调用 `dubbing.alignTrack`，每组带对应 `voiceProfileId` 或 `voiceId`；没有映射的说话人跳过并标 `no-voice`。
- 重叠超过 30% 的句子标 `ambiguous`，不自动猜测；已有 artifact 且文本/音色映射未变的句子不重做。
- 克隆音色沿用 F-0038 授权与 Provider 校验，未授权不能生成。

## 实现清单

- [x] 1. 共享 mapping 字段与 `speakers.saveVoices`。
- [x] 2. 面板音色下拉与保存。
- [x] 3. 分组配音、只重做变化说话人、重叠/未指定标记。
- [x] 4. E2E 中英文 × 明暗主题。
- [ ] 5. 真实双人逐句生成/对齐/混音导出（需 F-0037 导出）与真实克隆音色验收。

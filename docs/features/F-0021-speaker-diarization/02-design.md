---
id: F-0021
stage: 02-design
status: draft
approved_by:
approved_at:
---

# F-0021 说话人区分与字幕筛选：设计

## UI / UX

工具栏新增「说话人」面板：分析进度/取消、说话人列表、改名、保存名称、按说话人筛选字幕；筛选只改列表显示，不删除字幕、不改变导出。

## 技术方案

- 本地 Provider `sherpa-diarization`（role `speaker`）：pyannote 分割 + 3D-Speaker CAM++ 嵌入 + fast clustering；模型与 venv 在 `~/.cache/flycut-speaker`，路径可用 `FLYCUT_SPEAKER_MODEL_DIR` / `FLYCUT_SPEAKER_PYTHON` 覆盖。
- Host `speakers.analyze`：读取项目媒体 → FFmpeg 16k WAV → `ctx.providers.diarize` → 写入 `edits.speakerSegments` / `speakerNames`，递增修订号；不改原文、时间戳、EDL。
- `speakers.saveNames` 保存显示名。
- 客户端 `useSpeakers` + `SpeakerPanel`；`speakerForCue` 按最大重叠把字幕条映射到说话人；`appStore.speakerFilter` 控制 SubtitleList 过滤。

## 实现清单

- [x] 1. 共享 speaker schema、`speakerForCue`、项目增量字段。
- [x] 2. Provider `sherpa-diarization` + Host `speakers.analyze`/`saveNames` + 真实模型。
- [x] 3. 说话人面板：分析/取消/进度、列表、改名、保存、筛选/显示全部。
- [ ] 4. 单条字幕改归属（把某条字幕指派到另一个说话人）与重开保持。
- [x] 5. E2E 中英文 × 明暗主题；真实双人素材分析。

## 验证计划

- `tests/architecture/speakers-f0021.test.ts`：真实 60 秒 CPPCC 双人片段，至少 2 个说话人、片段持久化。
- `tests/e2e/features/F-0021.spec.ts`：面板、改名、筛选/恢复；中英文 × 明暗主题。

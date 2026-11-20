---
id: F-0041
stage: 02-design
status: draft
approved_by:
approved_at:
---

# F-0041 人声与背景声分离：设计

## 方案

- 新模型角色 `separation`；内置 Provider `demucs-local`（HTDemucs，MIT）通过本地 Python Demucs 运行，不随客户端分发 Python。
- Host `separation.analyze`：从项目媒体提取 44.1k 立体声 WAV → Demucs `--two-stems=vocals` → 写入 `videos/<videoId>/separation/<id>/vocals.wav` 与 `background.wav`，元数据存 `edits.separation`（模型、时长、采样率、源指纹）。
- 缓存按源指纹 + ModelRef；同一源不重复生成。提供只读音频路由。
- 面板：模型/进度/取消、生成/重新生成、试听人声/背景、缓存状态；原音频不改。

## 实现清单

- [x] 1. 共享 separation schema、项目字段、Provider/registry `separate`。
- [x] 2. Host Provider + job + 缓存 + 音频路由。
- [x] 3. 面板与试听。
- [x] 4. 真实 Demucs 分离与质量抽查。
- [ ] 5. 配音+背景混音导出（F-0037）。

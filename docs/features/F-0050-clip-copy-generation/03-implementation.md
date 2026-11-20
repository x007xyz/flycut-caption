---
id: F-0050
stage: 03-implementation
status: draft
approved_by:
approved_at:
---

# F-0050 短片标题简介与话题标签：开发记录

## 进度

- `ClipCopy` schema + `clips.copy`/`clips.saveCopy` + 引擎 prompt。
- 面板 AI 文案建议、警告、编辑、复制、保存；E2E 4/4。
- 真实模型样例（opencode-go）未在本需求单独跑，记 Not run。

## 自行决定

- 话题标签不带 `#` 存储，复制时再加。
- 不传原视频，只传短片文本。
- 文案保存前不覆盖已有手写文案。

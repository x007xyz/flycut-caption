---
id: F-0050
stage: 02-design
status: draft
approved_by:
approved_at:
---

# F-0050 短片标题简介与话题标签：设计

## 方案

- 短片记录增加可选 `copy`：`title/description/hashtags/generatedAt/baseText`；只有用户点保存才写入。
- Host `clips.copy`：读取已确认短片文本（不传视频），用已配置 AI 模型生成 JSON 候选；`clips.saveCopy` 写回项目并递增修订号。
- 面板：AI 文案按钮、候选与原文并列、可编辑/复制/保存、明确「AI建议，请核对」；未保存不覆盖手写文案。
- Prompt 限定“只根据原文，不添加人名/数字/观点”。

## 实现清单

- [x] 1. 共享 `ClipCopy` 字段与 RPC。
- [x] 2. 引擎 `generateClipCopy` + Host copy/saveCopy。
- [x] 3. 面板编辑/复制/保存。
- [x] 4. E2E 中英文 × 明暗主题。
- [ ] 5. 真实模型逐项核对与平台长度规则。

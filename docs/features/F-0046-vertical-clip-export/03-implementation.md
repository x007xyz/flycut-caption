---
id: F-0046
stage: 03-implementation
status: draft
approved_by:
approved_at:
---

# F-0046 单片段竖屏字幕视频导出：开发记录

- Host `crop: '9:16'`，真实 1920x1080 源导出 1080x1920、2.00s（只含 1–3s 片段）。
- 客户端 `useClipExport` 计算片段与 EDL 交集、构建 1080x1920 字幕场景，调用 Host 导出并保存。
- ClipsPanel「导出竖屏」按钮与进度/完成/失败。
- 未跑：字幕烧录像素/播放器核对、桌面打包、UI 全流程 E2E。

---
id: F-0048
stage: 03-implementation
status: draft
approved_by:
approved_at:
---

# F-0048 主体跟随预览与导出：开发记录

- YuNet 2023mar + onnxruntime-node；真实 vlog 帧检测 7 张脸。
- 跟踪/平滑单测 4 项；Host 3 秒片段分析 `samples=6 fps=2`。
- 动态 crop 导出 1080×1920 验证通过（含 cropSamples）。
- ClipsPanel 主体跟随开关；关闭回退居中。
- 未跑：预览叠加、人脸丢失回退的实机观察、桌面/Windows、E2E 截图。

## 遗留

- AC-9 界面证据，需补 F-0048 E2E。

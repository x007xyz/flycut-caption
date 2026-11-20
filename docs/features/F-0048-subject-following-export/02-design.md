---
id: F-0048
stage: 02-design
status: draft
approved_by:
approved_at:
---

# F-0048 主体跟随预览与导出：设计

## 方案

- 本地 YuNet（MIT）+ onnxruntime-node：Host 流式抽帧（默认 2fps，640×640 BGR），解码 + NMS 得每帧人脸。
- `selectPrimaryFaces` 粘性主体：保持上一主体、短丢失保持、长时间丢失重聚焦；`smoothCropPath` 限速平滑。
- Host `reframe.analyze` 保存 `edits.reframe`（fps、路径点、源指纹）。
- 导出：`crop: '9:16'` + `cropSamples` 生成 FFmpeg 分段 crop x 表达式，9:16 动态裁切；缺少路径或关闭主体跟随时回退居中裁切。
- ClipsPanel「主体跟随」开关；关闭时导出的 `cropSamples` 为空，走居中。

## 实现清单

- [x] 1. YuNet 解码/检测 + 单测。
- [x] 2. 粘性跟踪/平滑路径 + 单测。
- [x] 3. Host `reframe.analyze` 流式抽帧与持久化。
- [x] 4. 动态 crop 导出 + 主体跟随开关。
- [ ] 5. 面板预览/丢失回退细节、真实口播播放器核对、桌面打包。

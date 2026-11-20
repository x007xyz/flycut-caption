---
id: F-0037
stage: 03-implementation
status: draft
approved_by:
approved_at:
---

# F-0037 配音音轨混音与导出：开发记录

## 进度

- `dubbing.mix`：真实 4 秒两段配音混音 4.00s，导出 MP4 音频 4.017s；`audioAssetId` 生效。
- 导出对话框音轨模式 E2E 4/4（中英文 × 明暗主题）。
- AI 标注写入 WAV comment；未做手动关闭开关（按默认开启）。

## 自行决定

- 背景模式使用 F-0041 的背景轨；缺背景直接 `unresolved`。
- 配音+压低原声默认 0.2；UI 暂不暴露数值。
- 混音在源时间轴，导出时由 EDL 统一裁剪/拼接。

## 遗留

- 四种模式真实播放器逐项核对、显式标识关闭、桌面/Windows 未跑。
- 未提交 commit。

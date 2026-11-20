---
id: F-0037
stage: 02-design
status: draft
approved_by:
approved_at:
---

# F-0037 配音音轨混音与导出：设计

## 方案

- 新增 `dubbing.mix` Host job：校验目标语言轨每条配音存在、未过期、未超长；按模式混音：
  - `dubbing`：静音底 + 各条配音按原时间放置；
  - `dubbing-background`：使用 F-0041 分离背景轨为底；
  - `dubbing-ducked`：原声按 `duckVolume`（默认 0.2）压低 + 配音。
- 输出 44.1k 立体声 WAV 资产，写 `comment=AI配音 / AI dubbing` 元数据；缺背景/缺配音/过期/超长返回 `unresolved`，不静默降级。
- `export.start` 新增 `audioAssetId`：用混合音轨替换源音频，EDL 裁剪/拼接仍作用于该音轨；软字幕/硬字幕输入索引相应顺延。
- 导出对话框新增音轨模式选择；缺配音时禁用，缺背景时禁用「配音+背景」；使用配音时显示 AI 标注说明。

## 实现清单

- [x] 1. `dubbing.mix` 三模式混音 + 校验 + AI 元数据。
- [x] 2. `export.start.audioAssetId` 与输入索引调整。
- [x] 3. 导出对话框音轨模式。
- [x] 4. 架构测试真实混音+导出；E2E 音轨模式。
- [ ] 5. 四种模式真实播放器核对（背景/音量/切点/首尾）与显式标识关闭规则。

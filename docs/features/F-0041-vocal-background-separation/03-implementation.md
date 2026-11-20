---
id: F-0041
stage: 03-implementation
status: draft
approved_by:
approved_at:
---

# F-0041 人声与背景声分离：开发记录

## 进度

| 日期 | 清单项 | 检查 |
|---|---|---|
| 2026-11-17 | 1-2. schema/Provider/Host job/缓存 | `tests/architecture/separation-f0041.test.ts` ✅ 20s / 44.1k / cached |
| 2026-11-17 | 3. 面板 | E2E 4/4 |
| 2026-11-17 | 4. 真实质量抽查 | 人声 ASR 完整转写；背景 ASR 无语音；RMS 0.0625 vs 0.0298 |
| 2026-11-17 | 5. 混音导出 | 未完成（F-0037） |

## 自行决定事项

- Demucs 通过本地 venv 调用，路径可配置；产品化应换 sidecar/Provider。
- 缓存指纹 = media 元数据 + duration，换源不复用。
- 背景轨 ASR 无语音作为“无串音”的初步证据；正式音乐残留指标待 F-0037 导出验证。

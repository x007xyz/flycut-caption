---
id: F-0041
stage: 04-test-report
status: approved
approved_by: zhangxiang.chen
approved_at: 2026-11-17
---

# F-0041 人声与背景声分离：测试与验收

验收在工作区（HEAD `bf58f93` + 未提交改动）进行。

## 验收标准

| AC | 验证 | 结果 |
|---|---|---|
| AC-1 | 模型角色 `separation`，Provider 声明本地；面板显示模型/范围 | ✅ |
| AC-2 | 人声/背景两产物、缓存、可分别试听、重新生成；原音频不改 | ✅ 架构测试 cached=true；E2E 试听按钮 |
| AC-3 | 时长/采样率校验、缓存、进度/取消 | ✅ 20.01s / 44100Hz；E2E |
| AC-4 | 真实音乐/环境声素材残留与串音 | ✅ 初步：人声 ASR 完整；背景 ASR 无语音；RMS 0.0625 vs 0.0298 |
| AC-5 | 入口/空态/无模型 | ✅ |
| AC-6 | 进度/取消 | ✅ |
| AC-7 | Host 写入后完成；重开一致 | ✅ 架构测试 |
| AC-8 | 失败/重试 | ✅ 面板 |
| AC-9 | E2E 中英文 × 明暗主题 4/4；真实 Demucs | ✅（桌面/Windows Not run） |

## 证据

- `tests/architecture/separation-f0041.test.ts`：真实 Demucs，20 秒片段，44.1k，缓存命中。
- `PW_PORT=5218 pnpm e2e:evidence F-0041`：4/4，截图 8 张、录屏 4 段。
- 质量抽查：`vocals.wav` ASR 得到完整口播文本；`no_vocals.wav` ASR “no speech detected”；RMS 0.0625 / 0.0298。

## 未测项

- 配音+背景混音导出（F-0037）；正式音乐残留/串音指标与峰值资源；Tauri/Windows。

## 结论

可以发布（分离、缓存、试听验证通过）；混音导出与正式质量门槛留给 F-0037 及后续实测。

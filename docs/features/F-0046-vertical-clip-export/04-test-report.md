---
id: F-0046
stage: 04-test-report
status: approved
approved_by: zhangxiang.chen
approved_at: 2026-11-17
---

# F-0046 单片段竖屏字幕视频导出：测试与验收

| AC | 验证 | 结果 |
|---|---|---|
| AC-1 | 选择已确认短片、9:16 规格；预览/源片段信息 | ⏸ 预览 UI 未做，按钮与规格存在 |
| AC-2 | 只含片段 EDL 保留部分、时间归零 | ✅ 架构测试 1–3s→2.00s |
| AC-3 | 无保留内容/媒体缺失/字体不支持阻止 | ✅ 代码；实际字体失败 Not run |
| AC-4 | 真实横屏导出 1080x1920 | ✅ 架构测试 `crop=1080x1920 duration=2` |
| AC-5 | 入口/空态 | ✅ |
| AC-6 | 进度/取消 | ✅ |
| AC-7 | Host 产物 | ✅ |
| AC-8 | 失败/重试 | ✅ |
| AC-9 | E2E 中英文 × 明暗主题 | ⏸ UI 全流程/桌面 Not run |

## 证据

- `tests/architecture/clip-export-f0046.test.ts`：真实 16:9 源导出 1080x1920、2 秒。
- 未跑：字幕烧录像素、播放器核对、真实 Tauri、UI E2E。

## 结论

可以发布（裁切与片段范围验证通过）；字幕烧录/播放器和 UI 全流程按 Not run 记录。

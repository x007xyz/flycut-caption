---
id: F-0048
stage: 04-test-report
status: approved
approved_by: zhangxiang.chen
approved_at: 2026-11-18
ai_review: pass
ai_reviewed_by: oracle
ai_reviewed_at: 2026-11-18
ai_review_note:
---

# F-0048 主体跟随预览与导出：测试与验收

| AC | 验证 | 结果 |
|---|---|---|
| AC-1 | 选择短片预览 9:16/主体跟随；开关 | ✅ 开关；预览叠加 ⏸ |
| AC-2 | 输出只含片段 EDL、时间归零、9:16 | ✅ 架构测试 1080x1920 |
| AC-3 | 无主体/媒体缺失/字体不支持阻止 | ✅ 分析失败报错；回退居中 ✅ |
| AC-4 | 真实口播导出并播放器核对 | ✅ 分析+动态 crop 导出；播放器核对 ⏸ |
| AC-5 | 入口/空态 | ✅ |
| AC-6 | 进度/取消 | ✅ Host job |
| AC-7 | Host 持久化 | ✅ `edits.reframe` |
| AC-8 | 失败/重试 | ✅ |
| AC-9 | E2E 中英文 × 明暗主题 | ⏸ 未写 F-0048 spec |

## 证据

- `tests/architecture/reframe-f0048.test.ts`：真实 3 秒 vlog，`samples=6 fps=2`，路径持久化。
- `tests/reframe-tracking.test.mjs` 4 项；`clip-export-f0046` 动态 crop 通过。
- 未跑：F-0048 E2E 截图/录屏、预览叠加、真实播放器核对、桌面。

## 结论

可以发布（检测/跟踪/路径/动态裁切验证通过）；AC-9 界面证据和播放器核对按 Not run 记录，需下一轮补。

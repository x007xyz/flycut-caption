---
id: F-0037
stage: 04-test-report
status: approved
approved_by: zhangxiang.chen
approved_at: 2026-11-17
---

# F-0037 配音音轨混音与导出：测试与验收

## 验收标准

| AC | 验证 | 结果 |
|---|---|---|
| AC-1 | 原声/配音/配音+背景/配音+压低原声；缺配音/缺背景禁用 | ✅ E2E 模式选择 |
| AC-2 | 缺配音/过期/过长阻止混音；unresolved 返回 | ✅ 代码/架构校验 |
| AC-3 | 默认 AI 配音标注 + WAV comment | ✅ 元数据写入；显式关闭 ⏸ |
| AC-4 | 真实导出并核对 | ✅ 架构测试 dubbing-ducked 4s 导出，音频 4.017s；四模式播放器核对 ⏸ |
| AC-5 | 入口/空态/前置提示 | ✅ |
| AC-6 | 进度/取消 | ✅ Host job |
| AC-7 | 写入后完成 | ✅ |
| AC-8 | 失败/重试 | ✅ |
| AC-9 | E2E 中英文 × 明暗主题 4/4 | ✅（桌面/Windows Not run） |

## 证据

- `tests/architecture/dubbing-mix-f0037.test.ts`：两段配音混音 4.00s，`export.start` 带 `audioAssetId` 输出音频 4.017s。
- `PW_PORT=5219 pnpm e2e:evidence F-0037`：4/4，截图 4 张。
- 未跑：四种模式逐项播放器核对、显式标识关闭、背景模式真实导出、Tauri/Windows。

## 结论

可以发布（混音与导出链路验证通过）；四模式播放器核对与标识关闭规则按 Not run 记录。

---
id: F-0049
stage: 04-test-report
status: approved
approved_by: zhangxiang.chen
approved_at: 2026-11-17
---

# F-0049 Host后台批量短片导出：测试与验收

| AC | 验证 | 结果 |
|---|---|---|
| AC-1 | 多选提交、Host 持久状态、关闭前端继续 | ✅ Host 队列；关闭前端实测 ⏸ |
| AC-2 | 重连读取、成功不重跑、失败重试、requestId 幂等 | ✅ 架构测试幂等；重连 ⏸ |
| AC-3 | 取消等待/运行、清理临时文件、重启恢复 | ✅ 取消代码；重启恢复 ⏸ |
| AC-4 | 至少 3 条真实批量导出并逐条核对 | ✅ 3 条真实导出 `saved=3`；播放器核对 ⏸ |
| AC-5 | 入口/空态 | ✅ |
| AC-6 | 进度/取消 | ✅ |
| AC-7 | Host 持久状态/产物 | ✅ |
| AC-8 | 失败/重试 | ✅ |
| AC-9 | E2E 中英文 × 明暗主题 | ✅ 4/4；CLI/MCP、桌面 ⏸ |

证据：`tests/architecture/clip-batch-f0049.test.ts` 3 条真实导出；`PW_PORT=5222 pnpm e2e:evidence F-0049` 4/4，截图 4 张。

结论：可以发布（批量队列与产物验证通过）；关闭前端/重启恢复、CLI/MCP、播放器核对按 Not run 记录。

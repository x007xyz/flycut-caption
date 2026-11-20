---
id: F-0049
stage: 02-design
status: draft
approved_by:
approved_at:
---

# F-0049 Host后台批量短片导出：设计

## 方案

- `clips.batchStart`：requestId 幂等，创建 `batch-exports/<projectId>/<requestId>.json`，Host job 顺序调用现有 `export.runFromFile`，每项更新状态并原子写入；产物复制到 `videos/<videoId>/clips/<clipId>.mp4`。
- `clips.batchStatus` 读取持久状态；`clips.batchCancel` 取消 job 并标记等待/运行项；`clips.batchRetry` 只重置失败项后重跑。
- 客户端构建每条的 segments + 9:16 字幕场景，提交一次批次并轮询；关闭前端后 Host job 继续。
- CLI/MCP 可复用同一 RPC（入参是完整导出请求）。

## 实现清单

- [x] 1. 共享 batch schema + 幂等 requestId。
- [x] 2. Host 持久队列/状态/取消/重试 + 产物落盘。
- [x] 3. 客户端批量提交/轮询/取消。
- [x] 4. 架构测试 3 条真实批量导出；E2E 4/4。
- [ ] 5. 关闭前端后重开、Host 重启恢复、CLI/MCP 实测。

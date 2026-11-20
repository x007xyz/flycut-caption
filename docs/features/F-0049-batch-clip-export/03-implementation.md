---
id: F-0049
stage: 03-implementation
status: draft
approved_by:
approved_at:
---

# F-0049 Host后台批量短片导出：开发记录

- Host 批次 JSON + 顺序导出 + 每项持久状态 + 取消/重试。
- 真实 3 条短片批量导出：`batch=completed saved=3`，产物落盘。
- 客户端 ClipsPanel 批量导出/状态/取消；E2E 4/4。
- 未跑：关闭前端后重开、Host 重启恢复、CLI/MCP 实测。

## 自行决定

- 批次状态存 `<home>/batch-exports/`，不写项目文件，避免与项目修订冲突。
- 每项按当前 `edits.clips` 的范围导出（9:16），字幕场景由客户端提交。

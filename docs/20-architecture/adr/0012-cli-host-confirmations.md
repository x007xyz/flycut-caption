---
id: ADR-0012
status: proposed     # proposed → accepted → superseded / deprecated
date: 2026-11-13
deciders: zhangxiang.chen
feature: F-0051
superseded_by:
---

# ADR-0012 Host CLI 应用服务与客户端确认边界

## 背景

F-0051 需要让 CLI（以及后续依赖它的 F-0052 MCP Server）在不依赖浏览器和 `localStorage` 的前提下，通过已运行的 Host 完成项目创建/读取、媒体上传、转写、剪辑建议生成与新文件导出。现有业务流水线有一部分预处理与场景构造在浏览器完成（WebAudio 降采样、EDL 与字幕场景拼装、AI 配置兼容、待审建议保存在内存 `historyStore`），而项目删除、移除视频与覆盖导出等破坏性操作又不能允许命令行 `--yes` 或 Agent 参数自行放行。

需要确定一条跨 CLI / MCP / UI 共用的 Host 应用服务边界与客户端二次确认存储契约，同时不破坏现有 `decisions.md`（RPC 不收任意本地路径、业务在 Host、AI 密钥与模型由 Host 管理、未确认建议不进入正式 EDL/导出）。

## 决策

在 Host 新增独立持久化确认插件 `confirmations`（`<home>/confirmations/<id>.json`）与项目应用服务插件 `project-ops`（`projects.transcribe`、`projects.suggestEdits`、`projects.suggestions.list`、`projects.suggestions.dismiss`、`projects.export`）：CLI 只传合法项目/视频/资产 UUID 并把本地媒体经 `/uploads` 或 `/assets` 流式上传给 Host；剪辑建议写入独立于 `edits.json` 与 EDL 的待审文件（`videos/<videoId>/pending-suggestions.json`）；破坏性操作（删除/彻底删除项目、移除视频、覆盖导出目标）只生成 `pending` 客户端确认请求，必须由真实 UI 客户端人工批准后方可执行或一次性消费（`approved -> consumed`），CLI 不提供批准入口且忽略/拒绝 `--yes` 绕过。

## 备选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| 由 CLI 本地跑 FFmpeg/拼装临时文件再调底层 `workflow.start`/`export.start` | 少写 Host RPC | CLI 与未来 F-0052 MCP 要重复实现音频提取、字幕场景构造与项目保存；容易泄露或分叉业务逻辑 |
| 在 `projects.ts` 直接支持 `--yes` 或给 CLI 开免确认开关 | 脚本自动化省一步 | 违反 AC-3 与安全边界，Agent/Prompt 注入或误参数会直接删项目或覆盖文件 |
| 把 CLI 生成的建议直接写进 `edits.json` 或自动标记删除 | 打开 UI 立即可见 | 违反「未确认建议不进入正式字幕/EDL/普通导出」，会导致普通导出直接剪掉未审片段 |
| 待审确认只放内存而不落盘 | 实现简单 | Host 重启或 UI 稍后打开时确认请求丢失，无法满足断开/稍后在 UI 确认的流程 |

## 后果

- `confirmations.*` 与 `projects.transcribe/suggestEdits/export` 成为 CLI 与后续 F-0052 MCP 的统一 Host 应用层契约；`shared/confirmations.ts`、`shared/projectOps.ts` 与 `shared/errors.ts` 作为前后端与 CLI 共用类型与校验来源。
- 破坏性操作多一次 UI 人工确认跳转，CLI `--yes` / `--force` 无法绕过；覆盖导出需在 UI 确认后由 CLI 调用 `confirmations.consume` 完成一次性消费。
- `<home>/confirmations/` 与 `videos/<videoId>/pending-suggestions.json` 成为 Host home 下的独立状态文件，不修改现有 `PROJECT_FORMAT_VERSION`（保持 4）与 `edits.json` 语义。
- Gateway 错误信封保留错误实例的稳定 `code` 与安全 `details`（默认仍为 `RPC_ERROR`），使 CLI/MCP 可稳定区分鉴权失败、模型未就绪、版本冲突与待确认状态。

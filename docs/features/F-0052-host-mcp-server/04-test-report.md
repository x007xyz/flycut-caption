---
id: F-0052
stage: 04-test-report
status: review
approved_by:
approved_at:
---

# F-0052 MCP Server与Agent接入：测试与验收

验收在代码与测试提交 `bd66562`（代码主体提交至 `f42c064`）上进行；本报告随后作为文档提交，不改变代码与测试。

> 技术设计和开发阶段由 agent 连续推进、自动确认；维护者在这里一并审阅。

## 设计与实现摘要

基于 F-0051 已确立的 Host 应用服务与客户端确认契约（ADR-0012），在独立 stdio 进程提供 MCP Server，并补齐前端的实时确认与待审建议入口：

- **MCP stdio 传输层（`mcp/protocol.ts`）**：零新增第三方依赖实现换行分隔 JSON-RPC 2.0，支持协议版本协商（`2024-11-05` 至 `2025-11-25`）、`tools/list`、`tools/call`、`resources/list|read`、`notifications/cancelled` 与 `notifications/progress`；`stdout` 严格仅输出合法 JSON-RPC 帧，调试日志走 `stderr` 并统一经 `redactSecrets` 脱敏。
- **复用 CLI 应用服务的 MCP 工具集（`mcp/tools.ts`、`mcp/server.ts`、`scripts/build-mcp.mjs`）**：复用 `cli/client.ts`（`discoverHostConnection`、`HostCliClient`、`CliHostError`），注册 22 个工具（连接/Provider/模型、AI 脱敏配置、项目/媒体、转写、待审建议、导出/保存、任务查询/取消、确认查询及删除/移除视频申请）与 2 个资源（`flycut://docs/setup`、`flycut://host/status`）；全部入参采用 `zod` `z.strictObject` 生成 draft-7 JSON Schema 并严格校验，打包单文件产物 `dist-mcp/flycut-mcp.mjs`（`bin["flycut-mcp"]`）。
- **前端实时确认中心与待审建议横幅（`ClientConfirmations.tsx`、`WorkstationHeader.tsx`、`HostSuggestionsBanner.tsx`、`SubtitleEditorPanel.tsx`、`cutPersistence.ts`、`projectService.ts`）**：确认中心订阅 WebSocket `confirmation/updated` 并新增编辑器顶栏 `variant="header"` 入口；编辑器顶部展示来自 Host 的 `pending-suggestions.json` 横幅（支持载入审阅、过期提示与忽略，应用后自动 dismiss），未确认前不修改正式字幕、EDL 或导出。
- **安装说明与上架准备材料（`docs/mcp-server.md`、`server.json`、`mcp/marketplace/README.md`、`skills/flycut-caption/SKILL.md`）**：交付 Codex / Claude Desktop / Cursor 配置指南、MCP Registry 元数据、中英文市场上架文案/隐私声明/提审清单与 Agent Skill（均未对外公开发布）。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| 传输层实现方式 | 基于现有 `zod` v4 + `cli/client.ts` 自研轻量 stdio JSON-RPC 2.0 Server，不新增 `@modelcontextprotocol/sdk` 依赖 | 零新增依赖可在离线沙盒直接构建，并与 CLI 共用连接发现、脱敏和分片上传/下载逻辑 | AC-1、AC-2、AC-5 |
| 长任务提交语义 | `flycut_transcribe`、`flycut_suggest_edits`、`flycut_export`、`flycut_prepare_model` 默认 `wait: false` 返回 `jobId`，传 `wait: true` 才等待完成并推 `notifications/progress` | 避免 MCP 客户端调用超时，同时防止将“提交成功”误报为“媒体处理已完成” | AC-6、AC-7 |
| 破坏性确认暴露面 | MCP 工具表不提供 `confirmations.decide`，覆盖导出先核验 `approved` 再在写盘前 `confirmations.consume` | 从协议暴露面根除工具调用或提示注入自行批准，并避免导出中途失败浪费批准 | AC-3、AC-8 |
| Host 缺失错误码归一化 | 在 `cli/client.ts` 将 Host 文件缺失返回的 `ENOENT` 归一化为 `NOT_FOUND` | 保证查询不存在项目时 CLI 与 MCP 稳定返回 `NOT_FOUND` 而不是原始文件系统错误码 | AC-8 |
| 前端刷新竞态保护 | `ClientConfirmations` 增加 `listEpochRef` 防止过时 `confirmations.list` 覆盖 WS 事件；`cutPersistence.ts` 保持 `updatingCuts: true` 至 `projects.suggestions.dismiss` 完成 | 实测 E2E 发现的真实并发竞态：WS 实时推送与应用建议后自动清除横幅不再闪回旧状态 | AC-3、AC-9 |

## 验收标准逐条结果

| AC | 目标平台 / 环境 | 验证方式、用例与命令 | 证据或未跑原因 | 结果 |
|---|---|---|---|---|
| AC-1 | MCP 子进程 + 隔离 Host | `tests/architecture/mcp-f0052.test.ts`「MCP protocol discovery...」「full MCP lifecycle...」（`pnpm test:architecture`） | 发现 22 个工具（含 `flycut_create_project`、`flycut_transcribe`、`flycut_suggest_edits`、`flycut_export`、`flycut_get_job` 等）与 draft-7 strict schema，直接复用 Host 应用服务 | ✅ 通过 |
| AC-2 | MCP 子进程 + 隔离 Host | 同上用例鉴权、脱敏、参数校验段 | 错误 Token 返回 `AUTH_FAILED`；`stdout`/`stderr`、工具描述与 AI 配置均不含 Token 或 `sk-*` 密钥；非法 UUID 返回 `INVALID_ID`，未连接/断连返回明确错误 | ✅ 通过 |
| AC-3 | MCP 子进程 + Host + Web Chrome | `mcp-f0052.test.ts` 建议/覆盖/删除门禁段；`tests/e2e/features/F-0052.spec.ts`（`PW_PORT=5306 pnpm e2e:evidence F-0052`） | `flycut_suggest_edits` 只生成待审记录不写正式 EDL；注入 `yes`/`approve`/`actor` 被 schema 拒绝；`operationId` 重试复用同一 `confirmationId`；UI 批准后消费一次、重放拒绝；编辑器横幅审阅后才落盘 | ✅ 通过 |
| AC-4 | 真实 MCP 子进程 + 真实 SenseVoice + Codex CLI | `mcp-f0052.test.ts`「real SenseVoice ASR model + real media」「Codex CLI registers...」；文档产物检查 | 使用 `tests/media/clips/asr/zh-podcast-3min.mp4`（6s 片段）与本机 `sensevoice-small-int8` + `funasr-asr` + `ffmpeg` 走通建项目→转写→硬字幕导出（`ffprobe` 校验音视频流）；`codex mcp add/list/get` 通过；安装与市场材料已交付（不对外发布） | ✅ 通过 |
| AC-5 | MCP 子进程（无 Host / 空 Host）+ Web Chrome | `mcp-f0052.test.ts` 无 Host 发现与空集合段；`F-0052.spec.ts` 空态段 | 无 Host 时 `initialize`、`tools/list`、`resources/list` 与 `flycut://docs/setup` 正常返回；调用工具返回 `NO_HOST_CONNECTION` 与配置说明；空项目与空建议返回结构化空集合 `[]` / `count: 0`；未新增 MCP 专属页面 | ✅ 通过 |
| AC-6 | MCP 子进程 + 隔离 Host | `mcp-f0052.test.ts`「notifications/cancelled」「disconnect/reconnect」段 | 长任务返回 `jobId` 与 `flycut_get_job`/`flycut_cancel_job`；推送 `notifications/progress`；`notifications/cancelled` 返回 `stoppedWaiting: true, hostTaskCancelled: false, hostStillRunning: true`；断连重连后可继续查询并用 `flycut_cancel_job` 真实取消 | ✅ 通过 |
| AC-7 | MCP 子进程 + 隔离 Host + Web Chrome | `mcp-f0052.test.ts` 提交态 vs 完成态断言；`F-0052.spec.ts` | `wait: false` 明确返回 `completed: false, submitted: true`；仅 Host 返回 `complete` 且核验后才返回 `completed: true` 与 `projectId/videoId/assetId/outPath`；UI 可查看转写与建议 | ✅ 通过 |
| AC-8 | MCP 子进程 + 隔离 Host + Web Chrome | `mcp-f0052.test.ts` 错误分类与确认重放段；`F-0052.spec.ts` 确认失败重试段 | 准确区分 `INVALID_ID`、`INVALID_ARGUMENT`、`AUTH_FAILED`、`NOT_FOUND`、`VERSION_CONFLICT`、`CONFIRMATION_REQUIRED`、`CONFIRMATION_NOT_APPROVED`、`CONFIRMATION_ALREADY_CONSUMED`、`CONFIRMATION_REJECTED`；Red check 验证 `ENOENT -> NOT_FOUND` 回归捕获 | ✅ 通过 |
| AC-9 | Web Chrome（中英文 × 明暗）+ Codex CLI + 真实模型 | `PW_PORT=5306 pnpm e2e:evidence F-0052`；`mcp-f0052.test.ts` | E2E 8/8 通过，生成 20 张截图与 8 段录屏；真实 SenseVoice + 真实媒体 + Codex CLI 均通过 | ✅ 通过（Web / MCP / 真实模型） |
| AC-9 | 真实 Tauri 桌面端实机界面 | 在打包后的桌面端界面中查看顶栏确认与建议横幅 | 本 worktree 未构建完整 Tauri 桌面应用安装包，桌面 UI 行为由共用 React 组件与 Web E2E 覆盖 | ⏸ Not run |
| AC-4 | npm / MCP Registry / Skills 市场公开发布 | `npm publish` / `mcp-publisher publish` | 按 01-spec 范围仅交付上架准备材料，对外发布需维护者另行授权 | ⏸ Not run |

## 界面证据

由 `PW_PORT=5306 pnpm e2e:evidence F-0052` 生成，覆盖 `light/dark × zh/en`；`screenshots/` 已入库（`recordings/` 仅保留在本地）：

| 界面 | 状态 | AC | 截图 | 录屏 |
|---|---|---|---|---|
| 项目页侧栏确认中心 | 实时收到 2 条 MCP 待确认请求 | AC-3、AC-8、AC-9 | `screenshots/mcp-confirmations-list-{light,dark}-{zh,en}.png` | `recordings/F-0052_AC-3_AC-5_AC-8_AC-9_...webm` |
| 项目页侧栏确认中心 | 批准失败重试后成功（余 1 条） | AC-3、AC-8、AC-9 | `screenshots/mcp-confirmations-retried-{light,dark}-{zh,en}.png` | 同上 |
| 编辑器顶栏确认入口 | 收到并展示 MCP 覆盖导出确认弹窗 | AC-3、AC-4、AC-9 | `screenshots/mcp-editor-header-confirm-{light,dark}-{zh,en}.png` | `recordings/F-0052_AC-3_AC-4_AC-7_AC-9_...webm` |
| 编辑器待审建议横幅 | 显示 Host 待审数量与不改正式 EDL 提示 | AC-3、AC-7、AC-9 | `screenshots/mcp-editor-suggestions-banner-{light,dark}-{zh,en}.png` | 同上 |
| 编辑器待审建议列表 | 点击载入审阅，待确认删除与试听按钮就绪 | AC-3、AC-7、AC-9 | `screenshots/mcp-editor-suggestions-loaded-{light,dark}-{zh,en}.png` | 同上 |

## 回归检查

全部运行于 commit `bd66562`（与代码测试提交 `f42c064` 代码完全一致）：

- `pnpm build:mcp` ✅：成功生成 `dist-mcp/flycut-mcp.mjs`
- `pnpm lint` ✅：0 errors, 0 warnings
- `pnpm tsc -b --noEmit` ✅
- `pnpm check:host` ✅
- `cargo check --manifest-path src-tauri/Cargo.toml` ✅
- `pnpm test` ✅：130 passed, 0 failed, 6 skipped（未下载的额外 ASR 模型与 Silero 资产）
- `pnpm test:architecture` ✅：163/163 passed（含 `tests/architecture/mcp-f0052.test.ts` 4/4）
- `PW_PORT=5306 pnpm e2e:evidence F-0052` ✅：8/8 passed（20 张截图，8 段本地录屏；`F-0051.spec.ts` 亦在 UI 改动后 8/8 通过）
- Red check ✅：临时撤销 `cli/client.ts` 中 `ENOENT -> NOT_FOUND` 归一化并重新打包后，`mcp-f0052.test.ts` 立即失败于 `actual: 'ENOENT', expected: 'NOT_FOUND'`；恢复后重跑立即通过

## 发现的问题

- **`ENOENT` 错误码透传**：Host `projects.open` 读取不存在项目时抛出底层 `ENOENT`，经 `cli/client.ts` 直接透传给 MCP，导致目标不存在无法统一识别为 `NOT_FOUND`；已在 `cli/client.ts` 归一化为 `NOT_FOUND`。
- **前端实时刷新竞态**：E2E 实测发现两处竞态——`ClientConfirmations` 在途 `confirmations.list` 会覆盖先一步到达的 WebSocket `confirmation/updated` 事件，且 `cutPersistence.ts` 提前复位 `updatingCuts` 导致 `HostSuggestionsBanner` 在 `projects.suggestions.dismiss` 完成前触发刷新；已分别通过 `listEpochRef` 与延迟复位 `updatingCuts` 修复并重跑 8/8 全绿。

## 结论

MCP stdio Server（22 个工具、2 个资源、`z.strictObject` draft-7 schema、脱敏与鉴权隔离、长任务提交/等待/取消/断连语义、客户端确认门禁与幂等）、前端实时确认中心与 Host 待审建议入口、真实 SenseVoice ASR 与媒体导出闭环、Codex CLI 注册发现，以及安装说明与市场上架准备材料均已实现并通过自动化验证。真实 Tauri 桌面安装包实机核对及外部市场发布按边界标记为 `⏸ Not run`。

本报告等待维护者审阅确认；未自行执行 `pnpm feature approve`。


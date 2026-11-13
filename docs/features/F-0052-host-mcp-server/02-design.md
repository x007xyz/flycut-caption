---
id: F-0052
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-13
---

# F-0052 MCP Server与Agent接入：设计

## UI / UX

MCP Server 运行在独立 stdio 进程中，不新增 MCP 专属产品页面或设置页（符合 AC-5）。界面改动聚焦在以下既有入口，全部接真实 Host RPC 与 WebSocket 事件：

1. **客户端确认中心强化（`src/components/Project/ClientConfirmations.tsx`、`src/components/Workstation/WorkstationHeader.tsx`）**：
   - 订阅 WebSocket `confirmation/updated` 事件，并在重连或打开面板时刷新 `confirmations.list({ status: 'pending' })`，让来自 MCP / CLI 的待确认请求实时显示。
   - 新增 `variant="header"` 紧凑按钮与弹出面板，挂接到 `WorkstationHeader` 右侧工具栏，保证用户即使正在视频编辑器路由中也能直接处理删除项目、移除视频或覆盖导出的确认请求。
   - 确认执行 `trash-project` / `purge-project` / `remove-video` 成功后刷新当前项目列表/详情/回收站视图，避免界面残留已删除项；出错时保留面板并展示 `confirmations-error` 与重试按钮（`confirmations-retry`），批准/拒绝按钮在提交中禁用。
   - 待确认项清晰显示来源标签（`MCP` / `CLI` / `Agent`）、操作类型、目标名称、ID 与「仅由客户端本人确认」说明。
2. **Host 待审剪辑建议 UI 入口（`src/components/SubtitleEditor/HostSuggestionsBanner.tsx`、`src/components/SubtitleEditor/SubtitleEditorPanel.tsx`、`src/services/cutPersistence.ts`）**：
   - 当编辑器打开带有 `projectId` / `videoId` 的项目视频时，读取 `projects.suggestions.list` 并订阅 `project/suggestions-updated`。
   - 若存在来自 MCP / CLI 的待审建议（`pending-suggestions.json`），在 `SubtitleEditorPanel` 的建议区域顶部显示紧凑提示条（`data-testid="host-suggestions-banner"`），标注待审条目数与「未确认前不会修改正式字幕、EDL 或导出」。
   - 提供 **载入审阅**（`data-testid="host-suggestions-load"`）与 **忽略**（`data-testid="host-suggestions-dismiss"`）：载入时将批次送入 `historyStore.proposeSuggestions`，沿用既有 `PendingSuggestionsList` 进行勾选、剪前/剪后试听与确认；若视频自建议生成后已被编辑（`baseRevision !== current.videoRevision`），给出过期提示；在应用并持久化成功后自动调用 `projects.suggestions.dismiss` 清理 Host 待审记录。

端到端测试 `tests/e2e/features/F-0052.spec.ts` 覆盖中英文（`zh` / `en`）与明暗主题（`light` / `dark`）下的：MCP 来源确认请求实时出现、批准/拒绝、出错重试与空态、编辑器顶栏确认入口，以及 Host 待审建议在编辑器的载入审阅（未确认前不改 EDL）与忽略状态。

## 技术方案

### 涉及的子系统

- `docs/subsystems/cordis-host.md`、`docs/architecture-current.md`：Host RPC 契约（`shared/protocol.ts`）、`project-ops` 与 `confirmations` 应用服务、Gateway 鉴权与错误信封。
- `docs/subsystems/providers.md`：ASR / VAD `ModelRef` 能力校验与模型状态检查。
- `docs/subsystems/frontend.md`：`ClientConfirmations`、`WorkstationHeader`、`SubtitleEditorPanel`、`LocaleProvider`（中英文）、明暗主题与 Playwright 证据规则。
- `docs/decisions.md` 与 `docs/20-architecture/adr/0012-cli-host-confirmations.md`：复用 Host 应用服务与客户端确认边界；不新增独立业务或前端 Hook 服务；API Key 与 Token 不进入工具输出或日志。

### 方案

1. **零新增依赖的 MCP stdio 传输层（`mcp/protocol.ts`）**：
   - 基于标准 stdio 换行分隔 JSON-RPC 2.0 实现 MCP Server，支持协议版本 `2024-11-05`、`2025-03-26`、`2025-06-18`、`2025-11-25` 协商。
   - `stdout` 仅输出合法 JSON-RPC 2.0 帧；所有调试与进度日志严格写 `stderr`，并经过 `redactSecrets` 脱敏。
   - 支持 `initialize`、`notifications/initialized`、`ping`、`tools/list`、`tools/call`、`resources/list`、`resources/read`，以及客户端发送的 `notifications/cancelled`（中止对应请求本地等待）和服务端 `notifications/progress` 进度推送。
   - `initialize`、`tools/list`、`resources/list` 不强依赖 Host 已启动，保证真实 MCP 客户端在 Host 尚未运行时也能完成工具与说明发现（AC-5）；`resources/read` 提供 `flycut://docs/setup` 与 `flycut://host/status`。
2. **复用 CLI 应用服务的 MCP 工具集（`mcp/tools.ts`、`mcp/server.ts`）**：
   - 直接复用 `cli/client.ts` 的 `discoverHostConnection`、`HostCliClient`（`/rpc`、`/uploads` 分片上传、`/assets` 流式上传/下载、WS `/events` 监听与脱敏）与 `CliHostError`，不另起平行 HTTP 客户端或业务层。
   - 所有工具参数均以 `zod` `z.strictObject` 定义，通过 `zod.toJSONSchema(schema, { target: 'draft-7' })` 生成 MCP `inputSchema`，并在调用时做严格校验，拒绝未知字段（如注入的 `yes`、`approve`、`actor` 等）。
   - 工具清单（全部工具描述与错误输出均不含 Token、密钥或其他项目无关数据）：
     - 连接与模型发现：`flycut_host_status`、`flycut_list_providers`、`flycut_list_models`、`flycut_prepare_model`、`flycut_list_ai_configs`。
     - 项目与媒体：`flycut_list_projects`（空时返回 `{ projects: [], count: 0 }`）、`flycut_get_project`、`flycut_create_project`、`flycut_add_video`。
     - 转写、待审建议与导出：`flycut_transcribe`、`flycut_suggest_edits`（返回 `suggestionId` 与客户端入口 `#/projects/<pid>/videos/<vid>`）、`flycut_list_suggestions`（空时返回 `{ suggestions: [], count: 0 }`）、`flycut_dismiss_suggestion`、`flycut_export`、`flycut_save_export`。
     - 任务与客户端确认查询：`flycut_list_jobs`、`flycut_get_job`、`flycut_cancel_job`、`flycut_list_confirmations`、`flycut_get_confirmation`。
     - 破坏性操作申请（仅创建 `pending` 请求）：`flycut_request_delete_project`、`flycut_request_remove_video`。
3. **长任务、断线与取消语义（AC-6、AC-7）**：
   - `flycut_transcribe`、`flycut_suggest_edits`、`flycut_export`、`flycut_prepare_model` 支持 `wait?: boolean`（默认 `false`）与 `timeoutMs?: number`。
   - `wait: false` 时向 Host 提交任务后立即返回 `{ completed: false, submitted: true, jobId, hostStatus, projectId, videoId, pollTool: 'flycut_get_job', cancelTool: 'flycut_cancel_job' }`，明确标注媒体处理尚未完成（AC-7）。
   - `wait: true` 时通过 WS `/events` 与轮询等待，持续发送 `notifications/progress`；只有 Host 返回 `status: 'complete'` 并核验产物后才返回 `completed: true`。若等待超时或收到 `notifications/cancelled`，立即停止本地等待并查询一次 Host `jobs.get`，明确返回 `{ stoppedWaiting: true, hostTaskCancelled: false, hostStillRunning, jobId }`（不误报取消 Host 任务）。
   - 取消 Host 任务必须显式调用 `flycut_cancel_job`，返回 Host 实际返回的 `status` 与 `hostTaskCancelled: job.status === 'cancelled'`。
   - MCP 客户端断开（stdin EOF）后 Host 任务与持久化状态不受影响，重连后可通过 `flycut_get_job` / `flycut_get_confirmation` / `flycut_get_project` 恢复查看。
4. **确认门禁、幂等与覆写消费（AC-3、AC-8）**：
   - MCP 工具表**不提供**任何 `confirmations.decide` 批准工具，从协议暴露面根除工具调用或提示注入自行批准的可能。
   - `flycut_request_delete_project`、`flycut_request_remove_video`、`flycut_export`（目标路径已存在或 `overwrite: true` 且未带 `confirmationId`）向 Host `confirmations.create` 传 `source: 'mcp'` 与 `operationId`（未传入时自动生成并随结果回传）；使用同一 `operationId` 重试时，Host 幂等返回原 `ConfirmationRequest`（`confirmationId` 与状态一致）。
   - `flycut_export` / `flycut_save_export` 携带 `confirmationId` 时，先核验 `confirmations.get` 为 `approved`（若已拒绝/过期/未批准则分别返回 `CONFIRMATION_REJECTED` / `CONFIRMATION_EXPIRED` / `CONFIRMATION_NOT_APPROVED`），在完成导出即将覆写本地文件前调用 `confirmations.consume` 一次性消费后再原子落盘。
5. **打包、安装文档与市场上架材料（AC-4）**：
   - `scripts/build-mcp.mjs` 打包单文件 `dist-mcp/flycut-mcp.mjs`（shebang + `0755`），在 `package.json` 增加 `bin.flycut-mcp`、`scripts.mcp`、`scripts.build:mcp`，`server/tsconfig.json` 纳入 `../mcp/**/*.ts`，`eslint.config.js` 与 `.gitignore` 忽略 `dist-mcp`。
   - 交付 `docs/mcp-server.md`（安装配置、Codex / Claude Desktop / Cursor 示例、工具与错误码说明、安全边界）、根目录 `server.json`（MCP Registry 标准元数据）、`mcp/marketplace/README.md`（中英文市场介绍、权限与隐私声明、提审前检查表，标注对外发布需维护者授权）及 `skills/flycut-caption/SKILL.md`（Agent Skills 市场封装稿）。

### 接口与数据

- 沿用 F-0051 已确立的 `RpcMethods`（`projects.transcribe`、`projects.suggestEdits`、`projects.suggestions.*`、`projects.export`、`confirmations.*`）与 `RemoteEvents`（`confirmation/updated`、`project/suggestions-updated`），不修改项目存储格式（保持版本 4）。
- `shared/editing/suggestions.ts` 中的 `SuggestionBatch` 可携带可选字段 `hostSuggestionId?: string`（仅在前端载入 Host 待审批次时用于应用后自动调用 `projects.suggestions.dismiss`，不持久化到 `edits.json`）。
- 若未发现 Host 连接，MCP 工具统一返回结构化错误 `{ ok: false, error: { code: 'NO_HOST_CONNECTION', message, setup, next } }`（`isError: true`）。

### 备选方案与取舍

| 方案 | 优点 | 缺点 | 取舍 |
|---|---|---|---|
| 基于已有 `zod` v4 + `cli/client.ts` 实现轻量 MCP stdio JSON-RPC 2.0 Server | 零新增第三方依赖（离线 CI/沙盒可直接构建）、与 CLI 共用 `HostCliClient` 与 `redactSecrets`、`zod.toJSONSchema` 保证校验与 schema 单一来源 | 需自维护 stdio JSON-RPC 帧解析 | **采用**：用真实协议子进程与 `codex mcp` 集成测试覆盖兼容性 |
| 引入 `@modelcontextprotocol/sdk` | 官方 SDK 封装生命周期 | 需联网新增包并改动锁文件，且仍需自写 Host 连接、脱敏、确认门禁与提交/等待分离语义 | 不采用；后续若需 HTTP/SSE 传输再平滑接入 |
| 长任务工具默认同步阻塞至完成 | 调用方一次等待完成 | 容易触及 MCP 客户端工具超时（常为 60s），且混淆「提交成功」与「处理完成」 | **不采用**：默认 `wait: false` 返回 `jobId`，可选 `wait: true` + `timeoutMs` + 进度通知 |

## 架构决策

沿用已批准的 [ADR-0012：Host CLI 应用服务与客户端确认边界](../../20-architecture/adr/0012-cli-host-confirmations.md)，本需求不推翻或新增存储格式，无需新建 ADR。

## 自行决定的事项

- **长任务默认提交策略**：`flycut_transcribe`、`flycut_suggest_edits`、`flycut_export`、`flycut_prepare_model` 默认 `wait: false` 返回 `jobId` 与查询方式，传 `wait: true` 可等待完成并推送 `notifications/progress`；避免客户端工具超时并满足 AC-7「提交成功不等于完成」。
- **破坏性操作仅暴露申请工具**：MCP 工具集不提供任何 `confirmations.decide` 工具，仅提供 `flycut_request_delete_project` / `flycut_request_remove_video` / `flycut_export` 申请与 `flycut_get_confirmation` 查询（AC-3、AC-8）。
- **无 Host 时允许协议发现**：`initialize` 与 `tools/list` 在无运行 Host 时正常响应；真正需要 Host 的工具调用返回带配置说明的 `NO_HOST_CONNECTION`（AC-5）。
- **覆盖导出先核验后消费**：携带 `confirmationId` 时先核验 `approved` 状态，待 `projects.export` 成功产出资产准备写盘前再 `confirmations.consume`，防止导出中途失败浪费用户批准（AC-3、AC-8）。
- **UI 确认入口同步挂载至编辑器顶栏 + 待审建议横幅**：在 `WorkstationHeader` 挂接紧凑 `ClientConfirmations`，并在 `SubtitleEditorPanel` 增加 `HostSuggestionsBanner` 消费 F-0051 已预留的 `projects.suggestions.list`，补齐「在任何界面都能确认」与「建议提供客户端入口」（AC-3、AC-4、AC-9）。

## 风险与回退

- 风险：MCP 客户端对 JSON Schema 方言敏感（部分客户端不支持某些 draft-2020-12 关键词）。缓解：使用 `zod.toJSONSchema(schema, { target: 'draft-7' })` 生成通用 JSON Schema，并在集成测试用真实客户端验证。
- 风险：覆盖导出在 `confirmations.consume` 与文件写入之间发生 I/O 错误。缓解：先下载到临时 `.part` 文件，确认写完并检查目标存在性后原子 `rename`。
- 回退：`mcp/` 与 `scripts/build-mcp.mjs` 完全独立增量；前端 `HostSuggestionsBanner` 仅在 Host 存在 `pending-suggestions.json` 时渲染，不影响既有编辑与导出路径。

## 实现清单

- [x] 1. 实现零依赖 MCP stdio JSON-RPC 2.0 传输与生命周期层（`mcp/protocol.ts`），支持协议版本协商、`tools/list`、`tools/call`、`resources/list|read`、`notifications/cancelled`、`notifications/progress` 与秘钥脱敏日志。
- [ ] 2. 实现复用 `cli/client.ts` 的 MCP 工具注册与业务逻辑（`mcp/tools.ts`、`mcp/server.ts`），覆盖项目/媒体/转写/建议/新文件导出/任务状态/确认申请工具及严格 `z.strictObject` schema，配置 `scripts/build-mcp.mjs` 与 `package.json` `bin`/构建脚本。
- [ ] 3. 强化前端客户端确认中心与 Host 待审建议入口（`ClientConfirmations.tsx` 实时订阅与刷新、`WorkstationHeader.tsx` 确认入口、`HostSuggestionsBanner.tsx`、`cutPersistence.ts`、中英文国际化文案）。
- [ ] 4. 编写安装配置说明与市场上架准备材料（`docs/mcp-server.md`、`server.json`、`mcp/marketplace/README.md`、`skills/flycut-caption/SKILL.md`），明确对外发布需维护者授权。
- [ ] 5. 编写并跑通 MCP 架构与真实协议子进程集成测试（`tests/architecture/mcp-f0052.test.ts`），覆盖真实 stdio MCP 客户端与隔离 Host 端到端闭环（含真实媒体转写/导出、空集合、断连、取消、确认门禁与去重、schema 校验）及 `codex mcp` 注册验证。
- [ ] 6. 编写并跑通前端 E2E 测试与证据收集（`tests/e2e/features/F-0052.spec.ts`，`PW_PORT=5306 pnpm e2e:evidence F-0052`），覆盖中英文与明暗主题下的确认中心、编辑器顶栏入口与待审建议载入审阅。

## 验证计划

- 静态检查（每项后）：`pnpm lint`、`pnpm tsc-b --noEmit`、`pnpm check:host`、`cargo check --manifest-path src-tauri/Cargo.toml`。
- 架构与真实 MCP 协议子进程测试（项 1–2、5）：`tests/architecture/mcp-f0052.test.ts`（`pnpm test:architecture`），启动构建产物 `dist-mcp/flycut-mcp.mjs` 子进程走真实 stdio JSON-RPC 2.0 协议：
  - AC-1/AC-5：无 Host 启动时 `initialize` 与 `tools/list` 正常发现全部工具与 draft-7 JSON Schema；`flycut_list_projects` 与 `flycut_list_suggestions` 空时返回结构化空集合；无 Host 调用工具返回 `NO_HOST_CONNECTION` 与配置引导。
  - AC-2：错误 token 返回 `AUTH_FAILED`；工具描述/stdout/stderr 均无 token 与 API Key；非法 UUID、未知参数、不存在目标返回明确结构化错误（`isError: true`）。
  - AC-3/AC-8：`flycut_suggest_edits` 只生成待审记录不改正式 EDL；`flycut_request_delete_project` / `flycut_request_remove_video` / 覆盖 `flycut_export` 只返回 `pending_confirmation`，注入 `yes`/`approve`/`actor` 被 schema 拒绝；同一 `operationId` 重试复用原 `confirmationId`；UI 批准后才可消费一次并重放拒绝。
  - AC-4/AC-6/AC-7：从真实媒体上传创建项目 → 提交转写（验证提交态 `completed: false`）→ 等待完成后 `flycut_get_job` 核对 `completed: true` 与 UI 读取一致；测试 `notifications/cancelled` 停止等待而不误报取消 Host 任务，以及 `flycut_cancel_job` 真实取消；断连重启 MCP 后 `flycut_get_job` 仍可查询；导出新文件校验字节大小与格式；使用本地 `codex mcp add/get/list` 在隔离 `CODEX_HOME` 验证真实 MCP 客户端配置与发现。
- 真实 ASR 模型端到端验证（项 5）：使用 `tests/media` 真实素材、本机 `sensevoice-small` 模型与 `ffmpeg` 启动隔离 Host，通过真实 MCP stdio 子进程走通创建项目 → 真实转写 → 待审建议 → 新文件导出（`ffprobe` 验证流）并检查持久化项目状态。
- UI 端到端与视觉证据（项 3、6）：`tests/e2e/features/F-0052.spec.ts`，运行 `PW_PORT=5306 pnpm e2e:evidence F-0052`，覆盖 `light/dark × zh/en` 下 MCP 待确认请求展示、出错重试、批准/拒绝、编辑器顶栏确认入口、待审建议横幅载入与忽略。

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | `mcp/tools.ts` 复用 `cli/client.ts` 与 Host `project-ops`/`confirmations`/`jobs`，公开完整工具与 `z.strictObject` JSON Schema，无独立业务或 Hook 服务 |
| AC-2 | Host Bearer 鉴权 + `redactSecrets` 脱敏（工具描述/stdout/stderr 无凭据与其他项目数据）+ 结构化错误返回 |
| AC-3 | `flycut_suggest_edits` 返回 `suggestionId` 与客户端入口 + `HostSuggestionsBanner`；破坏性工具仅创建确认请求，严格 schema 拒绝注入审批，`operationId` 幂等 |
| AC-4 | 真实 stdio MCP 客户端与隔离 Host 完成创建 → 转写 → 新文件导出闭环并核对 UI；交付 `docs/mcp-server.md`、`server.json`、`mcp/marketplace/README.md`、`skills/flycut-caption/SKILL.md` |
| AC-5 | 无 Host 时 `initialize`/`tools/list` 正常发现且调用返回配置说明；空项目/建议返回结构化空集合；无 MCP 专属页面 |
| AC-6 | 长任务返回 `jobId` 与 `flycut_get_job` 查询方式；客户端断开不丢 Host 状态；`notifications/cancelled` 与 `flycut_cancel_job` 语义清晰不误报 |
| AC-7 | 结果含 `projectId`/`videoId`/`assetId`/`outPath` 并可在 UI 查看；提交成功返回 `completed: false`，仅 Host 核验完成后返回 `completed: true` |
| AC-8 | 区分 `INVALID_ARGUMENT`/`INVALID_ID`/`AUTH_FAILED`/`NOT_FOUND`/`VERSION_CONFLICT`/`CONFIRMATION_*`；删除/覆盖返回待确认请求，禁止自批，重试复用 `operationId` |
| AC-9 | `mcp-f0052.test.ts` 真实 stdio 协议 + schema 校验 + 真实媒体端到端；`F-0052.spec.ts` 覆盖中英文与明暗主题截图及录屏 |


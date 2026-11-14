# FlyCut Caption MCP Server

FlyCut Caption MCP Server 通过标准 stdio JSON-RPC 2.0 协议把本机（或受控内网）运行中的 FlyCut Host 能力暴露给外部 Agent 与 MCP 客户端（如 Codex、Claude Desktop、Cursor）。

MCP Server 直接复用 CLI 的 `HostCliClient` 与 Host 应用服务，不另起独立业务后端或前端 Hook 服务。

## 前置条件与连接方式

1. **启动 FlyCut Host**（二选一）：
   - 启动 FlyCut Caption 桌面端；或
   - 在仓库根目录运行 `pnpm host:dev`（开发模式）或 `pnpm host:start`（打包后 Host）。
2. **构建 MCP Server**：
   ```bash
   pnpm build:mcp
   ```
   构建产物位于 `dist-mcp/flycut-mcp.mjs`（同时对应 `package.json` 的 `bin["flycut-mcp"]`）。开发调试也可以直接通过 `pnpm mcp` 运行源码。
3. **Host 发现与鉴权优先级**：
   - 显式参数：`--host <url>` 与 `--token <token>`（或 `--token-file <path>`）
   - 环境变量：`FLYCUT_HOST_URL`、`FLYCUT_HOST_TOKEN`
   - 自动发现：读取 `--home <dir>` / `FLYCUT_HOST_HOME` / `~/.flycut-caption/host/connection.json`

> 在 Host 尚未启动时，MCP 客户端仍可完成 `initialize`、`tools/list`、`resources/list` 与 `resources/read`（`flycut://docs/setup`）发现；调用需要 Host 的工具时会返回结构化错误 `NO_HOST_CONNECTION` 与配置指引。

## 客户端接入示例

### Codex CLI

在仓库中构建 `dist-mcp/flycut-mcp.mjs` 后，注册本机 MCP Server：

```bash
codex mcp add flycut-caption -- node /ABS/PATH/TO/flycut-caption/dist-mcp/flycut-mcp.mjs
codex mcp get flycut-caption
```

或在 `~/.codex/config.toml` 中配置（若 Host 使用非默认 home 或显式地址，可追加环境变量）：

```toml
[mcp_servers.flycut-caption]
command = "node"
args = ["/ABS/PATH/TO/flycut-caption/dist-mcp/flycut-mcp.mjs"]

[mcp_servers.flycut-caption.env]
# 可选：覆盖默认 ~/.flycut-caption/host
# FLYCUT_HOST_HOME = "/path/to/host-home"
```

### Claude Desktop

在 `claude_desktop_config.json` 中加入：

```json
{
  "mcpServers": {
    "flycut-caption": {
      "command": "node",
      "args": ["/ABS/PATH/TO/flycut-caption/dist-mcp/flycut-mcp.mjs"]
    }
  }
}
```

### Cursor

在工作区 `.cursor/mcp.json` 中加入：

```json
{
  "mcpServers": {
    "flycut-caption": {
      "command": "node",
      "args": ["/ABS/PATH/TO/flycut-caption/dist-mcp/flycut-mcp.mjs"]
    }
  }
}
```

## 可用工具清单

所有工具均采用 `zod` `z.strictObject`（draft-7 JSON Schema）校验，拒绝任何未声明的额外字段。

### 连接、Provider 与 AI 配置

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `flycut_host_status` | 检查 Host 连接、`hostId`、协议版本与能力 | — |
| `flycut_list_providers` | 列出 Host 已注册的 ASR / TTS / VAD Provider | — |
| `flycut_list_models` | 列出可用模型与就绪状态（`ready` / `download` / `unavailable`） | `role?`, `providerId?` |
| `flycut_prepare_model` | 下载或准备模型（支持 `wait` 与进度通知） | `providerId`, `modelId`, `wait?`, `timeoutMs?` |
| `flycut_list_ai_configs` | 列出 Host 脱敏 AI 配置（仅含 `hasApiKey` 布尔值，不含密钥） | — |

### 项目与媒体

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `flycut_list_projects` | 列出活动项目（空时返回 `{ projects: [], count: 0 }`） | — |
| `flycut_get_project` | 查看项目、视频、转写、正式编辑摘要与待审建议，返回 `clientEntry` | `projectId`, `videoId?` |
| `flycut_create_project` | 从本地 `filePath`（分片/流式上传）、`assetId` 或空项目创建 | `name`, `filePath?`, `assetId?`, `empty?`, `operationId?` |
| `flycut_add_video` | 向已有项目添加视频 | `projectId`, `filePath?`, `assetId?`, `videoName?`, `operationId?` |

### 转写、待审建议与导出

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `flycut_transcribe` | 在 Host 上执行转写并保存；默认 `wait=false` 返回 `jobId` | `projectId`, `modelId`, `providerId?`, `language?`, `wait?`, `operationId?` |
| `flycut_suggest_edits` | 生成仅待审的口癖/静音/语义剪辑建议，**不改动**正式字幕与 EDL | `projectId`, `kind?`, `silenceMethod?`, `configId?`, `wait?`, `operationId?` |
| `flycut_list_suggestions` | 列出待审剪辑建议（空时返回 `{ suggestions: [], count: 0 }`） | `projectId`, `videoId?` |
| `flycut_dismiss_suggestion` | 忽略指定待审建议批次 | `projectId`, `videoId`, `suggestionId` |
| `flycut_export` | 从正式状态导出视频或字幕；写新文件直接放行，覆盖已存在文件需客户端确认 | `projectId`, `format?`, `quality?`, `subtitleProcessing?`, `outPath?`, `overwrite?`, `confirmationId?`, `wait?`, `operationId?` |
| `flycut_save_export` | 将已完成导出任务的 `assetId` 下载到本地路径（覆盖需 `confirmationId`） | `assetId`, `outPath`, `projectId?`, `overwrite?`, `confirmationId?`, `operationId?` |

### 任务与客户端确认查询

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `flycut_list_jobs` | 列出 Host 后台任务 | — |
| `flycut_get_job` | 查询任务当前状态、进度、结果或错误 | `jobId` |
| `flycut_cancel_job` | 向 Host 请求取消指定任务，返回 Host 实际状态 | `jobId` |
| `flycut_list_confirmations` | 列出客户端待确认/历史破坏性操作请求 | `status?` (`pending` \| `all`) |
| `flycut_get_confirmation` | 查询单个确认请求当前状态 | `confirmationId` |

### 破坏性操作申请（仅创建待确认请求）

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `flycut_request_delete_project` | 创建移入回收站或彻底删除项目的待确认请求，不可自行批准 | `projectId`, `purge?`, `operationId?` |
| `flycut_request_remove_video` | 创建从项目移除视频的待确认请求，不可自行批准 | `projectId`, `videoId`, `operationId?` |

## MCP Resources

- `flycut://docs/setup`：Markdown 安装配置与确认边界说明。
- `flycut://host/status`：当前 Host 连接状态 JSON（不含 Token 与 API Key；未连接时返回结构化连接引导）。

## 长任务、断连与取消语义

- `flycut_transcribe`、`flycut_suggest_edits`、`flycut_export`、`flycut_prepare_model` 默认 `wait=false`：提交任务后立即返回 `{ completed: false, submitted: true, jobId, hostStatus, pollTool: "flycut_get_job", cancelTool: "flycut_cancel_job" }`，绝不把“提交成功”当作“媒体处理已完成”。
- 传 `wait=true` 时通过 Host WebSocket `/events` 与轮询等待，并在客户端提供 `_meta.progressToken` 时持续推送 `notifications/progress`；只有 Host 返回 `complete` 且经核验后才返回 `completed: true`。
- 若客户端发送 `notifications/cancelled`、断开 stdio 或 `timeoutMs` 到期：MCP Server 仅停止本地等待并立即向 Host 查询一次任务现状，返回 `{ stoppedWaiting: true, hostTaskCancelled: false, hostStillRunning, jobId }`，不会误报 Host 任务已取消；MCP 断开后重连仍可通过 `flycut_get_job` 查看或用 `flycut_cancel_job` 取消。

## 安全与确认门禁

1. **不可绕过的客户端确认**：MCP 工具表**不提供**任何审批工具（无 `confirmations.decide`）。删除项目、移除视频、覆盖本地已有文件只能生成 `pending` 确认请求，由用户在 FlyCut UI 客户端确认中心（项目侧栏或编辑器顶栏）亲自批准后执行；覆盖导出采用 `approved -> consumed` 一次性消费。
2. **严格 Schema 与去重**：所有参数拒绝未声明字段（例如尝试注入 `yes`、`approve`、`actor`）；支持 `operationId`（UUID）对创建项目、转写、建议、导出与确认申请进行幂等去重。
3. **凭据与数据隔离**：`stdout`、`stderr`、工具描述与结构化错误均经 `redactSecrets` 脱敏，不输出 Bearer Token、`sk-*` API Key 或其他项目无关数据。
4. **未确认建议隔离**：`flycut_suggest_edits` 仅写入 Host `pending-suggestions.json`，不修改正式字幕、EDL 或普通导出，需用户在编辑器顶部提示条载入审阅并确认。

## 常见错误码

| 错误码 | 含义 | 处理建议 |
|---|---|---|
| `NO_HOST_CONNECTION` | 未发现或无法连接 Host | 启动 FlyCut 桌面端或 `pnpm host:dev`，核对 `--host` / `--home` |
| `AUTH_FAILED` | Bearer Token 无效或缺失 | 检查 `--token` / `FLYCUT_HOST_TOKEN` / `connection.json` |
| `INVALID_ARGUMENT` / `INVALID_ID` | 参数不符合 strict schema 或 UUID 格式错误 | 按工具 `inputSchema` 修正参数 |
| `NOT_FOUND` / `PROJECT_TRASHED` / `MEDIA_MISSING` | 目标项目/视频/任务/文件不存在或在回收站 | 运行 `flycut_list_projects` 或重新上传媒体 |
| `MODEL_REQUIRED` / `MODEL_NOT_READY` / `AI_CONFIG_NOT_READY` | 模型未就绪或 Host 未配置 AI 模型 | 用 `flycut_list_models` / `flycut_prepare_model` 准备模型或在 UI 配置 AI |
| `VERSION_CONFLICT` | 项目版本或确认状态冲突 | 用 `flycut_get_project` / `flycut_get_confirmation` 重新读取最新状态 |
| `CONFIRMATION_REQUIRED` | 目标文件已存在或需要客户端确认 | 在 FlyCut UI 批准 `confirmationId` 后再传入重试 |
| `CONFIRMATION_REJECTED` / `CONFIRMATION_NOT_APPROVED` / `CONFIRMATION_ALREADY_CONSUMED` / `CONFIRMATION_EXPIRED` | 确认被拒绝、未批准、已消费或已过期 | 根据需要重新发起确认请求 |

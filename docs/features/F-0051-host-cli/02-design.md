---
id: F-0051
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-13
---

# F-0051 Host项目操作CLI：设计

## UI / UX

CLI 本身运行于终端，不新增专门的 CLI 设置页面（符合 AC-5）。界面改动聚焦在以下两处既有入口，全部接真实 Host RPC 与 WebSocket 事件：

1. **客户端确认中心（`src/components/Project/ClientConfirmations.tsx`）**：
   - 挂载在 `ProjectsRoot`（覆盖首页、项目详情、回收站、编辑器四个路由）并在 `ProjectsShell` 底部状态区与 `WorkstationHeader` 右侧工具栏提供可点击的待确认徽标（仅当存在待确认请求时高亮显示数量，`data-testid="confirmations-trigger"`）。
   - 连接 Host 后加载 `confirmations.list`，并订阅 WebSocket `confirmation/updated` 事件；有新的 `pending` 请求时自动弹出确认对话框（`data-testid="client-confirmation-dialog"`），展示来源标签（CLI / Agent）、操作类型（移入回收站 / 彻底删除项目 / 移除视频 / 覆盖导出文件）、目标名称、ID 与「命令行 `--yes` 不能跳过确认」提示。
   - 提供 **确认执行**（`data-testid="confirmation-approve"`）与 **拒绝**（`data-testid="confirmation-reject"`）按钮；提交中禁用按钮并显示加载态；Host 返回失败时保留对话框并显示错误提示与重试能力；确认删除/移除视频成功后刷新当前项目列表/详情，避免界面残留已删除项目。
2. **编辑器待审建议入口（`src/components/SubtitleEditor/EditingSuggestionsPanel.tsx`）**：
   - 打开视频时检查 `projects.suggestions.list` 是否存在由 CLI/Host 生成的待审建议（`pending-suggestions.json`）；若有，仅在建议面板顶部显示「发现来自 CLI/Host 的待审建议（N 条）」提示条，提供「载入审阅」与「忽略」按钮，绝不自动写入正式 EDL 或 `edits.json`。
   - 点击「载入审阅」将建议载入 `historyStore.pendingSuggestions`，沿用现有 `PendingSuggestionsList` 勾选/试听/预览/确认或取消；确认应用或忽略时调用 `projects.suggestions.dismiss` 清理该待审记录。

E2E 测试 `tests/e2e/features/F-0051.spec.ts` 覆盖中英文与明暗主题下的：空状态（无待确认请求）、收到待确认请求弹窗（删除项目 / 覆盖导出）、拒绝、确认执行、提交中禁用、失败保留提示与重试、以及 CLI 建议加载审阅（未确认不修改 EDL）。

## 技术方案

### 涉及的子系统

- `docs/subsystems/cordis-host.md`、`docs/architecture-current.md`：Host 插件注册（`BUILTINS`、`PROFILES`）、`shared/protocol.ts` RPC/事件声明、Gateway 错误码传递、项目存储唯一入口。
- `docs/subsystems/providers.md`、`docs/subsystems/funasr-tauri.md`：ASR/VAD `ModelRef` 与能力校验、`funasr-asr` / FFmpeg 音频提取（16 kHz mono PCM16 WAV）。
- `docs/subsystems/frontend.md`：`ProjectsRoot` / `ProjectsShell` / `WorkstationHeader`、`LocaleProvider`（中英文）、明暗主题、Playwright 证据规则。
- `docs/decisions.md`：RPC 不收本地路径（媒体走 `/uploads` / `/assets`）；AI 配置与密钥只走 Host（F-0056）；未确认建议不进入正式字幕/EDL/普通导出。

### 方案

1. **稳定错误码与契约（`shared/errors.ts`、`shared/confirmations.ts`、`shared/projectOps.ts`、`shared/protocol.ts`）**：
   - 在 `gateway.ts` 保留 `HostRpcError.code` 与安全 `details`（普通 `Error` 仍回退 `RPC_ERROR`），提供稳定机器可读错误码：`AUTH_FAILED`、`NO_HOST_CONNECTION`、`CONFIRMATION_REQUIRED`、`CONFIRMATION_REJECTED`、`CONFIRMATION_NOT_APPROVED`、`INVALID_ARGUMENT`、`INVALID_ID`、`NOT_FOUND`、`PROJECT_TRASHED`、`MEDIA_MISSING`、`MODEL_REQUIRED`、`MODEL_NOT_READY`、`AI_CONFIG_NOT_READY`、`VERSION_CONFLICT`、`JOB_FAILED`、`INTERRUPTED`。
   - 抽离纯逻辑场景/字幕构建函数到 `shared/subtitle-graphics/`（`buildExportSubtitleSceneFromProject`、`buildBurnTextSubtitleVtt`、`serializeSubtitleExport`、`effectiveSubtitleStylePair`），供前端与 Host `project-ops` 共同复用，保证 CLI 与 UI 导出结果完全一致。
2. **客户端确认插件 `server/plugins/confirmations.ts`**：
   - 持久化 `<home>/confirmations/<id>.json`（原子写 + 按 ID 串行锁 + `operationId` 幂等去重 + 过期清理），并暴露 `confirmation/updated` 远程事件。
   - `confirmations.create` 校验目标项目/视频状态后生成 `pending` 请求（支持 `trash-project`、`purge-project`、`remove-video`、`overwrite-export`）。
   - `confirmations.decide` 要求 `actor: 'ui-client'`；批准 `trash-project` / `purge-project` / `remove-video` 时直接通过 `ProjectStore` 执行对应变更并转入 `executed`；批准 `overwrite-export` 时转入 `approved`，待 CLI 通过 `confirmations.consume` 一次性消费（`approved -> consumed`）后才写入本地目标文件。
3. **Host 项目应用服务插件 `server/plugins/projectOps.ts`**：
   - `projects.transcribe`：校验项目/视频/媒体与 ASR `ModelRef` 就绪状态，创建带 `operationId` 幂等保护的 Host Job；用 Host FFmpeg 提取 16 kHz mono PCM16 WAV，调用 `ctx.providers.transcribe`，完成后原子写入 `transcript.json` 并更新 `project.json`（含读回核验），再标记 Job 完成。
   - `projects.suggestEdits`：按 `kind`（`fillers` / `silence` / `semantic` / `all`）执行规则去口癖、VAD/静音分析或基于 F-0056 `ctx.aiSettings.resolve` 的语义分析；结果只写入 `<home>/projects/<projectId>/videos/<videoId>/pending-suggestions.json`，绝不触碰 `edits.json` 或 `edl`。同时提供 `projects.suggestions.list` 与 `projects.suggestions.dismiss`。
   - `projects.export`：基于项目正式 `transcript`、`edits`、`edl` 与 `projectStyle`（严格忽略 `pending-suggestions.json`），支持 `mp4` / `webm`（走 Host `export` / FFmpeg + Skia 字幕条带）及 `srt` / `vtt` / `json` / `ass` 导出，产物写入 `ctx.assets` 并返回 `{ assetId, filename, mimeType, format, durationSeconds }`。
4. **Host CLI（`cli/flycut.ts` + `cli/` 模块 + `scripts/build-cli.mjs` + `package.json` `bin`）**：
   - 发现已运行 Host：优先 `--host` / `FLYCUT_HOST_URL` + `--token` / `--token-file` / `FLYCUT_HOST_TOKEN`，否则读取 `--home`（默认 `~/.flycut-caption/host`）下的 `connection.json`；绝不读取浏览器 `localStorage`，所有输出与错误经过秘钥脱敏（`redactSecrets`）。
   - 严格区分通道：人类进度/连接提示写 `stderr`，命令结果写 `stdout`；`--json` 模式保证 `stdout` 仅输出合法单条 JSON（空列表输出 `[]` 包装或结构化响应）。
   - 全部 ID 参数（`projectId`、`videoId`、`assetId`、`jobId`、`configId`、`confirmationId`、`operationId`）执行严格 UUID 校验；媒体上传优先走 `/uploads` 分片断点协议（回退 `/assets`），再调用 `projects.create` / `projects.addVideo`。
   - 子命令：`status`、`providers list/models/prepare`、`ai list`、`media upload`、`projects list/create/get/add-video/delete/remove-video`、`transcribe`、`suggest`、`suggestions list/dismiss`、`export`、`jobs list/get/cancel`、`confirmations list/get`。
   - 破坏性控制：CLI 不存在批准确认命令；`projects delete` / `projects remove-video` / `export` 到已存在文件（或 `--overwrite`）时即使传 `--yes` / `-y` / `--force` 也拒绝直接执行，只创建或查询 `pending_confirmation` 请求并返回退出码 `4`。
   - 长任务与中断：默认通过 WS `/events` + `jobs.get` 等待结果，支持 `--no-wait` 仅提交；收到 `SIGINT`（Ctrl+C）立即停止等待并查询一次当前任务状态，输出 Host 任务是否仍在运行及 `flycut jobs get <jobId>` 后续命令后以 `130` 退出。

### 接口与数据

- 新增 `RpcMethods`：
  - `projects.transcribe`、`projects.suggestEdits`、`projects.suggestions.list`、`projects.suggestions.dismiss`、`projects.export`
  - `confirmations.create`、`confirmations.list`、`confirmations.get`、`confirmations.decide`、`confirmations.consume`
- 新增 `RemoteEvents`：`confirmation/updated`、`project/suggestions-updated`。
- Host home 新增状态文件：`<home>/confirmations/<id>.json`、`videos/<videoId>/pending-suggestions.json`；`project.json` 格式版本保持 `4`，`edits.json` 格式不变。
- CLI 退出码约定：`0` 成功；`1` 未知错误；`2` 鉴权失败；`3` 无 Host 连接/超时；`4` 需客户端确认或已被拒绝；`5` 参数/ID 错误；`6` 目标不存在/已删除/媒体缺失；`7` 模型或 AI 配置未就绪；`8` 版本冲突；`9` 任务执行失败/已取消；`130` Ctrl+C 停止等待。

### 备选方案与取舍

- 见 [ADR-0012](../../20-architecture/adr/0012-cli-host-confirmations.md)：不在 CLI 端拼接音频/字幕场景或允许 `--yes` 绕过破坏性操作，把业务编排与待确认门禁收拢在 Host 插件中，供 CLI 与后续 F-0052 MCP 直接复用。
- CLI 上传默认优先走 `/uploads` 分片校验接口（兼容小文件与大文件 SHA-256 校验），而不是只走 `/assets` 整包 POST，确保与 F-0015 一致并支持幂等 `operationId`。

## 架构决策

- [ADR-0012：Host CLI 应用服务与客户端确认边界](../../20-architecture/adr/0012-cli-host-confirmations.md)（`proposed`，待维护者验收确认）。

## 自行决定的事项

- CLI 输出约定：`--json` 返回统一包络 `{ ok: true, data }` / `{ ok: false, error: { code, message, next, details } }`，其中 `projects list` 空列表时 `data` 为 `[]`，`stdout` 保持纯净 JSON（AC-1、AC-5、AC-8）。
- Ctrl+C 默认行为：按下 Ctrl+C 默认**停止本地等待**而非自动取消 Host 后台任务，查一次 Host 任务状态后报告任务是否仍在运行（AC-4、AC-6）；需要取消后台任务时显式执行 `flycut jobs cancel <jobId>`。
- 退出码分级：用独立退出码区分鉴权（2）、断连（3）、待确认/拒绝（4）、参数错误（5）、不存在（6）、模型/AI未就绪（7）、版本冲突（8）、任务失败（9）、Ctrl+C（130）（AC-1、AC-8）。
- 客户端确认的 `overwrite-export` 流程：Host 保存 `approved` 状态，CLI 凭 `--confirmation-id` 一次性消费（`approved -> consumed`）后覆盖本地目标文件（AC-3、AC-8）。
- CLI 构建产物：除 `pnpm cli`（`tsx`）外增加 `pnpm build:cli` 输出带 shebang 的 `dist-cli/flycut.mjs` 并配置 `package.json` `bin.flycut`，便于真实终端直接运行且无 `tsx` IPC 限制（AC-9）。

## 风险与回退

- 风险：Host 进程内的 Skia 字幕条带渲染依赖 `@napi-rs/canvas` 与 `shared_assets/subtitle-fonts`；若缺字体或原生模块，硬字幕导出将明确失败（已由 `server/subtitle-render.ts` 显式报错保护）。
- 风险：浏览器端与 Host 共用 `subtitlePresets` / `exportFormats` 时需避免把浏览器 DOM API 引入 `shared/`；迁移时只抽取纯计算/纯类型部分并在 `pnpm check:host` 与 `pnpm tsc-b --noEmit` 验证。
- 回退：新 RPC 与确认中心完全增量挂接，停用 `confirmations` / `project-ops` 插件或移除 `cli/` 不影响现有桌面与 Web 项目读写格式。

## 实现清单

<!--
开发阶段按这份清单推进，不再拆任务。每一项是一段能单独验证的功能（从存储到界面打通），做完提交一次并勾选。
项数不限，一般 3–8 项；按依赖顺序排列。进入「测试与验收」前必须全部勾选（脚本检查）。
一个需求做不完、需要拆成几个 PR 分别发布时，说明需求太大，回到 Epic 拆成多个需求。
-->
- [x] 1. 抽取纯共享字幕/导出辅助与稳定错误码契约（`shared/errors.ts`、`shared/confirmations.ts`、`shared/projectOps.ts`、`shared/protocol.ts`、`gateway.ts`）。
- [ ] 2. 实现 Host 客户端确认插件 `server/plugins/confirmations.ts`（持久化、幂等去重、审批执行与一次性消费、`confirmation/updated` 推送）及架构测试。
- [ ] 3. 实现 Host 项目应用服务插件 `server/plugins/projectOps.ts`（`projects.transcribe`、`projects.suggestEdits` 仅生成待审、`projects.export` 与 UI 一致）及架构测试。
- [ ] 4. 实现 CLI 客户端与命令集（`cli/` + `scripts/build-cli.mjs` + `package.json` `bin`），覆盖发现/鉴权脱敏、`/uploads` 上传、转写、建议、新文件与覆盖确认导出、任务查询、Ctrl+C 与 `--yes` 防绕过。
- [ ] 5. 实现 UI 客户端确认中心（`ClientConfirmations` 挂接 `ProjectsApp`/`ProjectsShell`/`WorkstationHeader`）与待审建议载入入口，补齐中英文与明暗主题。
- [ ] 6. 编写并跑通 `tests/architecture/cli-f0051.test.ts`、`tests/e2e/features/F-0051.spec.ts`（含截图录屏）及隔离 Host 真实终端端到端闭环（上传真实媒体 → 转写 → 建议 → 导出新文件 → UI 重开核对 → 确认中心审阅）。

## 验证计划

- 静态检查（每项后）：`pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`、`cargo check --manifest-path src-tauri/Cargo.toml`。
- 架构与 CLI 契约测试（项 2–4、6）：`tests/architecture/cli-f0051.test.ts`（`pnpm test:architecture`），覆盖：
  - AC-1/AC-5：CLI `--help`、子命令用法、空列表 `[]` + exit 0、JSON 契约、非法 UUID 拒绝、缺失模型/目标可操作错误。
  - AC-2：F-0056 Host AI 配置引用（本地 HTTP fixture）、不读浏览器存储、输出与 stderr/日志无 token/API Key 泄漏、鉴权失败与模型未就绪错误码。
  - AC-3/AC-8：待审建议不写入 `edits.json`/EDL/正式导出；`projects delete` / `remove-video` / 覆盖导出生成待确认请求且 `--yes` 不能绕过；`operationId` 去重、版本冲突、拒绝/消费流转。
  - AC-4/AC-6/AC-7：真实子进程运行 `dist-cli/flycut.mjs` 驱动隔离 Host 完成媒体上传、转写、建议、新文件导出、Ctrl+C 停止等待并查询 Host 任务状态、断线后重连查状态与重复提交幂等。
- UI 端到端测试（项 5–6）：`tests/e2e/features/F-0051.spec.ts`，使用 `PW_PORT=5193 pnpm e2e:evidence F-0051`，覆盖中英文与明暗主题下的：无待确认状态、收到删除/覆盖导出确认请求弹窗、拒绝、确认执行、失败重试、以及 CLI 建议载入审阅。
- 真实终端 + 隔离 Host 实机验证（项 6）：使用 `tests/media` 真实素材与本机已下载 `sensevoice-small` 模型 + `ffmpeg` 启动隔离 `server/main.ts`，运行真实 `node dist-cli/flycut.mjs` 终端命令走通上传 → 转写 → 建议 → 新文件导出（`ffprobe`/`ffmpeg` 验证音视频流与时长）→ 启动前端核对同一 Host 数据与 UI 确认弹窗操作；若语义 AI 建议缺少真实外部付费 API Key，则用本地 OpenAI 兼容 fixture 验证协议通路并在 04 报告如实注明外部付费 API 为 `Not run` 及原因。

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | `project-ops` 应用服务 + `cli/` 子命令（创建/读取/上传/转写/建议/导出/任务查询）、`--help`/`--json`/退出码/UUID 校验 |
| AC-2 | Host `providers` 与 F-0056 `aiSettings` 引用、CLI 秘钥脱敏与禁读浏览器存储、鉴权/未就绪/无连接稳定错误码 |
| AC-3 | `pending-suggestions.json` 待审隔离 + `confirmations` 插件 + UI 确认中心 + CLI 禁 `--yes` 绕过 |
| AC-4 | `/uploads` 真实上传 → `projects.transcribe` → `projects.suggestEdits` → `projects.export`；`operationId` 幂等与 Ctrl+C/断线查任务 |
| AC-5 | `--help` 用法与示例；空项目列表返回 `[]` + exit 0；缺目标/模型返回错误码与 `next` 提示；无独立 CLI 设置页 |
| AC-6 | 稳定 `jobId` 查询、日志隔离至 `stderr`、进度输出、`SIGINT` 停止等待并报告 Host 任务运行状态 |
| AC-7 | Host 核验落盘后标完成并返回对象 ID；UI 重开 `projects.open` 读到一致转写与导出结果；exit 0 语义准确 |
| AC-8 | `HostRpcError` 稳定错误码映射至非零退出码；破坏性操作返回 `pending_confirmation`；不确定时先查 `jobs.get`/`confirmations.get` |
| AC-9 | `cli-f0051.test.ts` + 隔离 Host 真实终端闭环 + `F-0051.spec.ts` 中英文/明暗主题截图与录屏证据 |

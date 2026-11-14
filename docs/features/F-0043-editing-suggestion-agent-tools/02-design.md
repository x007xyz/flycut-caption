---
id: F-0043
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-13
---

# F-0043 剪辑建议的Agent工具：设计

## UI / UX

### 入口与组件

1. **编辑面板内的「Agent / Host 剪辑建议」条（`src/components/SubtitleEditor/AgentSuggestionsBar.tsx`，接入 `SubtitleEditorPanel.tsx`）**：
   - 复用现有字幕编辑器面板及 `PendingSuggestionsList`（不另建独立页面）。
   - 当项目视频打开时自动或手动拉取 `projects.suggestions.list`，并订阅 Host 推送的 `'project/suggestions-updated'` 实时刷新。
   - **状态覆盖（AC-2、AC-5–AC-8）**：
     - `loading`：显示「正在加载… / Loading…」，请求序号防切换视频/项目后迟到响应串项（AC-6）。
     - `empty`：无待确认建议时展开区域显示「暂无内容 / Nothing here yet」（AC-5），既有字幕编辑与导出保持可用。
     - `ready`：列出每条待确认建议批次（类别、来源、候选数、预计剪除时长），提供「预览到时间轴 / Preview on timeline」与「忽略 / Dismiss」按钮；点击预览后将 `batch` 载入 `historyStore.pendingSuggestions` 并开启 `previewPending(true)`，在 `PendingSuggestionsList` 与时间轴高亮显示每条候选、原文、时间范围、类别与原因。
     - `applying`：点击应用时显示「正在处理… / Processing…」，禁用重复提交；若 Host `projects.saveVideoEdits` 确认写入后再调用 `projects.suggestions.dismiss` 清理该建议，成功后提示「已完成 / Completed」（AC-6、AC-7）。
     - `stale`：若当前视频 `videoRevision !== suggestion.baseRevision` 或编辑基线已变动，显示「内容已更新，请重新检查 / Content changed. Review again.」，阻止直接应用并提供重新拉取/重新分析入口（AC-3、AC-8）。
     - `error`：读取或应用失败时显示具体原因及「重试 / Retry」「返回 / Back」，回滚未确认的本地临时状态，保留已有正式字幕与 EDL（AC-8）。

### 状态与 Stores

- 复用 `historyStore.pendingSuggestions` 与 `applyPendingWithPersistence`，绝不绕过用户确认直接改写 `edl`。
- 界面状态（loading/empty/ready/stale/error/completed）在 `tests/e2e/features/F-0043.spec.ts` 通过 `mockHost` 构造；Host 工具调用到 `projects.open` / `projects.export` / EDL 隔离由 `tests/architecture/agent-tools-f0043.test.ts` 在真实隔离 Host + 真实媒体上验证。

## 技术方案

### 涉及的子系统

- [docs/subsystems/cordis-host.md](../../subsystems/cordis-host.md)：Cordis 插件服务、`ctx.agentTools.register`、`ctx.rpc.register`、`READ_ONLY_RPC_METHODS`。
- [docs/subsystems/providers.md](../../subsystems/providers.md)：VAD 模型选择与 `ctx.providers.detectVoice`。
- [docs/subsystems/frontend.md](../../subsystems/frontend.md)：`SubtitleEditorPanel`、`PendingSuggestionsList`、`historyStore`、`cutPersistence`。
- [docs/decisions.md](../../decisions.md)、[ADR-0005](../../20-architecture/adr/0005-unified-edit-decisions.md)、[ADR-0010](../../20-architecture/adr/0010-semantic-cut-word-ranges.md)。

### 方案

1. **统一建议格式与原文提取（`shared/editing/suggestions.ts`、`shared/projectOps.ts`）**：
   - 在 `CutSuggestion` 增加可选 `text?: string`（候选区间对应原文/词段拼接），新增 `populateSuggestionTexts(items, chunks, wordChunks)` 供前端面板与 Host 分析器共用，保证工具输出与界面同输入结果在建议 ID、原文、原时间范围、类别和原因上完全一致（AC-1）。
   - 在 `projectSuggestInputSchema` 保持 `z.strictObject(...)`（拒绝任何未声明字段如 `apply` / `autoApply`），并支持可选 `expectedRevision?: number` 供调用方做乐观并发检查（不匹配抛出 `CONTENT_CHANGED`）。
   - 在 `ProjectSuggestResult` 增加可选 `warnings?: string[]` 与 `sentenceLevelOnly?: boolean`：当无可靠字词时间戳时，VAD 工具在 `warnings` 明确告知句级边界限制（不伪造字词时间），规则去口癖工具明确返回可理解错误（AC-3）。
2. **Host 共享剪辑分析服务与注册 Agent 工具（`server/plugins/projectOps.ts`、`server/services.ts`）**：
   - 抽离并向 Cordis 上下文提供 `ctx.projectOps.suggestEdits(input, signal, report)`（或由 `projectOpsPlugin` 内部共享并注册），使 `projects.suggestEdits` RPC（CLI/MCP 复用）与 Agent 工具执行完全同一套逻辑，不触碰任何 React Hook（AC-4）。
   - 通过 `ctx.agentTools.register` 注册两个专用工具（当 `ctx.agentTools` 存在时注册）：
     - `suggest_silence_cuts`：输入 `{ projectId, videoId?, expectedRevision?, silenceMethod?, vadModel?, silenceParams?, gapThresholdSeconds?, operationId? }`（`z.strictObject`，禁止静默应用参数）。
     - `suggest_filler_cuts`：输入 `{ projectId, videoId?, expectedRevision?, operationId? }`（`z.strictObject`，禁止静默应用参数）。
   - 重复分析（相同 `operationId` 或相同 `(kind, silenceMethod, baseRevision)` 且参数一致）直接复用已有待确认建议或幂等返回，不重复堆叠副作用；若期间 `expectedRevision` 过期则返回 `CONTENT_CHANGED`；任务取消 (`AbortSignal`) 不写入 `pending-suggestions.json`（AC-3）。
   - `projects.export` 始终只读取正式 `edits.json`（不读 `pending-suggestions.json`），确保未经用户确认的建议不会改变正式 EDL 或普通导出（AC-2）。

### 接口与数据

| 位置 / 方法 | 输入 | 输出 / 语义 |
|---|---|---|
| `shared/editing/suggestions.ts` | — | `CutSuggestion.text?`、`populateSuggestionTexts` |
| `shared/projectOps.ts` | `projectSuggestInputSchema`（新增 `expectedRevision?`） | `ProjectSuggestResult`（新增 `warnings?`、`sentenceLevelOnly?`） |
| `agentTools`: `suggest_silence_cuts` | `z.strictObject({ projectId, videoId?, expectedRevision?, silenceMethod?, vadModel?, silenceParams?, gapThresholdSeconds?, operationId? })` | JSON 序列化的 `ProjectSuggestResult`（仅写入 `pending-suggestions.json`） |
| `agentTools`: `suggest_filler_cuts` | `z.strictObject({ projectId, videoId?, expectedRevision?, operationId? })` | JSON 序列化的 `ProjectSuggestResult`（仅写入 `pending-suggestions.json`） |
| `src/runtime/connectionModel.ts` | — | 将 `projects.suggestions.list` 加入 `READ_ONLY_RPC_METHODS` |

### 备选方案与取舍

| 方案 | 优点 | 缺点 | 取舍 |
|---|---|---|---|
| **在 `projectOpsPlugin` 注册工具并复用同一 `suggestEdits` 管线（选定）** | 工具与 `projects.suggestEdits` 共享实现，与界面规则/VAD 算法同源且无前端依赖 | 需注意插件加载顺序（`projectOps` 注入可选/前置 `agentTools`） | 采用 |
| 在 `langgraphPlugin` 内单独重写分析逻辑 | 插件耦合少 | 与 `projectOps` / UI 算法容易漂移，违背 AC-1 结果一致要求 | 不采用 |
| 允许工具传 `apply: true` 跳过确认 | 少一步操作 | 违反 AC-2 与 `decisions.md`「未确认建议不改正式 EDL」硬约束 | 坚决禁止 |

## 架构决策

沿用既有 [ADR-0005 统一编辑决策与时间映射](../../20-architecture/adr/0005-unified-edit-decisions.md) 与 [ADR-0010 语义剪辑字词区间边界](../../20-architecture/adr/0010-semantic-cut-word-ranges.md)，无需新增架构决策。

## 自行决定的事项

- **工具命名与严格入参**：注册 `suggest_silence_cuts` 与 `suggest_filler_cuts` 两个工具并使用 `z.strictObject`，从 schema 层彻底拒绝 `apply`/`confirm`/`autoApply` 等未声明参数。
- **相同参数重复调用去重**：除了 `operationId` 幂等外，当 `pending-suggestions.json` 已存在同一 `baseRevision`、同一 `kind` 与同一 `params` 的未处理批次时直接返回既有批次，避免 Agent 连续重试生成冗余待审条。
- **无字词时间时的 VAD 降级提示**：保留句级/音频 VAD 分析能力并在结果明确标出 `sentenceLevelOnly: true` 与 `warnings`，不伪造字词时间；规则去口癖则保持严格门禁拒绝。

## 风险与回退

- **并发合入冲突提示**：`F-0052` 也在前端添加 `HostSuggestionsBanner.tsx`，若合入基线时与本需求 `AgentSuggestionsBar.tsx` 重叠，集成阶段统一保留单一 Host 建议审阅条即可。
- **回退**：卸载两个 Agent 工具注册与 `AgentSuggestionsBar` 即可回退，不影响已有界面去静音/去口癖和 `projects.suggestEdits` 接口。

## 实现清单

- [x] 1. **统一建议原文格式与校验契约**：扩展 `shared/editing/suggestions.ts`（`text?` 与 `populateSuggestionTexts`）、`shared/projectOps.ts`（`expectedRevision?`、`warnings?`、`sentenceLevelOnly?`）及 `src/runtime/connectionModel.ts`（`projects.suggestions.list` 只读白名单），并更新前端面板 `EditingSuggestionsPanel.tsx` / `SilenceCutPanel.tsx` 填充原文（AC-1、AC-3）。
- [x] 2. **Host 共享分析管线与 Agent 工具注册**：完善 `server/plugins/projectOps.ts` 与 `server/plugins/langgraph.ts` / `server/profile.ts`，注册 `suggest_silence_cuts` 与 `suggest_filler_cuts` 工具（拒绝静默应用参数、`expectedRevision` 冲突检测、去重、无字词时间降级/报错、取消保护），并编写 `tests/architecture/agent-tools-f0043.test.ts` 在真实媒体上验证从工具/Workflow 调用到确认应用、导出与历史撤销回退及 Red check（AC-1–AC-4、AC-7、AC-8）。
- [x] 3. **前端 Agent/Host 建议审阅条与生命周期 UI**：新增 `src/components/SubtitleEditor/AgentSuggestionsBar.tsx`，接入 `SubtitleEditorPanel.tsx`、订阅 `'project/suggestions-updated'`、预览加载入 `PendingSuggestionsList` 并校验基线版本后确认落盘，补充 `src/locales/filler.ts` 中英文文案（AC-2、AC-5–AC-8）。
- [x] 4. **E2E 回归、视觉证据与验收报告**：编写 `tests/e2e/features/F-0043.spec.ts`（`light/dark × zh/en`），运行 `PW_PORT=5305 pnpm e2e:evidence F-0043` 与全量静态/单测/架构回归，产出 `04-test-report.md`（AC-1–AC-9）。

## 验证计划

- **架构与真实媒体测试（`tests/architecture/agent-tools-f0043.test.ts`）**：
  - AC-1：比对直接调用核心分析器（UI 同源）与 `suggest_silence_cuts` / `suggest_filler_cuts` / `projects.suggestEdits` 在同一真实媒体输入下的建议 ID、原文、时间范围、类别与原因完全一致。
  - AC-2：调用 `agent.tools`、`agent.start`（或直调注册工具）与 `projects.suggestEdits` 生成待确认建议，校验 `projects.export` 与 `edits.json` 正式 EDL 均未变化；校验传入 `apply: true` 等参数被 `z.strictObject` 拒绝。
  - AC-3：缺失字词时间戳时 `suggest_filler_cuts` 明确报错、`suggest_silence_cuts` 返回 `sentenceLevelOnly: true` 与警告；重复分析不重复堆积；`expectedRevision` 过期报错 `CONTENT_CHANGED`；`AbortSignal` 取消不写入。
  - AC-4：使用真实口播媒体跑通 Host `suggest_silence_cuts` / `suggest_filler_cuts` → 读取待确认列表 → 模拟用户确认应用到 `edits.json` → `projects.export` 导出成片 → 撤销恢复。
  - Red check：撤掉 `z.strictObject` 或 `expectedRevision` 校验后，对应断言立即失败。
- **界面 E2E（`tests/e2e/features/F-0043.spec.ts`）**：
  - 覆盖 `light/dark × zh/en`：加载「正在加载…」、空态「暂无内容」、Host 推送待确认建议展示、预览到时间轴与 `PendingSuggestionsList`、应用完成「已完成」、基线过期「内容已更新，请重新检查」、失败「重试 / 返回」；运行 `PW_PORT=5305 pnpm e2e:evidence F-0043`。

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | `suggest_silence_cuts` / `suggest_filler_cuts` 注册与 `populateSuggestionTexts` 统一输出格式，清单 1、2 |
| AC-2 | 仅写 `pending-suggestions.json`、`z.strictObject` 禁静默应用、`projects.export` 不读待确认建议，清单 1、2、3 |
| AC-3 | 字词时间戳门禁/降级提示、重复调用去重、`expectedRevision` 保护、`AbortSignal` 取消，清单 1、2 |
| AC-4 | 真实口播媒体从 Host 工具/Workflow 到预览、确认、导出与历史回退全链路，清单 2、3 |
| AC-5 | `AgentSuggestionsBar` 复用编辑面板、空态「暂无内容」，清单 3 |
| AC-6 | 加载「正在加载…」、应用「正在处理…」、禁重复提交与防迟到，清单 3 |
| AC-7 | Host 确认后提示「已完成」且重开与第二客户端一致，清单 2、3 |
| AC-8 | 失败「重试 / 返回」、冲突「内容已更新，请重新检查」，清单 2、3 |
| AC-9 | `F-0043.spec.ts` 中英文明暗主题 + 真实媒体架构测试 + `04-test-report.md`，清单 4 |

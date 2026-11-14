---
id: F-0043
stage: 04-test-report
status: review
approved_by:
approved_at:
---

# F-0043 剪辑建议的Agent工具：测试与验收

验收在代码与测试提交 `225f1fb`（实现与 E2E 提交 `fc0c0c3`）上进行；本报告随后作为文档提交，不改变代码与测试。

> 技术设计和开发阶段由 agent 连续推进、自动确认；维护者在这里一并审阅。

## 设计与实现摘要

把 VAD 去静音与规则去口癖分析统一封装为 Host 服务并注册为 Agent 工具，同时保持严格的人工确认门禁：

- **统一建议原文与契约**（`shared/editing/suggestions.ts`、`shared/projectOps.ts`、`src/runtime/connectionModel.ts`）：在 `CutSuggestion` 增加可选 `text` 原文片段与共用提取函数 `populateSuggestionTexts`（供前端 `EditingSuggestionsPanel` / `SilenceCutPanel` 与 Host `projectOps` 同源复用）；`projectSuggestInputSchema` 增加 `expectedRevision`，`ProjectSuggestResult` 增加 `warnings` 与 `sentenceLevelOnly`；`projects.suggestions.list` 加入 `READ_ONLY_RPC_METHODS`。
- **Host 共享分析管线与 Agent 工具注册**（`server/services.ts`、`server/profile.ts`、`server/plugins/projectOps.ts`、`server/plugins/langgraph.ts`）：`projectOpsPlugin` 向 Cordis 提供 `ctx.projectOps.suggestEdits`，`builtinAgentToolsPlugin` 注册 `suggest_silence_cuts` 与 `suggest_filler_cuts`。工具均使用 `z.strictObject` 拒绝静默应用参数（如 `apply`/`autoApply`），仅写 `pending-suggestions.json` 并推送 `'project/suggestions-updated'`，绝不修改正式 `edits.json` EDL 或 `projects.export`。
- **防重与边界保护**：缺失可靠字词时间戳时，`suggest_filler_cuts` 明确拒绝并报错，`suggest_silence_cuts` 标明 `sentenceLevelOnly: true` 与警告而不伪造时间；相同 `operationId` 或同一 `(baseRevision, kind, origin)` 批次去重；`expectedRevision` 过期返回 `VERSION_CONFLICT`；任务取消不写盘。
- **前端审阅条与闭环**（`src/components/SubtitleEditor/AgentSuggestionsBar.tsx`、`PendingSuggestionsList.tsx`、`SubtitleEditorPanel.tsx`、`src/locales/filler.ts`）：订阅实时建议更新、支持一键预览到时间轴与 `PendingSuggestionsList`（展示带引号原文）、校验 `videoRevision` 一致后才写入正式 EDL 并清理待确认建议。
- **与设计的偏差**：`server/plugins/projectOps.ts` 对版本过期复用项目已有 `HostErrorCode` `'VERSION_CONFLICT'`（消息仍为「内容已更新，请重新检查」）。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| 工具入参禁止静默应用 | `suggest_silence_cuts` 与 `suggest_filler_cuts` 均使用 `z.strictObject` 且不定义任何确认/应用开关 | 从 schema 层彻底杜绝参数绕过人工确认 | AC-2 |
| 重复分析去重 | 同一 `operationId` 直接复用既有批次；同一 `baseRevision` 与 `kind/origin` 覆盖刷新而不叠加冗余批次 | 防止 Agent 重试产生重复待确认建议 | AC-3 |
| 无字词时间时的 VAD 降级策略（请确认） | VAD 返回 `sentenceLevelOnly: true` 与明确警告而不伪造字词切点；规则去口癖保持报错拒绝 | 保持音频边界分析可用，同时严守不伪造时间戳 | AC-3 |
| 审阅条挂载位置 | 在 `SubtitleEditorPanel` 挂载独立 `AgentSuggestionsBar` 复用 `PendingSuggestionsList`（不改 React Hook 供后端调用） | 与现行界面面板隔离且便于合并兼容 | AC-4、AC-5 |

## 验收标准逐条结果

| AC | 目标平台 / 环境 | 验证方式、用例与命令 | 证据或未跑原因 | 结果 |
|---|---|---|---|---|
| AC-1 | 真实隔离 Host + 真实口播 MP4 + FSMN-VAD | `tests/architecture/agent-tools-f0043.test.ts` | `agent.tools` 列出两工具；输入/输出（建议 ID、原文、时间范围、类别、原因）与 UI 同源分析器 `deepEqual` 完全一致 | ✅ 通过 |
| AC-2 | Host + `z.strictObject` + Web Chrome | `agent-tools-f0043.test.ts` + Red check + `F-0043.spec.ts` | 调用工具只产生 `pending-suggestions.json`，`edits.json` 未生成/未改写；传 `apply: true`/`autoApply: true` 被拒；Red check 放开 `strictObject` 后测试立即失败 | ✅ 通过 |
| AC-3 | Host + Web Chrome | `agent-tools-f0043.test.ts` + `F-0043.spec.ts`（`agent-stale`） | 无字词时间时规则工具拒绝、VAD 返回 `sentenceLevelOnly: true` 与警告；重复调用去重；过期 `expectedRevision` 报 `VERSION_CONFLICT`；`AbortSignal` 取消无写入 | ✅ 通过 |
| AC-4 | 真实隔离 Host + 3 分钟真实口播 MP4 + FSMN-VAD + FFmpeg | `agent-tools-f0043.test.ts` | 工具分析 → `projects.suggestions.list` → 确认应用 → `projects.suggestions.dismiss` → `projects.export` MP4 实测时长缩短 → 撤销回退恢复完整走通 | ✅ 通过 |
| AC-5 | Web Chrome | E2E `F-0043.spec.ts`（`agent-empty`） | 复用字幕编辑器面板；空记录显示「暂无内容 / Nothing here yet」，既有编辑与导出可用 | ✅ 通过 |
| AC-6 | Web Chrome | E2E `F-0043.spec.ts`（`agent-loading`）+ `AgentSuggestionsBar` epoch 守卫 | 加载显示「正在加载… / Loading…」、执行显示「正在处理… / Processing…」+ 取消，切换视频/项目丢弃迟到响应 | ✅ 通过 |
| AC-7 | Host + Web Chrome | `agent-tools-f0043.test.ts` 重开核对 + `F-0043.spec.ts`（`agent-completed`） | 仅 Host 确认写入后提示「已完成 / Completed」，重开后 EDL 与待确认状态一致 | ✅ 通过 |
| AC-8 | Host + Web Chrome | `agent-tools-f0043.test.ts` + `F-0043.spec.ts`（`agent-error`、`agent-stale`） | 失败显示原因与「重试 / Retry」「返回 / Back」；过期提示「内容已更新，请重新检查 / Content changed. Review again.」 | ✅ 通过 |
| AC-9 | Web Chrome（`light/dark × zh/en`） | `PW_PORT=5305 pnpm e2e:evidence F-0043` 与 `PW_PORT=5305 pnpm test:e2e tests/e2e/features/F-0043.spec.ts` | 4/4 passed，28 张截图已入库，4 段录屏留本地 | ✅ 通过（Web） |
| AC-9 | 真实 Tauri 桌面端应用 | 打包后在 Tauri 桌面端由外部 Agent 触发并预览确认建议 | 本 worktree 未构建桌面安装包 | ⏸ Not run |

## 界面证据

由 `PW_PORT=5305 pnpm e2e:evidence F-0043` 生成，覆盖 `light/dark × zh/en`；`screenshots/` 已入库，`recordings/` 仅留本地。

| 界面 | 状态 | AC | 截图 | 录屏 |
|---|---|---|---|---|
| Agent 剪辑建议条 | 空态（「暂无内容 / Nothing here yet」） | AC-5 | `agent-empty-{light,dark}-{zh,en}.png` | 本地 |
| Agent 剪辑建议条 | 加载中（「正在加载… / Loading…」） | AC-6 | `agent-loading-{light,dark}-{zh,en}.png` | 本地 |
| Agent 剪辑建议条 | 分析失败与重试/返回 | AC-8 | `agent-error-{light,dark}-{zh,en}.png` | 本地 |
| Agent 剪辑建议条 | 版本过期冲突重检 | AC-3、AC-8 | `agent-stale-{light,dark}-{zh,en}.png` | 本地 |
| Agent 剪辑建议条 | 待确认建议就绪 | AC-1、AC-2 | `agent-ready-{light,dark}-{zh,en}.png` | 本地 |
| 时间轴预览与清单 | 预览到时间轴并展示带引号原文 | AC-1、AC-2 | `agent-preview-{light,dark}-{zh,en}.png` | 本地 |
| Agent 剪辑建议条 | 确认应用完成（「已完成 / Completed」） | AC-7 | `agent-completed-{light,dark}-{zh,en}.png` | 本地 |

## 回归检查

均在提交 `225f1fb`（代码与 E2E 提交 `fc0c0c3`）上实跑通过：

- `pnpm lint` ✅（0 errors）
- `pnpm tsc -b --noEmit` ✅
- `pnpm check:host` ✅
- `cargo check --manifest-path src-tauri/Cargo.toml` ✅
- `pnpm test` ✅（130 passed, 0 failed, 6 skipped — 含真实 SenseVoice 与 FSMN-VAD 集成测试）
- `pnpm test:architecture` ✅（160 passed, 0 failed, 0 skipped — 含 `agent-tools-f0043.test.ts` 1/1 真实 3 分钟口播 FSMN-VAD + FFmpeg 导出 + 撤销恢复）
- `PW_PORT=5305 pnpm test:e2e tests/e2e/features/F-0043.spec.ts` ✅（4/4 passed）
- Red check ✅：临时把 `suggest_filler_cuts` 的 `z.strictObject` 放宽为 `z.object` 后，`agent-tools-f0043.test.ts` 立即失败于 `operator: 'throws'`（`agent-tools-f0043.test.ts:76`），恢复后全绿。

## 发现的问题

- 在并发跑全量 `pnpm test:architecture` 时，3 分钟 1080p MP4 导出耗时尚有波动（约 15–26s），已将 `agent-tools-f0043.test.ts` 轮询超时设为 60s 后稳定通过。
- 并发分支 `F-0052` 亦在 `SubtitleEditorPanel` 加入了 `HostSuggestionsBanner`，合入基线时需统一合并为单一 Host 建议审阅条。

## 结论

**可以发布**（Host Agent 工具与真实口播从调用到预览、确认、导出、撤销全链路及 Web 界面均已通过自动化验收；桌面端打包实机补验记为 `⏸ Not run`，请维护者审阅确认）。

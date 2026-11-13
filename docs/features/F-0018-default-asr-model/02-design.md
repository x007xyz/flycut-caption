---
id: F-0018
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-13
---

# F-0018 默认模型推荐与下载引导：设计

## UI / UX

所有新增与改动的界面文案通过 `src/locales/models.ts` 提供完整中英文支持，并适配明暗主题（使用现有 `aimu-*` / Shadcn 语义令牌）。前端不按 `providerId` 硬编码分支，统一读取 `ModelInfo` 的 `recommended`、`offline`、`timestampLevel`、`size` 与 `recommendation` 元数据。

### 1. 推荐模型卡片与引导视图（`RecommendedModelCard`）

在三个现有入口复用同一个推荐引导组件 `src/components/ASR/RecommendedModelCard.tsx`：

1. **设置 → 模型（`ModelsPanel`）**：顶部展示「推荐默认模型 / Recommended default model」卡片，下方保留按 Provider 分组的完整模型列表、FlyCut Cloud 与添加服务区域。
2. **编辑器「选项」标签页（`ASRSettingsPanel`）**：当推荐模型未安装，或当前未选中任何已就绪的本地模型时，展示紧凑版推荐模型卡片与引导按钮；已选中可用模型时保持精简表单，不打扰常规识别。
3. **编辑器字幕区（`SubtitleList` / `SubtitleEditorPanel`）**：在 `stage === transcribe` 且已加载视频、尚无字幕时，若当前没有就绪的识别模型（例如全新安装尚未下载默认模型，或所选模型尚未下载/不可用），不再自动报错弹窗，而是在字幕区展示推荐模型引导卡、禁用的「开始识别 / Start ASR」按钮（提示校验完成前不能识别）以及「管理模型 / Manage models」入口。已有字幕的项目（`stage === edit`）在无网或无模型时编辑功能完全不受影响。

### 2. 展示字段与 F-0001 评测范围（AC-1）

推荐卡片展示：

- 模型名称（如 `SenseVoice Small INT8`）
- Provider 名称与 ID（如 `sherpa-onnx（本地）· sherpa-onnx`）
- 下载大小（如 `230 MB`）
- 离线能力徽章（`离线可用 / Offline`）
- 时间戳级别（`句段级时间戳（字词时间未独立校准） / Segment-level timestamps (word timing unverified)`）
- F-0001 实测参照范围说明：明确引用 F-0001 在 2 段中文口播（1028 句）上的实测结果（SenseVoice 汇总 CER 6.29%、文本对齐语气词召回 98.65% / 146/148），同时显式说明「参考文本源于 SenseVoice 存在来源偏差；其余模型本轮未重跑，字词时间误差未独立验证，不构成全模型无偏排名」。不将任何未测量模型标为最佳。

### 3. 完整界面状态与文案（AC-2、AC-3、AC-5 ~ AC-8）

| 状态 | 展示内容与用户可操作控件 | E2E 构造方式 |
|---|---|---|
| 模型列表加载中（AC-6） | 显示「正在加载… / Loading…」与加载指示，不提前触发失败提示 | `mockHost` 对 `providers.models` 使用 `pending` |
| 无模型 / 前置不足（AC-5） | `ModelsPanel` 列表为空时显示「暂无内容 / Nothing here yet」；无推荐模型或 sidecar 缺失时明确说明缺少什么并提供「管理模型 / Manage models」与「重试 / Retry」，不显示假成功 | `mockHost` 返回 `[]` 或 `unavailable` + `reason` |
| 未安装推荐模型（AC-2） | 显示「下载推荐模型 / Download recommended model」按钮；「开始识别 / Start ASR」禁用并说明「模型校验完成前不能识别」 | `mockHost` 返回 `status: download` |
| 下载与校验中（AC-2、AC-6） | 显示「正在处理… / Processing…」、阶段（下载中 / 解压中 / 校验中）、字节进度（如 `115.0 MB / 230.0 MB · 50%`）及「取消 / Cancel」按钮；禁用重复点击；校验最后一步提示「正在校验文件完整性，请稍候（不可中断）」 | `mockHost` 拦截 `providers.prepare` 并推送带 `downloadedBytes` / `totalBytes` / `phase` 的 `job/updated` 事件 |
| 下载完成并校验通过（AC-7） | Host 返回 `status: ready` 后提示「已完成 / Completed」，显示「使用中 / In use」或「使用此模型 / Use this model」；编辑器引导卡启用「开始识别 / Start ASR」 | `providers.prepare` 完成后 `providers.models` 返回 `status: ready` |
| 失败 / 磁盘不足 / 无网络（AC-2、AC-3、AC-8） | 显示具体错误原因（如无网络、磁盘空间不足、校验失败）与「重试 / Retry」「返回 / Back」按钮；保留用户原有模型选择，若存在其他 `ready` 模型则提供「改选已有模型」入口，绝不自动切到收费或云端模型 | `providers.prepare` 任务失败或返回网络/磁盘/校验错误 |
| 状态/版本过期冲突（AC-8） | 发起下载或识别前如检测到 Host 上该模型状态已与页面快照不一致，提示「内容已更新，请重新检查 / Content changed. Review again.」，刷新清单后才可继续提交 | 首次 `providers.models` 与提交前校验返回的模型状态不同 |
| 已有有效选择 / 切换目标（AC-3、AC-6） | 已有有效 `asrModel` 时不覆盖；离开编辑器或切换视频后，迟到的模型列表或转写响应不写入新目标 | E2E 中预置 `localStorage` 的 `app-settings`，以及切换项目/视频验证 |

## 技术方案

### 涉及的子系统

- [模型 Provider](../../subsystems/providers.md)
- [Cordis / Host](../../subsystems/cordis-host.md)
- [前端（React / UI）](../../subsystems/frontend.md)
- [FunASR / Tauri](../../subsystems/funasr-tauri.md)

### 方案

#### 1. 推荐元数据与单一推荐源（`models.json`、`shared/providers.ts`、`server/plugins/asr.ts`）

- 在 `models.json` 中仅保留 `sensevoice-small-int8-zh-en-ja-ko-yue-2024-07-17` 的 `recommended: true`（将 `paraformer-zh-int8-2023-09-14` 设为 `recommended: false`，满足 01-spec 首发单一推荐与 F-0001 结论限制），并为其 `model.int8.onnx` 与 `tokens.txt` 补充真实 SHA-256 校验值，以及 `recommendation` 参照元数据（`benchmarkId: "F-0001"`、`cer: "6.29%"`、`fillerRecall: "98.65%"`、`sampleSentences: 1028`、`sampleCount: 2`、`comparedWith: ["paraformer-zh-int8-2023-09-14"]`）。
- 在 `shared/providers.ts` 的 `ModelInfo` 与 `modelInfoSchema` 中增加可选字段：
  - `offline?: boolean`（`sherpa-onnx` 本地模型由 `server/plugins/asr.ts` 设为 `true`；云端与外部 HTTP 服务默认为 `false`）
  - `recommendation?: ModelRecommendation`（包含 `benchmarkId` 等纯数据字段，供前后端读取，不带未验证的排名宣称）
- `server/plugins/asr.ts` 读取 `models.json` 时把 `offline: true` 与 `recommendation` 透传给 `ModelInfo`。

#### 2. Host 下载进度、磁盘校验、完整性校验与取消（`server/plugins/models.ts`、`server/plugins/providers.ts`）

- **磁盘空间预检**：开始下载前通过 `node:fs/promises` 的 `statfs` 检查目标目录可用空间（至少覆盖估算大小 × 1.15，archive 模式 × 2.1，或 `FLYCUT_MODEL_DISK_RESERVE_BYTES`）；不足或写入遇到 `ENOSPC` 时立即清理临时文件并报错。
- **字节级进度节流上报**：`fetchToFile` 统计累计已收字节 `downloadedBytes`（跨多文件下载累加已完成文件字节）和 `totalBytes`（取 HTTP `Content-Length`，无头时留空或结合估算），按 100ms 节流（首尾必发）通过 `ProgressReporter` 推送 `{ status: progress, purpose: download, progress, downloadedBytes, totalBytes, phase }` 到 `job/updated`。
- **取消与清理**：abort 时中止 `fetch` / `tar` 子进程并删除 `.part` / `.tmp` / `.extract`，保持模型为 `status: download`。
- **强校验与 `.verified.json`**：下载/解压完成后先报告 `phase: verifying`，校验每个声明文件存在、`size > 0`、`Content-Length` 一致（若服务端返回）、以及 `sha256`（若 manifest 非空）匹配，全部通过后原子写入 `.verified.json` 校验清单并报告 100%。`locate(model)` 检查所有文件非空且若存在 `sha256` 则比对 `.verified.json`（若缺少或 `size`/`mtimeMs` 变化则现场重算 SHA-256，校验不过返回 `undefined` 并拒绝识别）。
- **并发去重与幂等（AC-6、AC-8）**：`server/plugins/providers.ts` 按 `${providerId}/${modelId}` 跟踪进行中的 `prepare` 任务；重复提交返回同一个活跃 `JobSnapshot`，不重复起下载；结果已就绪时 `locate` 直接返回，不重下。

#### 3. 前端下载状态机与安全选型（`src/services/asrService.ts`、`src/utils/modelRecommendation.ts`、`src/hooks/useProviderModels.ts`）

- 在 `src/utils/modelRecommendation.ts` 提炼纯函数：
  - `findRecommendedAsrModel(groups)`：返回唯一 `role === asr && recommended` 的模型与所属 Provider。
  - `pickDefaultOfflineAsrModel(groups)`：仅从 `provider.kind === builtin && model.offline === true && model.role === asr && model.status === ready` 中挑选（优先 `recommended`），绝不自动选择 `flycut-cloud` 或外部 HTTP 服务。
  - `shouldPreserveUserModel(groups, current)`：当用户已有 `ready` 模型、或选中的模型所在 Provider 暂时报错（`group.error`）、或用户显式选了某个在列表中的模型时返回 `true`；只有 `current` 为空或原模型在健康 Provider 中已彻底不存在时才允许自动填入默认本地就绪模型。
- `ASRService`（按 `ClientRuntime` 隔离）维护 `downloads` 状态映射与订阅器（供 `useModelDownloads` Hook 使用）：
  - 支持 `prepareModel(ref, onProgress, signal)` 与 `cancelPrepare(ref)`。
  - 同一模型下载/校验中禁止重复发起，返回同一承诺。
  - 任务结束后调用 `providers.models` 二次向 Host 核对 `status === ready`，确认后才置为 `completed` 并（仅在无有效 `asrModel` 时）自动选中推荐模型；若 Host 未确认就绪则报校验错误。
  - 如在发起前或校验前发现模型状态与界面已知状态冲突（如变为 `unavailable`），触发过期冲突提示「内容已更新，请重新检查 / Content changed. Review again.」。
- `useProviderModels.ts` 增加请求序号与 unmount 保护，避免过期响应覆盖新刷新。
- `FlyCutCaption.tsx` 与 `useASR.ts`：在 `stage === transcribe` 时先等待 `providers.models` 加载完成并运行安全默认选型；若当前无已就绪本地模型，不自动触发 `startASR` 报错，而由 `SubtitleList` 呈现推荐下载引导；校验未完成前禁止识别。

### 接口与数据

- `shared/providers.ts`（向后兼容可选字段）：
  - `ModelRecommendation`: `{ benchmarkId: string; cer?: string; fillerRecall?: string; sampleCount?: number; sentenceCount?: number; testedModels?: string[]; note?: string }`
  - `ModelInfo` 新增 `offline?: boolean`、`recommendation?: ModelRecommendation`。
- `src/types/subtitle.ts`（向后兼容可选字段）：
  - `ASRProgress` 新增 `downloadedBytes?: number`、`totalBytes?: number`、`phase?: downloading | extracting | verifying | complete`。
- 不新增 RPC 方法，不改 `shared/protocol.ts` 边界，Tauri 保持纯外壳。

### 备选方案与取舍

1. **推荐信息放 `models.json` + `ModelInfo` vs 硬编码在前端组件**：选择前者。遵循 `docs/subsystems/providers.md`「模型清单跟着 Provider 走、前端不按 `providerId` 硬编码」原则；结构化指标放 `ModelInfo.recommendation`，具体展示文案由 `src/locales/models.ts` 做中英文渲染。
2. **下载状态放 `ASRService`（随 Runtime 隔离）vs 全局模块变量 / localStorage**：选择 `ASRService`。这样关闭/重开设置弹窗、在工具栏与设置页之间切换都能同步看到字节进度和取消按钮，且切换 Host 时自动随旧 Runtime 销毁隔离，不串状态。
3. **新增 Host 偏好 RPC 同步 `asrModel` vs 沿用 Host 模型就绪态 + 客户端持久化**：选择沿用现有契约（不改动 `shared/protocol.ts` 共享边界）。模型文件下载、校验与 `ready` 状态持久化在 Host 端；新客户端连接同一 Host 时通过 `providers.models` 读取完全一致的就绪状态，并在首次自动选用同一个已就绪推荐离线模型。

## 架构决策

无需新建 ADR：本设计完全遵循现有 [decisions.md](../../decisions.md) 与 [subsystems/providers.md](../../subsystems/providers.md) 契约。

## 自行决定的事项

1. **取消 `paraformer-zh-int8-2023-09-14` 的 `recommended: true`**：`models.json` 原同时标记 SenseVoice Small INT8 与 Paraformer 2023 为 `recommended: true`，与 01-spec「首发只设一个中文口播离线推荐」及 F-0001 结论（「SenseVoice 可优先试用；Paraformer 较快但插入较多」）一致，改为仅 `sensevoice-small-int8-zh-en-ja-ko-yue-2024-07-17` 为 `recommended: true`。
2. **为默认推荐模型补充实测 SHA-256 与 `.verified.json` 校验缓存**：为 `sensevoice-small-int8-zh-en-ja-ko-yue-2024-07-17` 填入实测 SHA-256；通过 `.verified.json`（记录 `size` + `mtimeMs` + `sha256`）避免每次 `providers.models` 重复读取 239 MB 文件，同时保证文件缺失、截断或篡改时立即重新校验并拦截识别。
3. **修复 `FlyCutCaptionContent` 自动转写盲触发**：原代码在 `stage === transcribe` 时直接调用 `startASR`，而默认选中模型的逻辑仅在「选项」标签页挂载后才执行，导致新用户拖入视频立即报错。改为在工作台顶层等待 `providers.models` 并执行安全选型，未就绪时在字幕区展示推荐下载引导，校验完成前禁用识别。
4. **通过 `ModelInfo.offline` 区分本地免费模型与云端/付费模型**：`sherpa-onnx` 模型标记 `offline: true`，`pickDefaultOfflineAsrModel` 严格限定 `provider.kind === builtin && model.offline === true`，从而在不违背「前端不按 `providerId` 写分支」的前提下保证绝不自动切到 `flycut-cloud` 或外部收费接口。

## 风险与回退

- **风险**：不同镜像的 SenseVoice 文件若未来上游重新打包可能导致 SHA-256 变化。**缓解**：实测校验 `model.int8.onnx` 与 `tokens.txt` 的确定哈希；若下载后校验不匹配会明确报错并清理损坏文件，用户也可选择其他模型或通过 HTTP Provider 接入。
- **风险**：`statfs` 在某些虚拟文件系统可能不可用。**缓解**：捕获不支持的平台错误并降级为写入时捕获 `ENOSPC`，不误杀正常下载。
- **回退**：所有扩展字段均为可选字段，若需回退推荐展示只需将 `recommended` 置空或恢复展示逻辑，不影响现有项目数据与导出契约。

## 实现清单

- [x] 1. **清单元数据与共享模型契约**：更新 `models.json`（单一推荐、SHA-256、F-0001 参照元数据）、`shared/providers.ts`（`offline`、`recommendation`）、`server/plugins/asr.ts` 与 `src/types/subtitle.ts`（字节进度字段）。
- [x] 2. **Host 下载进度、磁盘检查、SHA-256 校验与取消**：完善 `server/plugins/models.ts` 与 `server/plugins/providers.ts`（字节进度、`statfs` 磁盘不足/ENOSPC 处理、取消清理、校验完成后才就绪、并发去重），补充 `tests/architecture/default-asr-model.test.ts` 含真实本地 HTTP 下载校验 + `funasr-asr` 中文口播识别与重启保持验证。
- [x] 3. **前端安全选型、下载状态管理与过期防护**：实现 `src/utils/modelRecommendation.ts`（含单元测试）、完善 `src/services/asrService.ts`、`src/hooks/useProviderModels.ts`、`src/hooks/useASR.ts` 与 `src/locales/models.ts`。
- [x] 4. **推荐引导卡片与三大入口集成**：新增 `src/components/ASR/RecommendedModelCard.tsx`，改造 `ModelsPanel.tsx`、`ASRSettingsPanel.tsx`、`SettingsDialog.tsx`、`SubtitleList.tsx`、`SubtitleEditorPanel.tsx` 与 `FlyCutCaption.tsx`，覆盖中英文与明暗主题的全部生命周期状态。
- [ ] 5. **端到端验收与全量回归**：编写 `tests/e2e/features/F-0018.spec.ts`（带 `F-0018/AC-n`），使用 `PW_PORT=5196 pnpm e2e:evidence F-0018` 生成中英文及明暗主题截图，完成全部静态检查、架构测试与真实闭环验证。

## 验证计划

| AC | 目标平台 | 验证方式与命令 | 预期断言 |
|---|---|---|---|
| AC-1 | Node + Web | `pnpm test` + `tests/e2e/features/F-0018.spec.ts` | 仅单一推荐模型；展示名称、Provider、大小、离线能力、时间戳级别及 F-0001 实测范围与局限，未测模型不标最佳 |
| AC-2 | Node + Web | `tests/architecture/default-asr-model.test.ts` + `F-0018.spec.ts` | 未安装显示「下载推荐模型 / Download recommended model」；下载中显示字节进度与取消；失败显示原因和「重试 / Retry」；校验完成前识别被拒绝/禁用 |
| AC-3 | Node + Web | `tests/model-recommendation.test.mjs` + `default-asr-model.test.ts` + `F-0018.spec.ts` | 已有有效选择不被覆盖；无网/磁盘不足/不可用时可改选已有模型，绝不自动切到 `flycut-cloud` 或付费/云端服务 |
| AC-4 | Node (真实 Host + sidecar + 模型 + 口播媒体) | `pnpm test:architecture`（隔离 Host home + 本地静态 HTTP 源提供真实 `sensevoice` 文件 + `zh-podcast-3min.mp4` 片段） | 新安装从下载引导→校验→识别中文口播成功，输出非空中文与句段时间戳，重启 Host 后保持就绪与选择 |
| AC-5 | Web | `F-0018.spec.ts` | 复用设置/选项/字幕区入口；缺模型或 sidecar 时说明原因并提供入口，无记录显示「暂无内容 / Nothing here yet」，已有字幕项目仍可正常编辑 |
| AC-6 | Web | `F-0018.spec.ts` | 加载显示「正在加载… / Loading…」，下载显示「正在处理… / Processing…」+ 字节进度 +「取消 / Cancel」，防重复点击；切走或换目标后迟到响应不串项目 |
| AC-7 | Node + Web | `default-asr-model.test.ts` + `F-0018.spec.ts` | 仅 Host 确认就绪后显示「已完成 / Completed」；重开与第二个连接同一 Host 的客户端读取到一致的 `ready` 状态与默认选择 |
| AC-8 | Node + Web | `default-asr-model.test.ts` + `F-0018.spec.ts` | 失败显示原因 +「重试 / Retry」「返回 / Back」并保留原选择；状态变化时提示「内容已更新，请重新检查 / Content changed. Review again.」；重试/并发不盲目重复下载 |
| AC-9 | Web + Node/Sidecar | `PW_PORT=5196 pnpm e2e:evidence F-0018` + `pnpm lint && pnpm tsc -b --noEmit && pnpm check:host && cargo check --manifest-path src-tauri/Cargo.toml && pnpm test && pnpm test:architecture` | 覆盖中英文、明暗主题并保留截图与录屏；桌面真机打包 UI 视环境记为已测或 `Not run` 并说明原因 |

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | `models.json` 单一推荐与 F-0001 元数据 + `RecommendedModelCard` 展示字段与范围声明 |
| AC-2 | `server/plugins/models.ts` 字节进度/取消/SHA-256 校验 + `ASRService` + `RecommendedModelCard` |
| AC-3 | `modelRecommendation.ts` 安全选型 + `models.ts` `statfs`/网络错误处理 + `RecommendedModelCard` 改选已有模型 |
| AC-4 | `default-asr-model.test.ts` 隔离 Host + 真实 `sensevoice` 模型文件下载校验 + `funasr-asr` 口播识别与重启持久化 |
| AC-5 | `ModelsPanel` / `ASRSettingsPanel` / `SubtitleList` 入口复用、空态与已有项目编辑可用 |
| AC-6 | 加载/处理中文案、`Cancel`、`ASRService` 并发去重、`useProviderModels` 与 `useASR` 切目标隔离 |
| AC-7 | 二次向 Host 确认 `status === ready` 后显示「已完成 / Completed」、重开与第二客户端一致读取 |
| AC-8 | 失败重试/返回、保留已有选择、并发幂等查询与「内容已更新，请重新检查」过期防护 |
| AC-9 | `tests/e2e/features/F-0018.spec.ts`（zh/en × light/dark）+ `e2e:evidence` + 全量检查与真实闭环测试 |

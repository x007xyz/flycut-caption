---
id: F-0031
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-13
---

# F-0031 带上下文的分批翻译：设计

## UI / UX

### 入口与布局

- 复用字幕编辑器顶栏现有「翻译 / Translate」按钮（增加 `data-testid="translation-open"`），点击打开 `TranslationPanel`（位于 `LanguageTrackBar` 与 `CorrectionReviewPanel` 下方、字幕列表上方），不再在点击按钮后直接盲目请求全量翻译并写入 store。
- 复用顶栏现有 AI 模型选择器与目标语言选择器，并在面板内同步展示与切换：**源语言**（默认取当前转写语言，支持 `auto` 及常用语言）、**目标语言**、**AI 模型**、**发送范围**，以及可配置的**每行字数上限**（默认 `42`）与**读速上限（字/秒）**（默认 `20`）。
- 已有项目编辑器、时间轴与播放器编辑操作保持可用；面板打开期间仅管理翻译草稿与持久化提交流程。

### 状态与文案

| 状态 | 界面行为 | 必需文案（中 / 英） |
|---|---|---|
| 空字幕 | 编辑器列表已有空态，不显示假成功 | 暂无内容 / Nothing here yet |
| 前置不足（无模型/未选模型） | 提示缺少 AI 模型，提供「打开 AI 设置」入口与模型选择 | 请先配置AI模型 / Configure an AI model first；打开AI设置 / Open AI settings |
| 前置不足（无目标语言 / 选定范围内无条目） | 说明缺少条件并禁用开始按钮，不发请求 | 请选择目标语言 / Choose a target language；暂无内容 / Nothing here yet |
| 准备发送（含过期重翻） | 展示条数、语义句数、批次数及外部发送目标模型提示；范围选「仅过期条目」时列出可勾选过期条目（默认全选，也可从列表勾选同步） | 将发送 {count} 条字幕（{sentences} 语义句，{batches} 批）至 {model} / Sending {count} cues ({sentences} semantic sentences, {batches} batches) to {model} |
| 加载中 | 项目/资源载入中复用编辑器加载态 | 正在加载… / Loading… |
| 执行中（分批请求） | 展示「正在处理… / Processing…」、批次进度 `done/total` 与进度条，禁用重复提交，提供「取消 / Cancel」 | 正在处理… / Processing…；批次 {done}/{total} / Batch {done}/{total}；取消 / Cancel |
| 单批校验失败 | 缺条、多条、重复 ID、未知 ID 或空译文时整批标记无效并拒绝写入，不以原文填补；提供单批「重试 / Retry」与「排除 / Exclude」 | 翻译结果无效 / Invalid translation result；重试 / Retry；排除 / Exclude |
| 单批请求失败 | 保留已成功批次的可编辑译文，显示具体错误并支持单批「重试 / Retry」或「重试失败批次」 | 重试 / Retry；重试失败批次 / Retry failed batches |
| 取消或部分完成 | 中止当前请求并忽略任何迟到响应；保留已完成批次的可编辑译文，可继续编辑、重试未完成批或应用已完成批 | 已取消 / Cancelled；仅应用已完成 / Apply completed |
| 译文审阅与行超限 | 逐条展示源文、可编辑译文输入框（带手动修改标记）；超出每行字数或读速时标出「译文过长 / Translation too long」及实测数值，人工修改后实时重算 | 译文过长 / Translation too long |
| 原文或轨道过期 | 检测到源字幕文本或目标轨道版本改变时锁定提交并提示，需重新核对或重翻变更条目后才能提交 | 内容已更新，请重新检查 / Content changed. Review again. |
| 提交持久化中 | 写回 `historyStore` 并调用 Host 保存，禁用重复提交，说明 Host 写入步骤不可取消 | 正在处理… / Processing…；正在保存至 Host，此步骤不可取消 / Saving to Host; this step cannot be cancelled |
| 持久化失败 / 冲突 | 保存结果不确定时先查询 `verifyCurrentEditsSaved`；确认未写入则回滚正式数据，保留面板内译文与人工修改，显示具体原因与「重试 / Retry」「返回 / Back」；冲突时打开/提示检查更新 | 重试 / Retry；返回 / Back；内容已更新，请重新检查 / Content changed. Review again. |
| 持久化完成 | 仅当 Host 确认写入或只读核验通过后才展示完成态与结果摘要 | 已完成 / Completed |

### 端到端测试构造方式

- Web E2E（`tests/e2e/features/F-0031.spec.ts`）使用 `mockHost` 拦截 `aiSettings.list`、`projects.open`、`projects.saveVideoEdits`、`text.start`、`jobs.get`、`jobs.cancel`，构造：缺条/多条/重复/空译文批次、单批失败与单批重试、取消迟到响应、手动修改保留、选定过期条目重翻、每行字数/读速超限告警与人工修正、保存不确定回查（`projects.open`）、保存失败重试/返回与版本冲突，覆盖中英文 × 明暗主题并生成截图与录屏。
- 真实 Host 持久化、格式 4 轨道保存/重开与双客户端一致性由 `tests/architecture/batched-translation-f0031.test.ts` 启动真实 Cordis Host 验证。

## 技术方案

### 涉及的子系统

- [frontend.md](../../subsystems/frontend.md)：字幕编辑器面板、`historyStore`、`appStore`、`ProjectService` 自动保存与回查、Playwright 证据。
- [cordis-host.md](../../subsystems/cordis-host.md)：`shared/protocol.ts` 声明 `text.start` 扩展参数，`server/plugins/text.ts` 转发至 `OpenAICompatibleEngine`，Host 为项目持久化唯一真源。
- [ADR-0007](../../20-architecture/adr/0007-host-ai-settings-and-secrets.md)：继续通过 `configId` 在 Host 侧解析模型与密钥，密钥不进入前端。
- [ADR-0011](../../20-architecture/adr/0011-multilingual-subtitle-tracks.md)：翻译结果写入每视频 `languageTracks`，保存 `sourceText` 快照，投影至 `secondText`，沿用视频修订号冲突检查。

### 方案

1. **语义合并与上下文分批（`shared/text/translation.ts`）**：
   - 新增纯函数 `groupTranslationSentences(cues, options?)`：将相邻非删除字幕按句末标点（`。！？.!?…；;`）、较长停顿间隔（`>= 1.2s`）及安全上限（最多 6 条或 220 字符）合成为语义句组（`TranslationSemanticGroup`）。
   - 新增纯函数 `splitTranslationBatches(allCues, targetIds, options?)`：支持全量、未翻译、仅选中过期条目或勾选条目；在语义句组边界切分批次（默认每批最多 25 条或 2400 字符），避免把一句完整话拆跨两批；为每批从全量有序有效字幕中抽取前后文只读参考（默认前 3 条 + 后 3 条，`contextBefore` / `contextAfter`）；即便仅重翻 2 条过期条目，也会附带紧邻上下文。
2. **模型调用与双端严格校验（`shared/text/OpenAICompatibleEngine.ts` + `shared/text/translation.ts`）**：
   - 实现 `validateTranslationResults(requested, parsed)`（与 `OpenAICompatibleEngine` 共用）：逐条核对 `id` 集合与输入完全一致（无缺失、无未知多余项、无重复、非空原文对应译文不可为空白）。任何异常统一抛出包含「翻译结果无效 / Invalid translation result」的错误，整批失败，绝不静默回填原文。
   - `OpenAICompatibleEngine.translate(items, model, targetLang, options?)` 接收可选 `sourceLang`、`semanticGroups`、`contextBefore`、`contextAfter`：在 prompt 中指示模型结合前后文理解语义句整体含义后，按原 `id` 切分并返回 JSON 数组；保持旧三参数签名兼容现有测试与调用方。
3. **行字数与读速约束校验（`shared/text/translation.ts`）**：
   - `evaluateTranslationConstraints(text, timestamp, limits)` 按 `\n` 分行检查最大行数字符（Unicode 码点数）及阅读速度（`charCount / Math.max(0.1, durationSec)`）。默认值 `maxCharsPerLine = 42`、`maxCps = 20`，可由用户在面板内配置并保存在 `appStore.translationLimits`（非敏感界面偏好）。
4. **编排 Hook 与取消/防串台/过期守卫（`src/hooks/useBatchTranslation.ts`）**：
   - 使用单调递增 `runRef` 与 `AbortController` 管理执行周期；点击取消或切换视频/项目时立即中止请求、递增 `runRef`，任何迟到响应均被丢弃。
   - 维护每条草稿的 `manuallyEdited` 标志：单批重试或重试失败批只重发对应批的 `items`，合并结果时跳过已人工修改的条目，确保不覆盖人工修正。
   - 捕获任务开始时的 `baseSourceMap`（各字幕原文）及 `baseTrackSnapshot`（目标轨道 `entries` 快照）。一旦当前 `chunks` 或目标轨道在外部发生变化，立即置 `stale = true` 并锁定应用按钮，要求用户重新检查（确认更新基准或重翻变更条目）。
5. **安全持久化与不定态回查（`src/services/translationPersistence.ts` + `src/stores/historyStore.ts`）**：
   - `historyStore.applyLanguageTranslations` 支持可选 `trackId`，仅更新传入 `updates` 中的条目（不波及未选中的过期或其他条目），写入精确 `sourceText` 快照并投影 `secondText`。
   - 提交时先记录 `historyStore` 变更前快照；写入后调用 `ctx.projects.flush()`。若失败或结果不确定，先检查 `save.status === 'conflict'`，否则调用 `ctx.projects.verifyCurrentEditsSaved()` 通过 `projects.open` 回查 Host 真实状态。确认未写入时回滚 `historyStore` 至提交前快照并保留面板草稿，提供「重试 / Retry」和「返回 / Back」；只有 Host 确认保存或回查一致时才进入「已完成 / Completed」。

### 接口与数据

- **RPC 扩展（`shared/protocol.ts`）**：`textInputSchema` 增加可选字段 `sourceLang?: string`、`semanticGroups?: Array<{ sentence: string; itemIds: string[] }>`、`contextBefore?: Array<{ id?: string; text: string }>`、`contextAfter?: Array<{ id?: string; text: string }>`，保持 `mode`、`items`、`targetLang`、`configId` 兼容不变。
- **前端状态（`src/stores/appStore.ts`）**：增加持久化 UI 偏好 `translationLimits: { maxCharsPerLine: number; maxCps: number }`（默认 `{ maxCharsPerLine: 42, maxCps: 20 }`）及 `setTranslationLimits`。
- **`AIService`（`src/services/aiService.ts`）与 `useAI`（`src/hooks/useAI.ts`）**：扩展 `translate` 支持可选上下文参数并透传 `AbortSignal` 至 `text.start`。

### 备选方案与取舍

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 草稿暂存在翻译面板 + 显式应用并 Host 回查校验 | 未确认内容不污染正式轨道/导出；支持单批重试、人工编辑与版本冲突拦截；与 F-0013 一致 | 需要用户点击一次「应用译文」确认入库 | **采用**（满足 AC-3/AC-7/AC-8 与需求约束） |
| 每完成一批直接写入 `historyStore` 并触发自动保存 | 无需最后点击应用 | 失败批或中途取消会把半成品直接写进正式字幕与导出，违反「未确认不进入正式字幕」约束 | 舍弃 |
| 新增专用 `translation.start` RPC | 语义与纠错完全分离 | `text.start` 已支持 `mode: 'translation'` 与 `configId`，扩展可选字段更轻量且复用 `jobs` 与 F-0056 密钥解析 | 舍弃，复用并扩展 `text.start` |
| 在 Host 内建分批循环（单 job 跑全片） | 前端代码略少 | 单次 job 超长、前端难以做单批独立重试/排除及局部人工修改不覆盖 | 舍弃，由前端编排单批 `text.start` job |

## 架构决策

沿用 [ADR-0007](../../20-architecture/adr/0007-host-ai-settings-and-secrets.md) 与 [ADR-0011](../../20-architecture/adr/0011-multilingual-subtitle-tracks.md)，不新增持久化格式版本或新 RPC 方法，无需新增 ADR。

## 自行决定的事项

- **默认约束阈值**：每行字数上限默认 `42` 字符、读速上限默认 `20` 字符/秒，在面板内开放实时编辑并保存在 `appStore` UI 偏好中（默认值兼顾中英双语口播常见的单行英文 42 字符 / 20 CPS 标准）。影响 AC-4。
- **分批大小与上下文窗口**：默认单批上限 `25` 条 / `2400` 字符（按语义句边界向上对齐，不拆断同句），每批前后各附带最多 `3` 条相邻有效字幕作为只读上下文；停顿超过 `1.2s` 或句末标点自动切分语义句，无标点长段每 `6` 条或 `220` 字符兜底切分。影响 AC-1。
- **面板与已有 `F-0017` E2E 的入口对齐**：`SubtitleList` 顶栏「翻译 / Translate」按钮改为打开 `TranslationPanel`（与「纠错 / Correct」打开 `CorrectionReviewPanel` 保持一致）。`tests/e2e/features/F-0017.spec.ts` 中依赖原一键翻译的 2 行将同步更新为打开面板 → 开始 → 应用，以保持全仓 E2E 通过。影响 AC-1、AC-5。

## 风险与回退

- **长口播分批耗时**：60 分钟口播（约 1000 条字幕）按 25 条/批约 40 批，串行执行可避免上游限流并保证进度与取消行为确定；若真实环境下单批失败只需重跑单批。
- **外部模型 JSON 稳定性**：部分模型可能返回多余包裹文本或遗漏条目，双端（Host + 前端）严格校验保证绝不静默丢条或填回原文，直接标为「翻译结果无效」并可单批重试。
- **真机 / 真实外部 API 条件**：真实 OpenAI 兼容 API（如 60 分钟中文口播实时接口）和 Tauri 桌面真实打包环境若当前沙箱缺失，必须在 `04-test-report.md` 中明确记为 `⏸ Not run` 并注明阻塞原因。

## 实现清单

- [x] 1. 在 `shared/text/translation.ts` 实现语义句合并、上下文分批、严格条数/ID/空译文校验与行字数/读速检测纯逻辑，并补充单元测试。
- [ ] 2. 扩展 `shared/protocol.ts`（`textInputSchema`）、`shared/text/OpenAICompatibleEngine.ts` 与 `server/plugins/text.ts`，支持语义句组与上下文翻译及严格校验。
- [ ] 3. 扩展 `src/stores/appStore.ts`、`src/stores/historyStore.ts`、`src/services/aiService.ts`、`src/hooks/useAI.ts` 与 `src/services/translationPersistence.ts`，支持上下文翻译、选定条目定向更新与 Host 保存/不定态回查回滚。
- [ ] 4. 实现 `src/hooks/useBatchTranslation.ts`、`src/components/SubtitleEditor/TranslationPanel.tsx` 与 `src/locales/translation.ts`，接入 `SubtitleList.tsx`（含入口、空态、前置不足、批次进度、取消防串台、单批重试、人工修改保护、过期重翻、行超限标注与版本过期/冲突/失败处理）。
- [ ] 5. 编写架构与集成测试 `tests/architecture/batched-translation-f0031.test.ts`（真实 Host 翻译持久化/重开/双客户端/60 分钟规模映射验证）及 `tests/e2e/features/F-0031.spec.ts`（覆盖 AC-1～AC-9 中英文 × 明暗主题），并生成截图与录屏证据。
- [ ] 6. 完成全量静态检查、单测、架构测试、E2E 回归（含 `F-0017`、`F-0030` 兼容验证）与 `04-test-report.md` 报告整理。

## 验证计划

| 清单 | 目标平台与检查命令 | 预期断言 |
|---|---|---|
| 1 | Node 单测：`pnpm test`（新增 `tests/batched-translation.test.mjs`） | 语义句合并按标点/停顿/上限分组、跨批不拆句、上下文窗口正确、缺条/多条/重复/空译文均报错且不回填原文、行字数与 CPS 精确判定 |
| 2 | Host 类型与 Engine 单测：`pnpm check:host`、`pnpm test` | `text.start` 接收语义句与上下文参数并向模型发送结构化提示词；向后兼容旧三参调用；缺条/错 ID 整批拒绝 |
| 3 | 类型与架构测试：`pnpm tsc -b --noEmit`、`pnpm test:architecture` | `applyLanguageTranslations` 只更新选定 ID；保存失败自动回滚 `historyStore`；不定态触发 `verifyCurrentEditsSaved` |
| 4 | 前端构建与 Lint：`pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm build` | 中英文、明暗主题界面渲染正常，无 TS/ESLint 错误 |
| 5 | 真实 Host 架构测试 + Web Playwright：`pnpm test:architecture`、`PW_PORT=5191 pnpm e2e:evidence F-0031` | 60 分钟规模（~1200 条）映射/保存/重开/双客户端一致；Playwright 覆盖 AC-1～AC-9 全状态及中英文 × 明暗主题并产出截图/录屏 |
| 6 | 全套验收检查：`pnpm lint && pnpm tsc -b --noEmit && pnpm check:host && cargo check --manifest-path src-tauri/Cargo.toml && pnpm test && pnpm test:architecture`、`PW_PORT=5191 pnpm test:e2e tests/e2e/features/F-0031.spec.ts tests/e2e/features/F-0030.spec.ts tests/e2e/features/F-0017.spec.ts` | 全部自动化全绿；真实外部 LLM API 与 Tauri 桌面实机按环境可用性实测或据实记录 `Not run` |

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | 顶栏与 `TranslationPanel` 选择源/目标语言、AI 模型及发送范围；`groupTranslationSentences` + `splitTranslationBatches`；批次进度与 `取消 / Cancel` |
| AC-2 | `validateTranslationResults`（Host + 前端双层校验）整批失败并提示「翻译结果无效 / Invalid translation result」，绝不静默回填原文 |
| AC-3 | 已成功批保留于可编辑列表；单批「重试 / Retry」；`runRef` + `AbortSignal` 忽略取消迟到响应；`manuallyEdited` 防覆盖；源文/轨道变化标过期并阻断提交 |
| AC-4 | `scope === 'outdated'` 勾选列表仅重翻所选过期项；`evaluateTranslationConstraints` 标注「译文过长 / Translation too long」并支持人工修改；60 分钟中文口播映射与重开验证 |
| AC-5 | 复用编辑器「翻译」入口；空字幕「暂无内容 / Nothing here yet」；无模型/无目标语言/无匹配条目明确引导并提供设置入口，已有编辑不中断 |
| AC-6 | 加载「正在加载… / Loading…」、执行/保存「正在处理… / Processing…」+ 进度；防重复提交；取消/切换项目隔离迟到响应；Host 写盘不可取消说明 |
| AC-7 | 仅 Host `flush` / `verifyCurrentEditsSaved` 确认后显示「已完成 / Completed」；写入项目格式 4 轨道，重开与第二客户端读取一致 |
| AC-8 | 保存失败显示原因 +「重试 / Retry」「返回 / Back」并保留用户输入及已有正式数据；不定态先调用 `verifyCurrentEditsSaved` 查询；版本过期/冲突提示「内容已更新，请重新检查 / Content changed. Review again.」 |
| AC-9 | `tests/e2e/features/F-0031.spec.ts` 中英文 × 明暗主题全状态覆盖与截图/录屏；真实 Host 验证与外部条件如实记录 |

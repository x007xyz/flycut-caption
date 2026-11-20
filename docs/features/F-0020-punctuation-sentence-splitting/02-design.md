---
id: F-0020
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-16
---

# F-0020 标点与字幕断句优化：设计

## UI / UX

入口放在现有字幕编辑器工具栏（`SubtitleEditorPanel`），与「纠错」「关键词」「查找替换」并列，新增「断句 / Line breaks」按钮；不新建页面，不改播放器、时间轴和导出入口。面板在编辑器顶部展开，行为如下。

| 状态 / 入口 | 用户看到什么、能做什么 | 验收构造 |
|---|---|---|
| 空态 / 前置不足 | 没有字幕时显示「暂无内容 / Nothing here yet」；没有字词时间戳时显示「当前字幕没有字词时间戳，无法安全拆分 / This transcript has no word timestamps, so it cannot be split safely」，并保留手动编辑入口。 | mock `projects.open` 返回空 transcript 或只有句段级字幕 |
| 就绪 | 显示「每屏字数上限 / Max chars per screen」（默认 20，范围 8–60）、将拆分的句数和受影响句数；逐条显示原文与建议，可改每段文字、可对单条选「保留原文 / Keep original」。 | 返回带字词时间戳的长句 transcript，打开面板 |
| 无可拆分 | 显示「没有需要拆分的长句 / No long sentences to split」，关闭面板不改变字幕。 | 所有句子都在上限内 |
| 限制说明 | 没有字词时间戳、已有译文、已有关键词或已配音的句子不自动拆分，显示「N 句已跳过（缺少可靠时间或已有译文、关键词、配音）/ N skipped (no reliable timing, translation, keywords or dubbing)」；不做假时间、不均分时间。 | transcript 混入无 `wordIds`、带 `secondText` 的句子 |
| 应用中 | 按钮显示「正在应用… / Applying…」并禁用重复提交，执行一次撤销记录；期间编辑区 inert。 | 点击应用，保存请求挂起 |
| 已完成 | 仅在 `projects.saveVideoEdits` 返回 `saved` 且回读校验成功后显示「已完成 / Completed」；字幕列表与预览立即使用新句段。 | mock 保存成功 |
| 版本过期 | 分析后字幕或字词发生变化时，显示「字幕已更新，请重新检查 / Subtitles changed. Review again.」，禁止直接覆盖，提供「重新分析 / Analyze again」；正式字幕保持原样。 | 分析后触发一次撤销/文本修改再应用 |
| 失败 | 显示具体原因与「重试 / Retry」「返回 / Back」；应用失败时回滚到应用前的字幕与撤销栈，保留面板中的手动修改。 | mock 保存报错 |
| 已有数据兼容 | 拆分只改句段和字词归属，不改 EDL、项目格式、字幕样式；译文/关键词/配音句默认跳过，避免译文错位。 | 打开带 EDL 和译文的项目 |

文案集中放进 `src/locales/sentenceSplits.ts`，与 `correction.ts` 同一模式，中文/英文各一份。明暗主题沿用现有 CSS 变量，不新增颜色。

## 技术方案

### 涉及的子系统

已读 [frontend.md](../../subsystems/frontend.md)、[cordis-host.md](../../subsystems/cordis-host.md)、[providers.md](../../subsystems/providers.md)、[code-standards.md](../../code-standards.md)、[acceptance-testing.md](../../30-engineering/acceptance-testing.md)、[decisions.md](../../decisions.md)，并核对 `shared/asr/transcript.ts`、`src/utils/timeUtils.ts`、`src/utils/asrTranscriptUtils.ts`、`src/stores/historyStore.ts`、`src/services/projectService.ts`、`src/services/textPersistence.ts`、`src/components/SubtitleEditor/*`、`shared/protocol.ts`、`server/plugins/projects.ts`、`shared/projects.ts`。

### 方案

**1. 纯分析与拆分逻辑放 `shared/asr/sentenceSplitting.ts`**

不调用模型、不发 RPC、不依赖 React。输入是当前句段与字词（都已有可靠时间戳），输出「建议」：

```ts
interface SplitOptions {
  maxChars: number;                 // 8–60，默认 20
  pauseThresholdSec?: number;       // 默认 0.35
  translatedChunkIds?: ReadonlySet<string>;
  dubbingChunkIds?: ReadonlySet<string>;
}
interface SplitPiece { text: string; timestamp: [number, number]; wordIds: string[]; forced: boolean }
interface SplitSuggestion { chunkId: string; before: string; pieces: SplitPiece[]; reason: 'length' | 'punctuation' }
interface SplitAnalysis { maxChars: number; base: string; suggestions: SplitSuggestion[];
  skipped: { noWords: number; translated: number; keyworded: number; dubbed: number; short: number } }
```

断句优先级：句末标点（`。！？!?…；;`）> 逗号/顿号（`，,、`）> 停顿 ≥ 0.35s > 达到字数上限后的下一个词边界。只在**已有字词边界**上切，绝不按字数均分时间；每段文字由 `joinWordTexts` 从该段词文本拼出（沿用 sidecar 规则），保证不吞字、不重排。尾段少于 3 个字时并入上一段（不超过上限 + 2）。输出前校验每段时间在原句范围内、顺序有效、`wordIds` 不重复且覆盖原句全部词；任一校验失败则整句跳过并计入跳过数。

对以下句子不生成建议，只计数：没有 `wordIds`/字词时间戳（AC-4）、已有 `secondText` 或语言轨译文（避免译文与原文错位，AC-3）、有关键词高亮、已有配音产物。已经在上限内的句子不计入。

**2. 应用是 history store 的一次原子编辑**

`historyStore` 新增 `applySentenceSplits(plans)`，参数为 `{ chunkId, pieces: { text, timestamp, wordIds }[] }[]`。校验全部通过后一次性替换句段：

- 新句段 id 用 `crypto.randomUUID()`；继承原句的 `speaker`、`edlWordProjection`，`deleted` 保持 `false`（已删除句不参与）；
- 每个字词的 `sentenceId` 改成所属新句段 id，`wordIds` 原样保留；
- 不写 `secondText`/`keywords`（这些句子已被排除），不修改 EDL、样式、项目格式；
- 通过现有 `commit(..., 'sentence-split', false)` 写一次撤销快照，`cuts` 为 false，不进入剪辑历史；撤销/重做恢复句段与字词归属。

应用前由 hook 比较分析时的 `JSON.stringify([chunks, wordChunks])` 基线；不一致返回 `stale`，不写入（AC-3、AC-8）。

**3. 保存与「已完成」**

新增 `applySentenceSplitsWithPersistence(ctx, plans)`（放在 `src/services/textPersistence.ts`，复用 `persistFormal`）：先应用，再 `ctx.projects.flush()`，必要时 `verifyCurrentEditsSaved()` 确认；失败且字幕未被其他操作改动时回滚到应用前的句段、字词和撤销栈，返回 `apply-failed`。只有成功才显示「已完成」（AC-7）。自动保存仍由现有 history 订阅触发，不新增保存通道。

**4. 界面与状态**

新增 `src/hooks/useSentenceSplits.ts` 与 `src/components/SubtitleEditor/SentenceSplitPanel.tsx`：

- 面板打开时同步分析（纯函数，长项目也在毫秒级），显示建议；`maxChars` 改变时重新分析并把面板重置为就绪。
- 每条建议可逐段编辑文字、可「保留原文」；空文字就地报错并禁用应用。
- 关闭面板不修改任何正式数据；应用成功后关闭面板并保留一次撤销记录。
- 组件挂载/卸载用 `videoFile` 或项目切换重置，迟到应用结果不能写到新视频（沿用 `useCorrectionReview` 的 run/generation 做法）。

**5. 不做 Host 新 RPC**

分析与拆分都是当前字幕的纯变换，复用既有 `projects.saveVideoEdits` 的修订号、冲突、幂等和回读校验；新增 Host RPC 只会重复这套契约。CLI/MCP 不涉及本功能。

### 接口与数据

| 位置 | 接口 / 约束 |
|---|---|
| `shared/asr/sentenceSplitting.ts` | `countChars`、`analyzeSentenceSplits(chunks, wordChunks, options)`、`validateSplitPlans`；纯函数，无 I/O |
| `src/stores/historyStore.ts` | `applySentenceSplits(plans) => { ok: true; count } \| { ok: false; error: 'stale' \| 'invalid' \| 'empty' }`；一次撤销快照 |
| `src/services/textPersistence.ts` | `applySentenceSplitsWithPersistence(ctx, plans)`，保存失败回滚 |
| `src/hooks/useSentenceSplits.ts` | `open / close / analyze / toggleKeepOriginal / updatePiece / apply` 状态机 |
| `src/components/SubtitleEditor/SentenceSplitPanel.tsx` | 面板与全部界面状态，`data-testid` 供 E2E |
| 项目数据 | 无格式变化：`chunks` / `wordChunks` 既有字段，`deletedWordIds`、EDL 不变；不抬 `PROJECT_FORMAT_VERSION` |

### 备选方案与取舍

| 选定 | 备选 | 理由 |
|---|---|---|
| 客户端纯逻辑分析 + 既有保存通道 | 新增 `subtitles.suggestSplits/applySplits` Host RPC | 没有跨用户/跨进程状态，Host RPC 只会重复修订号与冲突逻辑；纯逻辑在 shared 中可直接单测 |
| 只按已有字词边界切 | 调用 `punc` 角色模型重新标点后切 | 当前没有已验证的中文标点模型（F-0001 未覆盖 punc），不能把未验证模型作为默认承诺；先做可解释的规则层，后续模型能力成熟再扩展 |
| 跳过已翻译/关键词/配音句 | 拆分后按字比例分配译文 | 按比例分配是伪造译文；跳过并计数符合 AC-3「译文映射不错位」 |
| 复用 `groupWordsIntoSentences` 的断点规则 | 另写一套断句规则 | 现有函数已有测试与停顿/标点/时长规则；本需求在其规则外补字数上限和「只在词边界切」的分析层，避免重复实现 |

## 架构决策

不新增 ADR。复用 [ADR-0001 项目存储格式](../../20-architecture/adr/0001-project-storage-format.md)（不改格式）、[ADR-0005 统一时间映射与 EDL](../../20-architecture/adr/0005-unified-time-mapping-edl.md)（不改 EDL）和 frontend/host 的既有边界。

## 自行决定的事项

- 默认每屏 20 字（中文）；范围 8–60。以 F-0001 的口播样本和三种画幅为后续调参依据，不在本需求硬编码平台差异（AC-1）。
- 拆分后不给句子自动补标点，只沿用原有标点或词边界；需要补标点时用户可在建议里手动改文字（AC-2）。
- 已翻译、关键词高亮、配音的句子默认不拆，避免译文/样式/音频错位；面板显示跳过数量（AC-3、AC-4）。
- 没有字词时间戳时不做任何拆分，只提示限制；不按字数均分时间（AC-4）。
- 应用成功后仅在保存确认后显示「已完成」；保存失败回滚并保留面板修改（AC-7、AC-8）。

## 风险与回退

- 规则断句可能不符合个别语义；所有改动都在预览中可见、可逐段编辑、可保留原文，且一次撤销可恢复。
- 超长句拆成过多段会产生很多短字幕；尾段合并与最小字数（3 字）限制已加入，E2E 覆盖。
- 译文/关键词/配音句跳过会让部分长句保持原样；面板明确计数，后续需求（F-0031/F-0032）可在翻译前先断句。
- 60 分钟项目的一次分析是 O(词数)，纯字符串处理；若实测超过 200ms，再考虑在 Worker 中执行，不改变接口。

## 实现清单

- [x] 1. **纯分析与校验核心**：`shared/asr/sentenceSplitting.ts`，覆盖标点/停顿/字数断点、尾段合并、无字词与已翻译句跳过、时间与词覆盖校验；`tests/architecture/sentence-splitting-f0020.test.ts` 单测（AC-1、AC-3、AC-4）。
- [x] 2. **原子应用与持久化**：`historyStore.applySentenceSplits` 一次撤销快照、字词 `sentenceId` 迁移、EDL 不变；`applySentenceSplitsWithPersistence` 保存失败回滚；架构测试覆盖撤销/重做、冲突、失败回滚（AC-2、AC-3、AC-7、AC-8）。
- [x] 3. **界面与状态**：`useSentenceSplits` + `SentenceSplitPanel`，入口、空态、限制、字数设置、逐段编辑、保留原文、应用中、已完成、版本过期、失败重试；中英文文案（AC-1、AC-2、AC-5–AC-8）。
- [x] 4. **端到端与证据**：`tests/e2e/features/F-0020.spec.ts` 覆盖中英文 × 明暗主题、主要状态与截图，`pnpm e2e:evidence F-0020` 产出证据；Red check 撤掉词覆盖校验或 stale 比较后测试必须失败（AC-5–AC-9）。
- [x] 5. **回归与真实验证**：`pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`、`pnpm test`、`pnpm test:architecture`、`cargo check`；用真实长口播项目（或 demo 素材 ASR 后）在三种画幅下检查超长句、断句、撤销、重开；缺真实桌面环境时写 Not run（AC-4、AC-9）。

## 验证计划

- **单测/架构测试**（`tests/architecture/sentence-splitting-f0020.test.ts`，`pnpm test:architecture`）：
  - AC-1：中文长句按句末标点/逗号/停顿/字数上限拆分；每段字数 ≤ 上限（尾段合并例外 ≤ 上限 + 2）；英文按词边界；不伪造时间。
  - AC-3：每段时间在原句范围内、顺序有效、`wordIds` 覆盖原句全部词且不重复；应用后字词 `sentenceId` 指向新句、EDL 与 `deletedWordIds` 不变；已翻译/关键词/配音句不生成建议。
  - AC-4：无 `wordIds` 的句子跳过并计数；时间不合规的词整句跳过，不进入建议。
  - AC-7/AC-8：保存成功才完成；保存失败回滚句段、字词与撤销栈；分析后字幕变化返回 `stale`。
  - Red check：撤掉「`wordIds` 覆盖校验」后重复/丢词用例失败；撤掉 stale 比较后过期用例失败。
- **界面 E2E**（`tests/e2e/features/F-0020.spec.ts`，`pnpm test:e2e tests/e2e/features/F-0020.spec.ts`）：mock Host 构造空态、无字词、长句建议、跳过计数、逐段编辑空值报错、保留原文、应用中、保存失败重试、保存成功「已完成」、版本过期提示；中英文 × 明暗主题，`shot()` 截图。
- **真实使用**（AC-4、AC-9）：用真实长口播素材跑一次 ASR，打开断句面板，在 16:9 / 9:16 / 1:1 三种画幅检查超长句、断句、撤销与重开；桌面端优先，Web 复用同一 Host。没有真实素材/模型时在测试报告写 `Not run` 及原因，不用 mock 代替。
- **全量回归**：`pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`、`pnpm test`、`pnpm test:architecture`、`cargo check --manifest-path src-tauri/Cargo.toml`。

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | 字数上限、断点优先级、只按词边界切，清单 1、3 |
| AC-2 | 原文/建议对照、逐段编辑、保留原文、确认前不改正式数据，清单 1、3 |
| AC-3 | 应用时原子替换、字词归属迁移、EDL/译文映射不变、stale 拦截，清单 1、2 |
| AC-4 | 无可靠时间不拆分、时间校验、真实长口播三画幅验证，清单 1、5 |
| AC-5 | 工具栏入口、空态、无字词提示，清单 3、4 |
| AC-6 | 应用中禁用重复提交、旧视频隔离，清单 3、4 |
| AC-7 | 保存确认后才显示完成、重开一致，清单 2、4 |
| AC-8 | 失败原因/重试/返回、保存失败回滚、版本过期，清单 2、3、4 |
| AC-9 | 中英文 × 明暗主题 E2E、截图录屏、真实环境或 Not run，清单 4、5 |

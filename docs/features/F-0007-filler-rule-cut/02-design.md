---
id: F-0007
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-09
---

# F-0007 去口癖规则层：技术设计

本设计把去口癖限定为「可核验的规则建议 + 人工确认」：规则只读已经转写出的句子与字词，不分析音频、不猜测未被 ASR 转写的声音，也不把「就是 / 那个 / 然后」这类有语义用途的词按词表直接删除。分析在前端用 shared 纯函数完成，Host 的编辑插件适配同一份核心供 Workflow / Agent 使用；所有建议先进入临时层，确认前不写正式 EDL、不进入项目、恢复副本或导出。

F-0005 的 EDL、持久历史、字幕 deleted 投影和恢复副本格式不变。本设计只新增共享的待确认建议契约和 F-0007 的规则层，不新增项目格式版本，也不新增 RPC。

## UI / UX

### 入口与组件

入口放在字幕编辑器右侧栏，位于 **CutHistoryPanel** 下方、字幕列表上方的新 **EditingSuggestionsPanel**。它是一个可收起的行：默认显示「去口癖 / Remove fillers」；有分析结果或待确认批次时展开候选列表。这样入口和候选列表、播放器、时间轴共用同一份 store 状态，不需要在 SubtitleList 再放一个会丢失上下文的按钮。

组件关系：

- **SubtitleEditorPanel**：挂载 **CutHistoryPanel** 和 **EditingSuggestionsPanel**，继续把 videoPlayerRef 传下去；updating 时保持现有 inert 行为。
- **CutHistoryPanel**：只保留操作历史、加载/回退/错误；原来内嵌的 pendingCuts 摘要移到共享候选面板，避免两套待确认 UI。
- **EditingSuggestionsPanel**：F-0007 的入口、分析状态、门禁状态、候选列表、预览/试听/应用/取消。候选列表由通用 **PendingSuggestionsList** 渲染，F-0006 复用同一组件和同一 store 契约，只换入口和参数。
- **PendingSuggestionsList**：逐条 checkbox、类别、原因、起止时间、标签、需复核标记、拒绝、试听；全选、全不选、按类别选择；整轮预览和应用。
- **SubtitleList / SubtitleItem**：不新增第二套候选交互；字幕列表仍负责校对和手工删除，F-0007 不把候选选择混进字幕多选状态。
- **TimelineWaveform**：读取选中建议区间，画红标、图标和「待确认删除 / Pending deletion」；悬停和键盘聚焦显示原因。
- **EnhancedVideoPlayer**：读取正式 EDL、整轮预览 EDL 和单条试听 EDL；预览/试听只影响播放派生状态，不改正式 EDL。
- **src/locales/filler.ts**：F-0007 新文案、类别和原因标签集中在这里，沿用 edl.ts 的按语言取 copy 的写法；必需的 AC 文案与 edlCopy 已有文案保持完全一致，不复制出第二份不同措辞。

### 状态

| 状态 | 触发与行为 | 界面 | 写入正式数据 |
|---|---|---|---|
| closed | 未打开面板 | 一行「去口癖 / Remove fillers」入口 | 否 |
| gate-blocked | 点击入口后字词时间戳门禁不通过 | 显示 AC-1 原文；不开始分析；不出现可点击的应用按钮 | 否 |
| analyzing | 门禁通过，异步规则分析运行中 | 显示「正在查找口癖… / Finding fillers…」和取消 | 否 |
| error | 分析抛异常（非取消） | 显示「分析失败，请重试 / Analysis failed. Try again.」、重试、取消 | 否 |
| empty | 分析完成且 0 条候选 | 显示「没有发现可剪除的口癖 / No removable fillers found」；不显示应用按钮；可重新分析 | 否 |
| results | 有候选 | 候选列表、选择/分类/拒绝、预览、试听、应用、取消 | 否，直到确认 |
| stale | 分析后正式 EDL、字幕文本或字词层变化 | 列表禁用，显示「建议已过期，请重新分析 / Suggestions are outdated. Analyze again.」，提供重新分析/取消 | 否 |
| applying | 点击应用并等待本地提交/Host 保存 | 禁用重复应用、checkbox、预览和导出；显示「正在应用… / Applying cuts…」 | 本地提交后才会 |
| apply-failed | 校验、提交或保存失败且已回滚 | 显示「应用失败，请重试 / Cannot apply cuts. Try again.」，保留候选与原剪辑 | 否，保留原正式数据 |
| all-dismissed | 用户拒绝最后一条候选 | 显示「已拒绝全部建议 / All suggestions dismissed」；可重新分析或关闭 | 否 |
| cross-kind | 已有另一种 kind 的待确认批次时再次启动分析 | 显示「先应用或取消当前待确认建议 / Apply or cancel the current pending suggestions first」；不替换旧批次 | 否 |

分析取消和迟到结果都只丢弃本地分析状态，不写 store。切换视频、返回项目或卸载编辑器时 AbortController 取消；即使回调已经排队，也用 runId 丢弃。

### 候选列表

每行显示：

- 左侧 checkbox；默认按规则给出的 selected，但不会自动应用。
- 触发文本 label（例如「嗯」「那个那个」）；过长时截断，title 和 aria-label 保留完整文本。
- 类别徽标：「独立语气词 / Standalone filler」或「叠词卡顿 / Repeated word」。
- 原因：独立语气词为「前后有停顿或标点的独立语气词 / Standalone filler between pauses or punctuation」；叠词为「相邻重复的词，只建议剪掉前一次 / Adjacent repeated word; only the earlier repetition is suggested」。
- 起止时间，使用 formatTimeWithMs，显示为 00:00:01.234 – 00:00:01.456。
- 低置信度或叠词显示「需复核 / Review」徽标；不显示百分比，避免把未经验证的置信度说成准确率。
- 「试听 / Audition」和「拒绝 / Reject」。

列表头部显示「已选 {selected}/{total} / {selected} of {total} selected」和「预计减少 {duration} / Removes {duration}」。预计时长按选中区间的并集计算，重叠不重复扣。全选/全不选只作用于当前批次；按类别按钮是切换式：点「独立语气词」选中该类全部，再点一次取消该类。拒绝会从当前批次移除该条，不修改字幕正文、deleted 标记或正式 EDL；重新分析可能再次发现它，这是预期行为。

### 预览与试听

整轮预览：面板提供「预览剪辑效果 / Preview proposed cuts」和「当前已确认版本 / Current confirmed cuts」。打开预览时 pendingSuggestions.preview 为 true，播放器 activeEdl 使用正式 EDL 加所有 selected 区间；只使用 selected，不使用未选项。播放器显示「预览，尚未应用 / Preview, not applied」。关闭预览回到正式 EDL。正式 EDL、字幕 deleted、项目保存和导出都不变。

单条试听：每行「试听 / Audition」进入单条模式，时间轴只给该条一个试听焦点标记；面板出现「剪前 / Before cut」「剪后 / After cut」「停止试听 / Stop audition」。剪前使用正式 EDL，剪后使用正式 EDL 加这一条；两条都从候选前约 2 秒开始播放到候选后约 2 秒，不重新识别、不重新上传。试听与整轮预览互不覆盖：试听时优先使用单条 EDL；停止试听后回到之前的整轮预览状态。取消选择或拒绝正在试听的条目会立即清除试听并恢复保留区间。

### 时间轴标记

TimelineWaveform 读取 selectedRanges（选中建议的并集），每个区间画红色块、警示图标和「待确认删除 / Pending deletion」。宽度不足时至少保留图标，aria-label 和悬停/聚焦浮层仍包含完整文字、类别、原因和起止时间。红标只代表临时层；正式 EDL 的删除段仍按现有 F-0005 样式显示。历史版本预览打开时隐藏待确认红标，避免把历史 EDL 与本轮建议混在一起；关闭历史预览后恢复。

### 应用

应用按钮文案按 kind 区分：filler 使用 AC-6 的「应用选中建议 / Apply selected suggestions」；silence 沿用 F-0005 的「确认剪辑 / Confirm cuts」，避免改变已验收行为。以下情况禁用应用：0 条 selected、分析中、stale、updating、没有 batch、门禁 blocked。提交期间禁用重复按钮、checkbox、分类、预览和试听。

一次确认只产生一个 EDL 快照和一条 cutHistory 记录。选中区间有重叠或相邻时，摘要旁显示「重叠建议会合并为一次剪切 / Overlapping suggestions are applied as one cut」，确认时只按并集扣一次。成功后清空 batch、preview、audition，撤销可恢复整轮；失败时保留候选和原正式剪辑，不写成功历史。保存结果不确定时先按 F-0002 的读回核验；已写入 Host 就按成功处理，未写入且本地状态未变化才回滚，避免把已保存的结果误报为失败。

### 文案

| key / 状态 | 中文 | English |
|---|---|---|
| entry | 去口癖 | Remove fillers |
| finding | 正在查找口癖… | Finding fillers… |
| cancel | 取消 | Cancel |
| retry | 重试 | Retry |
| analyzeAgain | 重新分析 | Analyze again |
| analysisFailed | 分析失败，请重试 | Analysis failed. Try again. |
| empty | 没有发现可剪除的口癖 | No removable fillers found |
| wordGate | 缺少可靠字词时间戳，无法精确剪除口癖 | Reliable word timestamps are required to cut fillers precisely. |
| wordGatePartial | 部分字幕缺少可靠字词时间戳，已跳过 | Some segments lack reliable word timestamps and were skipped |
| stale | 建议已过期，请重新分析 | Suggestions are outdated. Analyze again. |
| applyFiller | 应用选中建议 | Apply selected suggestions |
| applying | 正在应用… | Applying cuts… |
| applyFailed | 应用失败，请重试 | Cannot apply cuts. Try again. |
| allDismissed | 已拒绝全部建议 | All suggestions dismissed |
| alreadyApplied | 这些建议已经应用 | These suggestions are already applied |
| crossKind | 先应用或取消当前待确认建议 | Apply or cancel the current pending suggestions first |
| selectedCount | 已选 {selected}/{total} | {selected} of {total} selected |
| estimated | 预计减少 {duration} | Removes {duration} |
| selectAll | 全选 | Select all |
| selectNone | 全不选 | Select none |
| categoryStandalone | 独立语气词 | Standalone filler |
| categoryRepeat | 叠词卡顿 | Repeated word |
| reasonStandalone | 前后有停顿或标点的独立语气词 | Standalone filler between pauses or punctuation |
| reasonRepeat | 相邻重复的词，只建议剪掉前一次 | Adjacent repeated word; only the earlier repetition is suggested |
| review | 需复核 | Review |
| audition | 试听 | Audition |
| beforeCut | 剪前 | Before cut |
| afterCut | 剪后 | After cut |
| stopAudition | 停止试听 | Stop audition |
| auditioning | 正在试听… | Auditioning… |
| reject | 拒绝 | Reject |
| previewCuts | 预览剪辑效果 | Preview proposed cuts |
| currentCuts | 当前已确认版本 | Current confirmed cuts |
| previewNotice | 预览，尚未应用 | Preview, not applied |
| pending | 待确认删除 | Pending deletion |
| overlap | 重叠建议会合并为一次剪切 | Overlapping suggestions are applied as one cut |
| hint | 确认前不会修改项目、字幕或导出 | Nothing in the project, subtitles, or export changes until you apply |
| close | 关闭 | Close |

AC-1、AC-3、AC-4、AC-5、AC-6、AC-7 的中英文必须与 01-spec 完全一致；表中已经照抄，实施时直接使用，不再改写。silence 的列表类别显示「停顿 / Pause」，原因显示「超过阈值的空白 / Gap above threshold」，应用按钮沿用 edlCopy.apply。

## 技术方案

### 涉及的子系统

- shared/editing：规则核心、字词门禁、待确认建议类型、字词投影。
- src/stores/historyStore.ts：pendingSuggestions、选择/预览/试听/确认/取消/过期。
- src/components/SubtitleEditor、src/components/Timeline、src/components/VideoPlayer、src/locales：入口、列表、时间轴、播放器、文案。
- src/types/plugin.ts、shared/protocol.ts、server/plugins/editing.ts、server/plugins/langgraph.ts、server/profile.ts：编辑器插件、Workflow / Agent 适配。
- docs/subsystems/frontend.md、docs/subsystems/cordis-host.md：实现后更新 pendingSuggestions 和 remove-fillers 的说明。
- 不改 Tauri、sidecar、ASR Provider、项目格式或导出协议。

### 总流程

1. 用户点击「去口癖」。EditingSuggestionsPanel 从 historyStore 取当前 chunks、wordChunks、hasWordTimestamps、正式 EDL 和 sourceDuration，先用 shared 的 inspectFillerGate 做同步门禁。
2. 门禁 blocked：只显示 AC-1 文案，不启动分析，不生成候选。
3. 门禁通过：记录当前 editRevision 作为 base，启动可取消的异步规则分析；分析期间只改本地 phase，不写 historyStore。
4. 分析完成：把 FillerCandidate 映射成 CutSuggestion，调用 proposeSuggestions 写入 pendingSuggestions；默认 selected 由规则给出，preview 为 false。
5. 用户勾选、按类别选择、拒绝、试听、整轮预览；这些只改 batch 或临时播放状态。
6. 用户点击应用：historyStore 校验 base、ID、时间范围和 selected，计算选中区间并集，原子提交正式 EDL（filler 同时做字词投影）和一条 cutHistory；UI 负责 Host 保存和失败回滚。
7. 确认前后，editingOf、项目保存、恢复副本、字幕导出、视频导出都只读正式 EDL，不读 pendingSuggestions。

### 1. shared 纯规则分析器

新增 **shared/editing/fillerRules.ts**，不依赖 src，不读 DOM、音频、网络或模型。输入是当前转写和正式 EDL 的删除区间，输出是门禁结果、候选和统计。

主要类型：

~~~ts
export type FillerCategory = 'standalone-filler' | 'repeated-word';
export type FillerReason = 'filler.standalone' | 'filler.repeated';

export interface FillerRuleInput {
  chunks: Array<{ id: string; text: string; timestamp: [number, number]; deleted?: boolean;
    wordIds?: string[]; edlWordProjection?: boolean }>;
  wordChunks?: Array<{ id: string; text: string; timestamp: [number, number];
    sentenceId?: string; deleted?: boolean }>;
  hasWordTimestamps?: boolean;
  sourceDuration: number;
  existingDeleted?: Array<{ start: number; end: number }>;
}

export interface FillerCandidate {
  id: string;
  sentenceId: string;
  wordIds: string[];
  start: number;
  end: number;
  tokenStart: number;
  tokenEnd: number;
  label: string;
  category: FillerCategory;
  reason: FillerReason;
  confidence: number;
  defaultSelected: boolean;
}
~~~

导出 inspectFillerGate、analyzeFillerSentences、analyzeFillers 三个入口：inspectFillerGate 只做门禁并返回每个句子的 eligible/skip 原因；analyzeFillerSentences 只分析指定句子，供前端分批让出主线程；analyzeFillers 串起两者，供 Host 插件、测试和离线批处理使用。三者共享同一份规则，不允许在 src 或 server 再写一份词表或边界判断。

**字词表与语义保护。** 核心独立语气词表为：嗯、啊、呃、额、唔、唉、哎；边缘表只放哦，置信度更低。就是、那个、然后、这个、所以、但是、其实、还有等有语义用途的词永远不进入独立语气词表，单个出现时绝不生成候选。只有重复出现（如「那个那个」）才可能进入叠词候选。英文语气词、未转写出的呼吸/停顿/笑声不在本需求范围。词表是可审阅的常量，修改必须同时更新测试和验收记录。

**独立语气词。** 一个词要成为独立语气词候选，必须同时满足：

1. 规范化后的文本恰好等于词表中的一项，不能是更长词的一部分；例如「好啊」被 ASR 切成「好」「啊」时，「啊」不是独立语气词。
2. 该词在句子文本中的字符位置满足左右边界证据：左侧是句子开头、空白或标点，或者与前一个活跃词的间隔至少 80ms；右侧是句子结尾、空白或标点，或者与后一个活跃词的间隔至少 80ms。两侧都要有证据。
3. 该词不是已删除词，所在句子不是已删除句，且不在正式 EDL 已删除区间的完整覆盖内。

这个边界条件比单纯词表匹配保守：ASR 没有标点、词间也没有可测停顿时，宁可不报，也不把句末语气词或构词成分剪掉。句首独立语气词默认 selected=true；句内和句末独立语气词默认 selected=false，显示「需复核」。边缘表一律不默认选中。

**叠词卡顿。** 同一句内相邻两个活跃词规范化后相同，且满足以下条件时生成一条候选：

- 词的规范化长度至少 2 个字符；或者该词本身是上面的语气词表成员（用于「嗯嗯」这类由两个单字词组成的重复）。单字普通词不生成，避免把「看看」「试试」这类正常重叠当成口误。
- 两个词之间没有超过 250ms 的间隔，且时间不倒序。间隔更大时可能是刻意重复，不生成候选。
- 连续重复三次及以上时合并成一条：删除最后一个之前的所有重复词，保留最后一个。
- 候选 label 是整段重复文本（如「那个那个」），category 为 repeated-word，reason 为 filler.repeated，confidence 为 0.55；如果重复词是「那个 / 这个 / 就是 / 然后」等高频口头词，confidence 为 0.65。全部默认 selected=false，因为叠词只能作为候选，不能断言一定是口误。
- 只生成一条区间：从第一个重复词开始（含安全 padding），到最后一个重复词的 start 结束；这样保留最后一个词，避免把正常语义重复也剪掉。

**安全 padding。** 候选不能切入相邻发音。对每个候选，取前一个和后一个活跃词（可跨句）的时间，lead = min(40ms, max(0, gapBefore/2))，tail = min(40ms, max(0, gapAfter/2))。如果相邻词与候选之间没有间隙，padding 为 0。重复词候选只在最左侧加 lead，右边界停在保留词的 start，不向保留词内部扩。所有时间以整数微秒计算，输出时转成秒并四舍五入到微秒，避免不同调用点重复舍入。

**不推断未转写声音。** 规则只遍历 wordChunks 和句子文本，不做 VAD、音频能量、停顿检测或声学模型推断。ASR 没转写出的「嗯」不会因为音频里有停顿就被当成口癖；反过来，音频里没有但 ASR 幻觉出的词仍会按文本候选，最终由用户试听确认。

**输出稳定。** 候选按 start、sentenceId、wordIds 排序；id 使用 sentenceId + wordIds + category + startUs/endUs 的确定性字符串，便于测试和选择状态。label 是原始触发文本。统计包含 standalone/repeated 数量、建议总秒数（区间并集）、跳过句数和跳过原因。

### 2. 字词时间戳门禁

AC-1 要求只有通过校验的字词时间戳才能生成可执行精确候选。门禁分两层：全局层决定是否允许开始分析；句子层决定哪些句子可以产生候选。这样一条用户改过文本的句子不会让整段 60 分钟素材全部不可用，但任何句子都不会在不可靠的时间戳上生成精确剪切。

**全局层输入：**

- hasWordTimestamps 必须为 true。
- wordChunks 非空，chunks 非空。
- 每个句子有非空 wordIds；每个 word 有唯一 id、非空 text、有限 timestamp、sentenceId 指向存在的句子。
- word 的 timestamp 在 [0, sourceDuration] 内，start < end，且落在所属句子区间 ±20ms 内。
- 同一句内 word 的 start 不倒退；相邻 word 的重叠不超过 20ms；没有重复 id 或孤儿 word。
- 每个句子的 wordIds 覆盖它自己的全部 word，没有跨句复用。

**句子层文本重建：**

- 如果句子没有已删除词且 edlWordProjection 不为 true，比较 plain(joinWordTexts(全部 word 文本)) 与 plain(句子文本)；两者必须一致。
- 如果句子有已删除词或 edlWordProjection 为 true，比较 plain(joinWordTexts(仍活跃 word 文本)) 与 plain(句子文本)；两者必须一致。
- plain 去掉空白和 Unicode 标点，保留文字。这样 ASR 标点、英文空格和用户校对过的标点不会误伤；但用户改写了句意或字数导致无法和字词对应时，该句被跳过，不用按字数猜时间。

**句子层时间可信度：**

- 任一活跃 word 的时长小于 20ms 或大于 3s，标记 implausible-duration，跳过该句。
- 相邻活跃 word 重叠超过 20ms，标记 overlap，跳过该句。
- 至少 4 个活跃 word 时，如果每个 boundary 都等于句首 + i × 句长/n（误差 5ms 内），且词间没有真实间隙，标记 synthetic-timing，跳过该句。这是对「按字数均分时间」的防御：均分数据看起来结构完整，但不能用于精确剪切。
- 所有 word 时长在 2ms 内相同且词间总间隙小于 2ms 时，也标记 synthetic-timing。
- 全句只有一个 word 时不适用均分检测；仍要求它在句内且时间有效。

**结果状态：**

- 全局层失败：gate.ok=false，原因 missing-word-timestamps 或 no-valid-sentences；UI 只显示 AC-1 文案，不生成任何候选，不回退整句删除。
- 全局层通过但部分句子失败：gate.ok=true，eligibleSentences 正常分析，skippedSentences 计入统计；UI 显示「部分字幕缺少可靠字词时间戳，已跳过 / Some segments lack reliable word timestamps and were skipped」，仍可对合格句子应用。
- 没有任何 eligible 句子：按全局失败处理，显示 AC-1 文案。
- 正式 EDL 已完全覆盖的候选跳过；部分重叠允许，确认时并集。

**它不能证明什么。** 这些检查只能证明时间戳结构自洽、文本能对应、不是明显均分伪造；F-0001 已确认没有独立字词时间真值，不能据此宣称 ±毫秒准确率。因此仍然保留安全 padding、默认保守选择、单条试听和人工确认，验收报告只记录实测误报/漏报和听感，不编造准确率。

### 3. 跨 F-0006 / F-0007 的共用待确认建议契约

这是 F-0006 和 F-0007 共同使用的唯一 shape；F-0006 的设计和实现必须引用本节，不能另造 pendingRanges、pendingSilence 或第二套字段。

~~~ts
export type SuggestionKind = 'silence' | 'filler';

export interface CutSuggestion {
  id: string;
  start: number;
  end: number;
  reason: string;
  category?: string;
  label?: string;
  confidence?: number;
  selected: boolean;
}

export interface SuggestionBatch {
  kind: SuggestionKind;
  base: string;
  preview: boolean;
  items: CutSuggestion[];
}
~~~

**存放位置。** 类型和 selectedRanges、suggestionSummary 等纯 helper 放 shared/editing/suggestions.ts；historyStore 只保存一个 pendingSuggestions: SuggestionBatch | null。pendingCuts 从 state 移除；需要旧 ranges 视图的调用方和测试改用 selectPendingRanges(state)，它返回：

~~~ts
{ ranges: Array<{ start: number; end: number }>; base: string; preview: boolean } | null
~~~

ranges 是 selected 条目的区间并集，不是原始 item 数组。这样时间轴、播放器和旧 F-0005 测试拿到的都是不会重复扣时的视图。

**store 行为。**

- proposeSuggestions(batch)：校验 kind、base、items 的 id 唯一、时间有限且 end > start；只保存临时层，不写 EDL。已有同 kind 批次时，新分析成功后才替换；已有不同 kind 批次时拒绝并返回 cross-kind，UI 显示对应文案。proposeCuts 同样受 cross-kind 约束，避免 smart cut blank 静默覆盖口癖批次。
- proposeCuts(ranges)：F-0005 兼容入口，生成 kind='silence'、全部 selected、reason='silence'、category='silence' 的 batch；smart cut blank 和 F-0006 都走这一入口或 proposeSuggestions。proposeCuts 同样受 cross-kind 约束；SubtitleList/FlyCutCaption 的 smart cut 调用方捕获后显示 crossKind 文案，不静默覆盖当前批次。
- toggleSuggestion / setCategorySelected / rejectSuggestion：只改 items 的 selected 或移除 item；不改 EDL、chunks、wordChunks、cutHistory。拒绝当前试听条目时同时清 audition。
- previewPending(preview)：只改 batch.preview；false 时回到正式 EDL。preview 只使用 selected 条目。
- auditionSuggestion(itemId, mode)：只写临时 audition 状态，不进入 batch、不持久化；filler 面板用它做剪前/剪后单条试听。停止或取消选择时清除。
- cancelPending：清空 batch、preview、audition 和 suggestionError；不改正式剪辑。
- confirmPending：见下一节；只应用 selected，原子提交，一条 history。

**base 与过期。** historyStore 增加 editRevision，只在正式数据变化时递增：setTranscript、commit、undo/redo、restoreHistory、文本编辑、删除/恢复、EDL 变化。batch.base 存 String(editRevision)。confirmPending 先比较 base 与当前 editRevision；不一致直接返回 stale，不应用。选择、预览、试听、拒绝只改临时层，不递增 revision。用 revision 而不是每次序列化整段 chunks，避免 60 分钟项目在每次勾选时做 O(n) 比较。

**确认语义。**

1. 没有 batch 或 updatingCuts 时返回 false。
2. base 不一致：suggestionError='stale'，preview=false，audition=null，正式数据不动。
3. selected 条目为 0：返回 false，不报错；UI 禁用按钮。
4. 逐条校验 id 在当前 batch 中、start/end 有限、start >= 0、end <= sourceDuration、end > start；任一条非法则整批失败，不部分应用。
5. 计算选中区间并集；用 changeCuts 生成候选 EDL，validateEdl 通过后才提交。
6. kind='filler' 时在同一提交内做字词投影（见下一节）；kind='silence' 不改字词 deleted。
7. commit 记录一条 cutHistory，kind 为 'filler' 或 'silence'；baseline 仍按 F-0005 的规则。没有净变化时不新增记录，清空 batch 并显示 alreadyApplied。
8. 成功后清空 batch、preview、audition、suggestionError；失败保留 batch 和原正式数据。

**UI 与时间轴。** 两种 kind 共用 PendingSuggestionsList：每项 checkbox、reason/category/label/start-end、拒绝；时间轴只标 selected 区间的红标和图标/文字；播放器 preview 只使用 selected；未确认 batch 不进入正式 EDL、字幕投影、项目保存、恢复副本或导出。PendingSuggestionsList 根节点保留 data-testid="cut-suggestions"，时间轴标记保留 data-testid="pending-cut"，减少 F-0005 E2E 选择器迁移；新增逐条项用 data-testid="pending-suggestion-item"。选择、预览、试听、拒绝只改临时字段，不改变 edl/chunks/wordChunks/cutHistory，因此不会触发 projectService 的自动保存或恢复副本记录器。F-0006 可以有不同的入口、参数和候选生成，但必须复用这些字段、selectedRanges、confirmPending 和列表行为。

### 4. 应用、字幕投影与历史

F-0007 的确认不仅删音频区间，还要让字幕投影与之一致。CutSuggestion 不增加 wordIds 字段，保持共用契约不变；filler 批次在确认时按区间覆盖关系做字词投影：

1. 对每个 selected 区间并集，找出 timestamp 完整落在区间内的活跃 word。安全 padding 被限制在词间空隙里，正常不会完整覆盖非目标词。
2. 把这些 word 标记 deleted；保留原 id、原时间、原 sentenceId。原始 ASR 文本仍在项目转写记录里，不在这一步销毁。
3. 对受影响句子，复用 historyStore 现有 syncWords 的匹配规则：只有当前句子文本等于「投影前活跃词拼接」或 edlWordProjection 为 true 时，才用剩余活跃词重建 text；否则保留用户校对文本，避免覆盖校对。
4. 句子所有 word 都被删时 chunk.deleted=true；仍有活跃词时 chunk.deleted=false。secondText 不逐词猜测、不自动重译；跨区间时沿用 F-0005 的句子译文复制策略。
5. 以上 EDL、chunks、wordChunks、cutHistory 在同一个 commit 中写入，undo 一次恢复整轮。

如果某个 selected 区间没有完整覆盖任何 word，只写 EDL，不改字词；这在理论上只会出现在异常数据中，仍比猜测安全。silence 批次保持 F-0005 行为，只写 EDL 和空白投影，不做字词 deleted。

持久历史沿用 F-0005：一次确认一条 CutRecord，deletedIds/deletedWordIds 反映投影结果；重开后 CutHistoryPanel 可预览/回退，回退不撤回后来文字校对。未确认 batch 不进入 editingOf、项目格式、恢复副本、字幕导出或视频导出。

保存事务复用并抽出 CutHistoryPanel 现有的 flushCuts 逻辑：

- 本地 confirmPending 成功后，updatingCuts=true，禁止再次应用/编辑/导出。
- 有项目 owner 时调用 ctx.projects.flush()，失败时按 F-0002 读回核验。
- 已写入 Host：按成功处理，清空 batch。
- 未写入且本地状态仍等于 applied 快照：恢复 before 快照（含 editRevision、EDL、chunks、wordChunks、cutHistory、undo/redo、pendingSuggestions、audition），preview=false、audition=null、suggestionError='apply-failed'，显示 AC-7 文案；不留下成功历史。
- 若期间已有其他编辑或切换了视频：不回滚别人的状态，保留当前结果并显示项目保存错误。
- 没有项目 owner（纯本地演示/测试）时只做本地原子提交。

### 5. 前端分析与组件行为

新增 **src/services/fillerAnalysis.ts**：从 historyStore 构造 FillerRuleInput，调用 shared 的 inspectFillerGate 和 analyzeFillerSentences。分析在 setState('analyzing') 之后至少等一个 requestAnimationFrame 再开始，保证 AC-3 的加载态真实可见；每 200 个句子或每 8ms 让出一次主线程，检查 AbortSignal。取消、切视频、卸载都会 abort；runId 不匹配的迟到结果直接丢弃。分析不写 historyStore，成功后才 proposeSuggestions。

**EditingSuggestionsPanel** 持有本地 phase、runId、analysisStats、notice；historyStore 只持有 batch、preview、audition、suggestionError 和 editRevision。面板关闭不取消正在进行的分析；切换视频/卸载才取消。重新分析同 kind 时保留旧 batch 直到新结果成功；跨 kind 直接显示 cross-kind，不启动。

**TimelineWaveform** 使用 selectPendingRanges(state) 计算红标；每个标记是一个可聚焦元素，带 AlertTriangle 图标和「待确认删除」文字；悬停/聚焦浮层显示类别、原因、label 和起止时间。红标宽度按并集计算，重叠不画两次。历史预览打开时隐藏待确认红标。

**EnhancedVideoPlayer** 的 activeEdl 优先级为：historyPreview，其次 audition（单条剪前/剪后），其次 pendingSuggestions.preview，最后正式 edl。audition 和 preview 都只派生播放 EDL；正式 edl 不变。播放器暴露 setPreviewMode(on) 供面板在试听/预览时强制进入剪辑后视图；试听定位使用现有 seekTo，不重新识别。预览/试听徽标显示「预览，尚未应用」。开始本轮试听、整轮预览或应用前清除 historyPreview；历史版本预览期间建议列表只读，避免把历史 EDL 和本轮建议混用。

**文案和主题。** 新文案放 src/locales/filler.ts，明暗主题使用现有 aimu-* / semantic token；红标用 destructive/aimu-coral 语义色，不写死十六进制。所有新增状态在 zh/en、light/dark 下都要有截图证据。

### 6. Host 编辑插件、Workflow 与 Agent 适配

新增 **remove-fillers** 编辑器插件，和 delete-silence 并列注册。客户端 UI 不通过 RPC 调用它；它只让 Workflow / Agent 和将来的外部编辑消费者复用同一份 shared 规则。server/plugins/editing.ts 负责注册，server/profile.ts 的 BUILTINS 增加 editing-remove-fillers（位于 editing 之后），PROFILES 的 desktop/web/headless/server 自动包含；没有本地路径或安全面，不需要 profile 关闭项。

EditorAnalysisInput 做最小扩展，所有新字段可选，现有 deleteSilencePlugin 和调用方无需改：

~~~ts
export interface EditorAnalysisInput {
  chunks: Array<{
    id?: string;
    text?: string;
    timestamp: [number, number];
    deleted?: boolean;
    wordIds?: string[];
    edlWordProjection?: boolean;
  }>;
  wordChunks?: Array<{
    id: string;
    text: string;
    timestamp: [number, number];
    sentenceId?: string;
    deleted?: boolean;
  }>;
  hasWordTimestamps?: boolean;
  totalDuration?: number;
}
~~~

EditorRange 增加可选 category、label；EditOperation 增加可选 category、label、confidence；PipelineResult.cuts 增加同样的可选字段，并增加 warnings?: Array<{ stepId: string; code: string }>。这些都是向后兼容的协议扩展，不新增 RPC、不改 RPC 方法名。

- langgraph 的 analyze 节点改为传完整的 chunks、wordChunks、hasWordTimestamps、totalDuration；remove-fillers 插件调用 analyzeFillers，把 FillerCandidate 映射成 EditorRange（start/end/reason/category/label/confidence），buildOperations 映射成 delete-range。
- 门禁 blocked 时插件返回空 ranges，metadata 带 wordGate 和统计；langgraph 把它转成 warnings（如 filler-word-timestamps-unavailable），Agent 因此能区分「没有口癖」和「没有可靠字词时间戳」。
- builtinAgentToolsPlugin 的 transcribe_audio 增加可选 fillers: boolean；为 true 时附加 remove-fillers step，threshold 仍只控制 silence。Agent 只返回建议，不应用；现有 system prompt 已要求不声称已应用。
- editing.list 自动列出新 manifest；不需要新的 RPC。Workflow 返回的 cuts 仍需用户在前端确认后才会进入 EDL。

### 接口与数据

| 层 | 变更 |
|---|---|
| shared/editing/suggestions.ts | 新增 SuggestionKind、CutSuggestion、SuggestionBatch、selectedRanges、suggestionSummary；不持久化。 |
| shared/editing/fillerRules.ts | 新增纯规则、门禁、候选、统计；不依赖 src。 |
| shared/editing/fillerProjection.ts | 新增按删除区间做字词投影的纯函数；供 historyStore 和测试使用。 |
| src/stores/historyStore.ts | pendingCuts 改为 pendingSuggestions；新增 editRevision、suggestionError、audition；新增 toggle/category/reject/preview/audition/confirm 兼容层。 |
| src/services/fillerAnalysis.ts | 新增可取消、可让出主线程的客户端分析；只调用 shared 核心。 |
| src/services/cutPersistence.ts | 抽出 flushCuts/verify 读回逻辑，历史回退和建议应用共用。 |
| src/components/SubtitleEditor/EditingSuggestionsPanel.tsx | 新增入口、分析状态、候选列表、预览/试听/应用。 |
| src/components/SubtitleEditor/PendingSuggestionsList.tsx | 新增共用候选列表；F-0006 复用。 |
| src/components/SubtitleEditor/CutHistoryPanel.tsx | 移除 pendingCuts 摘要，保留历史；使用抽出后的保存 helper。 |
| src/components/Timeline/TimelineWaveform.tsx | selected pending 红标、图标/文字、焦点浮层、历史预览隐藏。 |
| src/components/VideoPlayer/EnhancedVideoPlayer.tsx | activeEdl 增加 pending/audition；setPreviewMode；预览徽标。 |
| src/locales/filler.ts | 新增 F-0007 文案、类别、原因；AC 文案与 edlCopy 一致。 |
| src/locales/edl.ts | cutKindLabel 增加 filler（去除口癖 / Remove fillers）；既有 silence/undo/restore 标签不变。 |
| src/types/plugin.ts | EditorAnalysisInput/EditorRange/EditOperation 可选字段。 |
| shared/protocol.ts | PipelineResult.cuts 可选字段和 warnings。 |
| server/plugins/editing.ts、server/profile.ts、server/plugins/langgraph.ts | 注册 remove-fillers；传 wordChunks；Agent 增加 fillers 参数。 |

不修改 shared/projects.ts、shared/editing/edl/index.ts 的 schema、项目格式、恢复副本 schema 或 export.start 协议。

### 备选方案与取舍

| 选定 | 备选 | 理由 |
|---|---|---|
| shared 纯核心 + 前端分析 + Host 插件适配 | 只在前端实现；或只走 Host RPC | 离线可用、UI 即时；Workflow/Agent 复用同一规则；代价是两处适配和契约测试，但不会出现第二套词表。 |
| 两侧边界证据 + 安全 padding | 词表命中即删；或按标点直接删 | 避免把「好啊」的「啊」、句末语气词和构词成分剪掉；代价是召回降低，宁缺毋滥。 |
| 全局结构门禁 + 逐句可信度 | 全部通过或全部禁用 | 一条用户改过的句子不会让整段不可用；坏句不产生精确候选；全局无合格句时仍显示 AC-1 文案。 |
| 叠词默认不选中 | 所有候选默认选中 | 叠词可能是正常重复，先让用户确认；独立句首语气词仍默认选中，保证常用路径少点一次。 |
| 一次确认同时做 EDL 和字词投影 | 只写 EDL，字幕保持原样 | 只写 EDL 会让剪掉的「嗯」仍留在字幕里；同一提交投影能保持字幕/音频一致，并保留用户校对。 |
| 主线程分批让出 | Web Worker | 60 分钟约一两万词，纯函数足够快；分批就能满足取消和加载态，避免 Worker 的构建/通信复杂度。 |
| 一次只保留一个 batch | 按 kind 并行保留多个 batch | 避免 silence 和 filler 的重叠确认、过期基准互相影响；代价是用户要顺序处理，但语义清楚。 |
| 建议不持久化 | 建议写入项目 | 符合 AC-9 和 decisions：未确认建议不产生正式历史/导出变化；重开后重新分析即可。 |

## 架构决策

复用 [ADR-0005](../../20-architecture/adr/0005-unified-edit-decisions.md) 的 EDL、整数微秒、持久历史和字幕投影决定。本设计不改变 EDL schema、项目格式或导出协议，因此不新增 ADR，也不创建第二套时间映射。待确认建议是纯内存层，不属于项目格式；如果实现中发现必须持久化建议或新增 RPC，先停下来提维护者确认，不在本需求里顺手改共用契约。

## 自行决定的事项

- 规则表只放嗯/啊/呃/额/唔/唉/哎，哦为边缘项；就是/那个/然后/这个/所以/但是/其实/还有等只在重复时作为叠词候选，单次出现绝不因词表删除（AC-2）。
- 独立语气词要求两侧边界证据：句子边缘/标点/空白，或至少 80ms 词间停顿；句首核心语气词默认选中，句内/句末和边缘项默认不选中（AC-2、AC-10）。
- 叠词只处理多字词或语气词成员，间隔不超过 250ms，连续三次以上合并；全部默认不选中，只作为候选（AC-2）。
- 安全 padding 为每侧最多 40ms，且不超过相邻间隙的一半；不切入相邻词（AC-10）。
- 门禁分全局和逐句两层；部分句子不可靠时跳过并提示，而不是整段禁用；无任何合格句时显示 AC-1 文案（AC-1、AC-3）。
- 用 editRevision 作为 batch.base，避免每次勾选都序列化整段转写；选择/预览/试听不算正式编辑（AC-6）。
- 确认 filler 时同时做字词投影，保持字幕与音频一致；silence 不投影字词（AC-8）。
- 单条试听与整轮预览分离：试听使用单条 EDL，预览只使用 selected；两者都不改正式 EDL（AC-5）。
- 一次只保留一个 kind 的 batch；跨 kind 启动分析先要求应用或取消（AC-7、AC-9）。
- 分析至少等一帧再开始，并分批让出主线程，保证取消和加载态可测；不为了显示加载态人为拖慢分析（AC-3）。

## 风险与回退

- **漏报**：边界条件保守，没有标点/停顿的句中语气词可能不报。验收记录漏报样本；只有证据支持时才调整阈值或词表，不能为了召回把语义词加进词表。
- **误报**：句末「啊」「哦」、强调语气和正常叠词可能被列为候选。通过默认不选中、需复核徽标、试听和拒绝降低伤害；任何默认选中候选如果切到非目标词，视为验收失败。
- **时间戳精度不足**：门禁只能证明结构自洽，不能证明毫秒级准确；F-0001 没有独立时间真值。保留 padding、试听和人工确认，报告不写虚构准确率。
- **字幕预览不一致**：确认前字幕仍按原转写显示，音频预览会跳过候选；确认后字词投影才更新字幕。若验收发现预览阶段字幕与音频差异明显，先在播放器层做只读 cue 投影，不写 store、不改正式字幕。
- **切点听感**：本需求不做音频淡入淡出；只通过安全 padding 和试听控制。若出现明显 click 或吞字，记录样本并回到 F-0006/导出切点平滑范围讨论，不在 F-0007 偷改导出。
- **保存回滚竞态**：保存失败时只在本地状态仍等于 applied 快照且 owner 未变时回滚；否则保留当前结果并显示项目保存错误，避免覆盖其他窗口或后续编辑。
- **性能**：60 分钟、两万词级别目标为 analyzeFillers 200ms 内完成、单次 UI 让出不超过 50ms；若超过，先剖析再做 Worker 或索引优化，不用半更新状态换速度。
- **回退方案**：移除入口和 remove-fillers 注册即可停止暴露功能；pendingSuggestions 从不持久化，不需要数据迁移。F-0005 的 EDL/历史不受影响；如果共享契约迁移出问题，可用 proposeCuts 兼容层临时恢复 silence 行为。

## 实现清单

- [x] 1. **共享建议契约与 store 迁移**：新增 shared/editing/suggestions.ts；historyStore 用 pendingSuggestions 替换 pendingCuts，加入 editRevision、selectPendingRanges、toggle/category/reject/preview/audition/confirm/cancel/stale；proposeCuts 保留 silence 兼容；一次确认只写一条 cutHistory；更新 F-0005 旧测试到派生 ranges（AC-4、AC-6、AC-7、AC-9）。
- [x] 2. **规则核心与门禁**：新增 shared/editing/fillerRules.ts 和 fillerProjection.ts；实现词表、边界证据、叠词、安全 padding、逐句门禁、synthetic-timing 检测和字词投影；纯函数单测覆盖正反例、非法输入和确定性（AC-1、AC-2、AC-8、AC-10）。
- [x] 3. **客户端分析与入口状态**：新增 fillerAnalysis 服务和 EditingSuggestionsPanel；接 historyStore，实现 analyzing/cancel/error/retry/empty/gate/partial-gate/cross-kind；文案集中到 src/locales/filler.ts（AC-1、AC-3、AC-10）。
- [x] 4. **候选列表与选择**：PendingSuggestionsList 显示 checkbox、类别、原因、起止、label、需复核；实现全选/全不选/按类别/拒绝；预计时长按并集计算；确认前不写 deleted（AC-2、AC-4、AC-6、AC-8）。
- [x] 5. **时间轴与播放器预览**：TimelineWaveform 画 selected 红标、图标/文字、hover/focus 原因；EnhancedVideoPlayer 支持 pending/audition EDL、单条剪前/剪后、整轮预览和未应用徽标；取消/拒绝恢复保留区间，不重新识别（AC-4、AC-5、AC-7）。
- [x] 6. **原子应用与保存回滚**：confirmPending 校验 ID/时间/base、selected 并集、幂等；filler 同提交投影字词；提交期间禁用重复操作；Host 保存失败读回核验并在未保存且状态未变时回滚、保留候选、显示 AC-7 文案、不写虚假历史；撤销恢复整轮（AC-6、AC-7、AC-8、AC-9）。
- [x] 7. **Host 插件与 Workflow/Agent 适配**：扩展 EditorAnalysisInput/EditorRange/EditOperation/PipelineResult；注册 remove-fillers；langgraph 传 wordChunks 和 warnings；transcribe_audio 增加 fillers；返回 category/label/reason/confidence，不自动应用、不新增 RPC（AC-2、AC-10）。
- [x] 8. **验收与证据**：新增 tests/e2e/features/F-0007.spec.ts 覆盖所有状态、明暗、中英文；两段 F-0001 原始口播逐条误报/漏报/切点听感；离线、真实导出、撤销/重开、性能和 Not run 记录；更新 frontend/cordis-host 子系统说明和 screenshots/recordings（AC-1–AC-10）。

## 验证计划

- 每项提交跑对应静态检查：pnpm lint、pnpm tsc -b --noEmit、pnpm check:host、cargo check --manifest-path src-tauri/Cargo.toml。全量测试跑 pnpm test、pnpm test:architecture；涉及前端交互追加 pnpm build。
- 新增 tests/architecture/filler-rules-f0007.test.ts 覆盖：句首/句内/句末独立语气词、好啊不误删、那个单次不生成、那个那个生成且默认不选、嗯嗯两词重复、看看/试试单字重叠不生成、250ms/80ms 边界、连续三次重复、padding 不切入相邻词、已有删除覆盖、部分重叠、确定性 ID、空 wordChunks、重复 id、孤儿 word、倒序、越界、重叠、文本不一致、synthetic-timing、字词投影、译文保留。
- 新增/改造 suggestions store 测试覆盖：pendingSuggestions shape、selectPendingRanges、proposeCuts 兼容、全选/分类/拒绝、preview 只取 selected、audition 临时层、stale revision、非法 ID/时间不部分应用、重叠并集、重复确认不二次扣时、一次确认一条历史、undo、cancel、editingOf 不包含建议、恢复副本/导出不受影响。
- Red check 至少做以下几条：撤掉 text-mismatch 门禁后，已校对句子仍生成候选，测试必须失败并指出该句；撤掉边界证据后「好啊」产生候选，测试失败；撤掉 selected 过滤后未选区间被扣时，测试失败；撤掉 stale revision 后文本编辑仍可应用，测试失败；撤掉字词投影后确认结果字幕仍含「嗯」，测试失败；撤掉保存回滚后保存失败仍留下新 EDL 和成功历史，测试失败。每条都要证明是行为断言失败，不是编译失败。
- tests/e2e/features/F-0007.spec.ts 按 AC 命名，覆盖：AC-1 门禁、AC-2 类别/语义词、AC-3 分析中/取消/失败/空结果、AC-4 列表与时间轴红标/焦点原因、AC-5 单条试听和整轮预览、AC-6 逐条/分类/应用/过期、AC-7 重叠/提交中/应用失败、AC-8 拒绝/原文媒体不变、AC-9 一条历史/撤销/重开、AC-10 离线。用 mockHost + 生成的小视频或真实短素材；分析中状态用延迟 requestAnimationFrame 的 addInitScript 构造，不增加生产调试 RPC；错误和保存失败用 page.route 构造。
- 每个新增界面状态在 zh/en、light/dark 各截一张图；运行 pnpm e2e:evidence F-0007 生成 screenshots/ 和 recordings/。截图文件名体现状态和主题，报告链接到证据。
- 真实使用：在 pnpm dev 的 Web 模式连接同一 Host，导入短中文口播，点击去口癖，逐条试听、按类别选择、应用、撤销、导出 MP4/SRT，确认音频切口、字幕文本和同步；不配置任何模型 API，确认规则分析仍可用。桌面端 pnpm tauri:dev 走同一流程；如果环境不具备，报告里写 Not run 和原因。
- 使用 docs/test-media.md 的 F-0001 两段已确认原始口播 external/coscup-BWgFrY91F_I.mp4 和 external/coscup-3UegVxMFyeo.mp4（如本地未下载，先 pnpm fetch:test-media 或按清单手动获取）。对两段的每条候选逐条试听并记录：clip、候选数、独立/叠词数、默认选中数、接受/拒绝数、误报、漏报（对照 F-0001 已确认参考文本）、切入非目标词次数、切点听感。任何默认选中候选切入非目标词都算失败，必须修规则后重跑；不预设未经维护者确认的准确率门槛，只报告实测值。
- 60 分钟性能：用 10000–20000 词的字幕/字词 fixture 测 inspect+analyze、一次选择切换、一次确认和 undo；记录硬件、词数、耗时。目标为 analyzeFillers 200ms 内、单帧让出不超 50ms；超出时先剖析，不通过显示半更新状态达标。
- 所有检查按 code-standards 的 Verification 格式写进 commit；未执行的列 Not run，例如 Windows 打包、未下载的桌面环境或不具备的模型 Provider。已知 F-0001 没有独立字词时间真值、F-0002 保存失败读回等既有边界，不在报告里冒充已验证。

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | 字词时间戳门禁的全局/逐句两层、AC-1 文案、blocked 状态、无整句删除回退；清单 2、3 |
| AC-2 | 词表与语义词保护、两侧边界证据、叠词规则、只读 wordChunks、不推断未转写声音；清单 2、4、7 |
| AC-3 | 分析中/取消/失败/空结果状态、AbortController/runId、至少一帧再分析；清单 3 |
| AC-4 | 候选列表字段、checkbox/类别/原因/时间、时间轴红标/图标/文字/焦点浮层、确认前不写 deleted；清单 1、4、5 |
| AC-5 | 单条剪前/剪后试听、整轮预览、预览未应用提示、取消恢复保留区间、不重新识别；清单 5 |
| AC-6 | 逐条/分类选择、应用选中建议、ID/时间/base 校验、stale 文案；清单 1、4、6 |
| AC-7 | 重叠并集、重复确认幂等、提交中禁用、应用失败文案、保留候选/原剪辑、保存回滚、无虚假历史；清单 1、6 |
| AC-8 | 拒绝不改源文本/剪辑、译文不逐词猜测、原 ID/原媒体保留、不按字数均分；清单 2、4、6 |
| AC-9 | 一次确认一条历史、立即撤销、重开可预览/回退、未确认建议不持久化/不导出；清单 1、6、8 |
| AC-10 | 两段 F-0001 真实口播、离线无模型 API、误报/漏报/切点听感记录、危险候选不默认可应用；清单 2、7、8 |

本需求依赖 F-0005、F-0001 已完成；设计阶段已核对当前实际接口。实现阶段如果发现需要改 F-0005 的 EDL/历史格式、引入第二套 pending 契约或新增 RPC，先停止并回到维护者确认，不直接在本需求里扩大范围。

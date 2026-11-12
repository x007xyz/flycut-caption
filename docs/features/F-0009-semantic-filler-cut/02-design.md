---
id: F-0009
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-12
---

# F-0009 去口癖语义层实现：设计

## UI / UX

现有“去口癖 / Remove fillers”按钮和规则候选流程不变：点击后仍在本地运行 F-0007，不要求模型，也不因模型失败而被阻断。旁边新增“语义去口癖 / Semantic fillers”入口，只有用户显式开始分析时才允许发送转写文本。

新增的语义流程放在 EditingSuggestionsPanel 内，复用 PendingSuggestionsList、historyStore.pendingSuggestions、时间轴红标、播放器试听/预览、确认保存与剪辑历史。预检使用组件内的语义区域，不新建第二套候选 store。

| 状态 | 用户看到什么 | 可执行动作 |
|---|---|---|
| no-model | AC-1 文案；“去口癖”规则入口仍可用 | 打开 AI 设置后返回 |
| word-gate / no-window | 字词时间戳不可用时明确禁用语义分析；没有易混窗口时显示空结果 | 继续使用规则层或普通编辑 |
| preflight | Host 当前选中的目标模型名称/模型 ID、发送的句数和词数、批次总数；说明只发送文本、编号和必要上下文，不上传媒体。远程 Host 额外说明字幕文本会经该 Host 发送到目标上游模型；API Key 由 Host 在本地解析，不进入浏览器 RPC | 开始分析、取消、打开 Host AI 设置更换默认配置 |
| running | 总批次数、已完成数、当前批次；取消按钮 | 取消，成功后保留已完成批次 |
| review | 每条显示原文、类别、原因、high/medium/low 可信等级、规则/语义来源；语义候选默认不勾选；重叠范围来源分别可见、合并扣时只算一次 | 勾选/全不选、按类别选择、单条剪前/剪后试听、临时预览、应用、拒绝 |
| partial | 成功建议 + 失败/无效/取消批次数量；“重试失败批次 / Retry failed batches”只重跑失败或无效批次 | 重试、继续审核成功建议、取消整个待确认层 |
| invalid | “分析结果无效 / Invalid analysis result”；不创建部分候选 | 重试该批 |
| empty | “没有发现可剪除的语义口癖 / No contextual fillers found” | 重新分析或关闭 |
| stale | “建议已过期，请重新分析 / Suggestions are outdated. Analyze again.”；语义/混合候选的应用按钮禁用 | 重新分析；规则候选的既有行为保留 |
| applying | 禁用重复提交，保留候选直到保存成功 | 等待；失败后可重试 |
| save-failed | 保留旧候选与正式项目，显示应用失败 | 重试保存或取消 |

所有新增文案走 src/locales/filler.ts，明暗主题使用现有 aimu CSS 变量。时间轴红标增加可访问的“规则 / 语义”来源文字与图标，不以颜色作为唯一信息。候选的 confidence 只显示 high/medium/low，不换算成百分比或概率。

## 技术方案

### 涉及的子系统

已按 AGENTS.md 阅读 docs/subsystems/frontend.md、cordis-host.md、providers.md、docs/architecture-current.md、docs/decisions.md、F-0007 设计/验收报告及 F-0008 已确认调研报告。依赖门禁：F-0007 04-test-report 与 F-0008 02-research 均已 approved。

### 方案

**1. 规则层保持原样，语义层是可选 pass**

shared/editing/fillerRules.ts、规则门禁、规则候选选择/默认勾选、规则 UI 均保持现有行为。语义入口单独触发，先生成规则建议，再对模型返回的语义建议合并；模型失败不会清空或替换规则建议。规则分析无模型时可继续使用。

**2. 共享返回契约和窗口构造**

新增 shared/editing/semanticFillers.ts，移植 F-0008 实验协议的 TypeScript 版本，定义类别 contextual-filler、repetition、self-correction、fragment，scope word/sentence，confidence high/medium/low，以及带词 ID 的窗口与候选类型。

从 chunks/wordChunks 建立权威字词索引；只对含易混话语标记、相邻重复、改口提示或明显残句的连续句子生成窗口。每窗最多 20 个目标句，前后各带 1 个上下文句，上下文词 deletable=false。已有 EDL 删除覆盖的句子不进入目标，避免对旧剪辑重复提建议。整个分析各批使用同一 base；base 用浏览器 Web Crypto 对 version、EDL、chunks、wordChunks 的规范化 JSON 计算 SHA-256。原文、字词时间戳、媒体时长或正式 EDL 变化都会使 base 不同。

发给模型的用户载荷只包含句子 ID/文本、词 ID/文本、deletable 和 opaque base，不含时间戳、媒体路径或整份项目。文本明确标为 untrusted，系统提示声明转写内指令不是模型指令。

**3. Host 文本任务与严格校验**

server/plugins/text.ts 增加 text.suggestCuts RPC，并在 shared/protocol.ts 声明。请求只携带 Host AI 配置的 configId 和一个 SemanticWindow；Host 在 job 内通过 ctx.aiSettings.resolve(configId) 读取已保存模型和密钥，再调用现有 OpenAI 兼容文本引擎。前端、RPC、job 输入和公开快照都不接收或转发明文 Key。不增加 Provider role、模型设置或收费服务切换。

Host 在成为候选前调用 shared validator，整批严格拒绝：未知/重复/反向/越界/不连续 ID、跨句 word scope、整句伪装为 word scope、删空半句、批量合并后空句、重叠、重复范围、空/超长原因、未知类别或不合法 confidence、超限候选。结构合法但 candidates 为 [] 是“未发现候选”，与缺失字段/坏 JSON/坏 base 的 invalid 区分。时间只由 Host 从字词表派生，模型提供的任何时间字段不予采用。

语义请求错误只返回脱敏后的 HTTP 状态或固定错误码；不把 API Key、响应体里的字幕内容或整段输入写入 job error。Host 在候选中生成稳定 suggestionId；模型错误、取消、运行中重启均不写正式项目。已合入的 F-0056 负责 Host 元数据、系统凭据/远程加密 secret、revision、迁移和 text/Agent 的 configId 解析；本需求直接复用，不改变其已验收行为。

**4. 客户端批次编排**

src/services/semanticFillerAnalysis.ts 负责窗口构造后的逐批 RPC（只传 configId 与窗口）、进度回调、AbortSignal 取消和失败分类；src/hooks/useSemanticFillerAnalysis.ts 保存一次分析的 runId、base、批次状态和成功结果。目标配置来自 F-0056 的 Host 快照，必须同时匹配当前 Host identity；每一批独立 job，便于失败批次只重试自身。

开始后只有当前 runId 且 base 仍一致的响应可进入结果；取消会 abort waitJob/job，并丢弃迟到响应。成功批次保留；failed/invalid 批次单独标注。重试仅取 failed/invalid 批次，并保留成功批次。最后把所有成功批次加规则建议合并，通过 historyStore.proposeSuggestions 进入唯一临时层。

**5. 来源合并、人工确认与过期**

CutSuggestion 只做向后兼容扩展：可选 source、sources、semanticCategory、semanticReason、semanticConfidence、scope、wordIds。SuggestionBatch 增加可选 origin。规则候选原字段与行为不变；语义候选默认 selected=false。

相同精确范围跨规则/语义来源时合并成一条，sources 显示 rule+semantic，保留规则已有选择状态，避免重复删除。部分重叠仍列出两个来源，selectPendingRanges 继续做非重叠并集，预计时长和 EDL 不重复扣除。来源相同的重复范围由 Host validator 整批拒绝。

确认仍调用 historyStore.confirmPending：先复核 batch.base，再一次性写 EDL、字词删除投影和一条持久剪辑历史，无空白占位行。拒绝/取消只清临时层。临时预览与试听不改正式 EDL，正常导出不包含 pendingSuggestions。重开历史预览/回退完全复用 F-0005/F-0007，不新增项目格式，也不回滚之后完成的文字校对。

**6. 过期与错误呈现**

语义或混合 batch 将当前 base 与 batch.base 比较。不一致时直接显示 stale、禁用应用与试听预览的临时切换，候选项保留供用户理解，允许关闭并重新分析。规则-only batch 保留 F-0007 在确认时报告 stale 的既有路径，避免改变已验收行为。保存失败保留 batch 和正式项目。

### 接口与数据

| 层 | 接口/变化 | 兼容性 |
|---|---|---|
| shared/editing/semanticFillers.ts | 窗口、候选、base、validator、窗口选择、规则/语义合并纯函数 | 新增，无 Host 本地路径 |
| shared/editing/suggestions.ts | CutSuggestion/SuggestionBatch 只加可选字段 | 既有 silence/rule 数据无需迁移 |
| shared/protocol.ts | text.suggestCuts schema（configId + SemanticWindow）、RpcMethods 与结果类型 | 新 RPC；text.start 保持兼容 |
| server/services.ts | TextService 增加 suggestCuts | 既有 start 保留 |
| server/plugins/text.ts | 注册 text.suggestCuts，job 内通过 ctx.aiSettings.resolve(configId) 取配置并执行 Host validator | 不改 Gateway/Tauri，不向 RPC 暴露 Key |
| shared/text/OpenAICompatibleEngine.ts | 新增语义提示/调用，错误正文不进入可持久错误 | 纠错/翻译路径行为不变 |
| src/services/semanticFillerAnalysis.ts | 逐批调用、取消、错误分类 | 只通过 ctx.connection |
| src/hooks/useSemanticFillerAnalysis.ts | runId/base/批次状态/重试 | 每次 ClientRuntime 独立 |
| src/stores/historyStore.ts | 仅必要时扩展临时 batch 元数据，确认仍走 confirmPending | 不持久化候选，不改项目格式 |
| src/components/SubtitleEditor/EditingSuggestionsPanel.tsx | 语义入口、预检、进度、失败状态 | 规则按钮不变 |
| src/components/SubtitleEditor/PendingSuggestionsList.tsx | 来源、语义类别/原因/可信信息、语义过期禁用 | 规则候选默认展示保持 |
| src/components/Timeline/TimelineWaveform.tsx | 现有红标增加来源文字/图标 | 不改变待删区间计算 |
| src/locales/filler.ts | 中英文全部 AC 文案 | 主题无关 |

请求/结果核心语义：

- SemanticWindow: version=1、base、language、target.startWordId/endWordId、sentences[id,text,words[id,text,deletable]]、policy。
- SemanticCandidate: suggestionId、startWordId/endWordId、wordIds、scope、category、reason、confidence、startMs/endMs（Host 派生）。
- RPC 输入：{ configId, request: SemanticWindow }；RPC 返回 JobSnapshot；job result 为 { version:1, base, promptVersion, candidates }。configId 指向 F-0056 的 Host AI 设置。
- 不修改 shared/projects.ts、项目格式、EDL schema、恢复副本或 export.start。

### 备选方案与取舍

| 选定 | 备选 | 取舍 |
|---|---|---|
| 词 ID 连续区间 + Host 校验 | 模型返回秒数或全文替换 | 时间戳必须来自权威字词；模型返回的时间不可信 |
| 规则保留、语义显式可选 | 自动把全部文本交给模型 | 降低外发范围、成本和误删面；规则离线仍可用 |
| 每窗一个 Host job，客户端顺序编排 | 一个长 job 包全部窗口 | 批次进度、失败重试、取消范围更清楚；多几个 RPC |
| 语义候选默认不勾选 | 按 confidence 自动勾选 | F-0008 未给出类别质量门槛，不伪造默认安全值 |
| 精确重复合并、部分重叠只提示一次扣时 | 所有重叠自动删成并集 | 保留来源和解释，用户仍能逐条选择 |
| 新增 text.suggestCuts | 扩 text.start mode 或新建 Provider 角色 | 输入输出差异大，独立 schema 更严格；仍按 configId 复用 F-0056 Host 配置 |

## 架构决策

新建 [ADR-0010 语义剪辑建议使用词 ID 范围并由 Host 校验](../../20-architecture/adr/0010-semantic-cut-word-ranges.md)，状态 proposed，待维护者随 F-0009 验收时确认。ADR 编号避开其他未合入分支已占用的 0007–0009。

## 自行决定的事项

- 语义入口与规则入口分开，保证 AC-1 的规则层可用且不在用户未请求时外发文本（AC-1、AC-2）。
- 语义窗口只覆盖易混句，最多 20 个目标句并带同句上下文；这是 F-0008“只分析规则无法判断窗口”的直接落地，质量/召回范围仍需真实评测（AC-2、AC-10）。
- 所有语义候选默认不勾选，confidence 只作可信等级展示；调研没有提供类别默认开启依据（AC-5、AC-8）。
- 精确同范围跨来源合并，部分重叠保留两条并按并集计一次时长（AC-5、AC-8）。
- 远程 Host 通过连接来源识别并说明文本外发路径；配置与 Key 只由 F-0056 的 Host AI settings 管理，语义 RPC 只传 configId（AC-2、AC-9）。
- 语义/混合候选的 stale 状态在列表内直接可见并禁用应用；规则-only 保持既有确认时文案（AC-7）。

## 风险与回退

- F-0008 没有语义质量和真实模型数据，因此本需求只能验收协议、校验、失败、人工确认和真实接线，不能宣称误删率或默认类别可用。真实 API/两段原始口播的质量验收若无法执行，必须在 04 标 Not run。
- 配置和 Key 的保存、迁移、系统凭据库/远程加密文件和 revision 冲突由已验收 F-0056 负责；F-0009 若绕过 ctx.aiSettings.resolve 直接读文件或继续传旧 model 字段，会破坏该边界，禁止这样做。
- 字词时间戳缺失、句子/词文本不一致或旧 EDL 覆盖窗口时宁可不出语义候选，不用句级猜测替代精确剪切。
- 模型输出格式不稳定时严格整批失败；用户仍可使用规则层，成功批次保留但不冒充全部成功。
- 回退：删除语义入口/RPC 后规则层、项目格式和已有剪辑历史不受影响；已确认剪辑仍由同一 EDL/历史恢复。

## 实现清单

- [x] 1. **规则保留与语义入口**：新增语义按钮、无模型/字词门禁/无窗口状态和模型预检，现有规则按钮及规则分析路径保持不动；补中英文和明暗主题端到端状态（AC-1、AC-2）。
- [x] 2. **共享词 ID 协议与 Host 文本任务**：实现窗口/base/validator/合并纯函数、text.suggestCuts、现有 OpenAI 兼容配置调用和脱敏错误；用合法、未知/重复/越界/不连续/半句/重叠、坏 JSON 与空候选测试（AC-2、AC-4、AC-9）。
- [x] **批次进度、取消、失败重试与过期**：逐批调用、runId/base 丢弃迟到结果、成功/失败/取消计数、只重试失败批次、语义 stale 禁用应用（AC-3、AC-7）。
- [x] 4. **候选展示与人工确认闭环**：原文/类别/原因/可信等级/规则与语义来源、红色标记、试听/集合预览、默认不选、精确去重与部分重叠单次扣时、确认/拒绝/保存失败，并验证正常导出不含 pending（AC-5、AC-6、AC-8）。
- [x] 5. **历史、隐私与真实环境验收**：重开/历史回退不撤文字校对、错误/日志无 Key/完整字幕、两个真实转写窗口与本地真实 HTTP Host 验证、桌面/Web 同 Host 记录；生成截图和测试报告（AC-9、AC-10）。

## 验证计划

- 每项完成运行 pnpm lint、pnpm tsc -b --noEmit、pnpm check:host，并运行对应 node 单元测试与该范围的 architecture 测试；提交前写 Verification，Not run 必须说明。
- 纯协议测试覆盖实验协议的 14 类安全校验、合法空候选、窗口上下文 deletable、精确/部分重叠合并、base 过期和语义候选默认不选。Host RPC 用 F-0056 的 Host AI settings 保存本机真实 HTTP OpenAI 兼容 fixture，再只以 configId 调用 text.suggestCuts，验证 job 结果、严格拒绝、取消，以及 RPC/输入/job 文件不含 Key 或字幕错误正文。
- tests/e2e/features/F-0009.spec.ts 以 AC 编号命名，覆盖 no-model、preflight、远程隐私确认、running/cancel、partial/failed retry、invalid、empty、semantic review、stale、apply/save-failed；明暗主题和中英文各跑一遍并用 shot() 存档。Host 状态用 page.route，正式 EDL 保存仍用现有 mock Host 的保存/读回路径。
- 规则层回归：重跑 tests/filler-rules.test.mjs、F-0007 E2E 和 filler-export architecture test，证明规则候选数量、默认选择与应用结果不变。
- 真实使用：在 pnpm dev 的浏览器连接真实 Host，用本机 OpenAI 兼容 fixture 走预检→两批→取消→重试→预览→确认→保存→重开历史；用 tests/media 两段真实转写构造窗口并记录批次数/词数。外部用户模型质量、桌面 Tauri 实际操作若没有可用配置/环境，明确 Not run。
- 正式导出不含待确认语义标记：确认前导出计划保持正式 EDL；确认后只由 confirmation 生成一次新历史，重复点击不重复扣时。
- 最终固定 commit 上运行 code-standards 第 1、2 条全量命令、pnpm test:e2e、pnpm e2e:evidence F-0009 与 pnpm feature review F-0009；不自行 approve、不 push、不发版。

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | 独立语义入口，无模型文案，规则按钮/分析逻辑保持；清单 1 |
| AC-2 | 预检发送范围与目标配置、媒体不发送、词 ID 协议、远程说明和 configId-only Host 解析；清单 1、2 |
| AC-3 | 每窗 job、进度、取消 runId、部分结果与失败批次重试；清单 3 |
| AC-4 | Host 严格整批 validator、坏结果 invalid、空 candidates 与失败重试；清单 2 |
| AC-5 | 原文/类别/原因/high-medium-low、来源、红标、重叠并集；清单 2、4 |
| AC-6 | 复用单条试听/集合预览、Preview not applied、空状态、正式导出隔离；清单 1、4 |
| AC-7 | SHA base 覆盖原文/时间戳/EDL，迟到与过期结果不可应用；清单 3 |
| AC-8 | 人工复选、confirmPending 原子 EDL+历史、拒绝不改项目、精确去重与保存失败；清单 4 |
| AC-9 | 持久历史/文字校对隔离、F-0056 Host secret 复用、语义错误脱敏、人工确认门禁；清单 2、4、5 |
| AC-10 | 本地真实 Host 接线、两段真实转写窗口、规则回归和未执行质量项如实报告；清单 5 |

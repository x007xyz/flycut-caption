---
id: F-0019
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-13
---

# F-0019 热词与专有名词识别：设计

## UI / UX

### 入口与组件

1. **ASR 识别设置面板热词概览（`src/components/ProcessingPanel/ASRSettingsPanel.tsx`）**：
   - 复用现有播放区下方「选项」中的 `ASRSettingsPanel`（不另建独立页面）。
   - 开始转写前明确展示当前所选模型与当前项目启用的热词摘要：
     - 若当前模型声明支持热词（`model.hotwords?.supported === true`）：显示本次将随转写发送的热词数量与预览标签，以及「管理热词 / Manage hotwords」按钮。
     - 若当前模型不支持热词：明确显示「此模型不支持热词 / This model does not support hotwords」，提供「更换模型 / Change model」快捷入口（跳转设置模型面板或展开模型列表），并保留正常转写能力（用户可继续普通识别，绝不声称热词已生效）（AC-2、AC-3）。
     - 若当前不在项目模式或项目为空：提示「暂无内容 / Nothing here yet」并提供配置/管理入口（AC-5）。
2. **项目热词管理弹窗（`src/components/Project/HotwordsDialog.tsx`）**：
   - 从 `ASRSettingsPanel` 与 `ProjectDetail` 顶栏按钮均可打开，编辑同一份项目级词表（AC-1、AC-5）。
   - **状态覆盖（AC-1、AC-5–AC-8）**：
     - `loading`：显示「正在加载… / Loading…」；请求序号守卫防止切换项目后迟到响应覆盖当前项目（AC-6）。
     - `empty`：词表为空时显示「暂无内容 / Nothing here yet」与新增表单（AC-5）。
     - `editing`：支持新增、行内编辑、删除、启用/停用热词开关、可选权重（仅当模型支持权重或供未来配置，校验正有限数 `0 < weight <= 100`）；空白词、超长词、无效权重与大小写去重冲突就地显示明确错误提示并禁用提交（AC-1）。
     - `saving`：显示「正在处理… / Processing…」，禁用重复提交（AC-6）。
     - `completed`：仅在 Host 返回 `saved` 确认后显示「已完成 / Completed」（AC-7）。
     - `stale`：若 Host 返回版本号冲突，显示「内容已更新，请重新检查 / Content changed. Review again.」，阻止直接覆盖，提供「重新检查 / Review again」刷新最新词表后再决定提交（AC-8）。
     - `error`：显示具体原因与「重试 / Retry」「返回 / Back」，保留用户未保存的输入草稿；若网络异常导致保存结果不确定，重试时先调用 `projects.getTerminology` 核对当前 Host 词表与 `operationId` 再决定是否重发（AC-8）。
3. **转写取消 / 失败保护（AC-4）**：
   - 转写进行中支持取消，取消或转写失败绝不覆盖当前已有的正式字幕内容。

### 状态与 Stores

- 在 `src/stores/projectStore.ts` 的 `CurrentProject` 增加 `terminology: ProjectTermEntry[]`、`terminologyRevision: number`，并在非持久化状态 `hotwordsDialog` 中管理弹窗生命周期与请求序号。
- 在 `src/services/projectService.ts` 提供 `loadProjectTerminology`、`saveProjectTerminology`（含 `operationId` 不确定结果先查后写、版本过期处理与重开读取同步）。
- E2E 中界面状态（loading/empty/validation/saving/completed/stale/error/model-unsupported）通过 `tests/e2e/lib/mockHost.ts` 构造；真实验证使用隔离 Host + HTTP ASR 测试服务 + 真实音频片段实测命中率与误替换对比。

## 技术方案

### 涉及的子系统

- [docs/subsystems/providers.md](../../subsystems/providers.md)：`ModelRef` 与 `ModelInfo` 能力声明、`ProviderRegistry` 校验、`httpProvider.ts`、`endpoints.ts`、`server/plugins/asr.ts`。
- [docs/subsystems/cordis-host.md](../../subsystems/cordis-host.md)：`shared/protocol.ts` RPC 声明、`server/plugins/projects.ts`、`server/plugins/projectOps.ts`、`server/projects/store.ts`。
- [docs/subsystems/frontend.md](../../subsystems/frontend.md)：`ASRSettingsPanel.tsx`、`useASR.ts`、`asrService.ts`、`projectService.ts`、i18n 与明暗主题 E2E。
- [docs/provider-http-protocol.md](../../provider-http-protocol.md)：补充 `ModelInfo.hotwords` 能力字段及与 `options.hotword` 的映射说明。
- [docs/decisions.md](../../decisions.md) 与 [ADR-0003](../../20-architecture/adr/0003-multi-video-projects.md)。

### 方案

1. **共享项目术语契约（`shared/terminology.ts` + `shared/projects.ts`）**：
   - 定义 `ProjectTermEntry`（`id`、`term`、`asHotword`、`weight?`、`translations?`、`updatedAt`）、`normalizeTermKey`、`dedupeProjectTerms` 与校验 schema（空白词、权重 `> 0 && <= 100`、最大词条数 500）。
   - `ProjectFile` 与 `ProjectOpenResult` 携带 `terminology`（缺省 `[]`）及 `terminologyRevision`（缺省 `0`）。
   - Host `projects.ts` 注册 `projects.getTerminology`（只读）与 `projects.saveTerminology`（在项目 write lock 下检查 `baseRevision === project.terminologyRevision`、通过 `operationId` 去重、保留 `translations` 未知语言译名供 `F-0032` 复用）。
2. **Provider 热词能力与网关强制过滤（`shared/providers.ts`、`server/plugins/providers.ts`、`server/providers/httpProvider.ts`、`server/plugins/endpoints.ts`、`server/plugins/asr.ts`）**：
   - `ModelInfo` 新增 `hotwords?: HotwordCapabilities`（`supported`、`weights`、`maxTerms`、`format`）；`AsrRequest` 新增可选 `hotwords?: Array<{ term: string; weight?: number }>`。
   - `sherpa-onnx`（`server/plugins/asr.ts`）：其当前 ONNX `OfflineRecognizer` 配置（SenseVoice/Paraformer/Whisper/Moonshine/FireRedASR）均走 `greedy_search`，不接收热词参数，因此如实声明 `hotwords: { supported: false }`。
   - `httpProvider.ts`：解析 `ModelInfo.hotwords`（若外部 FlyCut HTTP Provider 在 `options` 中声明 `hotword` 而未填 `hotwords` 字段则自动推导为 `{ supported: true, weights: false, format: 'space-separated' }`）；请求发送时按目标模型能力仅透传允许的格式与选项。
   - `endpoints.ts`（OpenAI 兼容服务）：模型可选声明 `hotwords?: boolean`（默认支持将词表编入 Whisper `/audio/transcriptions` 的 `prompt` 字段，不发送权重）。
   - `providers.ts`（`registry.transcribe`）：若 `request.hotwords?.length > 0` 而模型未声明 `hotwords?.supported === true`，直接抛出 `HostRpcError('INVALID_ARGUMENT', ...)`；若模型不支持权重，在进入 Provider 前剥离 `weight`。
3. **客户端与 Host 转写链路按能力条件发送（`src/hooks/useASR.ts`、`server/plugins/projectOps.ts`）**：
   - 客户端 `useASR.ts` 在发起 `workflow.start` 前读取当前选中模型 `ModelInfo`：仅当 `found.model.hotwords?.supported === true` 且项目存在启用的 `asHotword` 词条时才组装 `hotwords`（若不支持权重则剥离 `weight`）；若模型不支持热词，则完全不附带 `hotwords` 字段，并将此信息包含在 `operationKey` 中防止切换词表后复用旧识别缓存。
   - `server/plugins/projectOps.ts` 的 `projects.transcribe` 同理：自动读取项目术语表并仅在模型声明支持时附加 `hotwords`。

### 接口与数据

| 位置 / 方法 | 输入 | 输出 / 语义 |
|---|---|---|
| `shared/terminology.ts` | — | `ProjectTermEntry`、`HotwordCapabilities` 相关校验与去重工具 |
| `shared/providers.ts` | — | `ModelInfo.hotwords`、`AsrRequest.hotwords` |
| `projects.getTerminology` | `{ projectId }` | `{ projectId, revision, terminology }`（加入 `READ_ONLY_RPC_METHODS`） |
| `projects.saveTerminology` | `{ projectId, terms, baseRevision, operationId? }` | `{ status: 'saved', revision, terminology } \| { status: 'conflict', revision, terminology }` |

### 备选方案与取舍

| 方案 | 优点 | 缺点 | 取舍 |
|---|---|---|---|
| **在 `ModelInfo.hotwords` 声明能力并扩展 `ProjectFile.terminology`（选定）** | 不按 `providerId` 硬编码；天然与 `F-0032` 共用实体 | 需更新 `httpProvider`、OpenAI endpoint 与客户端面板 | 采用，写入 ADR-0015 |
| 通过通用 `options.hotword` 字符串拼接保存词表 | 少改字段 | 无法与 `F-0032` 共用结构化词条、无法区分权重与项目作用域 | 不采用 |
| 强行修改 `funasr-asr` Rust sidecar 猜测热词参数 | 想让本地模型也用热词 | SenseVoice/Paraformer ONNX 在 sherpa-onnx `greedy_search` 下不支持该参数，违背「不伪造能力」 | 不采用，待后续确认支持热词的本地模型再声明 |

## 架构决策

[ADR-0015 项目级术语词表与 ASR 热词能力契约](../../20-architecture/adr/0015-project-terminology-and-asr-hotwords.md)（`status: proposed`，验收确认时一并改为 `accepted`）。

## 自行决定的事项

- **实体前向兼容 `F-0032`**：`ProjectTermEntry` 直接预留 `translations?: Record<string, string>`，且 `saveTerminology` 在未提供新 `translations` 时保留已有词条上的译名数据，防止后续与 `F-0032` 互相覆盖。
- **本地 `sherpa-onnx` 模型诚实声明不支持**：经核查 `src-tauri/sidecars/funasr-asr/src/main.rs` 与 `models.json`，当前内置模型均为 `greedy_search` 且未配置热词表/BPE 热词解码，因此明确声明 `hotwords: { supported: false }`，在设置面板与选项面板诚实提示，不伪造生效。
- **任务幂等键包含词表版本**：`useASR` 的 `taskOperationKey` 纳入生效的 `hotwords` 摘要，修改热词后重新识别不会误命中修改前的旧 `operationId`。

## 风险与回退

- **与并发分支的 ADR 编号协调**：本分支本地生成 `ADR-0015`，合入基线时如与其他并行分支（如 `F-0023`/`F-0035`）编号冲突，在集成阶段顺延重命名编号即可。
- **旧项目文件兼容**：`terminology` 与 `terminologyRevision` 均为可选字段，不抬升 `PROJECT_FORMAT_VERSION`，旧项目无须额外迁移脚本。

## 实现清单

- [x] 1. **共享术语实体与 ASR 热词能力契约**：新增 `shared/terminology.ts`，扩展 `shared/projects.ts`、`shared/providers.ts` 与 `shared/protocol.ts`，补充规范化、去重、校验与不支持模型拦截单元测试（AC-1、AC-2、AC-3）。
- [x] 2. **Host 术语存储、Provider 校验与转发通道**：在 `server/projects/store.ts`、`server/plugins/projects.ts` 与 `server/plugins/projectOps.ts` 实现 `projects.getTerminology` / `projects.saveTerminology`（含冲突、幂等、保留 `translations`）与按能力透传；更新 `server/plugins/providers.ts`、`server/plugins/asr.ts`、`server/providers/httpProvider.ts`、`server/plugins/endpoints.ts` 与 `docs/provider-http-protocol.md`；新增架构集成测试与开启/关闭热词的真实接口对比测试（AC-1–AC-4、AC-7、AC-8）。
- [ ] 3. **客户端热词状态、防迟到/重开保持与按能力条件发送**：扩展 `src/runtime/connectionModel.ts`、`src/stores/projectStore.ts`、`src/services/projectService.ts`、`src/hooks/useASR.ts`、`src/components/AgentPanel.tsx` 与 `src/locales/{zh_CN,en_US,types}.ts`（AC-1–AC-8）。
- [ ] 4. **热词管理弹窗与 ASR 设置面板入口**：新增 `src/components/Project/HotwordsDialog.tsx`，接入 `src/components/ProcessingPanel/ASRSettingsPanel.tsx` 与 `src/components/Project/ProjectDetail.tsx`，覆盖全部 AC 界面状态（AC-1–AC-3、AC-5–AC-8）。
- [ ] 5. **E2E 回归、真实对比评测、Red check 与验收报告**：编写 `tests/e2e/features/F-0019.spec.ts`（中英文 × 明暗主题），运行 `PW_PORT=5301 pnpm e2e:evidence F-0019`、真实音频+真实热词对比测试（本地/HTTP/OpenAI 协议）、全量静态与单测回归，产出 `04-test-report.md`（AC-1–AC-9）。

## 验证计划

- **单测与架构测试（`tests/architecture/hotwords-f0019.test.ts`）**：
  - AC-1：新增、编辑、删除、空白词/非法权重拒绝、大小写去重、`baseRevision` 冲突与重开/双客户端读取一致，以及保留既有 `translations` 字段。
  - AC-2 / AC-3：向 `sherpa-onnx`（不支持热词）或未声明支持热词的 HTTP 模型发起带热词 `transcribe` 时，`ProviderRegistry` 明确拒绝且底层 Provider 收到的热词请求数为 0；向声明支持的 FlyCut HTTP / OpenAI-compatible HTTP 模型请求时，仅发送允许字段（不含不支持的权重）。
  - AC-4：启动本地真实 HTTP ASR 服务对同一段含人名/英文术语的测试音频（`tests/media` 口播素材）对比关闭/开启热词的命中率与误替换率，并验证取消/失败不覆盖已有字幕。
  - Red check：撤掉 `ProviderRegistry.transcribe` 的热词能力校验或 `useASR` 的不支持模型过滤后，对应断言立即失败。
- **界面 E2E（`tests/e2e/features/F-0019.spec.ts`）**：
  - 覆盖 `light`/`dark × zh/en`：模型支持热词预览、不支持热词提示「此模型不支持热词 / This model does not support hotwords」及继续普通识别/换模型、空词表「暂无内容 / Nothing here yet」、校验报错、加载「正在加载…」、保存「正在处理…」+「已完成」、冲突「内容已更新，请重新检查」、失败「重试 / 返回」；运行 `PW_PORT=5301 pnpm e2e:evidence F-0019`。
- **全量回归**：`pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`、`cargo check --manifest-path src-tauri/Cargo.toml`、`pnpm test`、`pnpm test:architecture`、`PW_PORT=5301 pnpm e2e:evidence F-0019`。

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | `shared/terminology.ts` 去重校验、`projects.saveTerminology`、`HotwordsDialog` 新增/编辑/删除与就地错误提示，清单 1、2、4 |
| AC-2 | `ASRSettingsPanel` 转写前模型与热词摘要、`ModelInfo.hotwords` 能力驱动过滤、`ProviderRegistry` 校验，清单 1、2、3、4 |
| AC-3 | 不支持模型显示「此模型不支持热词 / This model does not support hotwords」、提供换模型与继续普通识别、0 静默发送，清单 2、3、4 |
| AC-4 | 真实口播片段开启/关闭热词命中率与误替换对比、取消/失败保留原转写，清单 2、3、5 |
| AC-5 | 复用 `ASRSettingsPanel` 与 `ProjectDetail` 入口、空态「暂无内容」、无模型/无项目提示与配置跳转，清单 3、4 |
| AC-6 | 「正在加载…」「正在处理…」、禁重复提交、取消按钮、请求序号防迟到串项目，清单 3、4 |
| AC-7 | Host 确认持久化后提示「已完成」、重开与双客户端读取一致，清单 2、3、4 |
| AC-8 | 失败原因+「重试」「返回」保留输入、不确定先查 Host、版本冲突「内容已更新，请重新检查」，清单 2、3、4 |
| AC-9 | `F-0019.spec.ts` 中英文明暗主题全状态截图录屏 + 真实模型/协议对比实验与 `04-test-report.md`，清单 5 |

---
id: F-0053
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-13
---

# F-0053 TTS Provider能力与接入：设计

## UI / UX

### 入口与组件边界

- 复用现有「设置」弹窗入口（`src/components/Workstation/WorkstationHeader.tsx` 与 `src/components/Project/ProjectsShell.tsx` 打开 `src/components/ProcessingPanel/SettingsDialog.tsx`），不改动 `src/components/ASR/ModelsPanel.tsx` 的 ASR 推荐与下载区块（避免与 F-0018 冲突）。
- 在 `SettingsDialog.tsx` 新增独立导航标签「语音合成 / TTS」（`section === 'tts'`），挂载新组件 `src/components/TTS/TTSSettingsPanel.tsx`，配对新本地化字典 `src/locales/tts.ts`（中英文，依据 `LocaleProvider` 的当前语言切换）及客户端服务 `src/services/ttsService.ts`（挂入 `ctx.tts` 或复用 `useClientRuntime().connection` 封装）。

### 界面状态与文案映射

1. **空态与前置不足（AC-5）**：
   - 初始化拉取 `providers.models` 与 `tts.getSettings`；无可用 TTS 模型（或仅有未下载/不可用模型）时展示「暂无内容 / Nothing here yet」，明确说明缺少支持 TTS 的模型或 HTTP 服务，并提供「去配置模型 / Configure models」按钮直接跳转到 `SettingsDialog` 的 `models` 分区（下载或「添加服务」）。已有项目与字幕编辑完全可用，不受影响。
   - 选择的 TTS 模型若处于 `download` 状态，显示下载按钮（复用 `asr.prepareModel` / `providers.prepare`）与大小；处于 `unavailable` 时展示 `model.reason`。
2. **模型能力展示与参数表单（AC-1、AC-3）**：
   - 按 `ModelRef`（`{ providerId, modelId }`）从 `providers.models` 分组列出所有 `role === 'tts'` 模型，显示所属 Provider 名称、来源标签（内置/服务）与支持语言。
   - 明确展示模型能力限制标签：若 `model.tts?.voiceCloning !== true`，显式显示「不支持声音克隆 / Voice cloning is not supported」；若支持克隆，显示克隆条款（`cloningTerms`）与授权提示；同时展示流式（`streaming`）、语速/时长控制（`durationControl`）和输出格式支持情况。
   - 列出当前模型声明的自带音色（`tts.voices`）、支持语言（`languages`）以及自定义选项（复用 `ModelOptionsForm`）。
3. **声音克隆授权流程（AC-4）**：
   - 仅当当前模型声明 `tts.voiceCloning === true` 时才出现「声音克隆试听（需授权）/ Voice cloning audition (authorization required)」开关；打开后必须上传/选择参考音频（通过 `/assets` 上传并校验非空），并勾选明确的本人授权确认框（文案：「这是我本人的声音，或我已获得说话人授权 / This is my voice, or I have the speaker’s permission」），未勾选时禁止发起克隆请求。
4. **加载、执行中、防重与取消（AC-6）**：
   - 读取模型列表与 Host 设置时显示「正在加载… / Loading…」，禁止同时保存或试听。
   - 保存默认配置或生成试听音频时显示「正在处理… / Processing…」与任务进度，禁用重复提交；试听任务提供「取消 / Cancel」按钮调用 `jobs.cancel`，并清晰标注「取消只停止等待，已发出的外部 HTTP 合成请求可能继续完成 / Cancelling stops waiting; dispatched external requests may finish on the provider」。
   - 通过 `requestEpoch` 与 `expectedHostId` 防护：关闭设置弹窗、切走标签页或切换 Host 后抵达的迟到响应直接丢弃，不覆盖新状态。
5. **正常与持久化（AC-7）**：
   - 「保存默认设置 / Save defaults」发送 `tts.saveSettings`（带 `hostId`、`expectedRevision` 与 `operationId`）；只有在 Host 返回 `status: 'saved'` 后才提示「已完成 / Completed」，且重开设置或第二个连接同一 Host 的客户端调用 `tts.getSettings` 时读到一致的模型、音色、语言、参数与最近试听元数据。
   - 「生成试听 / Audition」提交 `tts.synthesize` 任务，仅在 Host 下载并校验音频格式/时长通过、写入资产并返回 `assetId` 后才提示「已完成 / Completed」，随后通过 `connection.download(assetId)` 生成 `Blob URL` 在内置 `<audio controls>` 播放器播放/停止并展示格式、采样率、字节数与时长。
6. **失败、冲突与重试（AC-8）**：
   - 鉴权失败（401/403）、请求超时、损坏音频、协议不兼容或网络错误时显示具体原因及「重试 / Retry」「返回 / Back」按钮，并完整保留用户已输入测试文本与界面选项，不丢弃已有持久化配置。
   - 保存结果不确定（例如提交 `tts.saveSettings` 时断网/超时）时，界面提示先查询再重发；点击「重试 / Retry」会先调用 `tts.getSettings` 检查 `lastOperationId` 或最新状态与 `revision`，避免盲目重复副作用。
   - 并发修改冲突（Host 返回 `status: 'conflict'`）时提示「内容已更新，请重新检查 / Content changed. Review again.」，展示 Host 最新配置供用户核对；只有用户点击「已核对最新状态 / Acknowledge update」后才允许再次提交保存。

### 端到端测试状态构造

- `tests/e2e/features/F-0053.spec.ts` 使用 `mockHost` 覆盖空态、加载中、正常保存与二次重开/多客户端读取、不支持声音克隆提示、带授权声音克隆请求、取消试听、损坏音频/鉴权失败重试、保存不确定先查后重发、并发 `revision` 冲突（中英文、明暗主题全覆盖）。
- 同时在架构测试 `tests/architecture/tts-f0053.test.ts` 中启动真实 Host + 本地可复现的示例 HTTP TTS 服务验证完整真实链路。

## 技术方案

### 涉及的子系统

- [模型 Provider](../../subsystems/providers.md)（`shared/providers.ts`、`server/plugins/providers.ts`、`server/plugins/endpoints.ts`、`server/providers/httpProvider.ts`、`docs/provider-http-protocol.md`）
- [Cordis / Host](../../subsystems/cordis-host.md)（`shared/protocol.ts`、`server/services.ts`、`server/profile.ts`、`server/plugins/tts.ts`）
- [前端（React / UI）](../../subsystems/frontend.md)（`src/components/ProcessingPanel/SettingsDialog.tsx`、`src/components/TTS/TTSSettingsPanel.tsx`、`src/locales/tts.ts`）

### 方案

1. **扩展 `shared/providers.ts` 能力声明**：
   - 新增 `TtsVoice`、`TtsCapabilities`、`TtsCloneAuthorization`、`TtsRequest` 及对应 Zod schemas。
   - `ModelInfo` 增加可选 `tts?: TtsCapabilities` 字段，`modelInfoSchema` 同步校验 HTTP Provider 返回的 `tts` 能力。
   - 不新增独立 TTS Provider 类或拆分现有后端：`sherpa-onnx` 不支持 TTS 时不实现 `synthesize` 方法；支持多种能力的 HTTP Provider 通过同一个 `Provider` 实例同时返回 `asr` 和 `tts` 模型。
2. **新增 `shared/tts/` 协议与音频校验**：
   - `shared/tts/audio.ts`：零外部依赖校验音频二进制头与完整性（支持 WAV `RIFF/WAVE` PCM/Float chunk 长度与 `durationSeconds` 精确计算、MP3 `ID3`/MPEG 帧同步头、OGG `OggS`、FLAC `fLaC` STREAMINFO），拒绝空数据、HTML/JSON 错误响应、截断帧或 0 时长音频，返回 `{ format, mimeType, byteLength, durationSeconds, sampleRate }`。
   - `shared/tts/settings.ts`：定义 `TtsSettingsSnapshot`、`TtsSettingsSaveInput/Result`（含 `hostId`、`expectedRevision`、`operationId`、`conflict`）、`TtsSynthesizeInput/Result` 契约及 Zod schema。
3. **Host Provider 注册表与 HTTP Provider 协议扩展**：
   - `server/services.ts`：`Provider` 接口新增可选 `synthesize?(request, signal, report)`，`ProviderRegistry` 新增 `synthesize(request, signal, report)`。
   - `server/plugins/providers.ts`：`registry.synthesize` 校验 Provider 是否实现 `synthesize`、目标模型是否存在且 `role === 'tts'` 且 `status === 'ready'`、选项合法性（`checkOptions`）、音色存在性（若非克隆且声明了固定音色）、克隆能力与本人授权声明，并调用 `validateTtsAudio` 校验产物。
   - `server/providers/httpProvider.ts`：支持读取 `/v1/health` 的 `capabilities`（若服务声明了非空 `capabilities` 且不含 `"tts"`，则直接报错拒绝调用）；实现 `synthesize`：
     - 无克隆时向 `POST /v1/tts/jobs` 发送 `application/json`；
     - 克隆时向 `POST /v1/tts/jobs` 发送 `audio/wav` 参考音频字节 + `X-Flycut-TTS-Request`（ASCII 转义 JSON，含 `authorization`）；
     - 复用 `GET /v1/jobs/{id}` 与 `POST /v1/jobs/{id}/cancel`，完成后按同源校验（遵守 `assertServiceUrl` 与 `redirect: 'error'`、带上 Bearer Auth）下载 `result.audioUrl` 并校验音频完整性；明确区分 401/403 鉴权错误、超时错误与响应解析错误，错误文案不回传 Key。
   - `server/plugins/endpoints.ts`：
     - `flycut:<name>` 与 `flycut-cloud` 共用 `createHttpProvider` 自动获得 TTS 能力；
     - `openai:<name>` 在 `endpointInputSchema.models` 支持可选 `role: 'asr' | 'tts'`（默认 `'asr'`）与 `voices?: string[]`、`languages?: string[]`；按实际配置模型角色决定是否暴露 `transcribe` / `synthesize`（不暴露空实现），`synthesize` 请求 `/audio/speech` 并校验返回音频（若请求克隆则明确拒绝）。
4. **Host TTS 插件与持久化（`server/plugins/tts.ts`）**：
   - 在 `server/profile.ts` 的 `BUILTINS` 注册 `tts` 插件（注入 `hostConfig`、`providers`、`jobs`、`assets`、`rpc`）。
   - 在 `<home>/tts-settings.json` 持久化默认 TTS 配置与最近试听摘要，原子写入（同目录临时文件 + `rename`），支持 `expectedRevision` 冲突检测与 `operationId` 去重（保存响应丢失后可先查询再确认）。
   - 注册 RPC：`tts.getSettings`、`tts.saveSettings`、`tts.synthesize`（创建可取消 `Job`，校验音频后写入 `ctx.assets` 返回 `assetId` 与音频元数据）。
5. **协议文档与可复现示例服务端/客户端**：
   - 更新 `docs/provider-http-protocol.md` 完整补充 TTS 协议章节（`capabilities: ["tts"]`、`role: "tts"` 模型结构、`POST /v1/tts/jobs` 常规与克隆请求、`GET /v1/jobs/{id}/audio`、错误码与安全边界）。
   - 新增可独立运行的本地示例 HTTP TTS Provider 服务端脚本 `scripts/examples/tts-provider-server.mjs`（实现 `/v1/health`、`/v1/models`（含固定音色模型与可选授权克隆模型）、`/v1/tts/jobs`、`/v1/jobs/{id}`、`/v1/jobs/{id}/audio`、`/v1/jobs/{id}/cancel`、可选 Bearer 鉴权与真实 WAV 音频生成），供开发者按文档接入与架构测试复现。

### 接口与数据

- **新增 RPC 方法（`shared/protocol.ts`）**：
  - `tts.getSettings`: `void -> TtsSettingsSnapshot`
  - `tts.saveSettings`: `TtsSettingsSaveInput -> TtsSettingsSaveResult`
  - `tts.synthesize`: `TtsSynthesizeInput -> JobSnapshot`（任务结果为 `TtsSynthesizeResult`）
- **`endpointInputSchema.models` 兼容扩展（`shared/protocol.ts`）**：
  - 每个模型项新增可选字段 `role?: 'asr' | 'tts'`（缺省为 `'asr'`）、`voices?: string[]`、`languages?: string[]`，对旧配置 100% 兼容。
- **Host 存储文件**：`<home>/tts-settings.json`（`formatVersion: 1`，含 `hostId`、`revision`、`selectedModel`、`voiceId`、`language`、`speed`、`options`、`lastAudition`、`operations`）。

### 备选方案与取舍

- **TTS 默认配置存在 Host 还是前端 `localStorage`**：选 Host（`tts-settings.json` + `revision`）。理由：满足 AC-7 多客户端读取一致与 AC-8 并发版本冲突、保存不确定先查后重发，并与 `decisions.md`「业务数据由 Host 保存」和 F-0056 一致。
- **HTTP 克隆传参用 `audio/wav` + `X-Flycut-TTS-Request` 还是 `multipart/form-data`**：选前者（常规合成用 `application/json`，带参考样本克隆用 `audio/wav` + `X-Flycut-TTS-Request`）。理由：与 `/v1/asr/jobs`「避免 multipart 依赖」保持一致，不引入服务端解析库；若未来确需 multipart 可向后扩展。
- **OpenAI 兼容服务支持**：在 `endpoints.ts` 通过可选 `role: 'tts'` 复用到同一个 `openai:<name>` Provider 上，不单独拆 Provider，也不暴露无用方法。

## 架构决策

- [ADR-0012 TTS Provider 能力声明与 HTTP 协议契约](../../20-architecture/adr/0012-tts-provider-contract.md)（`proposed`，验收时一并审阅确认）

## 自行决定的事项

1. **设置页内采用独立「语音合成 / TTS」分区而非修改 `ModelsPanel.tsx`**：避免与并行开发中的 F-0018（默认 ASR 模型推荐与下载引导）在同一文件区块产生合并冲突，同时让 TTS 模型查看、音色选择、能力限制提示与单句试听具备完整空间（影响 AC-3、AC-5）。
2. **Host 持久化 `tts-settings.json` 并引入 `operationId` 幂等与 `revision` 冲突检查**：满足 AC-7（重开与多客户端一致）与 AC-8（并发版本过期与不确定保存先查询）（影响 AC-7、AC-8）。
3. **HTTP 协议 `POST /v1/tts/jobs` 采用 JSON（普通）+ `audio/wav` + `X-Flycut-TTS-Request`（克隆）**：与 `/v1/asr/jobs` 避免 multipart 依赖的约定一致，且同时承载完整可核验的 `authorization` 对象（影响 AC-2、AC-4）。

## 风险与回退

- **外部真实引擎未预装风险**：本机环境若无 Kokoro / MeloTTS / CosyVoice / Qwen3-TTS 运行时或 FlyCut Cloud 凭据，不能在沙盒内编造外部试听结果；通过本地可复现 HTTP 示例服务完整验证协议与链路，并在 `04-test-report.md` 如实将真实外部引擎试听标记为 `⏸ Not run` 及阻塞原因。
- **音频格式误判风险**：不同 TTS 引擎输出 WAV header 变体（如 LIST/INFO/fact chunks 或 IEEE float）较多，`shared/tts/audio.ts` 需逐 chunk 扫描 `fmt ` 与 `data` 并兼容常见合法封装，同时严格拦截 HTML/JSON/截断/零时长损坏文件。
- **回退方式**：所有改动集中在新增 `shared/tts/`、`server/plugins/tts.ts`、`src/components/TTS/` 与向后兼容扩展的 `shared/providers.ts` / `httpProvider.ts`，现有 ASR/VAD/项目/导出链路零破坏，可按提交粒度安全回退。

## 实现清单

- [ ] 1. 共享契约与音频校验：扩展 `shared/providers.ts`（`TtsCapabilities`、`TtsVoice`、`TtsRequest`、`TtsCloneAuthorization`）与 `shared/protocol.ts`，新增 `shared/tts/audio.ts` 与 `shared/tts/settings.ts` 及单元测试。
- [ ] 2. Provider 注册表与 HTTP TTS 协议：更新 `server/services.ts`、`server/plugins/providers.ts`、`server/providers/httpProvider.ts` 与 `server/plugins/endpoints.ts`，支持 `capabilities: ["tts"]`、`/v1/tts/jobs`（含克隆授权头、鉴权、超时、取消、同源音频下载与损坏音频拒绝）及单 Provider 多能力共存。
- [ ] 3. Host TTS 插件与持久化：实现 `server/plugins/tts.ts` 并在 `server/profile.ts` 注册，完成 `tts.getSettings` / `tts.saveSettings`（`hostId` + `revision` + `operationId`）/ `tts.synthesize`（资产存储与权限/授权校验），并补全 `tests/architecture/tts-f0053.test.ts`。
- [ ] 4. 协议文档与可复现示例服务端：更新 `docs/provider-http-protocol.md` 与 `docs/subsystems/providers.md`，新增可独立运行与复现的示例 HTTP TTS Provider `scripts/examples/tts-provider-server.mjs` 并通过架构测试验证。
- [ ] 5. 设置页独立 TTS 面板与客户端闭环：新增 `src/locales/tts.ts`、`src/services/ttsService.ts` 与 `src/components/TTS/TTSSettingsPanel.tsx`，接入 `SettingsDialog.tsx`，实现空态跳转、模型与音色/参数选择、能力限制提示、本人授权克隆测试、加载/处理中/取消、重开与多端一致、失败重试/先查后发与版本冲突处理。
- [ ] 6. 端到端界面验收与静态/架构全量检查：编写 `tests/e2e/features/F-0053.spec.ts`（覆盖中英文、明暗主题与 AC-3/4/5/6/7/8 全状态），用 `PW_PORT=5194 pnpm e2e:evidence F-0053` 生成截图与录屏，并执行全量静态检查与真实 Host 验证。

## 验证计划

- **AC-1**：`pnpm check:host`、`pnpm tsc -b --noEmit`、`node --test tests/tts-audio.test.mjs` 与 `pnpm test:architecture`（断言 `sherpa-onnx` 不暴露 `synthesize`，单 HTTP Provider 可同时暴露 ASR 与 TTS，`ModelRef` 统一调用）。
- **AC-2**：`pnpm test:architecture` 中启动真实 Host + `scripts/examples/tts-provider-server.mjs`，验证 `/v1/health`、`/v1/models`、`POST /v1/tts/jobs`、`GET /v1/jobs/{id}`、`GET /v1/jobs/{id}/audio`、`POST /v1/jobs/{id}/cancel` 及错误透传。
- **AC-3**：`tests/e2e/features/F-0053.spec.ts`（Web / Playwright，覆盖中英文、明暗主题）及真实 Host 联调测试，验证在设置页查看/选择 TTS 模型、列出自带音色、显示「不支持声音克隆 / Voice cloning is not supported」并试听生成音频。
- **AC-4**：`tests/architecture/tts-f0053.test.ts` 与 `F-0053.spec.ts` 覆盖 401/403 鉴权错误、请求超时、损坏 WAV/MP3 音频拒绝、无授权克隆被拒绝、带完整 `cloneAuthorization` 的克隆成功、API Key 不出现在 RPC/文件/日志；外部真实 Kokoro/MeloTTS/CosyVoice/Cloud 试听按实际环境状态记录（缺失则标 `⏸ Not run`）。
- **AC-5 / AC-6 / AC-7 / AC-8**：`tests/e2e/features/F-0053.spec.ts` 分别在 `light/dark × zh/en` 下构造空态（「暂无内容 / Nothing here yet」与去配置按钮）、加载与处理中（「正在加载… / Loading…」、「正在处理… / Processing…」、禁用重复提交、取消、切走/换 Host 丢弃迟到响应）、保存与试听完成（「已完成 / Completed」、重开及第二客户端读同 Host 一致）、失败重试（「重试 / Retry」「返回 / Back」、保留输入、不确定保存先查 `tts.getSettings` 再重发）与版本冲突（「内容已更新，请重新检查 / Content changed. Review again.」）。
- **AC-9**：运行 `pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`、`cargo check --manifest-path src-tauri/Cargo.toml`、`pnpm test`、`pnpm test:architecture` 与 `PW_PORT=5194 pnpm e2e:evidence F-0053`。

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | `shared/providers.ts`（`ModelInfo.tts`、`ModelRef`、`TtsRequest`）、`server/services.ts`（可选 `synthesize`）、`server/plugins/providers.ts` |
| AC-2 | `server/providers/httpProvider.ts`、`server/plugins/endpoints.ts`、`docs/provider-http-protocol.md`、`scripts/examples/tts-provider-server.mjs` |
| AC-3 | `SettingsDialog.tsx` 独立「语音合成 / TTS」分区、`src/components/TTS/TTSSettingsPanel.tsx`、`src/locales/tts.ts` |
| AC-4 | `shared/tts/audio.ts`（损坏音频校验）、`httpProvider.ts`（鉴权/超时/redirect 错误）、`cloneAuthorization` 门禁与 Key 隔离 |
| AC-5 | `TTSSettingsPanel.tsx` 空态（`暂无内容 / Nothing here yet`）、前置不足提示与跳转「模型」配置入口 |
| AC-6 | `TTSSettingsPanel.tsx` 加载/处理态、防重复提交、`jobs.cancel` 取消、`requestEpoch`/`hostId` 迟到响应防护 |
| AC-7 | `server/plugins/tts.ts`（`tts-settings.json`、资产校验落盘）、`tts.getSettings` 多客户端一致性与「已完成 / Completed」 |
| AC-8 | `TTSSettingsPanel.tsx` 错误恢复（保留输入、`重试 / Retry`、`返回 / Back`、不确定先查）、`expectedRevision` 冲突提示 |
| AC-9 | `tests/e2e/features/F-0053.spec.ts`（`light/dark × zh/en`）、`tests/architecture/tts-f0053.test.ts`、全量检查与 `04-test-report.md` |

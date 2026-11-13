---
id: F-0035
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-13
---

# F-0035 单条译文配音与试听：设计

## UI / UX

沿用项目编辑器的字幕列表（`SubtitleList`）、行内操作（`SubtitleItem`）与设置弹窗（`SettingsDialog`），不新增独立页面或独立本地项目库。所有新增用户可见文案集中定义在 `src/locales/dubbing.ts`（中英文），复用 `useTranslation` 响应界面语言和明暗主题切换。

1. **入口与行内状态（`SubtitleList.tsx` + `SubtitleItem.tsx`）**
   - 在 `SubtitleList` 头部工具条「翻译 / Translate」旁增加「配音 / Dub」按钮（`data-testid="cue-dubbing-open"`），点击展开/收起 `SingleCueDubbingPanel`（位于 `TranslationPanel` 下方）。
   - 在每条未删除、非空白字幕行（`SubtitleItem`）左侧操作栏增加「单条配音 / Dub cue」按钮（`data-testid="cue-dub-button"`），点击直接选中该条并打开 `SingleCueDubbingPanel`。
   - 若该条在当前激活语言轨道已有项目配音产物（`CueDubbingArtifact`），在副字幕区域下方展示紧凑状态条（`data-testid="cue-dub-row-status"`）：显示配音时长（如 `1.20s / 2.00s`）、快捷试听/停止按钮（`data-testid="cue-dub-quick-play"`）、过长标记（`配音过长 / Dubbing is too long`，不截断不顺延）以及过期标记（`配音已过期 / Dubbing is outdated`，当译文或所选模型/音色变化时实时显现）。

2. **单条译文配音面板（`src/components/SubtitleEditor/SingleCueDubbingPanel.tsx`）与全生命周期状态**

| 状态 | 用户看到什么、能做什么 | 端到端构造方式 |
|---|---|---|
| 空态 / 前置不足（AC-5） | 无可用 TTS 模型时显示「暂无内容 / Nothing here yet」，说明缺少 TTS 模型并提供「去配置模型 / Configure models」按钮（打开 `SettingsDialog`），原有字幕编辑保持可用；无已确认译文或当前字幕译文为空时显示「暂无内容 / Nothing here yet」及提示先在字幕行或翻译面板确认译文，禁用生成；选中模型需下载或不可用时给出具体原因和「去配置模型 / Configure models」入口 | `providers.models` 返回空或无 TTS 模型；或打开无译文轨道的项目 |
| 模型、音色与发送前预览（AC-1） | 可选声明 `role: 'tts'` 的 `ModelRef`、自带音色（无自带音色时提示并使用默认声音）及声明的参数（语言、支持时长控制时的语速、`model.options`）；**不自动选择收费或远程服务**（仅使用已保存默认或 `offline === true` 的就绪模型，其余保持未选并提示手动选择）。发送前固定展示「发送前预览」卡片（`data-testid="cue-dubbing-preview"`）：目标译文文本、服务商与模型名（标明本地/远程）、以及会上传的内容（「上传文本：…」「参考样本：无（仅使用自带音色）」） | `providers.models` 返回本地与远程/云端 TTS 模型，断言默认不自动选收费/远程模型且预览显示完整 |
| 加载与处理中（AC-6） | 加载模型与配置时显示「正在加载… / Loading…」（`data-testid="cue-dub-loading"`）；生成请求执行中显示「正在处理… / Processing…」与进度（`data-testid="cue-dub-processing"`），禁用重复提交按钮，提供「取消 / Cancel」（`data-testid="cue-dub-cancel"`）并明示取消将停止等待但已发出的外部 HTTP 请求或正在写入的 Host 落盘步骤无法中途撤回。切换字幕条、切换轨道、切换视频或返回首页时自动中止等待并丢弃迟到响应，不串改当前字幕/项目 | `providers.models` / `tts.getSettings` / `dubbing.synthesizeCue` / `jobs.get` 延迟返回，验证取消与切换隔离 |
| 完成、试听与项目产物（AC-2、AC-7） | 仅当 Host 返回 `status: 'saved'` 且音频产物校验写入成功后显示「已完成 / Completed」（`data-testid="cue-dub-completed"`），并展示专用结果卡片：试听/停止按钮（`data-testid="cue-dub-play"` / `cue-dub-stop"`）、`<audio data-testid="cue-dub-audio">`、重做按钮（`data-testid="cue-dub-redo"`）、音频时长与字幕区间时长对比；超过字幕区间时标「配音过长 / Dubbing is too long」，不截断音频也不顺延字幕；明确提示「原视频音轨始终保留」。重开或第二个连接同 Host 的客户端可读取同一产物并试听 | `dubbing.synthesizeCue` 返回完整 WAV 产物并刷新页面 / 第二客户端读取，验证时长、过长标记与持久化一致 |
| 过期失效与重试去重（AC-3） | 修改该条译文文本，或切换 TTS 模型/音色后，旧音频立即标「配音已过期 / Dubbing is outdated」并说明原因；仍可试听旧音频或点击「重做 / Redo」覆盖更新。迟到异步响应因 epoch/targetKey 校验被丢弃，不覆盖当前字幕 | 修改译文或更换音色后断言过期标记；先触发慢请求再切换字幕/重改文本验证旧响应不覆盖 |
| 失败、不确定查询与版本冲突（AC-8） | 请求或音频校验失败时显示具体原因与「重试 / Retry」「返回 / Back」（`data-testid="cue-dub-retry"` / `cue-dub-back"`），保留用户当前选择的模型/音色/参数及既有正式字幕/配音产物；若网络断连导致保存结果不确定，提示「重试将先向 Host 查询结果以避免重复生成」，点击重试先查 `jobs.list` 与 `projects.open`；若 Host 返回 `conflict`，显示「内容已更新，请重新检查 / Content changed. Review again.」（`data-testid="cue-dub-conflict"`），禁用提交直到点击「重新检查 / Review latest」拉取最新状态 | 拦截 `dubbing.synthesizeCue` 构造 401/网络断开/版本冲突，断言查询优先与冲突阻断 |

## 技术方案

### 涉及的子系统

已读 `AGENTS.md`、`LESSONS.md`、`docs/code-standards.md`、`docs/decisions.md`、`docs/30-engineering/acceptance-testing.md`、`docs/subsystems/cordis-host.md`、`docs/subsystems/frontend.md`、`docs/subsystems/providers.md`、`docs/20-architecture/adr/0001-project-storage-format.md`、`0003-multi-video-projects.md`、`0011-multilingual-subtitle-tracks.md`、`0013-tts-provider-contract.md`。

### 方案

1. **共享纯逻辑与契约（`shared/tts/dubbing.ts`）**
   - 定义 `CueDubbingArtifact` schema（校验 `file` 必须匹配 `^dubbing\/[0-9a-f-]{36}\.(wav|mp3|ogg|flac)$`）、`dubCueInputSchema`、`DubCueResult`。
   - 提供纯函数 `pickDefaultOfflineTtsModel(groups)`（绝不自动选择收费或远程服务，仅在未保存设置时选 `offline === true` 且 `provider.id !== 'flycut-cloud'` 的就绪模型）、`evaluateCueDubbingStatus(artifact, context)`（计算 `tooLong`、`outdated` 及细分原因 `textChanged` / `modelChanged` / `voiceChanged`）、`upsertCueDubbing` 与 `removeTrackDubbings`。
   - 扩展 `shared/projects.ts` 的 `projectEditsSchema`，增加可选向后兼容字段 `dubbings: z.array(cueDubbingArtifactSchema).optional()`，保持格式版本 4，不破坏已有格式 3/4 读取；在 `ProjectStore.writeEdits` 中校验 `dubbings` 无重复 ID、无重复 `(trackId, chunkId)`、且引用的 `trackId` / `chunkId` 存在于当前 edits 中。

2. **Host 端配音插件与项目产物存储（`server/plugins/dubbing.ts`、`server/projects/store.ts`、`server/profile.ts`）**
   - 新增内置 Cordis 插件 `dubbingPlugin`（在 `server/profile.ts` 注册为 `dubbing`，`inject: ['hostConfig', 'rpc', 'jobs', 'providers', 'projectStore']`），并在 `shared/protocol.ts` 声明 `dubbing.synthesizeCue`。
   - `dubbing.synthesizeCue` 使用 `ctx.jobs.create(..., { operationId })` 执行三阶段流水线：
     1. **前置核对（`store.exclusive(projectId)`）**：校验项目未进回收站/未删除、视频存在、`video.revision === baseVideoRevision`、目标语言轨和字幕存在且已确认译文等于 `expectedText`。若 `edits.dubbings` 已有同一 `operationId` 的落盘记录，直接返回 `{ status: 'saved', duplicate: true, ... }`；若版本或译文已变，直接返回 `{ status: 'conflict', ... }`，不产生外部 TTS 请求；同时拒绝携带 `cloneReferenceAssetId`（F-0035 仅用自带音色）。
     2. **TTS 合成与音频验证**：调用 `ctx.providers.synthesize`（含 `validateTtsAudio` 字节头校验）；若返回音频为 MP3/OGG 等未自带精确时长，用 Host `ffmpeg` 探测时长（沿用 `parseFfmpegDuration`）。
     3. **原子落盘（`store.exclusive(projectId)`）**：再次核对 `video.revision === baseVideoRevision` 与译文未变；若期间被另一客户端改动，放弃写入并返回 `conflict`。否则原子写入 `<videoDir>/dubbing/<dubId>.<ext>`（`.tmp` → `rename`），更新 `edits.dubbings` 并调用 `store.writeEdits`，递增 `video.revision` 与 `project.revision` 并写入 `project.json`，最后清理被替换的旧音频文件。
   - 注册只读 HTTP 路由 `GET /projects/:projectId/videos/:videoId/dubbing/:dubId`（同媒体路由鉴权与 `queryToken` 规则，支持 HTTP Range 与 `Cache-Control: no-store`，拒绝回收站和已删除项目）。
   - `ProjectStore` 新增 `dubbingDir` / `dubbingFile` 路径校验方法；删除视频（`removeVideoFiles`）、彻底删除项目（`purge`）和复制项目（`duplicate`）天然包含 `videos/<videoId>/dubbing/`。

3. **前端服务、Store 与防竞态编排（`src/services/dubbingService.ts`、`src/stores/historyStore.ts`、`src/services/projectService.ts`、`src/recovery/copy.ts`、`src/hooks/useCueDubbing.ts`）**
   - `historyStore` 持有 `dubbings: CueDubbingArtifact[]`（与 `textHistory` 一样置于顶层状态而非文本/剪辑撤销快照中，避免撤销某次文字修改时误删 Host 已落盘的配音记录；`removeLanguageTrack` 时清理对应轨的 `dubbings`），并在 `setTranscript` / `upsertCueDubbing` 中维护。
   - `ProjectService` 在 `buildEdits`、`snapshot`、`baseline`、`videoDirty` 与 `src/recovery/copy.ts` 纳入 `dubbings`，使常规自动保存不会丢失已有配音记录，同时新增 `recordDubbingSaved` 在 `dubbing.synthesizeCue` 成功后同步更新 `videoRevision`、`revision` 与 `baseline.dubbings`；增加 `reloadCurrentVideo()` 供冲突后点击「重新检查」拉取 Host 最新版本。
   - `DubbingService` 封装 `dubbing.synthesizeCue`、`jobs.list` / `jobs.get` / `jobs.cancel`、以及通过鉴权请求拉取 `/projects/:projectId/videos/:videoId/dubbing/:dubId` 并转换为安全 `Blob` URL（避免把 bearer token 放进 DOM）。
   - `useCueDubbing` Hook 管理面板生命周期：
     - 发起生成前若当前编辑器存在未保存修改，先调用 `projects.flush()` 同步译文与修订号。
     - 维护 `requestEpoch` 与 `targetScopeKey`（`projectId:videoId:trackId:chunkId`），任何切换字幕/轨道/视频/离开页面或取消操作立即递增 epoch、取消等待并丢弃迟到响应。
     - 维护待确认的 `pendingOperation`（含 `operationId`、`projectId`、`videoId`、`trackId`、`chunkId`）：当出现不确定网络错误点击「重试」时，先查询 `jobs.list` 与 `projects.open` 核对是否已完成落盘，已落盘则直接采纳结果而不重复调用 TTS。

### 接口与数据

| 层 | 接口 / 契约 |
|---|---|
| `shared/tts/dubbing.ts` | `CueDubbingArtifact`、`dubCueInputSchema`、`DubCueResult`、`pickDefaultOfflineTtsModel`、`evaluateCueDubbingStatus`、`upsertCueDubbing`、`removeTrackDubbings` |
| `shared/projects.ts` | `projectEditsSchema` 新增可选 `dubbings?: CueDubbingArtifact[]`（格式 4 向后兼容扩展） |
| `shared/protocol.ts` | `RpcMethods` 新增 `'dubbing.synthesizeCue': { input: DubCueInput; output: JobSnapshot }` |
| `server/plugins/dubbing.ts` | 注册 `dubbing.synthesizeCue` RPC 与 `GET /projects/:projectId/videos/:videoId/dubbing/:dubId` 路由 |
| `src/stores/historyStore.ts` | 新增 `dubbings` 状态与 `upsertCueDubbing` 动作；`removeLanguageTrack` 同步清理 |
| `src/recovery/copy.ts` | `recoveryContentSchema` / `HostContent` / `diffWithHost` 纳入可选 `dubbings` |

### 备选方案与取舍

- **配音元数据与文件归属**：选择在 `edits.json` 增加可选 `dubbings` + `videos/<videoId>/dubbing/<id>.<ext>`（而非临时 `assets/<uuid>` 或独立 `dubbing.json`）。原因：临时资产有 24 小时 TTL 且不随 `duplicate` 复制；独立 `dubbing.json` 会引入第二套修订号，难以在并发改译文与生成配音时保持原子一致。
- **自动模型选择策略**：仅当 Host `tts-settings.json` 已有保存选择，或存在 `offline === true` 且非 `flycut-cloud` 的本地就绪模型时才预选；绝不自动选中 `flycut-cloud` 或远程 HTTP 服务，严格满足 AC-1。
- **音频播放拉取方式**：通过 `fetch`（带 session cookie 或 bearer header）拉取项目配音流并生成 `blob:` URL 交给 `<audio>`，而不直接把 `?token=...` 拼进 DOM，避免凭据出现在 DOM 或截图里。

## 架构决策

- [ADR-0015 项目单条译文配音产物与修订并发契约](../../20-architecture/adr/0015-project-cue-dubbing.md)（当前 `status: proposed`，随本需求验收确认时改为 `accepted`）

## 自行决定的事项

1. **单条配音入口位置**：同时提供 `SubtitleList` 头部「配音 / Dub」按钮与 `SubtitleItem` 每行左侧操作按钮及行内状态条，既方便逐条点击也方便检查无译文空态。（影响 AC-1、AC-2、AC-5）
2. **不自动选收费服务的判定边界**：将 `offline === true && providerId !== 'flycut-cloud'` 作为唯一可自动预选条件；其他未标记 `offline: true` 的服务（包括用户添加的 HTTP endpoint 和 `flycut-cloud`）除非用户已显式保存为默认 TTS 模型，否则均不自动选中。（影响 AC-1）
3. **旧音频过期判断规则**：当 `artifact.text !== currentTranslationText.trim()` 或（当前已选模型不为空且与 `artifact.model` 不同，或同模型下当前音色与 `artifact.voiceId` 不同）时即标为过期；当尚未选择模型时不对既有持久配音误报过期。（影响 AC-3）
4. **配音时长容差**：使用 `durationSeconds > cueDuration + 0.01` 判断「配音过长」，避免浮点精度误差导致恰好等长时误报。（影响 AC-2）
5. **撤销栈隔离**：`dubbings` 不纳入文本/剪辑 `undoStack` 快照，避免用户在生成并落盘配音后按 `⌘Z` 撤销某句文字编辑时丢失已落盘的配音记录；撤销后文本变化会自动触发过期状态重算。（影响 AC-3、AC-7）

## 风险与回退

- **风险 1**：用户在编辑某条译文后未等 1.5s 自动保存即点击生成配音。缓解：生成前主动 `flush()` 同步 `edits.json`，若存在并发冲突则立即阻断并提示检查。
- **风险 2**：本地运行环境缺少真实 Kokoro/MeloTTS/CosyVoice 推理引擎或付费云端 TTS API Key。缓解：使用 Host + `scripts/examples/tts-provider-server.mjs` 与真实 WAV/MP4 测试素材（`tests/media/clips/dub/`）验证完整协议、落盘、Range 播放、FFmpeg 时长探测与双客户端一致性；缺少的真实第三方模型/云端凭据与 Tauri 安装包实测在验收报告如实标 `⏸ Not run`。
- **回退**：移除 `dubbingPlugin` 注册、`dubbing` 字段与 `SingleCueDubbingPanel` UI 入口即可回退，既有的格式 4 多语言字幕轨道不受影响。

## 实现清单

- [x] 定义单条配音共享契约、状态评估与默认模型不自动选收费服务逻辑（`shared/tts/dubbing.ts`、`shared/projects.ts`、`shared/protocol.ts`）及单元测试（`tests/cue-dubbing.test.mjs`）
- [ ] 实现 Host 项目配音产物落盘、两阶段修订并发锁、`operationId` 幂等与只读流式路由（`server/projects/store.ts`、`server/plugins/dubbing.ts`、`server/profile.ts`）及架构集成测试（`tests/architecture/dubbing-f0035.test.ts`）
- [ ] 打通前端 `historyStore`、`ProjectService`、`recovery/copy.ts` 与 `DubbingService` 持久化与不确定重试核对逻辑，并补前端持久化/同步测试
- [ ] 实现 `src/locales/dubbing.ts`、`useCueDubbing`、`SingleCueDubbingPanel` 与 `SubtitleList` / `SubtitleItem` 入口与完整生命周期状态 UI
- [ ] 编写 Web 端到端测试 `tests/e2e/features/F-0035.spec.ts`（覆盖 AC-1 至 AC-8 全状态 × 中英文 × 明暗主题），执行 Red check 与 `PW_PORT=5304 pnpm e2e:evidence F-0035`

## 验证计划

| 范围 / AC | 目标平台 | 验证命令与用例 | 预期断言 |
|---|---|---|---|
| AC-1、AC-2、AC-3（纯逻辑） | Node | `pnpm test`（`tests/cue-dubbing.test.mjs`） | 校验不自动选收费/远程模型、过长判定（不截断不顺延）、改译文/换模型/换音色过期判定、路径正则安全与 Red check |
| AC-1、AC-2、AC-3、AC-4、AC-6、AC-7、AC-8（Host + 真实 HTTP 服务） | Node + 真实 Host + `tts-provider-server.mjs` + `ffmpeg` | `pnpm test:architecture`（`tests/architecture/dubbing-f0035.test.ts`） | 真实启动 Host 与示例 TTS HTTP 服务生成中英 WAV（及 MP3 时长探测），断言项目 `videos/<id>/dubbing/` 落盘、Range 播放、重开与第二客户端一致、`operationId` 重试去重、修订冲突阻断、取消停止、原媒体 untouched、删除视频/项目清理 |
| AC-1、AC-2、AC-3、AC-5、AC-6、AC-7、AC-8、AC-9（Web UI） | Web Chrome（zh/en × light/dark） | `PW_PORT=5304 pnpm test:e2e tests/e2e/features/F-0035.spec.ts --workers=1` 与 `PW_PORT=5304 pnpm e2e:evidence F-0035` | 覆盖空态/无模型/无译文引导、不自动选收费服务、发送前预览、加载/处理中/取消与切换不串项目、试听/停止/重做/过长标红、改译文与换音色过期、旧响应不覆盖、失败重试/不确定先查询/冲突「内容已更新，请重新检查」、重开一致 |
| AC-4、AC-9（真实第三方 TTS 与 Tauri 桌面打包） | 本地/远程真实 TTS 引擎与 Tauri 安装包 | 有真实引擎/凭据或桌面构建时实机运行；缺失时如实记为 `⏸ Not run` 并注明阻塞条件 | 不得用 mock 代替宣称真实引擎/桌面打包已验证 |
| 静态检查与架构回归 | 全仓 | `pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`、`cargo check --manifest-path src-tauri/Cargo.toml`、`pnpm test`、`pnpm test:architecture` | 全绿 |

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | `pickDefaultOfflineTtsModel`、`SingleCueDubbingPanel` 模型/音色/参数表单与发送前预览卡片 |
| AC-2 | `server/plugins/dubbing.ts` 项目目录落盘 + 试听/停止/重做控件 + `evaluateCueDubbingStatus` 时长对比与「配音过长 / Dubbing is too long」提示（不截断不顺延） |
| AC-3 | `evaluateCueDubbingStatus`（译文/模型/音色过期标记）、`useCueDubbing` epoch/scopeKey 防旧响应覆盖、`operationId` 重试去重、`video.media` 始终保留 |
| AC-4 | `tests/architecture/dubbing-f0035.test.ts` 使用真实 Host + 示例 HTTP TTS 服务生成中英样例并校验产物；真实第三方 TTS 运行时/凭据按实际环境如实记录 |
| AC-5 | `SubtitleList`/`SubtitleItem` 入口、无 TTS 模型与无确认译文空态（「暂无内容 / Nothing here yet」+ 去配置入口），保持已有编辑可用 |
| AC-6 | 加载中（「正在加载… / Loading…」）、处理中（「正在处理… / Processing…」+ 禁重提交 + 取消及不可撤回说明）、切换/返回丢弃迟到响应 |
| AC-7 | Host 落盘与校验成功后显示「已完成 / Completed」与试听/重做/保留原轨提示；`edits.json` + 项目产物保证重开及第二客户端一致 |
| AC-8 | 失败展示原因与「重试 / Retry」「返回 / Back」并保留状态；不确定结果先查 `jobs.list`/`projects.open`；版本冲突提示「内容已更新，请重新检查 / Content changed. Review again.」 |
| AC-9 | `tests/e2e/features/F-0035.spec.ts`（zh/en × light/dark）+ 截图/录屏证据 + 真实 Host 与测试汇报 |

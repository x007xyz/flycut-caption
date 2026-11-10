---
id: F-0006
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-09
---

# F-0006 VAD 去静音：技术设计

## UI / UX

入口放在现有剪辑控制区：`SubtitleEditorPanel` 在 `CutHistoryPanel` 上方渲染 `SilenceCutPanel`，标题按钮为「去静音 / Remove silence」。复用 F-0005 的剪辑面板、时间轴和播放器，不新增顶层工作台入口，也不改变「智能剪空白」的现有入口和算法。

`SilenceCutPanel` 分参数区和候选区。参数区包含模型、最短静音、切点余量、模式、保留时长、分析/取消；候选区复用 F-0007 的 `PendingSuggestionsList`。分析时只改本地 phase，不写 `historyStore`；分析成功后才调用 `proposeSuggestions`。候选列表根节点保留 `data-testid="cut-suggestions"`，每项为 `data-testid="pending-suggestion-item"`，时间轴红标保留 `data-testid="pending-cut"`。

| 状态 | 用户看到什么 / 能做什么 | 文案（中 / 英） |
|---|---|---|
| 无可用模型 | 模型为空，分析禁用，显示设置入口；不回退到字幕间隙 | 没有可用的人声检测模型 / No voice detection model available |
| 默认参数 | 最短静音 0.5s、余量 0.15s、压缩停顿、保留 0.25s | 分析 / Analyze |
| 参数非法 | 就地错误，分析禁用，不发 RPC | 请检查参数 / Check these settings |
| 分析中 | 显示阶段进度和取消；重复点击不启动第二个任务 | 正在分析… / Analyzing…，取消 / Cancel |
| 分析失败 | 通用失败文案加可读原因；保留参数，可重试 | 分析失败，请重试 / Analysis failed. Try again. |
| 无候选 | 参数可调，应用按钮禁用 | 没有可移除的停顿 / No pauses to remove |
| 无语音 | 同上，并说明没有检测到人声；不生成全删候选 | 没有检测到人声 / No speech detected |
| 有候选 | 候选数、选中后的预计减少时长、每项起止与原因 | 候选 / suggestions，预计减少 / Estimated cut |
| 预览 | 播放器只试听选中候选；时间轴只标选中区间 | 预览，尚未应用 / Preview, not applied |
| 当前版本 | 退出预览，回到正式 EDL | 当前已确认版本 / Current confirmed cuts |
| 过期 | 基准变化后禁止预览和应用 | 建议已过期，请重新分析 / Suggestions are outdated. Analyze again. |
| 提交中 | 禁用 checkbox、全选、预览、应用和导出 | 正在更新剪辑… / Updating cuts… |
| 应用失败 | 正式剪辑和候选都保留，可重试 | 应用失败，请重试 / Cannot apply cuts. Try again. |
| 无字词时间戳 | 候选仍可分析，但默认不勾选并显示保护提示 | 缺少可靠字词时间戳，疑似发音边界不默认剪切 / Reliable word timestamps are unavailable. Uncertain speech boundaries will be kept. |
| 无音轨 / 媒体缺失 | 分析失败并给出明确原因；不伪造成功 | 该媒体没有音轨，无法分析 / This media has no audio track, so it can't be analyzed.；项目媒体缺失，请重新链接媒体 / Project media is missing. Relink the media. |

列表每项包含 checkbox、原因/类别、起止时间；原因使用稳定代码（`silence.vad-pause`、`silence.vad-edge`），由 `src/locales/silence.ts` 映射为中英文，不把 Host 英文文案直接显示在中文界面。全选/全不选只作用于当前批次；预计减少时长按 selected 区间并集计算，重叠不重复扣。

时间轴只把 `selectPendingRanges(state)` 返回的选中区间画成红色块，带警示图标和「待确认删除 / Pending deletion」文字，不只靠颜色；未选项只出现在列表。播放器 `activeEdl` 优先级沿用 F-0005/F-0007：历史预览、audition（F-0007）、`pendingSuggestions.preview`、正式 EDL。预览只看选中项；历史预览打开时隐藏本轮红标。所有新增状态在明暗主题、中英文下都要有截图证据。

## 技术方案

### 涉及的子系统

已核对 `docs/subsystems/cordis-host.md`、`providers.md`、`frontend.md`、`docs/architecture-current.md`、`decisions.md`、F-0005 设计、F-0007 设计的共享建议契约，以及 `server/plugins/asr.ts`、`editing.ts`、`projects.ts`、`server/projects/store.ts`、`server/services.ts`、`server/plugins/export.ts`、`shared/editing/edl/index.ts`、`src/stores/historyStore.ts`、`CutHistoryPanel.tsx`、`SubtitleList.tsx`、`EnhancedVideoPlayer.tsx`、`TimelineWaveform.tsx`、`src-tauri/sidecars/funasr-asr/src/main.rs`、`tests/lib/vadRunner.mjs`、`tests/fsmn-vad.integration.test.mjs`。

F-0005 已验收，依赖满足。F-0007 的 `shared/editing/suggestions.ts`、`pendingSuggestions`、`selectPendingRanges`、`confirmPending` 是本需求唯一可复用的建议契约；F-0006 不新增 `pendingSilence`、`pendingRanges` 或第二套确认逻辑。

### 方案

**1. 共用待确认建议层（与 F-0007 完全一致）**

`shared/editing/suggestions.ts` 定义：

```ts
export type SuggestionKind = 'silence' | 'filler';
export interface CutSuggestion {
  id: string; start: number; end: number; reason: string;
  category?: string; label?: string; confidence?: number; selected: boolean;
}
export interface SuggestionBatch {
  kind: SuggestionKind; base: string; preview: boolean; items: CutSuggestion[];
}
```

`historyStore` 只保存 `pendingSuggestions: SuggestionBatch | null`，不再保存 `pendingCuts`。`selectPendingRanges(state)` 返回 `{ ranges, base, preview } | null`，ranges 是 selected 项区间的并集；旧 F-0005 调用方和测试改用这个派生视图。`editRevision` 只在正式数据变化时递增（`setTranscript`、`commit`、文本编辑、删除/恢复、undo/redo、`restoreHistory`、EDL 变化），`batch.base = String(editRevision)`。选择、预览、拒绝、audition 只改临时层，不递增 revision、不触发自动保存或恢复副本。

`proposeSuggestions(batch)` 校验 kind、base、id 唯一、时间有限且 `end > start`；同 kind 批次在新分析成功前保留旧批次，跨 kind 返回 `cross-kind`，不静默覆盖。`proposeCuts(ranges)` 仍作为 F-0005 兼容入口生成 `kind:'silence'`、全部 selected、`reason:'silence'` 的 batch；智能剪空白和 F-0006 都可使用。`confirmPending` 只应用 selected 项，先比较 base 与当前 `editRevision`，再逐项校验 id/范围，计算并集，一次 `commit` 只写一条 `cutHistory`（kind 为 `'silence'`）；没有净变化时清空 batch 并返回 alreadyApplied。

**2. Host VAD 分析路径**

新增 `server/plugins/silence.ts`，注册 `silence.analyze` 和 capability `silence`。它不接收路径、assetId 或任意客户端媒体：

```ts
silenceAnalyzeSchema = z.strictObject({
  projectId: z.uuid(), videoId: z.uuid(),
  model: modelRefSchema,
  params: { minPauseSeconds, guardSeconds, mode: 'shorten'|'remove', retainSeconds }
})
```

`projectsPlugin` 增加 Host 内部服务 `projectMedia.open(projectId, videoId)`。它在项目写锁内读取项目、视频、transcript 和 edits，校验生命周期，调用现有 `mediaStatus(..., true)`（linked 媒体比较 fingerprint），返回内部路径、项目时长、video/project revision、转写和正式 editing。路径只传给 Host 插件，不出现在 RPC 返回值里。项目在回收站/已删除、视频不存在、媒体缺失、时长未知都直接抛错；Web 连接不支持 linked 媒体时同样按缺失处理，不尝试客户端路径。

分析 job 的步骤：

1. `projectMedia.open` 读取项目快照；校验 `durationSeconds > 0` 和现有 EDL 的 `sourceDurationUs` 一致。
2. 用 Host 的 FFmpeg（`FFMPEG_PATH` 或内置副本）从项目媒体提取 16 kHz 单声道 PCM16 WAV 到临时文件，`-vn`；解析 `-progress` 报告 5–20%。无音轨、文件消失、FFmpeg 失败都返回明确错误。
3. 通过 `ctx.providers.detectVoice` 调用所选 VAD 模型。内置 `sherpa-onnx` Provider 用现有 sidecar 执行 `--input <wav> --vad-type fsmn|silero --vad-dir|--vad-model ... --vad-dump-json`。因为输入已是 WAV，sidecar 不再嵌套启动 FFmpeg，取消信号能直接结束进程；临时 WAV 在 finally 删除。
4. 校验 VAD 输出：`vadType` 与模型匹配、duration 有限、段有序、`end > start`、落在项目时长内（误差不超过 100ms）；项目时长与 VAD duration 不一致时失败，不偷偷裁剪。
5. 读取 transcript 的 `hasWordTimestamps` 和 `wordChunks`。Host 再校验有限、正时长、在项目范围内、属于对应句子；不合格就按「没有可靠字词时间戳」处理，而不是部分信任。
6. 用 shared 纯函数生成候选，返回 `{ vadType, durationSeconds, hasReliableWordTimestamps, warnings, candidates }`。
7. `signal.throwIfAborted()` 后提交 job 结果；取消或迟到的结果不写项目、不改正式 EDL。

进度：读取项目 5%，提取音频 5–20%，人声检测 20%（没有可信百分比时用不确定进度条，不伪造百分比），生成候选 90%，完成 100%。取消调用现有 `jobs.cancel`，job 状态为 `cancelled`。

**3. VAD 模型与 Provider 能力**

`sherpa-onnx` 的 `models()` 增加两个 `role:'vad'` 模型：`fsmn-vad`（默认、中文优先、`recommended:true`）和 `silero-vad`。资源沿用 `src-tauri/shared_assets/funasr-fsmn-vad` 与 `silero-vad/silero_vad.onnx`；sidecar 或资源缺失时返回 `status:'unavailable'` 和原因，不假装 ready。VAD 资源随安装包/构建准备，本需求不新增模型下载协议。

`Provider` 增加可选 `detectVoice?(request: ModelRef, audioPath, signal, report)`，`ProviderSummary` 增加 `capabilities: Array<'asr'|'vad'>`，由注册表按实际实现生成。`ProviderRegistry.detectVoice` 只接受 `role === 'vad'`、`status === 'ready'` 的模型；HTTP Provider 即使声明 vad 角色，没有 `detectVoice` 也不会出现在本功能的可用列表里。这样不按 Provider ID 写分支，也不把 ASR 选项里的配套 VAD 模型误当成可独立分析的模型。

`shared/providers.ts` 增加 `VoiceActivityResult`（`vadType:'fsmn'|'silero'`、`duration`、秒为单位的 `segments`）和纯校验函数，内置 Provider 与未来实现共用。

**4. 参数、切点保护与候选生成**

默认值：`minPauseSeconds = 0.5`、`guardSeconds = 0.15`、`mode = 'shorten'`、`retainSeconds = 0.25`。UI 和 Host 都执行：只接受有限数；guard/retain 非负；minPause 大于 0；mode 只能是两值；大于安全整数微秒的值拒绝。非法输入就地显示「请检查参数 / Check these settings」，不启动分析；Host 的 strict schema 同样拒绝，不能只靠前端。

全部计算使用整数微秒。候选生成在 `shared/editing/silence.ts`：

1. VAD speech 段取并集；可靠字词区间再并入，得到 protected speech。字词时间戳存在时，任何切入 word 的区间都不允许；VAD 与 word 冲突时以并集为准，宁可少删。
2. 在 `[0, duration)` 的补集上生成停顿。内部停顿两端各留 `guard`；`shorten` 模式在靠近下一段语音的一侧额外保留 `max(guard, retain)`，`remove` 模式只留 `guard`。片头/片尾静音也生成候选：`shorten` 保留 `max(guard, retain)`，`remove` 只留 `guard`。因此默认 `shorten` 的内部停顿总共保留 `guard + retain = 0.4s`，`remove` 保留 `2 × guard = 0.3s`，压缩模式一定比删除模式删得少。
3. 停顿原始长度小于 `minPause`、切点余量吃掉全部区间、或净剪切长度小于 1ms 时不产生候选；保留量永远不超过原停顿。
4. 减去正式 EDL 已删除区间；结果按 1ms 容差合并重叠/相邻，再按正式删除区间切分，按 `startUs:endUs` 去重。重复分析或重复应用同一区间不会二次扣时。
5. 候选字段：`id = silence-<startUs>-<endUs>`；`start/end` 为秒；内部停顿 `reason:'silence.vad-pause'`，片头片尾 `reason:'silence.vad-edge'`，`category:'pause'`；有可靠字词时 `confidence:0.9`、默认 `selected:true`；没有可靠字词时 `confidence:0.5`、默认 `selected:false`，并返回警告。没有语音段时返回空候选和 `no-speech` 警告，不生成「删除全片」。
6. 不按字数猜测时间，不把字幕句间空隙当作 VAD 回退；VAD 失败就是失败。

**5. 前端状态、选择与预览**

`SilenceCutPanel` 本地持有 phase、runId、jobId、分析时参数、`base = String(editRevision)` 和上一次错误。启动分析前先 `ctx.projects.flush()`，保证 Host 读到已保存快照；保存失败则显示「分析失败」并停止。分析中禁用参数和重复点击；取消、切换视频、卸载时 `jobs.cancel`，runId 不匹配的迟到结果直接丢弃。

成功结果通过 `proposeSuggestions` 写入 `pendingSuggestions`，`preview:false`，base 使用启动时捕获的 revision。若分析期间 `editRevision` 已变化，丢弃结果并提示重新分析，不把旧候选标成新结果。同一 kind 重新分析成功前保留旧 batch；已有 filler batch 时返回 cross-kind，不静默替换。

列表复用 `PendingSuggestionsList`：checkbox、原因/类别、起止、label/置信度；全选/全不选；预计减少按选中并集。选择只改 `items[].selected`，不写 EDL。预览 `previewPending(true)` 只切换 batch.preview；`EnhancedVideoPlayer` 用 `selectPendingRanges` 构造临时 EDL，只包含选中项。取消清空 batch、preview 和错误，时间轴红标消失；正式 EDL、字幕 deleted、保存状态和导出不变。

**6. 应用、过期与历史**

应用前：

1. `historyStore.confirmPending` 比较 base 与当前 `editRevision`；不一致返回 stale，清 preview，保留正式数据和候选。
2. 前端 `cutPersistence`（F-0007 设计的共享 helper）先 `ctx.projects.flush()`；再用 `projects.open` 读回 Host，比较当前 `video.revision`/`project.revision` 与本地 `current.videoRevision`/`current.revision`。不一致返回 stale，不应用。
3. 重新确认 batch 仍存在、selected 非空、id 和范围仍合法；任何一项非法整批失败，不部分应用。
4. `confirmPending` 用选中区间并集调用 `changeCuts`，一次 commit 生成正式 EDL、必要的空白投影和一条 `cutHistory`；silence 批次不改 wordChunks 的 deleted（VAD 已避开 word 区间）。
5. `updatingCuts=true` 提交；禁用 checkbox、全选、预览、应用、其他剪辑和导出。
6. 保存成功清空 batch 和 preview，显示一条历史；保存失败按 F-0002 读回核验。已写入 Host 按成功处理；未写入且本地状态仍是 applied 快照时恢复 before（含 editRevision、EDL、chunks、wordChunks、cutHistory、undo/redo、pendingSuggestions、preview），保留候选并显示「应用失败，请重试」；不写虚假历史。期间有其他编辑或切换视频时不回滚别人的状态。
7. 撤销一次恢复整轮；重开后 `CutHistoryPanel` 从持久历史预览/回退，只恢复剪辑决策，不撤回后来文字校对。未确认 batch 不进入 `editingOf`、项目格式、恢复副本、字幕导出或视频导出。

**7. 导出与播放器平滑**

新 UI 的 `joinFadeMs` 默认 5000，放在 `appStore` 的运行时/用户设置（不是 EDL、不是项目格式）；可在去静音面板和导出对话框关闭（0）。`useVideoExport` 把 `joinFadeMs` 放进 `export.start.options`，旧客户端不传时按 0 处理，保持旧输出。

Host 的 EDL 音频链在每段 `atrim`、`asetpts` 之后加 `afade`：

```text
[0:a:0]atrim=start=S:end=E,asetpts=PTS-STARTPTS,
afade=t=in:st=0:d=F,afade=t=out:st=D-F:d=F[aN]
```

`F = min(joinFadeMs / 1000, D / 2)`；只在 `S > 0` 时加进入淡入、`E < sourceDuration` 时加离开淡出，片头第一段和片尾最后一段不做无意义淡化。fade 不改变时间戳、不插入采样、不改变 `outputDuration`，仍由 `-t outputSeconds` 约束；有音频流才加，无音轨直接失败/不伪造音频。导出结果写入临时文件后 `assets.adopt`，源媒体始终只读。

预览用同一份选中 EDL 定位并跳过删除区间；能建立 Web Audio `MediaElementAudioSourceNode` 时，用 `requestVideoFrameCallback` 的 mediaTime 在接点附近做 5ms 近似 gain ramp，seek 时重置并取消旧 ramp。浏览器不支持或帧时间不足时，预览仍保持相同保留区间和接点，但不声称已应用采样级淡化；导出侧是权威的 5ms `afade`。这样预览不修改 EDL，也不写源媒体。

### 接口与数据

| 层 | 变更 |
|---|---|
| `shared/editing/suggestions.ts` | F-0007 设计的 `SuggestionKind`、`CutSuggestion`、`SuggestionBatch`、`selectedRanges`、`suggestionSummary`；F-0006 直接复用，不新增字段。 |
| `shared/editing/silence.ts` | 参数校验、VAD/word 区间并集、候选生成、EDL 减法、1ms 合并、稳定 id、估计时长；纯函数。 |
| `shared/providers.ts` | `VoiceActivityResult`、VAD 校验、`Provider.detectVoice?`、`ProviderSummary.capabilities`。 |
| `shared/protocol.ts` | `silence.analyze` 的 strict input/output；`export.start.options.joinFadeMs?: number`（0–50ms，缺省 0 兼容旧客户端）。不新增路径字段。 |
| `server/services.ts` | `ProjectMediaService.open`、Provider 注册表 `detectVoice`、Context 注入。 |
| `server/plugins/projects.ts` / `server/projects/store.ts` | `projects` 提供 `projectMedia`；只在 Host 内部返回媒体路径、时长、revision、transcript、editing；复用 `mediaStatus(..., true)` 和现有写锁。 |
| `server/plugins/asr.ts` | 两个 VAD 模型、`detectVoice` sidecar 调用、FFmpeg 环境；VAD 资源缺失时 unavailable。 |
| `server/plugins/providers.ts` | `detectVoice` 的 role/status 校验和结果校验；capability 汇总。 |
| `server/plugins/silence.ts` / `server/profile.ts` | 新增 Host 分析插件、`silence.analyze` job、capability；BUILTINS/PROFILES 登记。 |
| `server/plugins/export.ts` | 音频 `afade` 链，保持 EDL 时长和源媒体不变。 |
| `src/stores/historyStore.ts` | 按 F-0007 设计迁移到 `pendingSuggestions`、`editRevision`、`selectPendingRanges`、`proposeSuggestions`、`confirmPending`、`suggestionError`；`proposeCuts` 兼容智能剪空白。 |
| `src/stores/appStore.ts` | `joinFadeMs` 默认 5000，提供设置方法和导出对话框/去静音面板开关。 |
| `src/services/cutPersistence.ts` | F-0007 设计的共享 flush/读回/回滚 helper；F-0006 应用直接复用。 |
| `src/components/SubtitleEditor/SilenceCutPanel.tsx` | 入口、参数、分析状态、候选摘要、预览/应用/取消、无模型/无音轨/过期。 |
| `src/components/SubtitleEditor/PendingSuggestionsList.tsx` | F-0007 设计的共用列表；F-0006 只传入 silence 候选和文案。 |
| `src/components/SubtitleEditor/SubtitleEditorPanel.tsx` | 挂载 `SilenceCutPanel`，把设置回调传进去。 |
| `src/components/Timeline/TimelineWaveform.tsx` | 用 `selectPendingRanges` 画 selected 红标、图标/文字、焦点/悬停原因；历史预览时隐藏。 |
| `src/components/VideoPlayer/EnhancedVideoPlayer.tsx` | `activeEdl` 支持 `pendingSuggestions.preview`；只使用 selected；预览徽标；近似接点平滑。 |
| `src/hooks/useVideoExport.ts` / `src/services/videoEngines/HostExportEngine.ts` / `ExportDialog.tsx` | 传 `joinFadeMs`；导出对话框提供关闭平滑的开关。 |
| `src/locales/silence.ts` / `src/locales/edl.ts` | 新增 AC 文案和原因映射；`edlCopy.stale`、`pending`、`preview` 等沿用。 |

不修改 `shared/projects.ts`、`shared/editing/edl/index.ts` 的 schema、项目格式版本、恢复副本 schema 或 `export.start` 的旧字段语义。VAD 建议是纯内存层，不需要迁移。

### 备选方案与取舍

| 选定 | 备选 | 理由 |
|---|---|---|
| Host 读项目媒体并跑 VAD | 前端上传任意音频/路径给 Host | 不接收任意路径；Web/桌面共用 Host 业务；避免大文件重复上传。 |
| 预提取 16k WAV 后调 sidecar | 让 sidecar 直接读视频并内部调 FFmpeg | 进度、无音轨错误、取消和临时文件清理都在 Host 可控范围内；sidecar 仍走现有 `--vad-dump-json`。 |
| VAD + 字词区间并集保护 | 只用 VAD；或按字数推测 | VAD 判断真实人声，字词时间戳只防切字；没有可靠词时保守不默认勾选，不伪造精度。 |
| 复用 F-0007 的 pendingSuggestions | 单独的 pendingSilence / pendingRanges | 一个批次、一次确认、一条历史；避免两个剪辑建议体系互相覆盖或重复扣时。 |
| 整批选中后一次应用 | 逐条写入 EDL | 一次确认只推进一次 base、只写一条历史，避免确认第一条后其余建议过期；逐条选择仍可在列表中完成。 |
| 5ms 作为渲染选项 | 写进 EDL 或项目格式 | EDL 只表达保留/删除决策；平滑是可关闭的导出/预览效果，不改变时长，也不需要迁移。 |
| 专用 `silence` Host 插件 | 把 VAD 塞进同步的 `EditorPlugin` | 现有 EditorPlugin 是同步、仅字幕输入的契约；VAD 需要项目媒体、异步 job 和取消。专用插件不改变现有 Workflow，也不建立第二套时间映射。 |

## 架构决策

复用 [ADR-0005](../../20-architecture/adr/0005-unified-edit-decisions.md)：EDL 是唯一剪辑真源，整数微秒，字幕只做投影，历史只保存已确认剪辑，未确认建议不持久化。本需求不改变 EDL schema、项目格式或导出协议，因此不新增 ADR。

共享待确认建议契约以 F-0007 设计的第 3 节为准；F-0006 只增加 `kind:'silence'` 的生产者、Host 分析和参数/候选规则，不另造字段、store 或确认路径。若实现中发现必须持久化建议、增加路径字段或改变 EDL 语义，先停下来提维护者确认。

## 自行决定的事项

- 片头/片尾静音也作为候选：`remove` 模式只留 guard，`shorten` 模式在语音一侧留 `max(guard, retain)`；这样去静音能处理开头/结尾，又不会在压缩模式下无缘无故保留很长的空白。
- `shorten` 的保留量按「紧邻下一段语音前」的静音计，且不小于 guard；内部停顿总保留量因此是 `guard + retain`（默认 0.4s），`remove` 是 `2 × guard`（0.3s）。这保证压缩模式删得比删除模式少；如果验收认为默认 0.4s 太长，只需调 retain 语义/默认值，不改 EDL。
- 候选净长度小于 1ms 时丢弃，避免 1µs 级无意义切点和大量噪声候选。
- 没有可靠字词时间戳时仍使用 VAD，但所有候选 `selected:false`、`confidence:0.5`，用户必须逐条勾选；不按字数补时间，也不退回字幕间隙算法。
- Host 分析前先 `flush`，以 `String(editRevision)` 作为 batch.base；分析期间 revision 变化就丢弃迟到结果，不把旧候选伪装成新结果。
- 一次只保留一个 kind 的 batch；silence 与 filler 不能并行待确认，跨 kind 时要求先应用或取消。
- 平滑是 `joinFadeMs` 渲染设置（默认 5ms，0 关闭），不写 EDL、不改项目格式；旧客户端不传时保持旧输出。
- F-0006 不注册同步 `EditorPlugin`，因为现有契约无法表达异步、项目媒体和取消；使用专用 Host 插件和 `silence.analyze`。将来要进 Workflow 时再泛化分析器契约，不在本需求里偷改。

## 风险与回退

- **参数语义**：`retain` 与两侧 guard 的组合可能让默认保留比用户直觉更长；设计明确按「下一段语音前」计，验收时用真实口播听感确认。若需改成总保留量，只调整纯函数和文案，不改 EDL。
- **VAD 误检/漏检**：候选是建议，不自动应用；无字词时默认不选。验收记录误切、漏切和接点可听性，不能把 VAD 通过当成字幕时间戳可靠。
- **媒体缺失/无音轨**：linked 媒体在 Web/服务端可能不可见；必须明确失败，不把无音轨当静音全删。项目时长与 VAD duration 不一致时失败，不静默裁剪。
- **取消/资源**：Host 预提取 WAV 后 sidecar 不再嵌套 FFmpeg，取消可同时结束 FFmpeg 和 sidecar；若预提取未完成，临时文件必须 finally 清理。
- **5ms 淡入淡出**：`afade` 不改变时长，但可能在接点产生轻微音量凹陷；5ms 很短，默认开启，可关闭。预览的 Web Audio 近似可能受浏览器帧率限制，不能宣称与导出采样级一致。
- **保存竞态**：应用前比较 editRevision 和 Host revision；保存失败先读回，只在未写入且本地仍是 applied 快照时回滚，避免覆盖其他窗口/后续编辑。
- **性能与规模**：60 分钟 VAD 段可能很多；候选用整数微秒、线性扫描，列表滚动，不把全部候选写进项目。若 60 分钟分析或 UI 卡顿超出可接受范围，先剖析，不用半更新状态换速度。
- **回退方案**：移除入口和 `silence` 插件注册即可停止暴露；pendingSuggestions 从不持久化，不需要数据迁移；F-0005 的 EDL/历史和旧导出不变。若共享建议契约迁移出问题，`proposeCuts` 兼容层仍保留 smart cut。

## 实现清单

- [x] 1. **共享建议契约与 store 迁移**：按 F-0007 设计新增 `shared/editing/suggestions.ts`；`historyStore` 用 `pendingSuggestions` 替换 `pendingCuts`，加入 `editRevision`、`selectPendingRanges`、`proposeSuggestions`、`confirmPending`、`suggestionError`；智能剪空白的 `proposeCuts` 兼容且不改变检测算法；一次确认只写一条 `cutHistory`（AC-4、AC-6、AC-7、AC-9）。
- [x] 2. **Host 项目媒体与 VAD 分析**：`projects` 提供 `projectMedia`，新增 `server/plugins/silence.ts` 与 `silence.analyze` job；预提取 WAV、进度、取消、媒体缺失/无音轨/时长不一致错误；`server/profile.ts` 登记（AC-1、AC-3、AC-8、AC-10）。
- [x] 3. **VAD Provider 与 sidecar**：`sherpa-onnx` 暴露 FSMN/Silero 两个 vad 模型和 `detectVoice`；Provider 注册表校验 role/status/结果；VAD 资源缺失显示 unavailable；补 `--vad-dump-json` 的 Host 级测试（AC-1、AC-2、AC-3、AC-10）。
- [x] 4. **候选生成与切点保护**：`shared/editing/silence.ts` 实现参数校验、VAD/word 并集、guard/retain、片头片尾、1ms 合并、现有 EDL 减法、稳定 id、无可剪区间；纯函数测试覆盖合法/非法/重叠/字词保护（AC-2、AC-4、AC-6、AC-10）。
- [x] 5. **界面、选择与预览**：新增 `SilenceCutPanel` 和 `silence` 文案，复用 `PendingSuggestionsList`；模型/参数/分析/取消/失败/无候选/无语音/过期状态；`TimelineWaveform` 只标 selected 红标，`EnhancedVideoPlayer` 只预览 selected；明暗、中英文（AC-1、AC-3、AC-4、AC-5、AC-6）。
- [x] 6. **原子应用、过期与历史**：应用前查 editRevision 与 Host revision；保存失败读回/回滚、保留候选和原剪辑、不写虚假历史；提交中禁用重复操作；撤销/重开历史验证（AC-7、AC-8、AC-9）。
- [x] 7. **导出 5ms 平滑与真实导出**：`joinFadeMs` 默认 5、可关闭；Host `afade` 只作用于内部接点，不改变输出时长；预览 Web Audio 近似或明确降级；真实导出检查声画/接点（AC-8、AC-10）。
- [x] 8. **验收、证据与文档**：新增 `tests/e2e/features/F-0006.spec.ts` 覆盖全部状态、明暗、中英文；两段真实未剪辑口播、真实 sidecar、真实导出、Web 同 Host、缺失媒体/无音轨/取消/过期；更新 frontend/cordis-host/providers 子系统说明和 screenshots/recordings（AC-1–AC-10）。

## 验证计划

- 每项完成跑：`pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`、`cargo check --manifest-path src-tauri/Cargo.toml`；全量跑 `pnpm test`、`pnpm test:architecture`、`pnpm build`。VAD/导出相关追加 `pnpm test:funasr-sidecar`、`pnpm test:fsmn-vad`、`pnpm test:smart-cut`。
- 新增 `tests/architecture/silence-cut-f0006.test.ts`：Host `silence.analyze` 的 strict schema 拒绝任意 path/asset；项目媒体 resolve、缺失、无音轨、时长不一致；VAD 段非法/空/重叠；默认参数和非法参数；1ms 合并、已有 EDL 减法、重复分析幂等；进度、取消、迟到结果不写项目；Provider role/status/capabilities。
- 新增 `tests/silence-cut.test.mjs`（或同等 shared 纯函数测试）：0.5/0.15/0.25 默认值；短于阈值不候选；片头/片尾；shorten 与 remove 的保留差异；字词区间切入保护；没有可靠字词默认不选；重叠去重；边界/越界/NaN/Infinity；空 VAD 不生成全删；稳定 id 和确定性。
- Red check：撤掉字词并集后，构造 VAD 间隙覆盖 word 的样本，测试必须失败并指出切入词；撤掉 retain/guard 后，删除模式与压缩模式的保留断言失败；撤掉 selected 过滤后，预览/应用扣了未选项；撤掉 editRevision 后，文本编辑仍能应用；撤掉 Host revision 检查后，跨窗口旧基准仍写 EDL；撤掉保存回滚后，失败仍留下新 EDL/历史；撤掉 `afade` 或时长约束后，导出接点或时长断言失败。
- `tests/e2e/features/F-0006.spec.ts` 按 AC 命名，覆盖：无模型、无音轨、参数非法、分析中/取消/失败、无候选/无语音、候选列表红标/选择、预览/当前、无字词提示、过期、应用中/应用失败、撤销/重开。用 `mockHost` 构造 `silence.analyze` 延迟/失败/取消和 `projects.open/saveVideoEdits` 竞态；正常路径用真实短素材。每个状态在 zh/en、light/dark 各截图，`pnpm e2e:evidence F-0006` 生成 screenshots/recordings。
- 真实 sidecar：用现有 demo 媒体和 `src-tauri/shared_assets` 的 FSMN/Silero 资源，启动真实 Host 项目，分别跑 FSMN 和 Silero；检查 `vadType`、段数、项目时长、候选和取消。缺资源时 Skip 并记录 Not run。
- 真实使用：两段未剪辑口播（现有测试资产/用户可提供的原始素材），逐条检查候选起止、误切/漏切，确认预览与导出的保留区间一致；删除和压缩两种模式都走一遍，播放器打开导出结果确认不吞字、接点可听。桌面 `pnpm tauri:dev` 用 linked 媒体，Web `pnpm dev` 用同一 Host 的 stored 媒体，确认候选/确认/导出一致。
- 导出验证：生成带可识别声画标记的短视频，至少一次内部剪切；用 FFmpeg 探测输出总时长等于 EDL 目标（误差不超过一帧），确认 `afade` 只在内部接点、关闭平滑后无 fade；检查源文件 mtime/hash 不变。无音轨、全删、空 EDL 分别验证错误/禁用，不生成非法文件。
- 60 分钟或等价长素材：记录 VAD 分析耗时、候选数、选择/确认/保存耗时；目标分析不阻塞 Host 其他 RPC，列表滚动和勾选不出现半更新状态。超出时先剖析，不用虚假进度或省略测试达标。
- 所有检查按 code-standards 的 Verification 格式记录；未执行项列 Not run（例如 Windows 打包、没有真实模型资源、没有桌面环境），不能把设计完成说成功能已验收。

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | VAD 模型列表、能力标记、无模型/无 sidecar 文案与设置入口；Host 只走 VAD，不回退字幕间隙；清单 2、3、5 |
| AC-2 | 默认 0.5/0.15/0.25、有限非负校验、minPause>0、保留不超过原停顿、短停顿不候选；清单 3、4 |
| AC-3 | 单 job、阶段进度、jobs.cancel、失败/取消/迟到结果隔离、参数或源编辑后过期；清单 2、4、5 |
| AC-4 | 候选数/预计减少/起止/原因、时间轴 selected 红标和文字图标、无候选文案、应用禁用；清单 5 |
| AC-5 | preview/current 切换、只预览 selected、未应用徽标、取消清标记、普通导出只用正式 EDL；清单 1、5 |
| AC-6 | VAD+word 区间并集、无可靠词时 warning/默认不选/confidence 降级、不按字数猜；清单 3、4 |
| AC-7 | 应用前 editRevision+Host revision 复核、提交中禁用、原子写 EDL+一条历史、失败保留原结果和候选；清单 1、6 |
| AC-8 | 预览与导出同一保留区间、5ms 可关闭 `afade` 不改时长、无音轨明确失败、源媒体只读；清单 2、7 |
| AC-9 | 撤销整轮、重开历史预览/回退、回退不撤回文字校对、缺失媒体/历史失败保留现状态；清单 1、6 |
| AC-10 | 桌面真实模型与导出、Web 同 Host、全删沿用 F-0005 禁用导出、重复分析/应用不重复扣时、原始媒体不改；清单 2、3、7、8 |

## 开发前置与规模复核

F-0005 已验收，依赖满足。设计范围是一个可独立验收的闭环：Host 分析 → 临时建议 → 预览 → 确认 → 导出；不拆成「先 Host、后 UI」的多个发布。实现清单 8 项按依赖顺序推进，预估不超过约两周；若实现中发现需要新增外部 VAD 协议、持久化建议或改变 EDL/项目格式，先停下来回 Epic/维护者确认，不扩大本需求。

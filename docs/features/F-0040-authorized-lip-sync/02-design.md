---
id: F-0040
stage: 02-design
status: draft
approved_by:
approved_at:
ai_review: fail
ai_reviewed_by: deepseek-v4.1-flash-reviewer
ai_reviewed_at: 2026-11-19
ai_review_note: 两轮未通过：确认门可信来源在现有架构下不成立（RPC 无调用方通道），交维护者在 (a)/(b)/(c) 中选择；其余第2轮项已由主会话修正并经第3次核对，见 B-01
---

# F-0040 授权口型同步与结果管理：设计

本设计以 [01-spec.md](01-spec.md) 的 AC-1 到 AC-9 为界。依据是已确认的 [F-0039 调研报告](../archive/F-0039-lip-sync-service-research/02-research.md)。调研结论是「暂不产品化，先做有条件试点」，真实质量、耗时和账单都还没有实测数据。因此真实服务相关的步骤全部排在试点结论之后执行，「能否开工」列为第一个需要维护者确认的问题。

约定：「请确认」后面是建议答案，需要维护者拍板；「需维护者确认的契约改动」列出所有会改动共用契约的点。

## UI / UX

新增口型同步面板，入口与声音克隆按钮并列，放在字幕编辑器工具栏（`src/components/SubtitleEditor/SubtitleList.tsx`，现有 `voice-clone-open` 旁，入口 testid `lipsync-open`）。状态由 hook 持有，沿用 `TrackDubbingPanel` 与 `SeparationPanel` 的做法，不新建全局 store，结果不写入前端持久化。

**文件**

| 文件 | 内容 |
|---|---|
| `src/hooks/useLipsync.ts`（新增） | 面板状态机：读取能力与记录、生成预览、提交、取消、刷新、删除本地产物。请求键为 `projectId + videoId`，迟到响应与当前键不一致时丢弃（AC-6）。参数形式与 `useTrackDubbing(modelGroups, onOpenSettings)` 一致 |
| `src/components/SubtitleEditor/LipsyncPanel.tsx`（新增） | 面板：配音轨道与混音模式（只读）、模型与服务商信息、预览卡（上传内容、时长、大小、接收方、保留条款、估算费用上限）、授权勾选、记录列表与每条记录的操作 |
| `src/components/SubtitleEditor/SubtitleList.tsx`（修改） | 增加入口按钮与面板挂载 |
| `src/locales/*`（修改） | 文案中英文成对新增 |

**Store 与 RPC**：不新增 store。面板只读 Host 记录，不写 `projectStore`，避免与 `projects.saveVideoEdits` 的整体覆盖冲突（见「接口与数据」）。RPC 见「接口与数据」。

**界面状态（中英文文案，验收截图按此逐一覆盖）**

| 状态 | 中文 | English | 入口 / 动作 | 触发条件 | e2e 构造 | 真实构造 |
|---|---|---|---|---|---|---|
| 加载中（AC-6） | 正在加载… | Loading… | 无 | `lipsync.capabilities` 或 `lipsync.list` 尚未返回 | 挂起 capabilities | 打开面板瞬间 |
| 无配音（AC-5） | 还没有配音，先完成配音再做口型同步 | No dubbing yet. Finish dubbing before lip sync. | 「去配音 / Go to dubbing」 | `reason: 'no-dubbing'` | capabilities 返回该 reason | 空项目 |
| 配音轨道不存在（AC-5） | 所选配音轨道不存在，请重新选择 | The selected dubbing track was not found. Choose another. | 轨道选择 | `reason: 'track-missing'` | 返回该 reason | 删除轨道后打开 |
| 项目在回收站（AC-5） | 项目已移入回收站，无法操作 | This project is in Trash and cannot be changed. | 「返回项目 / Back to projects」 | `reason: 'trashed'` | 返回该 reason | 回收站中的项目 |
| 模型不可用（AC-5） | 口型同步服务不可用：{reason} | Lip sync service unavailable: {reason} | 「去模型设置 / Open model settings」（调用 `onOpenSettings`） | `reason: 'model-unavailable'` 或 `no-key` | 返回该 reason | 不设置密钥 |
| 超出支持范围（AC-1） | 视频超过 {max} 分钟，暂不支持 | Videos over {max} minutes are not supported yet. | 禁用预览 | `reason: 'too-long'` | 返回该 reason | 超长视频 |
| 空态（AC-5） | 暂无内容 | Nothing here yet | 预览入口可用 | `list` 返回 `[]` | 返回空数组 | 新视频 |
| 预览就绪（AC-1） | 上传视频 {时长/大小}，配音 {时长}，接收方 {服务商}，保留条款 {链接}，估算费用上限 ${x}（以服务商账单为准） | Uploads: video {duration/size}, dub {duration}; recipient {provider}; retention terms {link}; estimated cost up to ${x} (provider invoice governs). | 「开始提交 / Submit」（需授权） | 预览成功 | `lipsync.preview` 返回 `LipsyncPreview` | 真实混音 |
| 未授权（AC-1） | 请确认本人或说话人授权（每次提交都需要确认） | Confirm you or the speaker have permission (required every time). | 提交禁用 | 勾选框为空 | 不勾选 | 同左 |
| 处理中（AC-2, AC-6） | 正在处理… + 阶段（排队、上传、处理中、下载、校验） | Processing… + stage (queued, uploading, processing, downloading, verifying) | 提交与预览禁用；可取消的显示「取消 / Cancel」 | 任务运行 | `jobs.get` 挂起并返回 `processing` 记录 | 试点服务 |
| 仅停止等待（AC-2） | 停止等待（服务商侧任务可能仍在处理并计费，FlyCut 无法停止） | Stop waiting (the provider job may keep running and billing; FlyCut cannot stop it.) | 「停止等待 / Stop waiting」 | 所选服务不支持远端取消 | `lipsync.cancel` 返回 `abandoned` | 试点服务 |
| 已完成（AC-7） | 已完成 | Completed | 播放、保存、删除本地产物；标注「AI 口型同步」 | Host 返回 `completed` | `lipsync.list` 返回 `completed` | 试点服务 |
| 失败（AC-8） | 原因：{reason}（服务商拒绝内容 / 网络断开 / 下载失败 / 校验失败） | Failed: {reason} | 「重试 / Retry」「返回 / Back」；保留预览，**授权勾选清空**，重试须重新勾选并重新确认（AC-1 逐次授权） | 记录 `failed` | `jobs.get` 返回 `error` | 断网、拒绝样例 |
| 已关闭未核实（AC-8） | 无法核实服务商是否已处理，已关闭这次提交。再次提交可能重复计费。 | Closed without verification. The provider may have processed this request; submitting again may be charged twice. | 「重新提交 / Submit again」（弹出新确认并提示重复计费）「返回 / Back」 | 记录 `closed-unverified` | `lipsync.refresh` 带 `acknowledgeUnknown: true` | 假服务不返回任务 |
| 重复提交（AC-3） | 这次提交已在处理，没有再次发送。 | This request is already being processed and was not sent again. | 自动跳到既有记录 | 返回 `duplicate: true` | 同一 `operationId` 连续调用两次 | 假服务计数 |
| 删除本地产物（AC-7） | 已删除本机的口型同步结果和输入副本。服务商可能仍保留上传的素材和成片，请到服务商后台按其条款处理。 | Local lip-sync result and input copies were deleted. The provider may still keep the uploaded media and output; manage them in the provider's console under its terms. | 「播放 / Play」「保存 / Save」「删除 / Delete」；删除后只剩「返回 / Back」 | `remoteRetained: true` | `lipsync.remove` | 本地目录不存在 |
| 结果不确定（AC-4, AC-8） | 无法确认提交结果，请先查询；核对前不能再次提交同一输入 | Submission result unknown. Refresh first. Do not resubmit the same input until checked. | 「查询 / Refresh」；「我已在服务商后台核对 / I checked the provider dashboard」 | 记录 `unknown` | 记录 `unknown` | 模拟断网（试点） |
| 版本过期（AC-3, AC-8） | 内容已更新，请重新检查 | Content changed. Review again. | 「重新预览 / Preview again」 | `list` 返回 `stale: true`，或提交返回 `stale` | `stale: true` | 修改配音后 |
| 已有进行中任务（AC-6, AC-8） | 该视频已有进行中的口型同步任务 | A lip sync job is already running for this video. | 提交禁用，显示当前记录 | 提交返回 `conflict: 'already-running'` | 返回该 conflict | 连续点击 |

明暗主题与中英文的每个状态都要截图并录屏（见「验证计划」）。

## 技术方案

### 涉及的子系统

- [docs/subsystems/providers.md](../../subsystems/providers.md)：新增 `lipsync` 角色与能力声明；视频输入为规则例外（见「接口与数据」）。
- [docs/subsystems/cordis-host.md](../../subsystems/cordis-host.md)：RPC 由插件注册并在 `shared/protocol.ts` 声明；`ProjectStore` 读写；长任务用 `ctx.jobs`；`server/profile.ts` 的 `BUILTINS` 登记。
- [docs/subsystems/frontend.md](../../subsystems/frontend.md)：hook 与面板、i18n、e2e 与截图录屏约定。
- [docs/subsystems/funasr-tauri.md](../../subsystems/funasr-tauri.md)：确认桌面端只经 Host 访问媒体；不新增 Tauri command，不传本地路径。
- [docs/decisions.md](../../decisions.md)：「模型 Provider」、「Agent 和 MCP / CLI 调用也不能跳过这一步，必须由用户本人确认」（声音克隆条目）、「成片默认标注 AI 配音」、「RPC 不接收任意本地路径」、「需求内部不拆任务」。

### 方案

**总体流程**：配音轨道 + 时间线投影（EDL） → 预览（Host 生成投影后的视频与配音音频，写入项目内预览文件，计算摘要） → 用户逐次确认授权并看到将上传的内容 → 提交（Host 校验摘要、授权、确认记录，写入记录，上传并提交远端任务） → 轮询 → 下载 → 内置 FFmpeg 探测与校验 → 原子写入产物并标记 `completed`。

1. **能力门槛（AC-1, AC-5）**：`lipsync.capabilities` 依次检查：项目存在且未在回收站（`trashed`）；视频存在；配音轨道存在（`track-missing`）；所有可说话条目都有未过期、未超长的配音（复用抽出的混音校验函数，见第 2 点）；模型 `ready`（`model-unavailable` / `no-key`）；投影后的视频时长不超过 `maxDurationSeconds`（`too-long`）。
2. **混音抽取（前置工作）**：`server/plugins/dubbing.ts` 的 `dubbing.mix` 处理器目前把校验与 ffmpeg 混音写在同一个 `ctx.jobs.create` 闭包里，没有可复用的函数。实现第一步必须先把校验（`missing` / `outdated` / `tooLong` / `backgroundMissing` 的计算）与 ffmpeg 参数构造抽成模块内函数（建议名 `mixDubbingTrack`，同文件导出），再让 `dubbing.mix` 调用它，行为不变，由 `dubbing-mix-f0037` 与 `dubbing-f0035` 测试回归。
3. **时间线投影（EDL）**：FlyCut 的剪辑真源是 `history.edl`（保留/删除区间，见 `shared/editing/edl`），导出走 `export.start` 的 `edl` 派生保留段。F-0040 与导出保持一致：预览时用同一派生保留段对源视频做投影（剪掉删除区间），配音的时间戳同样按投影映射（`shared/editing` 的映射函数）。结果视频因此与「导出后的成片时间线」一致，删除的内容不会被送去服务。删除区间变化后，预览与记录都按第 9 点标记过期。请确认：默认采用投影（见「自行决定」第 3 点）；备选是源时间线（删除片段仍保留在结果中）。
4. **预览（AC-1）**：`lipsync.preview` 是 `ctx.jobs.create` 任务。它调用 `mixDubbingTrack` 与投影函数，把结果写到 `videos/<videoId>/lipsync/previews/<previewId>.wav`（音频）与投影后的视频文件，计算 SHA-256 作为 `previewDigest`，返回：上传视频大小与时长、音频时长、服务商与模型、保留条款文本（来自模型声明）、估算费用上限（`时长 × 单价上限`，单价常量与来源日期写在 Provider 文件中）。预览 30 分钟过期，启动时清理过期预览。
5. **授权与来源（AC-1）**：每次提交都要带一份新的授权记录（`lipsyncAuthorizationSchema`，见「接口与数据」），含确认语句、确认时间、适用范围与「来源素材」。Host 只校验形状和时间，不存放可复用的授权。
6. **确认门（AC-1, 来源可信）**：Host 不信任调用方声明的 `source`（`server/plugins/confirmations.ts` 的 `input.source ?? 'cli'` 由调用方提供）。机制如下（需维护者确认，见「自行决定」第 6 点）：
   - 用户在界面中提交授权时，客户端先调用 `confirmations.create({ kind: 'lipsync-upload', target: { projectId, videoId, previewId, previewDigest } })`。
   - 用户在界面的确认卡中点击「批准」，客户端调用 `confirmations.decide`。
   - **已核实：按当前代码，这一步不能区分界面与 Agent。** `ctx.rpc.register` 的 handler 只收到 `input`（`server/plugins/rpc.ts`），Gateway 的 `/rpc` 分发不把鉴权类型传给 handler；桌面前端（`src/runtime/connection.ts`）与 CLI/MCP（`server/plugins/gateway.ts`）用的是同一种 bearer；`confirmations.decide` 的 `actor: 'ui-client'` 由调用方填写，`decidedBy` 无条件写入。任何持 bearer 的调用方都能自己 create 再 decide。F-0051 的测试也是同一通道直接批准的。所以「由 Host 写入可信 `decidedVia`」在现有架构下**不成立**，需要维护者在下面选一个方向（见「自行决定」第 6 条，AI 审查两轮未解决，交人工节点）：
     - (a) 新增一个只给本机桌面界面用的批准通道（例如 Tauri 外壳持有、不下发给 CLI/MCP 的独立 UI 令牌，Gateway 按令牌类型给 handler 传 `caller`），`decide` 只接受该通道；改动 `server/plugins/gateway.ts`、`server/plugins/rpc.ts` 的 handler 签名，是共用契约改动。
     - (b) 不追求技术上区分来源，接受「持 bearer 即视为本人」的现有信任模型（与 F-0051/F-0052 一致），在文档中写明 Agent 可绕过逐次确认的风险——这与 decisions.md「Agent 和 MCP / CLI 调用也不能跳过这一步，必须由用户本人确认」冲突，需维护者明确接受。
     - (c) 口型同步在 F-0040 中只开放界面，不向 MCP/CLI 暴露 `lipsync.*` 与对应确认 kind（工具清单层面排除），技术上仍可被持 bearer 的自写脚本调用。
     建议 (a)；规模评估按 (a) 另加 3–4 天。
   - `lipsync.submit` 只接受 `confirmationId`，要求该确认 `status: 'approved'`、`decidedVia: 'client-ui'`、`kind: 'lipsync-upload'`，且 `target` 中的 `previewDigest` 与提交内容一致。提交请求中的 `authorization.confirmed: true` 只作为形状校验，不作为授权依据。
   - 因此 Agent、MCP、CLI 调用 `lipsync.submit` 时，只能拿到「等待用户确认」的结果，不能直接上传。
   - 确认记录一次性使用（`consumed`），用于每一次提交。
7. **提交（AC-2, AC-3, AC-6）**：`lipsync.submit` 是 `ctx.jobs.create` 任务。在 `store.exclusive(projectId, ...)` 内检查：项目与视频存在且未在回收站；`previewId` 的预览存在且未过期；`previewDigest` 与重新计算的摘要一致，否则返回 `stale`；确认记录有效（第 6 点），否则返回 `unconfirmed`；该视频已有非终态记录则返回 `conflict: 'already-running'`；同一 `operationId` 已存在则返回既有记录（`duplicate: true`，不再次提交）；同一输入存在 `unknown` 记录则返回 `conflict: 'unknown-pending'`（见第 13 点）。之后：复制输入到 `lipsync/<recordId>/input-audio.wav` 与 `input-video.mp4`（预览可能被清理，记录必须自带输入副本）；先写记录（状态 `uploading`，含 `operationId`、授权、模型、估算、输入哈希），再发起远端请求；拿到 `remoteId` 后状态转 `processing`。
8. **轮询、远端不确定与取消（AC-2, AC-4, AC-8）**：轮询由 Provider 的 `pollLipsync` 完成，间隔与超时放在 Provider 文件中，并随 `signal` 中止。远端状态映射：排队/处理中 → `processing`；完成 → `downloading`；`FAILED` 与 `REJECTED` → `failed(remote)`，原因写入记录（`REJECTED` 显示「服务商拒绝了这段内容」）。提交请求超时或断开且拿不到 `remoteId` → 记录转 `unknown`。取消：Sync 的取消接口未核实，`cancelLipsync` 不实现，`lipsync.cancel` 只中止本地轮询，记录转 `abandoned`，返回 `remoteStopped: false`，界面文案同步。
9. **过期判定（AC-3, AC-8）**：`lipsync.list` 每次读取时重新计算当前指纹：视频媒体指纹（stored 用 `file + size`，linked 用 `fingerprint`）、视频时长、EDL 保留段的哈希、当前配音轨道每条的 `id + text + durationSeconds` 哈希。与记录的 `inputFingerprint` 不一致则返回 `stale: true`。过期记录保留文件，但面板不把它当作当前成片，也不作为「最新结果」提供下载。
10. **下载与校验（AC-4, AC-7）**：下载到 `lipsync/<recordId>/result.tmp`，失败最多重试 3 次（退避）。仍失败则记录转 `failed(download)`，保留 `remoteId`，用户点「查询」时 `lipsync.refresh` 重新获取结果地址后下载（结果地址有效期待核实）。下载完成后用**内置 FFmpeg** 探测（复用 `server/plugins/export.ts` 中的 `probeStderr` 与 `probeVideo` 解析逻辑，见「接口与数据」的抽取项，不使用 ffprobe 与系统 PATH）：存在视频与音频流；时长与输入音频时长相差不超过 `max(0.1 s, 1 帧)`；分辨率与输入视频一致（不一致时记录实际值并转 `failed(verify)`，是否容忍待试点判定）；文件大小大于 0。全部通过后原子重命名为 `result.mp4`，写入 `resultSha256`，状态转 `completed`。任何一步失败都不标成功。
11. **结果标识（AC-3, AC-7）**：结果存放在源视频目录下 `lipsync/<recordId>/result.mp4`，原视频、配音与授权记录不改。元数据 `comment` 写入 `AI口型同步 / AI lip-sync`，面板展示同样的标注。画面角标按既定决定的默认开启，是否实施见「自行决定」第 9 点。
12. **恢复（AC-7, AC-8）**：Host 启动时扫描记录：`processing` 且有 `remoteId` 的恢复轮询；`uploading` 且无 `remoteId`，或 `unknown`，标为 `unknown`；`downloading` 的重新下载。恢复不自动重复提交。
13. **unknown 的终态与再提交（AC-8）**：`unknown` 之后有三种结局。(a) `lipsync.refresh` 通过 `remoteId` 或服务商幂等键查到任务：转入正常路径（`processing` 或 `completed`）。(b) 查不到，用户点「我已在服务商后台核对」（`acknowledgeUnknown: true`）：记录进入终态 `closed-unverified`，不产生结果；对同一输入的新提交需要用户再次确认，并在确认卡中提示「可能重复计费」。(c) 用户不核对：记录保持 `unknown`，同一输入的提交持续被 `unknown-pending` 阻止。重试不复用旧 `operationId`（旧记录已关闭），因此不会被误判为重复。
14. **删除（AC-7）**：`lipsync.remove` 只删本地目录（结果、输入副本、记录），返回 `remoteRetained: true` 与说明。远端样本与成片是否可删取决于服务商条款：Sync 没有单作业删除接口（待核实）。界面必须说明，不宣称已删除。

**Provider 接入**：第一个服务作为内置 Provider 插件，参考 `server/plugins/indexTts302.ts`：`server/plugins/syncLipsync.ts` 注册 provider `sync-so`，模型 `lipsync-2`（F-0039 Q-5 第 1 优先级）。API Key 读取与 302.ai 一致：环境变量 `FLYCUT_SYNC_API_KEY`，其次 macOS 钥匙串 `flycut-sync`；缺少时模型为 `unavailable` 并给出 reason。基地址可用 `FLYCUT_SYNC_BASE_URL` 覆盖，便于测试指向本地假服务。协议细节按官方 `POST /v2/generate` 文档实现，字段与状态名以实现时核对的官方文档为准。

## 接口与数据

**共享契约（`shared/lipsync.ts`，新增）**

```ts
export const lipsyncAuthorizationSchema = z.strictObject({
  confirmed: z.literal(true),
  statement: z.string().trim().min(1).max(300),        // 请确认文案，见「自行决定」第 5 点
  confirmedAt: z.iso.datetime(),
  confirmationId: z.uuid(),                              // 指向 client-ui 批准的 lipsync-upload 确认
  sourceMaterial: z.strictObject({                       // 来源素材（F-0039 Q-4）
    videoId: z.uuid(),
    speakerLabel: z.string().trim().min(1).max(80),
    provenance: z.enum(['own', 'authorized-third-party']),
    note: z.string().trim().max(300).optional(),
  }),
  speakerScope: z.literal('single-speaker-front-face'),
});

export const lipsyncRecordSchema = z.looseObject({
  id: z.uuid(),
  operationId: z.uuid(),
  model: modelRefSchema,
  state: z.enum(['uploading', 'processing', 'downloading', 'completed', 'failed', 'unknown', 'closed-unverified', 'abandoned']),
  remoteId: z.string().min(1).max(200).optional(),
  failure: z.object({ stage: z.enum(['submit', 'remote', 'download', 'verify']), reason: z.string().max(500) }).optional(),
  inputVideoFile: z.string(),         // lipsync/<id>/input-video.mp4（投影后）
  inputAudioFile: z.string(),         // lipsync/<id>/input-audio.wav
  inputFingerprint: z.string().min(1),
  resultFile: z.string().optional(),
  resultSha256: z.string().optional(),
  durationSeconds: z.number().finite().positive(),
  estimatedMaxUsd: z.number().finite().nonnegative(),
  authorization: lipsyncAuthorizationSchema,
  acknowledgedUnknownAt: z.iso.datetime().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
```

`confirmations` 的 `lipsync-upload` 目标结构：`{ projectId, videoId, previewId, previewDigest }`。

**RPC（`shared/protocol.ts` 声明，`server/plugins/lipsync.ts` 注册）**

| 方法 | 输入（均为 `z.strictObject`） | 输出 | 说明 |
|---|---|---|---|
| `lipsync.capabilities` | `projectId`、`videoId`、`trackId` | `{ available, reason?, model?, maxDurationSeconds }` | 同步、只读 |
| `lipsync.preview` | `projectId`、`videoId`、`trackId`、`mode`（`audioMixModeSchema`）、`model` | `JobSnapshot`，结果为 `LipsyncPreview` 或 `unresolved` | 投影、混音、写预览文件，不上传 |
| `lipsync.submit` | **`projectId`、`videoId`**、`previewId`、`previewDigest`、`confirmationId`、`authorization`、`operationId` | `JobSnapshot`，结果为 `saved` / `duplicate` / `stale` / `unconfirmed` / `conflict` / `unresolved` | 写记录、上传、提交、轮询、下载、校验 |
| `lipsync.list` | `projectId`、`videoId` | `LipsyncRecordView[]`（含 `stale`，按创建时间倒序） | 只读，多客户端读同一份 Host 数据 |
| `lipsync.cancel` | `projectId`、`videoId`、`recordId` | `{ remoteStopped: false, state: 'abandoned' }` | 只停止本地等待 |
| `lipsync.refresh` | `projectId`、`videoId`、`recordId`、`acknowledgeUnknown?` | `JobSnapshot` | 查询远端并下载；`acknowledgeUnknown: true` 仅对 `unknown` 有效，写入 `acknowledgedUnknownAt` 并转 `closed-unverified` |
| `lipsync.remove` | `projectId`、`videoId`、`recordId` | `{ removed, remoteRetained: true, note }` | 只删本地 |

路由：`GET /projects/:projectId/videos/:videoId/lipsync/:recordId/result`，`auth: 'client'`、`queryToken: true`，仅 `completed` 且非过期的记录可取，`sendFile` 返回 `video/mp4`，支持 Range。

**Provider 契约（`shared/providers.ts`、`server/services.ts`）**

- `ModelRole` 与 `modelInfoSchema.role` 增加 `'lipsync'`。
- `ModelInfo.lipsync?: { maxDurationSeconds, async: true, cancel: boolean, delete: boolean, zdrContract: boolean, termsText: string }`。
- `Provider` 可选方法：`submitLipsync(modelId, { videoPath, audioPath, operationId, durationSeconds }, signal, report): Promise<{ remoteId }>`；`pollLipsync(modelId, remoteId, signal): Promise<{ status, resultUrl?, reason? }>`；`downloadLipsync(modelId, resultUrl, targetPath, signal)`；`cancelLipsync?`、`deleteLipsync?` 只在核实后实现。
- **例外（需维护者确认）**：`providers.md` 规定 Provider 收到的总是 16 kHz 单声道 PCM16 WAV。口型同步的输入是视频（服务商要求整段视频），因此 `submitLipsync` 收到的是视频文件路径与配音 WAV 路径。理由：视频无法降采样为音频 WAV 而保留画面；例外只适用于 `lipsync` 角色，不改变其他角色的输入规则。`providers.md` 需要在该角色条目下补充这一条说明。
- `server/plugins/providers.ts` 注册表增加对应方法，缺能力时抛出「不支持口型同步」，写法与 `separate` 一致。

**需维护者确认的契约改动（汇总）**

1. `shared/providers.ts`：`ModelRole` 与 `modelInfoSchema` 增加 `lipsync`；`ModelInfo` 增加 `lipsync` 字段。
2. `server/services.ts`：`Provider` 增加 `submitLipsync` / `pollLipsync` / `downloadLipsync`（输入为视频路径，是上条规则的例外）。
3. `shared/confirmations.ts` 与 `server/plugins/confirmations.ts`（已对照代码核实，需要的改动）：`confirmationKindSchema` 增加 `lipsync-upload`；`confirmationTargetSchema` 目前是只含 projectId/projectName/videoId/videoName/outputName/format 的 `z.strictObject`，需要按 kind 区分的 target（增加 `previewId`、`previewDigest`）；`enrichAndValidateTarget` 对未知 kind 走 overwrite-export 分支（要求 `outputName`），需要增加 `lipsync-upload` 分支；`confirmations.decide` 对非 overwrite-export 的 kind 会直接执行并置为 `executed`，需要让 `lipsync-upload` 停在 `approved`；`confirmations.consume` 目前只接受 overwrite-export，需要扩展到 `lipsync-upload` 以实现一次性消费。`defaultSummary` 的 switch 需要增加 `lipsync-upload` 分支（否则类型检查失败）。新增字段 `decidedVia: 'client-ui' | 'other'`（现有只有调用方可填的 `decidedBy`），只有选方向 (a) 时由 Host 按 `caller` 写入；选 (b)/(c) 时不新增该字段，`lipsync.submit` 只校验 kind、status、target 摘要与一次性消费。
4. `shared/protocol.ts`：声明 7 个 `lipsync.*` RPC，并在 `RpcMethods` 中对齐 `confirmations.*` 的输入。
5. `shared/projects.ts`：不改动（见下条）。
6. `server/plugins/dubbing.ts`：抽出 `mixDubbingTrack`（行为不变，内部重构）。
7. `server/plugins/export.ts`：把 `probeVideo`（模块级函数，第 20 行）与 `probeStderr`（`export` 插件闭包内，第 71 行）抽到共享模块（建议 `server/lib/ffmpegProbe.ts`），导出路径与 F-0037 测试保持不变（内部重构）。
8. `server/profile.ts`：`BUILTINS` 登记 `flycut-lipsync` 与 `sync-lipsync`，`provides` 包含 `lipsync` 相关服务（见实现清单第 4 项）。

**项目存储（不改 `edits.json`，不升格式版本）**

- 新文件 `<project>/videos/<videoId>/lipsync/records.json`，内容 `{ version: 1, records: LipsyncRecord[] }`，只经 `ProjectStore` 读写（新增 `lipsyncDir`、`lipsyncRecordsFile`、`lipsyncPreviewFile`，路径校验同 `separationDir`）。
- 写入都在 `store.exclusive(projectId, ...)` 内，先写临时文件再重命名（与 `dubbing.ts` 一致）。
- 删除视频或彻底删除项目时，`removeVideoFiles` 删除整个 `videos/<videoId>`，记录与产物一并删除。
- 旧项目读取为空列表，无需迁移。

## 备选方案与取舍

1. **记录放入 `edits.lipsync`（F-0039 Q-4 的建议）vs 独立 `records.json`（采用）**。F-0039 Q-4 建议 `edits.lipsync`。取舍：`projects.saveVideoEdits`（`server/plugins/projects.ts`）整体写入客户端提交的 edits，不区分服务端字段；Host 后台轮询完成后写入的记录，会在用户下一次自动保存时被客户端旧副本覆盖，违反 AC-7「重开结果一致」。`dubbings` 与 `separation` 能共存，是因为它们在前端 edits 中被完整回传；口型同步的记录由异步任务写入，窗口更大。独立文件避免该竞态，代价是多一个文件与一份读取路径。若维护者坚持 `edits.lipsync`，需要先修改 `saveVideoEdits` 保留服务端拥有的字段，那是共用契约改动，不在本设计内。
2. **内置 Provider 插件（采用）vs HTTP Provider 协议扩展**。HTTP Provider v1 协议不含口型同步，扩展它会开放给用户自建服务，且这些服务的保留条款与授权没有经过核实。内置插件可在 `ModelInfo.lipsync.termsText` 中固定条款。代价：新增服务需要发版。
3. **结果作为源视频下的产物（采用，待确认）vs 作为新项目视频（`projects.addVideo`）**。01-spec 的 AC-3 写「保存为新视频」。新增项目视频需要复制字幕、EDL、样式与历史，并保持两份数据同步，超出「结果管理」的范围；产物方式只需要播放、保存、删除。若维护者选择新视频，实现项需要增加 `projects.addVideo` 调用、字幕与 EDL 的复制策略，规模显著增大，需要重新评估（见「规模评估」）。
4. **预览时投影 EDL（采用，待确认）vs 源时间线**。投影与导出一致，删除内容不送去服务、费用更低；代价是预览要多做一次视频切割，且删除区间变化会使记录过期。
5. **本地模型（自研或分发 Python）**：被 01-spec 排除，不再讨论。

## 架构决策

- 本设计不创建 ADR。
- **建议（不在本设计创建）**：为新的口型同步存储格式（`lipsync/records.json`、产物目录、预览与输入副本的结构）与「内置 Provider 接入 + 视频输入例外」的边界各写一份 ADR，参照 [ADR-0015 项目配音存储](../../20-architecture/adr/0015-project-cue-dubbing.md) 的做法。01-spec 第 91 行要求新存储格式与接口边界写 ADR。编号与标题待实现前确定（当前最大编号为 0015，建议 0016 起），由维护者决定是否创建。

## 自行决定的事项

1. **请确认：能否在试点结论前开工。** F-0039 结论是「暂不产品化，先做有条件试点」，并写明没有试点证据不得进入 F-0040 的实现。建议：契约、Host 状态机（假 Provider）、混音与投影抽取、界面可以先做；真实服务步骤（真实提交、质量判断、费用核对、发布）等试点结论。试点不达标则 F-0040 暂停，回到调研结论。影响 AC-1、AC-2、AC-4、AC-9 的真实部分。
2. **请确认：第一个服务选 Sync.so `lipsync-2`，内置插件接入。** 依据 F-0039 Q-5 优先级（文档完整、有幂等键与 ZDR 条款）。备选 HeyGen `v3/lipsyncs`（有删除接口，但官方价格未核实）。
3. **请确认：时间线。** 默认按 EDL 投影后的时间线预览与提交（与导出一致），备选源时间线。
4. **请确认：结果形式。** 默认产物方式（见备选 3）。若选新视频，本设计需要补充字幕与 EDL 的复制策略。
5. **请确认：授权语句与来源字段。** 中文草案：「这是我本人的画面和声音，或我已获得画面中人物的授权」。英文版待定。`provenance` 取值 `own`（本人）或 `authorized-third-party`（经授权的第三方），`note` 可选。每次提交都要求重新勾选，无「记住本次授权」。
6. **请确认（AI 审查两轮未解决）：确认门的可信来源。** 已核实现有 RPC 不能区分界面与 Agent/CLI（见「方案」第 6 点）。三个方向：(a) 新增仅本机界面持有的批准通道并把 `caller` 传给 handler（建议，改 `server/plugins/gateway.ts`、`server/plugins/rpc.ts`，共用契约改动）；(b) 接受「持 bearer 即本人」并书面接受与 decisions.md 的冲突；(c) 只在界面开放口型同步、不进 MCP/CLI 工具清单。选择影响 AC-1 的覆盖和规模。
7. **请确认：支持矩阵。** 源视频为单个正面说话人、无明显遮挡；配音语言为中文或英文（即 F-0040 能力覆盖中英配音，与 AC-9 的英文正面样例一致）。侧脸、遮挡、多人属于 F-0039 定义的失败边界，不在支持范围内。画面中是否符合由用户在授权勾选中确认，不做人脸检测（超出 01-spec 范围）。**10 分钟上限来自 F-0039 试点预算（$30 以内），不是已确认的支持矩阵**，请维护者确认是否作为正式上限。
8. **请确认：费用。** 预览显示估算费用上限（Sync `lipsync-2` 单价上限约 $0.05/秒，访问日期 2026-11-17，实现时重新核对）。建议：单次估算超过 $30 需要二次确认。
9. **请确认：AI 标注（偏离既定决定，需明确批准）。** `docs/decisions.md` 规定成片默认标注「AI 配音」，标注可为字幕或画面角标，默认开启。本设计的结果视频默认只在元数据与面板中标注「AI 口型同步」，不烧入画面，属于偏离。建议：实现角标（在第 10 点的校验后用 FFmpeg `overlay` 叠加，字体打包需要待核实），使其符合既定决定；若维护者批准偏离，则记录在测试报告中。
10. **自行决定：`operationId` 与服务商幂等键。** 客户端生成 UUID，记录先写入，重试时复用，Host 返回既有记录（`duplicate: true`），并作为服务商 `Idempotency-Key`。幂等键保留 7 天（F-0039 来源）；超过 7 天的重试按新提交处理，确认卡提示可能重新计费。
11. **自行决定：轮询参数。** 初始 5 秒，指数退避至 30 秒，总超时 60 分钟。超时进入 `unknown`，不是 `failed`。
12. **自行决定：取消语义。** 对 Sync 只能「停止等待」，界面文案按此设计。
13. **自行决定：unknown 的终态（AC-8）。** 见「方案」第 13 点：`closed-unverified` 为终态，之后允许再次提交，但每次需新确认并提示可能重复计费。

## 风险与回退

| 风险 | 影响 | 处理 |
|---|---|---|
| 质量不达标（口型、脸部伪影、背景、首尾） | 功能不能发布 | 按 F-0039 Q-2 的盲评门槛判定；不达标则暂停，不影响已有配音功能 |
| 账单与估算不符（失败重试、下载、存储） | 费用超预期 | 预览写明「以服务商账单为准」；超过上限需二次确认 |
| 远端不可取消、不可单独删除 | 用户以为已停止或已删除 | 文案固定为「停止等待」「本地删除」，并显示远端保留说明 |
| 提交结果未知 | 重复收费或丢失结果 | `unknown` 与终态规则（第 13 点）；试点验证 409 返回内容（待核实） |
| 确认来源无法可靠识别 | Agent 或脚本绕过本人确认 | 第 6 点机制；若 Gateway 无法提供可信通道标识，则重新设计（只开放 client 通道），在 1 项中先核实 |
| 下载地址过期或下载失败 | 已付费结果拿不到 | 保留 `remoteId`，`lipsync.refresh` 重新取地址；试点验证有效期（待核实） |
| 配音、源片或 EDL 变化 | 旧结果被误用 | 指纹比对，`stale`，不作为当前成片 |
| 大文件上传（10 分钟视频） | 上传失败或耗时过长 | 试点记录大小与耗时；Sync 上传上限待核实，超限在能力检查中以 `too-long` 拒绝 |
| Host 重启 | 远端状态丢失 | 启动恢复（第 12 点），不自动重提交 |
| 备份导出包含结果与输入副本 | 隐私与体积 | 核实 F-0023 备份是否包含 `videos/<id>`（待核实）；若包含，备份说明中告知 |
| 客户端自动保存覆盖记录 | 丢失记录 | 独立 `records.json`（备选 1） |

**回退**：功能由内置 Provider 的 `ready` 状态与 `BUILTINS` 登记控制。移除登记或未配置密钥时，`lipsync.capabilities` 返回 `model-unavailable`，面板显示说明，不显示假成功。已完成的结果仍可在本地播放与删除。数据格式未变化，无需迁移。

## 规模评估

- 工作量：约 7 个实现项，涉及共享契约 4 处、两处内部重构（`mixDubbingTrack`、FFmpeg probe 抽取）、2 个新插件、1 个新 hook、1 个新面板、i18n、三类测试。单人加 AI 开发估计 8–10 个工作日，不含试点与外部等待。
- 重算（第 2 轮审查后）：确认门需要改 `confirmations` 契约 6 处（+1–2 天）；按建议方向 (a) 新增可信 UI 批准通道（+3–4 天）。合计约 12–16 个工作日，**超过两周**。
- 结论：建议拆分为两个需求：F-0040a「契约、可信确认通道、Host 状态机与假服务」与 F-0040b「真实服务接入、结果管理与界面」；若维护者选 (b) 或 (c)，约 9–12 天，可以不拆。是否拆分请维护者确认。
- 试点与真实环境（账号、授权素材、桌面 Tauri 验证）不计入上述估计。

## 与同批次需求的重叠

- **F-0029 跨平台字幕校验**：可能共用字幕投影与校验函数；若 F-0029 修改 `shared/editing` 的映射，F-0040 的第 3 点需跟随。`mixDubbingTrack` 不属于 F-0029 范围。
- **F-0054 桌面自动更新**：二者都可能在 `shared/protocol.ts` 与 `server/profile.ts` 的 `BUILTINS` 中增加条目。合并时以行为最小改动为准，先合并者先定，另一方跟随；本设计不改动 F-0054 的相关条目。
- `shared/protocol.ts` 是最可能的共享冲突文件，`shared/confirmations.ts` 次之。

## 实现清单

- [ ] 1. 共享契约与存储：`shared/lipsync.ts` schema（授权、来源素材、记录、预览、RPC 入参与出参）；`shared/providers.ts` 增加 `lipsync` 角色与能力；`shared/protocol.ts` 声明 7 个 RPC；`ProjectStore` 路径方法；单元测试覆盖授权缺失、来源缺失、路径注入、时长越界。
- [ ] 2. 内部重构：抽出 `mixDubbingTrack`（`server/plugins/dubbing.ts`）与 `server/lib/ffmpegProbe.ts`（来自 `server/plugins/export.ts`），`dubbing.mix` 与 `export.start` 行为不变，由 `dubbing-mix-f0037`、`dubbing-f0035`、`export` 相关测试回归。
- [ ] 3. 预览与能力检查：`lipsync.capabilities`、`lipsync.preview`（含 EDL 投影）、预览摘要与过期清理、`no-dubbing`、`track-missing`、`trashed`、`too-long` 原因；确认门：`confirmations` 的 `lipsync-upload` kind、按 kind 的 target schema、`enrichAndValidateTarget` 分支、`decide` 停在 `approved`、`consume` 一次性消费，以及按「方案」第 6 点所选方向实现的可信来源；负向测试：用 bearer 直接 create + decide 后调用 `lipsync.submit`——选 (a) 时应被拒绝；选 (b) 时记录为已接受的风险并断言审计记录写明调用方；选 (c) 时断言 MCP/CLI 工具清单中没有 `lipsync.*`。
- [ ] 4. 提交状态机（假 Provider）与 Provider 插件：`lipsync.submit` 的摘要、确认、`stale`、`already-running`、`duplicate`、`unknown-pending`；`lipsync.list` 的 `stale`；`cancel` 语义；`server/plugins/syncLipsync.ts` 对本地假 HTTP 服务的集成测试（`Idempotency-Key`、状态映射、409、退避）；`server/plugins/lipsync.ts` 与 `syncLipsync.ts` 在 `server/profile.ts` 的 `BUILTINS` 登记。真实服务的调用在试点结论后执行。
- [ ] 5. 结果校验、恢复与角标：下载重试、`refresh`、内置 FFmpeg 校验（真实生成的测试视频）、原子写入、结果路由（Range）、Host 启动恢复、`lipsync.remove`、`unknown` 的三种结局；角标按「自行决定」第 9 点的结论实施或维持。
- [ ] 6. 前端面板与入口：`useLipsync`、`LipsyncPanel`、`SubtitleList` 入口、i18n 中英文、界面状态表全部状态（含加载中与 reason 文案）。依赖第 3、4 项的契约。
- [ ] 7. 验证与试点：Web e2e（F-0040 spec，中英文 × 明暗主题，截图与录屏）、架构测试、`pnpm acceptance:f0040` 真实试点脚本与试点记录。真实服务步骤在试点结论给出后执行，未执行的写 `⏸ Not run`。

依赖：1 → 2 → 3 → 4；5 依赖 4；6 依赖 3、4 的契约，可与 5 并行；7 最后。清单只记录进度，不设门禁（decisions.md「需求内部不拆任务」）；需要真实服务的步骤在试点结论给出后执行。

## 验证计划

平台：**桌面端（macOS Tauri）优先，Web 复用同一 Host**。

**每项完成时的基础检查**：`pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`、`pnpm test`、`pnpm test:architecture`、`cargo check --manifest-path src-tauri/Cargo.toml`（本需求必跑）。

**架构测试**：`pnpm test:architecture` 运行 `dubbing-mix-f0037`、`separation-f0041`，以及本需求新增的 `tests/architecture/lipsync-f0040.test.ts`（Host 状态机、授权、来源、确认门、路径）与 `tests/architecture/lipsync-sync-f0040.test.ts`（本地假 HTTP 服务）。`pnpm test` 只用于单元测试。

**逐条 AC**（命令在仓库根目录执行）

| AC | 平台 | 自动化用例 / 命令 | 预期断言 | 真实验证 |
|---|---|---|---|---|
| AC-1 | Host | `pnpm test:architecture`，`lipsync-f0040` 中的 capabilities 与 submit 用例 | 无授权、无确认、摘要不符、超时长、无配音时，假 Provider 的 `submitLipsync` 调用次数为 0 | 试点：用授权素材预览，核对界面上传内容与文件实际大小 |
| AC-1 | Web | `pnpm test:e2e tests/e2e/features/F-0040.spec.ts -g "AC-1"` | 未勾选时提交禁用；预览卡显示接收方与估算上限；确认卡出现 | 无 |
| AC-2 | Host | `lipsync-f0040` 中的轮询用例：`processing → completed`，`cancel` 后 `abandoned` 且 `remoteStopped: false` | 状态与取消语义正确 | 试点：排队与处理期间取消，核对服务商后台状态（截图） |
| AC-2 | Web | `F-0040.spec.ts -g "AC-2"`（假 Host 挂起的任务） | 界面显示「正在处理…」与阶段；取消后显示「停止等待」与远端说明；无「已完成」 | 无 |
| AC-3 | Host | `lipsync-f0040` 中的过期用例：修改配音文本、删除一条配音、修改 EDL、替换媒体 | `stale` 为真；`result.mp4`、源视频、配音、授权记录仍在；`edits.json` 未改动 | 试点：完成后修改配音，核对面板标记 |
| AC-3 | Host | 同一 `operationId` 连续两次提交 | 第二次 `duplicate: true`，假服务只收到一次 | 试点：服务商后台只能看到一个任务 |
| AC-3 | Web | `F-0040.spec.ts -g "AC-3"`：`stale: true` 的记录 | 显示「内容已更新，请重新检查」；无下载为当前成片的入口 | 无 |
| AC-4 | Host（内置 FFmpeg） | `lipsync-f0040` 中的下载失败三次、校验失败、时长超限用例（校验逻辑单元用例，不代替真实验收） | `failed(download)` / `failed(verify)`，从未出现 `completed` | 试点：真实拒绝样例；断网步骤写入脚本，由人执行 |
| AC-4 | Host | 提交超时与 409 分支 | 记录 `unknown`；同一输入的提交返回 `unknown-pending`；`refresh` 可查询 | 试点：验证 409 返回内容（待核实） |
| AC-4 | Web | `F-0040.spec.ts -g "AC-4"`：`unknown` 与 `failed(download)` 状态 | 显示「无法确认提交结果」与「查询」；「提交」禁用 | 无 |
| AC-5 | Web | `F-0040.spec.ts -g "AC-5"`：各 reason、空态 | 文案与入口与状态表一致；空态显示「暂无内容 / Nothing here yet」；项目内其他编辑仍可用 | 无 |
| AC-6 | Web | `F-0040.spec.ts -g "AC-6"`：capabilities 挂起、预览挂起、切换视频时迟到响应 | 「加载中 / Loading…」「正在处理… / Processing…」显示；提交禁用；迟到响应不改变当前视频面板；连续点击只产生一次提交 | 无 |
| AC-7 | Host | `lipsync-f0040` 中的完成与重启用例 | 完成后 `list` 一致；重启后记录可读；两个客户端读同一项目结果一致 | 试点：完成后重启桌面应用，结果可播放 |
| AC-7 | Web（具体用例） | `F-0040.spec.ts -g "AC-7"`：两个浏览器上下文连接同一真实 Host；A 完成一次试点任务；B 刷新后读取 | B 中同一记录状态为「已完成」，播放地址可取，`lipsync.list` 返回值与 A 一致；「已完成」只在 Host 返回 `completed` 后出现 | 真实 Host 与真实服务，试点结论后运行；未运行写 `⏸ Not run` |
| AC-7 | 桌面（macOS） | 手动步骤（自动化入口待 F-0058） | 结果可播放、可保存；原视频可播放 | 必须：真实 Tauri 中完整流程，记录版本与日期 |
| AC-8 | Web | `F-0040.spec.ts -g "AC-8"`：失败原因、重试、返回、版本过期、已有进行中任务 | 文案与按钮与状态表一致；重试保留预览、授权勾选被清空且需重新确认 | 试点：真实拒绝样例 |
| AC-8 | Host | 重试语义：确定性失败后新 `operationId` 可再提交；`closed-unverified` 后需再次确认 | 不重复收费；`failure.reason` 有值；确认卡提示可能重复计费 | 试点：确认重试计费 |
| AC-9 | Web（中英文 × 明暗主题） | `pnpm test:e2e tests/e2e/features/F-0040.spec.ts`，`pnpm e2e:evidence F-0040` | 每个状态一张截图；录屏存入 `recordings/`（与 F-0037、F-0041 同一约定，文件名含 AC 编号、状态、主题、语言） | 无 |
| AC-9 | 桌面（macOS） | 手动 + 截图与录屏 | 与 Web 相同状态的截图与录屏 | 必须：真实 Tauri 中一次完整流程与关键状态 |
| AC-9 | 远程 Host | 同一用例指向远程 Host | 列出远程结果 | 远程环境未准备：`⏸ Not run（缺少远程 Host 与服务凭据）` |
| AC-9 | 真实服务 | `pnpm acceptance:f0040`（新增，需 `FLYCUT_SYNC_API_KEY` 与 `ACCEPTANCE_F0040_VIDEO`） | 按 F-0039 试点方案：3 段已授权素材（中文正面、英文正面配音、侧脸或遮挡的失败样例），每段 15–30 秒；记录耗时、账单、三人盲评（1–5 分） | 缺服务账号或授权素材时报告 `⏸ Not run` 与阻塞原因，不以假服务替代 |

**试点的人工评估**：盲评门槛按 F-0039 Q-2（口型主观均分 ≥ 4/5，无严重脸部伪影，背景无可感知变化，首尾误差 ≤ 1 输出帧）。试点记录写入本需求目录的验收文件，不写入 F-0039 的已确认报告。

**需要真实环境的部分**：真实服务上传、生成、下载、取消（如适用）、删除（如适用）；真实授权素材；桌面端完整流程。缺任何一项时在测试报告写 `⏸ Not run` 并写明原因。

## 验收标准覆盖

本表只覆盖 01-spec 的 AC-1 至 AC-9；每条依赖的「请确认」事项已注明。

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | 「方案」第 1–7 点（能力门槛、投影、预览、授权与来源、确认门、提交）；UI / UX「预览就绪」「未授权」「超出支持范围」；RPC `lipsync.capabilities`、`lipsync.preview`、`lipsync.submit`；自行决定 1、3、6、7、8 |
| AC-2 | 「方案」第 7–8 点（提交、轮询、取消语义）；Provider 契约 `submitLipsync` / `pollLipsync`；UI / UX「处理中」「仅停止等待」；自行决定 11、12 |
| AC-3 | 「方案」第 4、7、9、11 点（投影与预览、输入副本、过期判定、结果标识）；项目存储（独立 `records.json`，备选 1）；产物方式（备选 3，依赖自行决定 4）；UI / UX「版本过期」；自行决定 4、9、10 |
| AC-4 | 「方案」第 8、10、13 点（远端不确定、下载与内置 FFmpeg 校验、unknown 终态）；风险表「提交结果未知」「下载地址过期」；UI / UX「结果不确定」；自行决定 13 |
| AC-5 | UI / UX「无配音」「配音轨道不存在」「项目在回收站」「模型不可用」「空态」；`lipsync.capabilities` 的 `reason` 取值；回退说明 |
| AC-6 | UI / UX「加载中」「处理中」「已有进行中任务」；hook 按 `projectId + videoId` 丢弃迟到响应；Host 的 `already-running` 与前端禁用；取消文案 |
| AC-7 | 「方案」第 10、11、12、14 点（校验、标识、恢复、删除）；RPC `lipsync.list`、`lipsync.remove`、结果路由；验证计划的 Web 双上下文用例；UI / UX「已完成」 |
| AC-8 | 「方案」第 9、13 点；UI / UX「失败」「结果不确定」「版本过期」「已有进行中任务」；自行决定 10、13；风险表 |
| AC-9 | 验证计划（逐条 AC 的平台与命令、截图与录屏约定、真实环境阻塞规则）；UI / UX 的状态表（中英文与明暗主题） |

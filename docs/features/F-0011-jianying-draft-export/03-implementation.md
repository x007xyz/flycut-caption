---
id: F-0011
stage: 03-implementation
status: approved
approved_by: auto
approved_at: 2026-11-10
---

# F-0011 剪映草稿导出：开发记录

## 分支与 PR

- 分支：`codex/f0011-jianying-export`
- PR：

## 进度

<!-- 每完成实现清单的一项，在 02-design.md 勾选，并在这里追加一行：日期、清单项、提交 sha、跑过的检查。
换会话接着做时，先读 02-design.md 和这里。 -->

| 日期 | 清单项 | 提交 | 检查 |
|---|---|---|---|
| 2026-11-10 | 1. 共享能力/preflight/start/source 契约、非重叠校验和能力对象 | `5a886f8`, `7b8feac` | 默认/内部模式、严格 source 联合、重叠字幕拒绝；Host 类型检查通过 |
| 2026-11-10 | 2. Host 目录 grant、冻结、job、持久幂等和原子 staging | `d00c4f6`, `7b8feac` | F-0011 Host 6/6：shell-only/CORS、一次性 grant、server linked-media 硬拒绝、丢回包/重启幂等、独立时间和失败清理 |
| 2026-11-10 | 3. Tauri 原生目录选择 shell 外壳 | `7b8feac` | `cargo test ... jianying_output` 2/2；只返回 opaque grant |
| 2026-11-10 | 4. 完整导出面板状态机与中英文 | `c72cff2`, `7b8feac` | 目录、准备、进度、取消、错误、成功和默认/Web 禁用；20 个中英明暗 Playwright 用例通过 |
| 2026-11-10 | 5. Host/生成器/回读/安全失败测试 | `5a886f8`, `d00c4f6`, `7b8feac` | 非重叠明显时间字幕、独立期望、SHA-256、同级 staging 清理、取消和 post-copy failure 通过 |
| 2026-11-10 | 6. 全量静态/回归与界面证据 | `7b8feac` | 静态 4 项、架构 97/97、F-0011 E2E 20/20；两段口播/编辑/重开/搬迁/Windows 仍 Not run |

## 自行决定的事项

<!-- 开发中自己决定的事：决定了什么、为什么、影响哪条 AC。验收时汇总进测试报告 -->

- 能力对象按设计使用 `checkedAt`，并在矩阵中实际渲染调研日期；新增 Web 目标行，明确候选生成只支持桌面 Host。影响 AC-1。
- 检查失败页只提供重试，不显示生成按钮；加载中同样没有目录选择或导出动作。影响 AC-1、AC-5、AC-8。
- 候选 harness 在调用 FFmpeg 前先检查源媒体；文件缺失直接报 `Source media is missing`，便于区分媒体错误与解码失败。影响 AC-6。
- `preflightId` 同时作为确定性 job ID，并持久化 operation→job 关联。普通 RPC 仍只收 opaque ID；并发、回包丢失、重复调用和 Host 重启后返回同一个 JobSnapshot。影响 AC-2、AC-5。
- linked 项目媒体由 desktop 默认允许、server profile 硬拒绝。resolved profile 早于普通 patch 生效，配置/env 不能在 server 暗开本机路径。影响 AC-3。
- 投影后的主字幕区间若重叠则 preflight 失败，不让 Mac 导入自行串排。新测试字幕使用文本内时间标识，验证是独立期望，不拿生成器自检冒充软件时序。影响 AC-7。

## 与设计的偏差

<!-- 实现时改变了设计的地方及原因；重大偏差回到 02-design.md 修改，并记进测试报告 -->

- 默认产品仍禁用；显式 `internalValidation` Host 才注册 preflight/start/shell 目录 route。所有写入口仍不进入正常发行路径。
- 目录授权分为 15 分钟 grant 和 10 分钟 preflight，preflight 绑定 grant；start 后 operation 持久化。这样既保持短授权，也能查回已启动任务。
- 设计清单从 5 项细化为 6 项：把 Tauri 外壳、Host 幂等和独立验证拆开，便于 03 记录检查。

## 遗留问题

### 本机 macOS 11.7.0 兼容性复核

- 按维护者指示使用本机剪映专业版 11.7.0。只读检查带 `Timelines/project.json` 的五个本地样本：五个根 `draft_info.json` 和对应时间线 `draft_info.json` 均不是可直接解析的 JSON，外层为 Base64；其中两个另留有可解析的旧 `draft_content.json`。没有修改已有草稿。
- 用 `scripts/jianying-candidate.ts` 和仓库 demo 视频在临时目录生成 Windows 5.9.0 明文候选，生成器完成回读校验：3 段视频、4 段字幕、21,091,224 字节的媒体副本。现有本地草稿用于确认格式；候选产物用于测试 FlyCut 的输出。
- 在 Mac 剪映的「文件 → 找回草稿」进入候选目录并尝试打开 `draft_content.json`；随后桌面自动化超时，未观察到候选进入时间线，也未得到应用明确拒绝的证据。macOS 导入、播放、改字幕、保存重开仍未验证，产品导出继续禁用。

### 候选产物只读复核（2026-11-10）

- 沿用主 agent 已生成的 `/private/tmp/f0011-mac.l9QZ7q/F0011-Mac-Validation`，没有新建或修改剪映草稿，也没有修改本机五个用户样本。
- 用 `verifyJianyingDirectory` 只读复核：`draft_content.json` 与 `draft_info.json` 字节相同，SHA-256 都是 `d712cb235a970a4a3353994f619ec4abb8d5f44dbd1f5744aa7bb6ff55e5fa25`；3 个视频段、4 个投影文本段。
- 复制媒体为 21,091,224 字节，SHA-256 为 `ac51c81d497e6faafd4750615b89b2530d12e3f8077aff2eda10b597a3a7f90d`，与仓库 `src/assets/demo.mp4` 一致；封面是 1280x720 JPEG。
- 这证明候选结构、EDL 投影、媒体复制与回读校验一致，不证明任何剪映版本能导入、播放或编辑。

### 已登记测试候选与本机导入动作（2026-11-10）

- 测试候选显示名为 `F0011-Mac-Validation-20261109-2358`，是草稿库中唯一以 `F0011-Mac-Validation-` 开头的测试项。它只用于 F-0011 实机验证，不属于用户现有草稿。
- 只读检查剪映的 `Log/draft_acion_watch.json`：2026-11-09 23:58:03 EST 有一条 `type:"copy_draft_external"`、`errno:0`、`suc:true` 的动作记录，目标正是上述测试候选。这说明本机剪映 11.7.0 已成功执行外部草稿复制/导入动作，并生成唯一的测试候选目录。
- 测试候选随后出现在 `root_meta_info.json` 的 `all_draft_store`，`draft_timeline_materials_size=21091224`、`tm_duration=199200000`。候选目录仍保留明文 `draft_content.json` 和 `draft_info.json`，尚未观察到向 `Timelines` 私有格式的迁移。
- 只读回读候选：3 个视频段、4 个投影文本段、30 fps、1280×720、199.2 秒；`draft_content.json` 与 `draft_info.json` 字节一致，SHA-256 为 `765befead8d4b17a62534dedc9585cd7e0271481660ce0c949f8ce603988f89e`。本次没有修改或删除该候选。
- 时间线核对点：视频目标区间为 `[0,5)`, `[5,19)`, `[19,199.2)` 秒，对应源区间 `[0,5)`, `[6,20)`, `[21,201.2)` 秒；测试字幕目标区间为 `[1,5)`, `[4.5,5)`, `[5,5.5)`, `[20,22)` 秒，其中连续两段是跨首个切点的投影结果。
- 主 agent 重连 `/Applications/VideoFusion-macOS.app` 时再次返回 CUA `timeoutReached`，未观察到时间线，也没有得到应用明确拒绝。该结果只能记为“导入/复制动作成功，打开与编辑未观察”，不能记为 AC-7/AC-9/AC-10 通过。
- 下一条实机路径应从剪映现有窗口的草稿列表直接打开已登记的 `F0011-Mac-Validation-20261109-2358`，不再重复启动/重连或再次导入同一候选。进入时间线后先核对 199.2 秒、3 个视频段与 4 条字幕，再决定是否继续播放、字幕编辑和保存重开。

### Mac 候选实际打开与播放（2026-11-10）

- 维护者在对话中确认已从本地列表打开 `F0011-Mac-Validation-20261109-2358`，原话为「已进入时间线」。这是打开结果的确认，不是整个 F-0011 的验收批准。
- 主 agent 随后通过原生 UI 观察到同名候选，播放器总时长 `00:03:19:06`（30 fps，即 199.2 秒），视频轨显示三个连续保留区间，画面能够读取复制媒体。按空格播放后，时间码从零前进，画面和音频电平变化，并看到生成文字 `F0011 第二段实现`；这里只确认播放和文字可渲染，未逐帧核验字幕时序或听校音画同步。
- 对该测试候选执行保存并关闭到首页后，首页仍显示同名卡片与 `03:20` 的取整时长。只读检查发现根 `draft_info.json`、`draft_meta_info.json` 已改为非 JSON，且新增 `Timelines/<id>/draft_info.json`；旧的明文 `draft_content.json` 仍保留。文件修改时间与本次操作相符。这说明 Mac 11.7.0 能将该旧明文候选读入并保存为新格式，不能再断言「明文格式一律无法打开」。
- 未修改任何用户原有草稿。测试候选的字幕编辑、保存后重开、目录搬迁、两段真实口播及完整产品导出链路仍未验证。坐标点击测试候选卡片返回 `noWindowsAvailable`，因此未将保存后重开记录为通过。
- 产品入口继续禁用；支持矩阵和未来启用条件应以本次新增的 Mac 实测事实继续完善，不从单个候选推导其他版本或全部字幕能力可用。

#### 字幕时序实机核对（2026-11-10）

- 在剪映 11.7.0 的同一测试候选中，用时间码定位和逐帧/十帧导航，以应用可访问时间码为准检查，屏幕截图可能滞后于播放器时间，不拿旧截图覆盖时间结论。
- `00:00:01:12` 显示「F0011 第一段真实字幕」（契约 `[1,5)`）；`00:00:05:08` 显示「F0011 跨切点字幕」且第一段消失（契约覆盖 `[4.5,5)` 与 `[5,5.5)`）；`00:00:20:00` 显示「F0011 第二段实现」，`00:00:21:16` 仍显示，`00:00:22:16` 不再显示（契约 `[20,22)`）。这与回读的四个目标区间一致。
- 截图和播放帧可能被 ScreenCaptureKit 延迟，因此记录同时保存应用时间码。此次仍未验证字幕轨道在剪映内直接编辑、保存后重开或目录搬迁；原生应用坐标点击返回 `noWindowsAvailable`，不以程序修改草稿代替 UI 编辑证据。

### 完整产品导出链路实现（2026-11-10）

- 正常 Host 仍只注册只读 `jianying.capabilities`，`exportEnabled:false`，没有目录 route/preflight/start。内部验证通过环境变量或 Host profile 显式开启，能力和界面都标“仅内部验证”。
- Tauri `pick_jianying_output_directory` 只打开原生目录选择器；路径经 shell secret 登记，WebView 只收到 `{grant,expiresAt}`。命令拒绝文件、符号链接和不存在目录。
- Host 重新校验目录、realpath、写权限和同名目标；grant 15 分钟，preflight 10 分钟。preflight 检查资产/项目媒体、probe 时长/尺寸、非重叠字幕和空间，并绑定 grant。
- `jianying.start` 只收 preflight ID。preflight ID 作为确定性 job ID，operation→job 关联写到 `<home>/jianying/operations/`；并发、丢响应、重复调用和 Host 重启后用同一 preflight 返回同一 JobSnapshot。operation 指向缺失 job 时失败关闭，不重新启动。
- linked 项目媒体 desktop 默认允许，server profile 在 resolved profile 层硬拒绝。普通 profile patch 或 env 即使把 `allowLinkedMedia` 改 true 也不能在 server 暗开。
- Host 任务报告复制/哈希/封面/写 JSON/回读/提交进度；signal 贯穿 probe、复制、hash、FFmpeg 和阶段检查。staging 只在成功后同级 rename，取消/失败 finally 清理。
- 面板接入正式 EDL、字幕、主样式、项目和视频身份。准备时冻结快照；准备后锁定输入，成功后显示项目、视频、冻结时间、输出路径和导入说明。
- 生成器拒绝投影后字幕重叠。新测试使用 `F0011 A 01-01.8`、`B 03-07`、`C 10-12` 等文本自带时间标识的非重叠字幕；测试把源/目标区间写成独立期望，不依赖生成器回读自证。
- 重新生成候选 harness 也改成非重叠字幕。Mac 20–22 秒时序结论只属于已登记测试候选，不自动推广到所有 Mac 草稿或字幕样式。

### 回归与证据（完整实现）

- `pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`、`cargo check --manifest-path src-tauri/Cargo.toml` 通过。
- `node --import tsx --test tests/architecture/jianying-f0011.test.ts`：6/6 通过，覆盖默认 fail-closed、内部写路径、shell-only/CORS、一次性 grant、server linked-media 硬拒绝、丢回包/重启幂等、独立时间、SHA、重叠拒绝、取消和 staging 清理。
- `cargo test --manifest-path src-tauri/Cargo.toml jianying_output`：2/2 通过，覆盖真实目录、文件拒绝和符号链接拒绝。
- `pnpm test:architecture`：97/97 通过。主 agent 提示的既有 WebSocket snapshot 竞态已改为等两帧发完再断开；重跑全绿。
- `pnpm test`：95 通过、3 跳过、0 失败。跳过是 3 个未下载模型；真实 FunASR/demo、FSMN + Silero VAD 与其它可运行集成测试已执行。
- `PW_PORT=5181 pnpm e2e:evidence F-0011`：20/20 通过；32 张截图在 `screenshots/`，20 段录屏和摘要在本机忽略目录。5173 被其他 worktree 占用，本轮统一使用维护者指定 5181；`playwright.config.ts` 增加 `PW_PORT` 覆盖，避免复用错误分支。
- 只读复用的本地资源仅来自原分支：`tests/media`、FFmpeg/FunASR sidecar 和 FSMN VAD 权重。链接均在忽略位置，不进入提交；完成后清理。

### 剩余门禁与下一步可行验证

- **AC-1/AC-8 产品门禁：** 正常发行仍禁用；内部验证构建已具备完整 Host/UI 链路，但成功文案明确标内部，不能作为正式支持。
- **AC-7 字幕：** 已登记 Mac 候选用一个目标核对 AX currentProgress 的 20–22 秒显示区间；字幕编辑仍未验证。重叠输入已被新实现拒绝，避免目标应用自行串排。
- **AC-9 搬迁：** `⏸ Not run`。复制媒体不等于绝对路径移动后仍可用，不宣称通过。
- **AC-10 两段真实口播：** `⏸ Not run`。仍需两段不同原始口播分别完成字幕/EDL、在目标应用播放、编辑字幕、保存后重开；同一 demo 切段不能冒充。
- **保存后重开：** 已观察旧候选保存迁移，但未能在 UI 中重新打开核对；保持 `⏸ Not run`。
- **Windows 5.9.0：** `⏸ Not run`，本机无目标环境。
- **产品内部链路实机：** 本轮实现后尚未在 Tauri 里从新按钮实际选择目录并生成；主 agent 需用显式内部验证构建补这条真实使用证据。生成器单测/E2E 不能替代。
- 因此 02/03 可自动确认并创建 04，但 04 只能列真实缺口并请维护者验收；不得 approve 04、推送、合并或把 ADR 改为 accepted。

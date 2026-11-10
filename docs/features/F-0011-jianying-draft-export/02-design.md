---
id: F-0011
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-10
---

# F-0011 剪映草稿导出：设计

## UI / UX

顶部「导出」菜单中的「剪映草稿 / Jianying draft」打开真实导出面板。面板先读取 `jianying.capabilities`，再按四种能力状态显示：加载、读取失败可重试、默认禁用矩阵、显式内部验证。所有文案有中英文，全部状态在明暗主题下跑 E2E。

| 状态 | 界面 | 可执行动作 |
|---|---|---|
| 加载 | “正在检查剪映草稿支持信息…” | 无，按钮不出现 |
| 读取失败 | “无法读取剪映草稿支持信息”，显示重试 | 重试只重新读取能力，不创建任务 |
| 正常发行版 | Windows 候选、Mac 有界导入证据、其他版本/CapCut/Web 不支持；固定显示产品导出门禁未过 | 无目录选择、无 preflight、无 start |
| 显式内部验证 | 明确写“仅内部验证”，展示 Mac 20–22 秒字幕已核对、编辑/重开/搬迁/两段素材未验证 | 选目录、冻结快照、生成、进度、取消 |
| 无法冻结 | 无视频、EDL 未就绪、无字幕、画面尺寸未知或字幕重叠 | 说明原因，不创建任务 |
| 目录未选/已选 | Host 只收到 opaque grant；不向 WebView 返回路径 | 已选后可准备 |
| 准备成功 | 显示项目、视频、冻结时间、视频段/不重叠字幕段、复制大小、可用空间、明确降级清单 | 开始生成或放弃 |
| 生成中 | “正在生成剪映草稿…”，Host 进度百分比和阶段；开始键禁用 | 取消 |
| 取消 | “已取消生成”，说明临时目录已清理、既有目录和原媒体未改 | 重新选目录再开始 |
| 失败 | 区分媒体缺失、空间不足、权限、字幕重叠、同名冲突、目录授权失效和格式失败 | 重试要求重新选择目录 |
| 成功 | “草稿已生成”，显示项目、视频、冻结时间、输出路径和导入说明 | 用户到剪映本地找回/导入 |
| Web | 明确不支持本地目录写；即使远端错误返回启用能力也不显示写入流程 | 无 |

冻结快照在“准备导出”点击时生成。面板从正式 `history.edl`、非删除字幕、主样式、画面尺寸和项目身份取值；待确认建议不属于正式 EDL/字幕状态，因此不进入快照。准备后编辑输入被锁定；Host 保存快照副本，后续本地编辑不会改变草稿。

## 技术方案

### 涉及子系统

- [cordis-host](../../subsystems/cordis-host.md)、[architecture-current](../../architecture-current.md)：RPC、job、asset、shell-only route 和 Host 业务。
- [frontend](../../subsystems/frontend.md)：导出菜单、面板状态机、正式 store 和 E2E。
- [funasr-tauri](../../subsystems/funasr-tauri.md)：只新增原生目录选择外壳命令；不新增业务 Tauri command。
- [F-0005 设计](../F-0005-unified-edit-decisions/02-design.md)：正式 EDL 与字幕投影。
- [ADR-0009](../../20-architecture/adr/0009-jianying-draft-export.md)：门禁、授权和原子写入。

### 契约

`shared/protocol.ts` 声明：

- `jianying.capabilities: void -> JianyingCapabilities`，始终存在且默认 `exportEnabled:false`、`exportMode:'disabled'`。
- `jianying.preflight: {directoryGrant,draftName,source,snapshot} -> {preflightId,expiresAt,...}`，只在内部验证 Host 注册。
- `jianying.start: {preflightId} -> JobSnapshot`，只在内部验证 Host 注册。

`source` 是严格判别联合：`{kind:'asset',assetId}` 或 `{kind:'project',projectId,videoId}`。任何 path、mediaRef、outputParent 额外字段都被 Zod 拒绝。`snapshot` 只含冻结 EDL、字幕、映射后的主样式、尺寸和项目/视频元数据。

### 目录与媒体授权

1. Tauri `pick_jianying_output_directory` 选择文件夹，检查真实目录和符号链接，canonicalize 后通过 shell secret POST `/shell/jianying/directories`；命令只返回 `{grant,expiresAt}`。
2. Host 再次执行路径检查，把 canonical parent、15 分钟 TTL 和 consumed/绑定 preflight 状态保存在内存。没有 shell token 或带 Origin 的请求由 Gateway 拒绝。
3. preflight 校验 grant 未用、目标名安全且不存在、媒体存在、probe 时长/尺寸与快照一致、字幕投影不重叠、空间足够；成功后绑定 grant 并生成 10 分钟 TTL 的 preflight。
4. start 只接受 preflight ID，创建 job 前原子消费 grant/preflight。preflight ID 同时作为确定性 job ID，`operation→job` 关联持久化；并发、回包丢失、重复调用或 Host 重启后用同一 preflight 都返回同一 `JobSnapshot`，不创建第二任务。Host 重启后未消费授权失效，但已启动任务可查回。
5. 项目来源由 `ProjectStore` 解析 saved/linked media；资产来源由 `assets.path` 解析。任何路径都不经过普通 RPC。desktop 默认允许 linked 项目媒体，server profile 固定拒绝；即使 profile patch/env 把配置写成允许，resolved profile 检查仍会关闭。
6. source 保存 size/mtime/指纹；start 前再次核对，复制结束后再核对。源文件变化则失败并删除 staging。

### 生成与任务

- `buildJianyingDraft` 校验冻结快照，按 F-0005 `deriveKept/projectCues` 生成三段视频轨道模型和单主字幕轨；字幕目标区间必须严格不重叠。
- `generateJianyingDraft` 在同父目录写 staging：复制媒体、双端 SHA-256、生成 JPEG 封面、写三份 JSON、回读验证，最后 `rename`。signal 贯穿 FFmpeg、复制、哈希和每个阶段。
- Job 把复制字节进度映射到 10–55%，后续哈希/封面/写入/回读/提交到 100%。取消由通用 `jobs.cancel` 中断 signal，`finally` 删除 staging。
- 成功结果含项目/视频身份、冻结时间、输出路径、复制字节、段数/字幕数和降级 key。UI 在准备和成功状态都展示身份与时间。
- 不写 `root_meta_info.json`，不自动打开剪映。

### 格式与回读

只写 Windows 5.9.0 候选：`draft_content.json`、字节一致的 `draft_info.json`、`draft_meta_info.json`、`draft_cover.jpg`、`materials/`。回读检查两份 content 字节一致、版本/platform、轨道/material/speed 引用、视频源与目标区间、字幕时间/文本、最终媒体路径、大小/SHA-256 和 JPEG。

测试用文本本身带时间标识的非重叠字幕，并在测试中写独立期望数组；生成器内部回读只证明结构与冻结输入一致，不能替代目标应用时序。Mac 11.7.0 的支持状态记录：一个候选导入并播放；AX `currentProgress` 在 20:00/21:16/22:16 核对 20–22 秒字幕；第一条约 1.4 秒、跨切点约 5.08 秒显示且前条消失。字幕编辑、保存后重开、搬迁和两段真实口播仍未验证。

### 备选方案与取舍

| 方案 | 取舍 |
|---|---|
| shell-only 目录 grant + Host 任务 | 采用；符合 Host 业务和普通 RPC 无路径 |
| 普通 RPC 接目录 | 拒绝；推翻既有安全边界 |
| zip 后由 Tauri/Rust 改 JSON | 拒绝；格式业务离开 Host，失败清理和回读分散 |
| 默认启用“实验”按钮 | 拒绝；真实门禁未完全通过，AC-1/8 不允许伪可用 |
| 引用源媒体 | 拒绝；源文件移动即失联，当前也未证明可搬迁 |

## 架构决策

更新 [ADR-0009](../../20-architecture/adr/0009-jianying-draft-export.md)，保持 `proposed`：Host 完整链路、内部验证门禁、shell-only opaque grant、一次性 preflight、原子 staging、媒体复制、非重叠字幕和 Mac 有界证据。维护者验收前不得改 `accepted`。

## 自行决定的事项

| 事项 | 决定 | 原因 | AC |
|---|---|---|---|
| 默认可用性 | 正常 Host 不注册写 RPC/route | 正式目标仍缺编辑、重开、搬迁、两段素材和平台证据 | AC-1/8 |
| 内部验证开关 | 环境变量或 Host profile 显式启用 | 允许主 agent 用真实产品链路补设备证据，同时不冒充支持 | AC-1/5/8 |
| 字幕轨道 | 只写单主字幕轨，并拒绝重叠投影 | Mac 对重叠输入有自动重排风险，不能静默改变时序 | AC-7 |
| 目录授权/任务恢复 | 15 分钟 grant + 10 分钟 preflight；preflight ID=job ID，operation 关联持久化 | 授权短生命周期；重复 start/丢回包返回同一 job | AC-3/5 |
| 媒体来源 | 项目来源传 ID，独立编辑器通过既有 asset 上传 | 避免下载再上传，也不接任意本机路径 | AC-3/4 |
| 错误重试 | 失败后要求重新选目录 | start 已消费 grant，避免同一授权被继续复用 | AC-6 |
| 搬迁 | 不宣称支持 | 当前绝对媒体路径未通过真机移动验证 | AC-9 |

## 实现清单

- [x] 共享能力/preflight/start/source 契约、非重叠校验和默认/内部验证能力对象。
- [x] Host shell-only 目录 grant、preflight、冻结快照、任务进度/取消、staging 原子提交和失败清理。
- [x] Tauri 原生目录选择与 shell 登记外壳，只返回 opaque grant。
- [x] 导出面板完整状态机、中英文文案、冻结快照、进度/取消/重试/成功和 Web 禁用。
- [x] Host/生成器/回读/安全失败测试，使用非重叠明显时间字幕和独立期望值。
- [x] 中英明暗 Playwright 覆盖、全量静态/回归检查和证据产物。

## 验证计划

1. `pnpm check:host`、`node --import tsx --test tests/architecture/jianying-f0011.test.ts`：默认 fail-closed、内部写 RPC、shell-only/CORS、grant 一次性、server linked-media 硬拒绝、start 丢回包幂等与 Host 重启查回、项目/资产来源、冻结、非重叠、独立时间、SHA、同级 staging 清理和取消。
2. `cargo test --manifest-path src-tauri/Cargo.toml jianying_output`：真实目录、文件拒绝和符号链接拒绝。
3. `PW_PORT=5181 pnpm exec playwright test tests/e2e/features/F-0011.spec.ts`：中英明暗下加载、错误、默认禁用、Web 禁用、目录、准备、进度、取消、错误、成功；断言正式 EDL 生成的冻结字幕和唯一 start。
4. `pnpm e2e:evidence F-0011` 生成截图和录屏；在 5181 运行，避开其他 worktree 的 5173。
5. 全量 `pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`、`cargo check`、`pnpm test`、`pnpm test:architecture`；复用原分支已有且本分支缺失的只读测试资源，链接只在本地忽略位置。
6. 真实设备：Mac 已有单候选时序证据；内部构建链路和主 agent 后续编辑/重开/搬迁核对；两段真实口播与 Windows 未通过项写 `Not run`。

## 验收标准覆盖

| AC | 设计与验证 |
|---|---|
| AC-1 | 默认能力/UI 禁用；Mac 仅显示有界证据；写方法仅在内部构建存在；Host 和 Playwright 断言 |
| AC-2 | 点击准备冻结 EDL/字幕/样式/身份；Host 保存副本；准备/成功显示项目视频时间；后续 UI 锁定 |
| AC-3 | 原生目录选择 + shell-only grant；普通 RPC 无 path；同名拒绝；取消选目录不建任务 |
| AC-4 | preflight 显示 copy 策略、大小/空间；媒体复制并 SHA；原文件只读 |
| AC-5 | Job 进度、取消和唯一 start；取消中止复制/FFmpeg/哈希，清理 staging |
| AC-6 | 媒体/空间/权限/重叠/同名/授权/格式分类；失败不留最终半成品；可重选重试 |
| AC-7 | 非重叠主字幕轨道和 EDL 投影独立回读；Mac 20–22 秒时序已核对；字幕编辑未跑 |
| AC-8 | 内部成功仅显示“草稿已生成”并标内部；正常产品不显示成功；给出路径和导入说明 |
| AC-9 | 仍 `Not run`；不因复制媒体宣称移动后可打开 |
| AC-10 | 单候选 Mac 时序有证据；两段原始口播和编辑/重开仍缺，04 不得因此通过 |

## 风险与回退

- 正常发布仍不能使用剪映导出；内部验证开关不能进入普通用户默认配置。
- 绝对媒体路径导致搬迁风险；失败关闭，不猜相对路径。
- Mac 导入可能串排重叠字幕，因此产品快照拒绝重叠；已有单候选的旧重叠事实不能在报告中当作成功。
- 实机编辑、重开、搬迁、两段口播和 Windows 仍需主 agent/维护者补充；缺证据时 04 结论只能是需要修复/重测。
- 如果目录命令、shell route 或原子 staging 失败，所有写入通道失败关闭，不退回前端路径或 zip 改写方案。

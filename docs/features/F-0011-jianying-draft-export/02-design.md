---
id: F-0011
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-09
---

# F-0011 剪映草稿导出：设计

## UI / UX

在顶部「导出」菜单增加「导出剪映草稿 / Export Jianying draft」，复用现有导出对话框的 Radix Dialog 外壳，新增独立的 `JianyingDraftExportPanel`。入口先向 Host 读取 `jianying.capabilities`，界面不自行猜系统或版本。

支持矩阵只展示 F-0010 已经检查过的对象：

| 目标 | 展示 | 行为 |
|---|---|---|
| 剪映 Windows 5.9.0 明文草稿 | **候选 / 实验性 / 尚未实机验证 / Unverified candidate** | Windows Host 可生成候选草稿；结果只写「候选草稿文件已生成」，不能写「支持剪映」或「已通过导入」 |
| 其他 Windows 5.9.0 build | **不支持此草稿版本 / Unsupported draft version** | 禁用导出 |
| macOS 11.7.0（Timelines/私有封装） | **不支持此草稿版本 / Unsupported draft version** | 禁用导出，不尝试解密或生成伪格式 |
| CapCut | **不支持此草稿版本 / Unsupported draft version** | 不在范围 |
| Web Host / 非 Tauri | **桌面端 Windows 候选格式尚未验证；Web 暂不支持 / Desktop Windows candidate is unverified; Web is unsupported** | 禁用目录导出 |

候选目标卡片同时列出能力边界：单时间线、单视频轨、单主字幕轨、按原媒体切点；媒体复制到草稿目录；不更新用户的 `root_meta_info.json`；不承诺字体、精确定位、副字幕或双语；真实剪映打开/播放/编辑/搬迁验证仍未完成。

界面状态和文案：

1. 检查中：`正在检查剪映草稿能力… / Checking Jianying draft support…`，导出按钮禁用。
2. 不支持：红色说明，显示上面的 `不支持此草稿版本 / Unsupported draft version`，不创建任务。
3. 候选可配置：显示草稿名、目标支持矩阵、媒体「复制打包」策略、预计空间、完整样式降级清单、取消与「生成候选草稿」。副字幕/双语和字体等不支持项必须在用户勾选「已阅读样式降级」后才允许继续。
4. 选择位置：桌面原生目录选择器；取消不创建任务、不上传媒体、不调用 `jianying.start`。选择后只拿到 opaque `directoryGrantId`，界面不显示或接收 Host 本地路径。
5. 同名冲突：在任务开始前显示「同名目录已存在」和「改名 / 取消」，不覆盖。目标名也做 Windows 文件名与路径穿越校验。
6. 生成中：固定显示 `正在生成剪映草稿… / Creating Jianying draft…`、阶段进度和取消按钮；重复点击由按钮锁和 Host `requestId` 幂等双重挡住。
7. 失败：显示媒体丢失、空间不足、权限错误、目录 grant 过期、格式校验失败或生成失败的具体原因，可重试；明确说明本次临时产物已清理，既有目录未改动。
8. 成功：显示 `候选草稿文件已生成 / Candidate draft files created`，同时显示「剪映 Windows 5.9.0 实机导入尚未验证」，项目名、视频名、目标草稿名、媒体策略和导出时间；提供「在文件夹中显示」和「用剪映打开后需要核对切点与字幕」的说明。成功文案不冒充 AC-7/9/10 已通过。

所有状态覆盖明暗主题、中英文。E2E 使用 Host 路由 mock 构造加载、不支持、冲突、进度、取消、失败、成功状态；真实目录生成、文件内容、媒体字节和回读由 Host 架构测试及真实视频命令验证。

## 技术方案

### 涉及的子系统

- [cordis-host](../../subsystems/cordis-host.md)、[architecture-current](../../architecture-current.md)：新增 Host 业务插件，RPC 注册、任务、资产和 shell route。
- [frontend](../../subsystems/frontend.md)：导出菜单、导出面板、当前项目/视频快照、明暗主题与中英文 E2E。
- [funasr-tauri](../../subsystems/funasr-tauri.md)：目录选择与 shell-only Host 通道；不新增业务 Rust 命令。
- [F-0005 设计和验收](../F-0005-unified-edit-decisions/02-design.md)：EDL、`deriveKept`、`projectCues` 是唯一时间映射来源。
- [F-0010 研究](../archive/F-0010-jianying-draft-research/02-research.md)：Windows 5.9.0 明文候选、字段结构、媒体策略和未验证项。

### 方案

Host 新增 `jianying` 插件，唯一负责校验快照、探测媒体、生成草稿、复制媒体、回读验证和原子落盘。事件、取消和进度复用现有 `jobs`，不新增并行任务系统。

**目标门禁。** `jianying.capabilities` 返回结构化矩阵，来源带 `research: F-0010`、检查日期和 `verifiedByImport: false`。只有 `process.platform === 'win32'` 且处于 Tauri 桌面形态时，目标显示 `candidate`，返回 `formalSupport: false`、`experimental: true`。其他平台返回不支持。前端没有切换平台或伪造 verified 的配置。真实导入未通过时，验收结论固定为未通过/Not run，不能仅凭能力字段转成正式支持。

**导出快照。** 点击「生成候选草稿」时，前端同步从当前 React/store 状态 `structuredClone` 一个不可继续变化的快照：项目 ID/名称、视频 ID/名称、EDL、句子字幕、当前主字幕样式、视频宽高和预期时长。`pendingSuggestions`、`historyPreview`、`textHistoryPreview` 不读取；词级 chunks 不发送，草稿只按 `projectCues(edl, sentenceChunks)` 生成。后续编辑不能修改已提交 payload。

**时间映射。** EDL 全部保留整数微秒。每个 `deriveKept` 区间生成一个视频 segment：`target.start = outputStartUs`、`target.duration = endUs-startUs`、`source.start = startUs`、`source.duration` 相同。每个 `projectCues` 结果生成一个文本 material + text segment，使用投影后的微秒时间。跨切点字幕由 `projectCues` 拆段；生成器不另算时间。探测到的源时长必须与 `edl.sourceDurationUs` 在既有 50 ms 媒体探测容差内一致。

**字幕能力。** 只导出主字幕。样式只写 F-0010 有字段证据的颜色、透明度、粗体/斜体/下划线、描边颜色/宽度、字号和间距候选值；字体 family、精确定位、背景 padding、副字幕和双语不承诺。界面始终列出「字体会使用剪映默认值，字号/位置/换行需导入后复核；副字幕和双语不会写入」。

**媒体策略。** 固定为「复制到草稿目录」。前端先上传原媒体资产；Host 验证资产存在和字节大小，再复制到 `<draft>/materials/`。JSON 的绝对路径在最终目录确定后写入，并且在临时目录生成 JSON 时也使用最终目录路径。原媒体只读，不移动、不删除。预计空间取上传前 `videoFile.size`，Host 实际复制时仍处理 `ENOSPC`。媒体副本与上传资产分别计算 SHA-256，防止复制损坏；不创建空文件。

**目录 grant。** Tauri 新增原生目录选择 action：用户选择父目录后，Rust 立即用启动 Host 时生成的 shell secret 调用 `POST /shell/exports/jianying/directories`。该 route 只接受无 `Origin` 的 shell bearer，校验路径绝对、存在、是目录、可写，并 `realpath` 规范化；生成随机 `grantId`，绑定当前 Host generation、用户本次选择、15 分钟 TTL，不把路径返回前端。

`jianying.preflight` 只接收 `grantId + assetId + draftName`，用于读取媒体大小、同名冲突和安全名校验；`jianying.start` 使用同一 grant，校验 asset/name 未变化并一次性消费。普通 RPC 永远不接收本地路径。grant 到期、Host 重启、资产不一致或目录被替换时失败关闭。落盘前后对父目录 realpath、最终目标与 staging 的 `lstat` 检查，拒绝符号链接和穿越；目标名拒绝 `/`、`\`、控制字符、`.`/`..`、Windows 保留名。

选择成功后可调用 shell-only `POST /shell/exports/jianying/locate` 获取已创建草稿的真实路径，Tauri 只用它执行「在文件夹中显示」。前端仍只拿 `grantId`。该通道只对 shell secret 开放，server profile 无 shell token 时关闭。

**原子生成。** Host 在用户选择父目录的同一文件系统创建 `.${draftName}.flycut-${uuid}.tmp`，依次复制媒体、生成封面、写 `draft_content.json`、字节复制 `draft_info.json`、写 `draft_meta_info.json`，执行回读验证，最后用 `rename` 移到 `<parent>/<draftName>`。开始和提交前各检查最终目标不存在。取消、失败、ENOSPC、权限错误或校验失败只删除本次 staging；绝不删除既有目录。成功 rename 后不再接受取消的清理，任务报告已完成。

**不更新根索引。** 不读取、不写 `root_meta_info.json`，避免改用户剪映资料库。成功界面明确说明草稿目录位置和打开方式；能否被剪映自动发现仍属于真实导入验证。

**回读校验器。** `verifyJianyingDraft` 重新解析三份 JSON，检查 `draft_info.json` 与 `draft_content.json` 字节一致、版本/platform、轨道/material/speed 引用、视频与字幕时间非负且不超 outputDuration、字幕来自快照、所有媒体路径位于最终 `materials/`、媒体存在且哈希/大小一致、封面 JPEG 有效、没有悬空引用。验证失败不产生最终目录。

### 接口与数据

`shared/protocol.ts` 增加：

- `jianying.capabilities`：input `void`，输出候选矩阵、`formalSupport: false`、`verifiedByImport: false`、`mediaStrategy: 'copy'`、字幕/样式能力与不支持原因。
- `jianying.preflight`：`{ grantId, assetId, draftName }`，输出 `{ available, targetExists, estimatedBytes, mediaProbe, degradations }`；不创建任务。
- `jianying.start`：`{ requestId, grantId, assetId, draftName, snapshot }`，返回 `JobSnapshot`。相同 `requestId` 返回同一 job。
- 任务结果：`{ status:'created', draftName, projectId?, projectName?, videoId?, videoName?, exportedAt, target, mediaStrategy, verifiedByImport:false, degradationKeys }`。

共享纯模块新增 Windows 5.9.0 schema、草稿名校验、快照 schema、生成器输入类型和 `verifyJianyingDraft` 的回读契约。Host 数据结构不写入 FlyCut 项目格式，不改 `PROJECT_FORMAT_VERSION`；这是外部导出插件，不是新的项目数据源。

`JianyingDraftExportPanel` 通过 runtime `connection` 调能力和任务；`useJianyingDraftExport` 管理状态、重复点击锁、`jobs.cancel` 和成功结果。桌面目录 grant/显示位置通过 `src/utils/jianyingExportPath.ts` 调 Tauri command；Web 直接显示不支持。新增 `src/locales/jianying.ts` 保存中英双语文案。

### 备选方案与取舍

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| shell-only 目录 grant，Host 写最终目录 | 后端最终路径正确；RPC 无任意路径；Host 唯一导出 | 多一个短生命周期授权通道 | 采用 |
| 前端上传目标目录路径给 RPC | 实现短 | 违反已拍板安全边界，远程 Host 会接受任意路径 | 拒绝 |
| Host 生成 zip，桌面 shell 解压并改写 JSON | 目录由 shell 落盘 | JSON 路径改写变成 Tauri 业务逻辑，跨层且易半成品 | 拒绝 |
| 引用原媒体不复制 | 省空间 | 移动/删除原文件失联，F-0010 样本路径仍是绝对路径 | 不采用 |
| macOS 新格式实验 | 可覆盖本机 | F-0010 明确核心时间线不可读，不在批准范围 | 拒绝 |

## 架构决策

新增 [ADR-0009](../../20-architecture/adr/0009-jianying-draft-export.md)，状态 `proposed`：Windows 5.9.0 实验性候选、复制媒体、shell-only 目录授权、Host 唯一生成、不更新根索引、失败关闭。已接受的 ADR-0002/0005 保持不变。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| 候选目标的可用文案 | 文件生成成功仍只称候选，不称正式支持 | F-0010 的 `verifiedByImport` 为 false；AC-1 要求不宣称未知版本可用 | AC-1、AC-8 |
| 字幕范围 | 首版只写主字幕 | 双语和多 range 没有真实样本；提前降级比静默丢失可控 | AC-7 |
| 媒体复制 | 固定复制，不允许引用 | F-0010 推荐复制，且复制不会让原媒体移动立即失联 | AC-4、AC-9 |
| 根索引 | 不写 | 修改用户资料库风险高且是否自动扫描未验证 | AC-3、AC-8 |
| 目录授权 | shell-only、15 分钟、单次消费、绑定资产/名称 | 同时满足 Host 最终路径、RPC 无路径和失败关闭 | AC-3、AC-5、AC-6 |
| 幂等 | 前端按钮锁 + Host `requestId` 映射 | 防止双击或重试生成两份目录 | AC-5 |

## 风险与回退

- **真实导入仍是阻塞门禁。** 本机没有 Windows 5.9.0 剪映实机；macOS 11.7.0 不支持生成的明文格式。没有真实导入证据时，AC-7、AC-9、AC-10 和成功指标保持 `Not run`/未通过，阶段 04 只能交维护者审阅。
- 剪映是专有格式，结构字段可能随 build 变化；只接受明确候选目标，错误时失败关闭，不猜其他版本。
- 绝对路径使移动草稿目录后可能需要重联；当前策略只保证原媒体移动不影响草稿内副本，交付时明确提示，AC-9 由实机判定。
- 字幕字号、位置、字体和背景可能被剪映默认值覆盖；界面列出降级并要求确认。
- 大文件复制占用额外空间；开始前展示预计值，实际 `ENOSPC` 映射为可重试错误。
- shell route 是安全边界：只接受 shell secret、无 Origin、TTL、一次性 grant、realpath/lstat 和名称校验；任何一项不满足都失败关闭。

## 实现清单

- [ ] 共享候选契约、快照/命名校验、Windows 5.9.0 生成器与真实回读验证，建立含两段以上保存区间和主/副字幕输入的固定样本。
- [ ] Host `jianying` 插件与 worker：媒体探测、复制、封面、JSON、哈希、冲突/空间/权限错误、取消清理、requestId 幂等和原子提交。
- [ ] Tauri shell-only 目录选择/grant/locate 与 Host 授权路由，覆盖 TTL、来源、符号链接、路径穿越和普通 RPC 无路径断言。
- [ ] 剪映草稿导出面板、能力矩阵、快照、预计空间、样式降级确认、进度/取消/失败/成功与项目/视频标签，中英文明暗主题 E2E。
- [ ] 两段真实视频的 EDL 导出、真实目录/媒体/JSON 回读、真实剪映导入与搬迁验证；生成证据和 04 报告，不把 Not run 写成通过。

## 验证计划

1. 契约与生成器：`pnpm test:architecture` 运行 `F-0011/AC-1、AC-4、AC-7` 纯测试；真实写出含多保留区间、跨切点字幕、主/副字幕输入和中文样式的 Windows 5.9.0 草稿，解析回读、核对整数微秒、所有引用和哈希。Red check 删除一次 source 跳转或字幕投影后，目标断言必须失败。
2. Host 插件：`pnpm test:architecture` 在临时 Host home 和真实视频上执行 `jianying.start`，检查文件结构、`draft_content`/`draft_info` 字节一致、封面 JPEG、目标只出现一次、requestId 不重复、同名目录、ENOSPC/权限错误（可用真实只读目录与临时小容量条件构造）、取消和失败都不留 staging/最终半成品。
3. shell 授权：Rust `cargo test`/`cargo check` 与真实 Host route 测试，证明 client bearer/前端不能登记目录、任意路径 RPC schema 不接收 path、过期/复用/改名/换 asset 被拒绝、符号链接与 `..` 不出授权根、Host 重启 grant 失效。
4. UI：`pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`、`cargo check --manifest-path src-tauri/Cargo.toml`；Playwright 用 5179 临时配置跑 `tests/e2e/features/F-0011.spec.ts`，逐状态断言文案与控件，明暗主题、中英文，并用 `shot()` 生成截图。
5. 真实使用：用本机真实两段口播（或已有授权 demo 媒体）执行 Host 草稿生成，检查实际输出路径、媒体字节 SHA-256、EDL 每一切点与字幕时间；用播放器/解析器验证从草稿路径能重新关联媒体。真实 Windows 5.9.0 剪映打开、播放、改字幕、保存、重开和移动目录重开必须实际操作，没有该环境则 `⏸ Not run`。

全量回归按 `docs/code-standards.md` 第 1、2 条；本轮先采用主 agent 提供的基线结果，再在实现 commit 上重跑可运行项。端到端端口固定 5179，若编写临时 Playwright 配置只放 `/private/tmp`。

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | `jianying.capabilities` 结构化矩阵；Windows 5.9.0 仅候选/未验证；不支持平台显示固定文案并禁用；E2E 覆盖两语言两主题 |
| AC-2 | 点击开始时 `structuredClone` 项目/视频/EDL/字幕/主样式/媒体身份；不读取临时建议/预览；payload 冻结，结果带项目/视频和导出时间 |
| AC-3 | 原生目录选择 → shell-only grant；取消无任务；同名 preflight 改名/取消；Host 只写新目录；普通 RPC 无 path；原媒体只读 |
| AC-4 | 固定复制策略；界面显示预计空间和原媒体移动说明；Host 校验资产、媒体非空和哈希；副字幕/字体列为降级 |
| AC-5 | `正在生成剪映草稿… / Creating Jianying draft…`、进度、取消；按钮锁 + requestId 幂等；staging 清理；成功前不报完成 |
| AC-6 | media probe/asset 缺失、ENOSPC、EACCES、grant、格式校验分类；重试；失败不产生最终目录；不删既有目录 |
| AC-7 | EDL→video source/target 与 `projectCues`→text 的真实片段；只支持主字幕并在导出前列降级；真实剪映打开编辑为外部门禁 |
| AC-8 | 成功后候选草稿名称、项目/视频、媒体策略、导出时间和「在文件夹中显示」；不冒充正式剪映支持；Web 明确不支持 |
| AC-9 | 固定复制到草稿 materials 后声明绝对路径风险；真实移动草稿后打开由剪映实机验证；本机无目标应用时 Not run |
| AC-10 | 两段真实口播逐切点/字幕生成并以回读/哈希证明文件一致；真实剪映播放、编辑、保存、重开和切点字幕核对是验收门禁，无 Windows 5.9.0 环境时 Not run |

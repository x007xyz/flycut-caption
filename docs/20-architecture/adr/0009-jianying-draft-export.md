---
id: ADR-0009
status: accepted
date: 2026-11-09
deciders: zhangxiang.chen
feature: F-0011
superseded_by:
---

# ADR-0009 剪映草稿的 Host 完整导出链路与实机门禁

## 背景

F-0010 找到可完整读取的 Windows 5.9.0 明文草稿结构。F-0011 随后用同一个候选在 Mac 剪映 11.7.0 中完成外部草稿导入、播放和保存迁移；主 agent 以 AX `currentProgress` 核对了一个候选的字幕显示时点：20:00 出现「F0011 第二段实现」，21:16 仍显示，22:16 消失；第一段约 1.4 秒、跨切点字幕约 5.08 秒出现且前一条消失。该证据证明这个候选的字幕时序能够被目标应用按预期播放，但不证明全平台支持、字幕轨道可编辑、重开、搬迁或两段真实口播均通过。

需求仍要完整的产品导出链路：原生目录选择、Host 任务、进度/取消、冻结快照、媒体复制、回读、失败清理和成功说明。实现同时遵守“Tauri 只做外壳”“普通 RPC 不收任意路径”“业务在 Host”这三条决定。

## 决策

**Host 实现完整草稿业务；桌面外壳只选择目录并向 Host 登记；普通 RPC 只使用 opaque grant / preflight ID / 已授权媒体引用。正常发行版继续 fail-closed；显式内部验证构建可以走完整链路，但只能标为内部验证，不能宣称正式支持。**

### 门禁与目标

- 默认 `jianying.capabilities` 返回 `exportEnabled:false`，不注册 `jianying.preflight`、`jianying.start` 或 shell 目录登记 route。UI 只展示矩阵与缺口。
- `FLYCUT_JIANYING_INTERNAL_VALIDATION=1` 或 Host profile 的 `jianying.internalValidation:true` 才注册写方法和 `/shell/jianying/directories`。能力对象返回 `exportMode:'internal-validation'`，界面固定显示“仅内部验证”。
- Mac 11.7.0 只标记为 `observed-unverified` 或内部验证目标，不加入正式支持矩阵。编辑、保存重开、搬迁、两段真实口播和 Windows 实机仍是正式启用门禁。
- 未验证目标、未启用构建和 Web 不提供写入入口；浏览器即使伪造“已启用”能力也不能调用 shell route。

### 目录授权

1. Tauri `pick_jianying_output_directory` 打开原生目录选择器，校验所选目录与 canonical path 不是符号链接，然后把路径通过 Host 启动时生成的 shell secret 发到 `/shell/jianying/directories`。
2. Host 再次检查绝对路径、目录、realpath、写权限和符号链接，生成 UUID grant，15 分钟 TTL；路径只保存在 Host 内存，WebView 只收到 `{grant,expiresAt}`。
3. `jianying.preflight` 接收 `{directoryGrant,draftName,source,snapshot}`。Host 校验 grant、未同名目标、源媒体、时长/尺寸、非重叠字幕和磁盘空间，冻结快照并生成 10 分钟有效的 `preflightId`；同一 grant 只能绑定一次 preflight。
4. `jianying.start` 只接收 `{preflightId}`。Host 原子消费 preflight/grant，并用 preflight ID 作为确定性 job ID，把 operation→job 关联原子写入 `<home>/jianying/operations/`。首次或并发调用共享同一个启动 Promise；响应丢失、重复调用、甚至 Host 重启后，使用同一 preflight 都返回同一个 `JobSnapshot`，不会启动第二份。
5. grant/preflight 表随 Host 重启消失；operation 关联和 job 快照保留。operation 指向不存在的 job 时失败关闭并要求重新准备，不猜新任务。过期和已消费 grant/preflight 定期清理。

### 媒体与快照

- `source` 只有两种普通 RPC 形式：已上传的 `assetId`，或 `{projectId,videoId}`。项目来源由 Host 的 `ProjectStore` 解析 stored/linked media；普通 RPC 不接收路径、mediaRef 或输出目录。
- linked 项目媒体是部署边界：desktop 默认允许，server profile 固定拒绝，Host 在 profile 解析后再次硬编码门禁；普通 profile patch 或环境变量即使把 `allowLinkedMedia` 写成 true 也不能在 server 暗开。
- UI 在“准备导出”时读取正式 EDL、当前字幕、主字幕样式、画面尺寸和项目/视频身份，生成一次冻结快照；待确认建议不属于 `edl`/`chunks` 的正式状态，因此不进入快照。
- 来源增加 size/mtime 和项目媒体指纹。preflight/start/复制结束都复核；源媒体变化时失败，不生成混用新旧内容的结果。
- 媒体固定复制到 `<draft>/materials/`，源文件只读。布局继续使用绝对最终路径；搬迁仍由实机实验决定，不因“复制了媒体”就宣称可搬迁。

### 任务、原子性和 UI

- Host job 报告复制、哈希、封面、写 JSON、回读和提交进度；取消会终止 FFmpeg/复制/哈希并在 finally 删除本次 staging。
- 生成先写同父目录 `.name.flycut-<id>.tmp`，回读通过后才 rename 到最终名。同名、链接、路径穿越、悬空引用、媒体 hash 不一致或不重叠约束失败都不产生最终目录。
- Host 不读写用户的剪映 `root_meta_info.json`，不启动或驱动剪映 UI。
- UI 覆盖加载、能力错误、默认禁用、Web 不可用、目录选择、冻结准备、进度、取消、失败可重试和成功；成功显示项目、视频、时间、输出目录和导入说明。中英文和明暗主题由 Playwright 覆盖。
- 取消/失败保留既有目录和原媒体；成功后由 Host 返回输出位置。桌面打开/导入动作仍由用户完成。

### 生成格式与回读

- 只生成 Windows 5.9.0 候选布局：`draft_content.json`、字节相同的 `draft_info.json`、`draft_meta_info.json`、`draft_cover.jpg`、`materials/`。
- 单时间线、一个视频轨、一个主字幕轨。字幕目标区间必须互不重叠；重叠输入直接失败，避免目标应用自行重排后仍被误报成功。
- 新测试使用文本自带时间标识的独立字幕，不把生成器回读当实机时序证据。回读验证检查真实文件、独立期望时间、文本、引用、SHA-256 和 JPEG 封面的结构。
- Mac 11.7.0 对一个候选的字幕时序观察写入支持矩阵；字幕编辑、保存后重开和搬迁仍标未验证。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| shell-only 目录 grant + Host 原子生成 | 最终路径由 Host 写对，普通 RPC 无任意路径，业务全在 Host | 新增短生命周期授权状态 | 采用 |
| 前端把目录路径传给普通 RPC | 改动少 | 推翻 RPC 路径安全边界 | 拒绝 |
| Host 生成 zip，Tauri 解压后改 JSON | 前端不碰路径 | 业务和格式改写分到外壳，容易出现半成品 | 拒绝 |
| 未验证就默认启用实验按钮 | 可提前体验 | 违背 AC-1/AC-8 和默认真实门禁 | 拒绝 |
| 引用原媒体 | 省空间 | 源文件移动/删除即失联，也未证明可搬迁 | 拒绝 |

## 后果

- 正常发行版仍不可导出，直到编辑、重开、搬迁、两段真实素材和首发平台证据满足需求；代码实现完成不等于 04 可验收。
- 内部验证构建能用实际桌面链路生成候选，供主 agent 继续做 Mac 实机编辑/重开/搬迁及 Windows 验证。
- 目录 grant 被伪造、复用、过期或跨 Origin 使用时拒绝；Host 重启后必须重新选择目录。
- 搬迁能力仍是已知缺口；绝对媒体路径不会因为当前回读通过而被重新宣传为“可搬迁”。
- ADR 在维护者完成 04 验收前保持 `proposed`；不得以生成器或 E2E 通过把它改为 `accepted`。

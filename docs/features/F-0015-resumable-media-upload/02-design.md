---
id: F-0015
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-09
---

# F-0015 大文件断点续传与断线恢复：设计

> 2026-11-09 设计前置核对：F-0014 已验收，当前 Host 即维护者认可的 Cloud 后端；现有 `/assets` 只有整文件上传，没有上传会话、分片确认/查询、最终摘要校验、取消或过期协议。本需求在批准范围内补齐 Host 传输扩展，不建设账号、计费或多租户服务。

## UI / UX

新增一个项目导入上传面板，首页和项目详情页共用同一个 `MediaUploadCard` 组件。首页选文件时表示“新建项目”，详情页选文件时表示“添加到当前项目”。面板直接读取 `stores.project.uploads`，所有动作调用 `ctx.projects` 的真实方法；不另做假数据页面。

| 状态 | 用户看到什么 | 可操作 |
|---|---|---|
| `checking` | “正在读取上传限制… / Reading upload limits…” | 取消 |
| `unsupported` | “此Host不支持断点续传 / This Host does not support resumable uploads” | 关闭 |
| `rejected` | 文件名、总大小、超限的类型或大小原因 | 重新选择 |
| `hashing` | “正在校验文件… / Checking file…” 与文件名、大小 | 暂停、取消 |
| `uploading` | 文件名、总大小、目标 Host、`已确认字节 / 总字节`、百分比；只计服务端确认分片 | 暂停、取消 |
| `paused` | “已暂停 / Paused”，保留已确认字节 | 继续、取消 |
| `interrupted` | “上传已中断，等待重连 / Upload interrupted. Waiting to reconnect.”，显示有限重试进度 | 立即重试、暂停、取消 |
| `needs-file` | “选择原文件以继续 / Select the original file to continue”，显示原文件名、大小和目标 Host | 选择原文件、取消 |
| `mismatch` | “文件不匹配 / File does not match”，旧会话与字节数保留 | 重新选择、取消 |
| `verifying` | “正在核验结果… / Checking result…” | 无；禁用重复启动 |
| `failed` | 校验失败、空间不足、权限错误或网络重试耗尽的具体原因 | 重试、取消 |
| `expired` | “上传会话已过期，请重新开始 / Upload session expired. Start again.” | 用户确认后重新开始 |
| `complete` | 项目已创建/视频已添加，行随后移出上传面板 | 无 |

刷新页面后，上传服务按当前 `hostId` 读取本机定位元数据并请求真实会话；只显示同一 Host 的会话。源文件句柄不能跨刷新恢复，因此进入 `needs-file`，重新选择后先比较大小与完整 SHA-256，再只补缺失分片。切换 Host 或身份后不读取旧身份的定位元数据。

`ProjectsHome` 和 `ProjectDetail` 各增加一个上传面板插槽；`ProjectsApp` 将 store 中的上传行、目标 Host 和动作接给组件。中英文文案放 `src/locales`；明暗主题由现有主题变量自然继承。桌面端仍走已验收的本地 `mediaRef` 路径，Web 端走本协议。

<!-- 界面状态和文案以 01-spec.md 的 AC 为准。这里写改哪些组件、新增哪些组件、接哪些 stores 和 RPC；没有界面改动写「无界面改动」 -->

## 技术方案

### 涉及的子系统

- [cordis-host.md](../../subsystems/cordis-host.md)：插件注册 RPC/HTTP 路由、Gateway 鉴权、Host 资产存储与任务快照。
- [frontend.md](../../subsystems/frontend.md)：React 组件、store、真实 Host 调用与 E2E。
- [architecture-current.md](../../architecture-current.md)：Gateway、项目媒体、任务和资产边界。
- F-0014 的 `/__flycut/connection`、HttpOnly Cookie、CSRF、bearer 与 Host 身份契约。

<!-- 对照 AGENTS.md 的路由表，列出要读的子系统文档 -->

### 方案

1. **Host 原生分片协议**：新增 `uploads` Cordis 插件，在 `<home>/uploads/<sessionId>/` 保存 `session.json` 与 `chunks/<index>`。会话包含大小、媒体类型、完整 SHA-256、分片大小、确认分片、过期时间和创建者身份摘要。所有路由都由 Gateway 先鉴权，再把已认证主体传给插件；客户端不能自报 owner/namespace。
2. **身份边界**：浏览器会话的主体是当前 HttpOnly `flycut_session`；bearer 的主体是 Host token 的 SHA-256 摘要。会话查询/写分片/完成/取消都要求主体一致，不一致一律 404，避免暴露其他身份存在哪些会话。普通刷新复用仍有效且未过期的 Cookie 会话，保持同一身份；登出删除会话，过期后不能继续。该改动只涉及 `/__flycut/connection` 的会话复用，具体 diff 已交主 agent 审阅。
3. **分片幂等**：客户端发送 `X-Flycut-Offset`、`X-Chunk-SHA256`。Host 校验 index、offset、长度、末片余量、分片摘要后原子 rename。已确认同 index：内容与摘要一致返回原确认，不增加字节；不一致返回 409。写失败只留下不可见 `.part`，启动时清理。
4. **完成与原子资产**：完成前检查无缺失分片、总大小、顺序流式重算 SHA-256、媒体容器头。Host 先生成确定性 assetId 并写入 `finalizing`，把拼接文件 `adopt` 到资产目录，再写 `complete + assetId`。重启后按 assetId 检查并补完状态，重复 complete 返回同一资产。摘要/大小不符保留分片供继续修正，返回 422。
5. **取消、过期与空间**：每会话串行锁；取消删除临时目录，已完成会话不删除已生成资产（可能已被项目使用）；完成与取消竞态由锁和状态机裁决。过期由查询/上传时与每小时扫描共同处理，结束后返回 410。创建时和服务端写分片前检查公开最大大小、类型、磁盘剩余空间（保留安全余量），不足返回 507；前端检查只做提前提示。
6. **Session 定位与恢复**：客户端只在 localStorage 保存 `{hostId, sessionId, name,size,type,sha256,operationId,target}`，不含源媒体、字幕或 token；按 `flycut.upload.sessions.<hostId>` 隔离。启动/重连时逐条 GET 会话，活动会话进入 `needs-file`，完成会话重试项目落库，过期/取消清理定位。
7. **项目与任务幂等**：`projects.create`、`projects.addVideo` 增加可选 `operationId`，Host 持久记录操作号到结果；重试返回同一项目/视频。`workflow.start`、`export.start` 增加可选 `operationId`，Job 快照带该号，相同号返回同一任务。项目创建响应丢失时客户端保持同一 operationId 并显示 `verifying`；ASR/导出沿用同一号重试，查询任务快照后再决定继续。
8. **客户端传输器**：新增增量 SHA-256、会话定位与 `ResumableMediaUpload`。逐片上传并在每个请求前查询会话，网络失败后有限退避；每次重试先 GET 已确认分片，不重传已确认部分。暂停用 AbortController 中止当前片但保留会话；取消先请求 DELETE，响应丢失再 GET 判定。重连后仅对 active 会话继续，过期/无权不循环。

### 接口与数据

新增 `shared/uploads.ts`（协议版本、限制、会话、错误码与纯校验函数），并在 `shared/protocol.ts` 注册：

| RPC / 路由 | 输入 | 输出 / 语义 |
|---|---|---|
| `uploads.capabilities` | void | `protocolVersion, chunkSize, maxBytes, sessionTtlHours, allowedMimeTypes, maxChunks` |
| `POST /uploads` | `{fileName,size,mimeType,sha256,idempotencyKey}` | 201 会话；同主体+key+摘要返回同一会话 |
| `GET /uploads/:id` | 会话 id | 当前状态、确认分片、已确认字节、过期时间、完成 assetId |
| `PUT /uploads/:id/chunks/:index` | 原始分片 + offset/摘要头 | 幂等确认；错误 offset/不同内容/越界明确报错 |
| `POST /uploads/:id/complete` | `{sha256}` | 校验全部内容并返回 `{assetId, session}` |
| `DELETE /uploads/:id` | 会话 id | active 清理并返回 cancelled；已完成返回 complete 且不删资产 |

Host 配置新增 `uploadMaxBytes`（默认 4 GiB，沿用现有资产上限）、`uploadChunkBytes`（默认 8 MiB）、`uploadSessionTtlHours`（默认 24）、`uploadDiskReserveBytes`（默认 256 MiB），并允许 `FLYCUT_UPLOAD_*` 环境变量覆盖。`HttpRoute.handle` 增加认证主体参数；Gateway 的 CORS 方法补 `PUT`。`HostInfo.capabilities.resumableUpload` 供客户端快速判断；旧 Host 返回 false/无此能力时 UI 显示不支持。

项目 schema 只增加可选 `operationId: uuid`，不改变持久格式版本。`JobSnapshot` 增加可选 `operationId`；`pipelineInputSchema`、`exportInputSchema` 同样增加可选字段，旧调用保持兼容。

<!-- RPC 方法（shared/protocol.ts）、事件、数据结构变化、兼容迁移 -->

### 备选方案与取舍

- **继续整文件 POST**：实现小，但断线只能整份重传，无法满足分片确认、刷新恢复和幂等完成。
- **tus/第三方上传服务**：需要额外服务与部署依赖，且当前维护者认可的 Cloud 就是本仓库 Host；引入外部协议不能替代本项目真实端点。
- **客户端自报 owner/namespace**：可跨刷新，但客户端可伪造，违反既有 Host/凭证边界；拒绝。
- **Host 内存会话**：实现更短，但 Host 重启丢失会话，不满足“重启会话恢复”审阅要求；选持久元数据 + 原子文件。
- **完成后再校验并复制整份文件**：会产生额外 4 GiB 拷贝；选择顺序流式摘要 + 原子 rename 进资产目录。
- **所有上传共用 `/assets`**：会改变现有 ASR/导出小资产路径；保留 `/assets`，仅项目源媒体走 `/uploads`，减少共享面。

## 架构决策

新增 [ADR-0008](../../20-architecture/adr/0008-resumable-media-uploads.md)，状态 `proposed`：Host 负责分片会话、身份绑定、摘要校验和原子落资产；客户端只保存非敏感定位元数据。验收确认时再改 `accepted`。

<!-- 需要长期遵守的决定写成 ADR：docs/20-architecture/adr/NNNN-<slug>.md，这里只放链接 -->

## 自行决定的事项

- 默认分片 8 MiB、最大 4 GiB、会话 24 小时；与现有 `/assets` 4 GiB 上限和资产 TTL 对齐，测试可覆盖更小值。
- 媒体类型按允许 MIME/扩展名先验检查，完成时再检查容器头；未知容器拒绝，不能仅信任浏览器声明的 MIME。
- “暂停”是客户端停止发送并保留 Host active 会话，Host 不增加独立 paused 状态，避免多客户端对同一会话状态互相覆盖。
- 刷新后重新选文件必须重算完整 SHA-256；文件名和大小只用于提示。
- 取消在完成后不删除已生成资产，避免把已被项目接管的媒体删掉；UI 在 finalizing/complete 后不再显示可执行取消。
- 桌面端本地路径继续使用 `mediaRef`，不把本地路径发给远程 Host；Web、CLI 或显式 bearer 客户端使用本协议。
- 项目/任务幂等使用可选 `operationId`，不改变旧请求语义；同一失败任务不自动重置，用户需明确新操作号重试。

<!-- PRD 没写清、由设计自己决定的事：决定了什么、为什么、影响哪条 AC。验收时汇总进测试报告 -->

## 风险与回退

- **存储与磁盘耗尽**：分片临时目录可能占空间。创建与写入前检查剩余空间并保留余量；异常退出留下的 `.part` 启动清理；取消/过期删除临时目录。
- **完成与取消竞态**：单会话锁 + 持久状态；完成一旦生成资产，取消只返回 complete，不删资产。
- **Host 重启**：session.json 和 chunks 是持久真源；finalizing 记录确定性 assetId，启动时完成或回滚。
- **身份刷新**：复用有效 Cookie 会话跨越普通刷新；登出/过期仍切断。若主 agent 不接受该 diff，则本需求只能将刷新恢复限制为同一 bearer/显式会话，需要在报告中降级对应 AC，不能伪称通过。
- **代理/反向代理缓冲**：真实断线由 Host 保留会话；代理不得缓存 `/uploads`。真实测试使用可切断 TCP 代理验证。
- **回归风险**：`/assets` 路径保持不变；上传协议新增路由，不改项目存储格式。出现协议问题时旧版本仍可整文件上传，新前端必须明确显示 Host 不支持，不静默降级。

## 实现清单

- [ ] 1. **共享上传契约与 Host 鉴权上下文**：新增 `shared/uploads.ts`、`uploads.capabilities`、HttpRoute 认证主体、会话刷新复用、`resumableUpload` 能力与配置读取；补协议/鉴权/旧 Host 不支持测试（AC-1、AC-2、AC-10）。
- [ ] 2. **Host 分片会话与持久恢复**：实现 uploads 插件、session.json、原子分片、查询/取消/过期、重启恢复、空间与媒体类型检查（AC-2、AC-3、AC-4、AC-7、AC-8、AC-10）。
- [ ] 3. **Host 最终完整性校验与幂等完成**：顺序拼接、大小/摘要/容器头校验、确定性资产 adopt、complete 重试、完成取消竞态（AC-3、AC-7、AC-8）。
- [ ] 4. **项目与任务 operationId**：项目创建/添加视频、workflow.start/export.start/JobSnapshot 幂等，失败/不确定重试不重复副作用（AC-9）。
- [ ] 5. **客户端上传器与恢复定位**：增量 SHA-256、逐片调度、暂停/取消/有限重试、刷新定位元数据、重新选文件核验、Host 隔离（AC-2 到 AC-8、AC-10）。
- [ ] 6. **上传面板与真实项目集成**：首页新建项目和详情页添加视频接上传器，展示文件名/大小/目标 Host/进度、全部状态、暂停/继续/取消/重试/重新选择；中英文和明暗主题（AC-1 到 AC-10 的界面部分）。
- [ ] 7. **ASR/导出结果核验**：上传完成后以同一 operationId 重试项目/任务；结果不确定显示核验中并禁止重复启动，重连查询任务快照（AC-9）。
- [ ] 8. **真实网络与验收证据**：真实 Host + TCP 代理断网/恢复、Host 重启、大文件完整上传、浏览器刷新重选、取消/过期/错分片/重复提交/限额测试；Playwright 证据、测试报告和架构文档（AC-1 到 AC-10）。

## 验证计划

- 每项完成后运行 `pnpm lint`、`pnpm tsc -b --noEmit`，Host 改动追加 `pnpm check:host`；涉及任务/项目改动运行对应架构测试。
- Host 协议测试：真实 `createHost` + HTTP；覆盖创建/查询/分片确认/错误 offset/重复同片/同片不同内容/缺片完成/大小与 SHA 不符/媒体头不符/取消/过期/完成竞态/Host 重启恢复/身份隔离/磁盘与最大大小限额/并发完成。测试名称带 `F-0015/AC-n`。
- 真实网络测试：Node TCP 代理连接真实 Host，上传中途销毁所有代理 socket，再恢复并断言只发送缺失分片、最终资产摘要等于源文件；测试必须记录实际重传字节数 < 全文件大小。补充 Host 进程重启后继续。
- 幂等测试：项目创建和添加视频同一 operationId 重试返回相同 id；workflow.start/export.start 同一 operationId 返回同一 job；不同 operationId 才创建新任务。
- E2E（mock 状态）：`tests/e2e/features/F-0015.spec.ts` 使用 `tests/e2e/lib/mockHost.ts` 的受控上传端点，覆盖 unsupported/rejected/hashing/uploading/paused/interrupted/needs-file/mismatch/verifying/failed/expired/cancel 确认和明暗主题、中英文；`shot()` 存 screenshots。
- 真实浏览器：5177 端口用真实 Host/代理，选择一个可识别的大媒体 fixture；中途断开代理、恢复后确认进度不回零，刷新后重新选原文件完成；错文件拒绝；取消后 Host 会话清理；过期会话显示重启提示。真实 Host 的浏览器证据与 mock E2E 分开记录。
- Red check：移除 offset/分片摘要校验、移除 owner 校验、移除完整摘要比较、移除 operationId 幂等、移除刷新定位中的 SHA 比较，对应测试必须失败并指出具体行为。
- 回归：`pnpm test`、`pnpm test:architecture`、`pnpm build`；Web 端口 5177；不把 mock 结果写成真实 Host/Cloud 结果。

<!-- 每一项完成时要跑的检查（对照 docs/code-standards.md）；涉及界面的 AC 写哪些端到端测试；哪些 AC 需要真实使用验证 -->

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | Host 前置核对、方案 1/2、`resumableUpload` 能力、旧 Host 不支持 UI、实现清单 1/6/8 |
| AC-2 | 上传面板 checking/rejected、服务端二次大小/类型校验、目标 Host 展示、磁盘检查、实现清单 1/2/5/6 |
| AC-3 | 会话确认分片、幂等 PUT、完成摘要/大小/媒体头校验、原子资产、实现清单 2/3/5 |
| AC-4 | `paused` UI、AbortController、仅查缺失分片、已确认字节进度、实现清单 2/5/6 |
| AC-5 | interrupted 状态、有限退避、恢复后先 GET、重试上限、实现清单 1/2/5/6/8 |
| AC-6 | 刷新定位元数据、按 hostId 隔离、needs-file、SHA 身份核验、mismatch、实现清单 5/6/8 |
| AC-7 | 取消状态机、完成竞态、过期 410、重新开始确认、不删项目媒体、实现清单 2/3/7 |
| AC-8 | 逐项错误码、空间/权限/校验失败、日志脱敏、实现清单 2/3/5/6/8 |
| AC-9 | operationId、JobSnapshot、verifying、任务快照查询、实现清单 4/7/8 |
| AC-10 | 真实 Host + TCP 代理、重启、浏览器 5177、身份隔离、真实大文件与摘要证据、实现清单 8 |

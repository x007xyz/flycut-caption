---
id: F-0004
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-05
---

# F-0004 崩溃恢复：技术设计

## UI / UX

以已确认的 `01-spec.md` 文案、状态及保护边界为准，复用 F-0002 的项目打开、保存和冲突界面。新增 `RecoveryDialog`、`DiscardRecoveryDialog`、`RecoveryUnavailableBanner`，通过 `ctx.recovery` 和每 Context 的 recovery store 驱动，不增加全局业务 Context。

| 状态 | 数据与操作 | E2E 构造 |
|---|---|---|
| checking | 打开项目后冻结编辑，读取副本和 Host 状态；返回首页 | 挂起本地适配器或 Host 请求 |
| choose | 显示副本记录时间、会话、Host 保存时间；恢复/放弃/稍后 | 预置同项目多会话副本 |
| applying | 锁定当前选择，禁用重复提交；核验并恢复 | 挂起恢复请求 |
| recovered | 载入 Host 确认的编辑结果，显示成功提示 | 实际恢复后重开核对 |
| failed / uncertain | 保留副本，显示 PRD 对应失败/结果待确认文案 | 本地读取错误、断线、目标缺失、响应丢失 |
| conflict | 复用冲突流程，显式覆盖/另存/取消 | 真实第二窗口修改版本，mock 覆盖各界面分支 |
| discarding / discard-failed | 确认后只删除选中的副本；失败保留确认框 | 挂起或拒绝副本删除 |
| unavailable | 持续错误条，重试本地记录/立即保存 Host | 模拟配额耗尽、事务失败 |

没有副本则沿用普通编辑器；稍后或关闭选择框返回首页，副本不变。页面返回、异步完成和取消均用打开会话 generation 防止旧结果污染新路由。所有文案进入 zh_CN/en_US，界面按主题变量实现。

## 技术方案

### 涉及的子系统

已读 `docs/subsystems/frontend.md`、`docs/subsystems/cordis-host.md`、`docs/architecture-current.md`、`docs/subsystems/funasr-tauri.md`、`docs/decisions.md`、ADR-0001/0002 及 F-0002 当前项目服务、store。F-0002 仍在开发，其 `saveNow/openConflict` 尚有占位，开发前必须重新对照验收后的代码，不能把当前草稿 API 当成已完成能力。

### 方案

**1. Context 内恢复服务与本地副本**

新增 `src/services/recoveryService.ts` Cordis 插件，依赖 connection、stores 和 projects；由 ClientRuntime 组装。`src/recovery/` 存放 schema、快照、存储适配器、调度和恢复状态机。业务展示状态放 `src/stores/recoveryStore.ts`。

两端先选 IndexedDB 保存临时恢复副本（Tauri WebView 的应用存储、Web 当前站点的浏览器存储），不把业务副本写进 localStorage，也不新增 Rust 业务 command。存储适配器提供 load/list/put/delete 条件操作，测试可注入；数据库事务完成才记为记录成功。实际 Tauri 强退测试是验收必需项，不能用浏览器测试替代。若其持久性或性能不满足 PRD，先报告证据、调整设计，不擅自放宽 AC 或绕过原生边界。

副本：`{ schemaVersion, hostId, projectId, videoId, sessionId, sequence, snapshotId, recordedAt, baseRevision, edits, pendingOperation? }`。edits 使用 F-0002 的保存快照，包括文本、删除标记、译文、主副样式和画幅；不存源媒体、密钥、撤销栈或整份原始 ASR。对恢复内容做 schema 校验；未知版本或损坏记录不删除，显示无法恢复，不强行降级解析。

`sessionId` 每次独立编辑生命周期随机生成，不用浏览器可能复制的 tab ID。每个会话只覆盖自己的完整最新副本，多会话分行展示。日期只用于展示和排序，判定保存对应关系使用 snapshotId/sequence 和 Host 回执，不能靠客户端时间推测版本新旧。

**2. 稳定 Host 身份**

当前 RPC generation 每次进程重启变化，不能用于副本隔离。在 projects 插件新增 `projects.identity`，返回在 Host home 独立文件中持久生成的随机 UUID；使用原子创建，重启/换 token 不变，换 Host home 不复用。URL 仅用于连接，不作为身份。身份文件损坏时显式失败，不静默生成新身份掩盖旧副本。目录克隆/迁移到新 Host 时应重建身份，不能将身份文件作为项目导出内容。

打开项目先从当前鉴权连接读取身份，再按身份检索副本，绝不枚举其他 Host 的字幕给当前页面。connection generation 变化后重新核验身份；不把旧 token 持久化到本地副本。远程多用户隔离继续属于 Cloud，本次只支持已规定的单租户 Host。

**3. 记录调度与普通保存协调**

订阅已保存转写项目的编辑变化，生成递增 sequence。空闲防抖目标 250ms，连续编辑最大等待 1 秒，给完整快照序列化和持久化留余量；验收测量 PRD 的停止编辑 1 秒/连续 2 秒边界。每个会话写入串行且合并中间版本，永远在事务内替换完整副本，失败保留旧版本并显示 unavailable，不能阻止正式自动保存。

保存发送时捕获不可变快照，不得发送时读一次、清理时再读取当前编辑。Host 回执只确认该 snapshotId；本地清理采用 compare-and-delete，只有当前记录仍为已确认快照才移除。更新副本存在时保留，并将其 baseRevision 在同一事务中推进到本窗口已确认的前序保存版本；不能推进到其他窗口的未知修改版本。客户端崩溃在回执与本地更新之间时，由持久 operation 标记和 Host 回执对账，避免把自己的已保存内容误判为他人的冲突。

**4. 可确认的幂等保存**

新增 projects 插件方法，不改变 F-0002 原有 RPC 参数语义。正常自动保存与主动恢复在开启恢复能力时都通过同一幂等保存路径，保证「Host 已写成功但客户端未收到」可以查询确认。

请求有 operationId、snapshotId、预期 baseRevision 和明确目标。Host 在项目串行写锁内检查权限、目标存在和版本，保存 edits 与持久回执。相同 operationId 且相同内容重试返回同一结果；不同内容复用 ID 拒绝。回执与写入必须由可恢复项目事务协调：先准备目标快照、修订号与回执，写事务记录，再幂等提交文件，恢复后才开放读写。不能仅在内存中记 ID，不能只依赖先写 edits 再写 receipt。

客户端提交前先持久化 pendingOperation，期间不移除待确认内容。重启对账查询 operation 状态；已提交则处理对应回执及副本，未提交再检查目标当前版本，未知结果保留副本。若有更新本地编辑，不可直接载入旧已提交快照覆盖更新内容。提交期间同项目读与状态查询必须等待事务恢复，不能读到半次操作。

回执是存储协议的兼容扩展，独立于正式 edits 的业务字段；如最终 F-0002 schema 需要新增字段，则先写版本化迁移和测试，不能静默改变格式。回执不因固定时间到期丢弃未确认结果；本次只保留必要 operation 元数据与内容摘要，不存历史字幕版本。已确认且没有再查询需求的回执清理由后续设计证据决定，不能破坏崩溃对账。

**5. 恢复、放弃与冲突**

打开项目先暂停编辑/自动保存，取得 Host 最新状态并对账。可读副本按会话展示；用户恢复时再次比较版本。同版本走幂等 apply，成功后从 Host 重新载入快照、清空撤销栈，再清理对应副本。媒体缺失复用 F-0002 提示；不可读或无权限不清理副本。

冲突操作复用 F-0002 的交互，但恢复覆盖和另存仍经幂等接口；另存使用 operationId 稳定分配新项目 ID，防止响应丢失后创建多个副本。force 仅在用户明确选择时使用，不能重建已不存在的项目。取消保留副本并回选择状态。

放弃只条件删除选择时的 sequence；如果其他上下文已更新该记录，重新读并提示选择，不能删除更新版本。删除失败留在确认框；成功后读取 Host 正式内容。损坏副本原始记录保留；不设置自动时间清理，不偷偷限制为「只留最新一个会话」。

### 接口与数据

| 位置 / 方法 | 契约 |
|---|---|
| projects.identity | 无输入；输出稳定 hostId 和 recovery 协议版本能力 |
| projects.saveRecoverable | `{ projectId, videoId, baseRevision, operationId, snapshotId, edits, force? }`；返回保存 revision/时间及 snapshotId 或 conflict/目标错误 |
| projects.recoveryOperation | projectId、operationId；返回 committed（含目标、新版本、snapshotId）/not-found；恢复未完成时报待确认错误 |
| projects.duplicateRecoverable | 原目标、预期版本、operationId、snapshotId、edits；返回稳定的新项目身份或错误，显式选择才可调用 |
| RecoveryStore | checking/choose/applying/failed/uncertain/conflict/discarding/ready，候选元数据与本地保护状态 |
| RecoveryStorage | 按 host/project/video/session 的完整快照事务；按 sequence 条件删除和基准版本推进 |

方法在 `shared/protocol.ts` 声明并由 projects 插件注册；输入 schema 在 `shared/projects.ts` 或专门 recovery 协议文件。Gateway 只传输和鉴权，不增加业务分支。新增 capability 由插件声明，旧 Host 不支持时显示恢复不可用，不伪造已保护状态，普通保存仍可工作。

### 备选方案与取舍

| 选定 | 备选 | 理由 |
|---|---|---|
| 两端 IndexedDB 临时副本 | 桌面原生文件 | 统一适配和故障测试，遵守 Tauri 外壳边界；仍须真实验证 WebView 持久性 |
| 完整 edits 快照 | 操作日志 | 无需重放历史，避免不同版本日志语义漂移；需测长视频序列化开销 |
| 稳定 Host UUID | URL/token/generation | 重启或凭证变化不误分组，同地址换 Host 不串内容 |
| 持久事务与 operation 回执 | 收到响应即清理/比较时间 | 覆盖提交成功但响应丢失、客户端同时崩溃的结果确认 |
| 用户选择完整会话副本 | 自动合并 | 不把语义冲突和删除状态静默混合 |

## 架构决策

[ADR-0004 客户端临时恢复副本与幂等恢复保存](../../20-architecture/adr/0004-client-recovery-copies.md) 为 proposed，验收时统一审阅。客户端临时缓存的受限例外已由维护者确认，具体实现方案仍需验证。

## 自行决定的事项

- 使用 IndexedDB 两端适配，避免新增 Tauri 业务 command（AC-1、AC-10）。
- 用稳定 Host 身份和会话 sequence，而不是 URL、日期或进程 generation 关联记录（AC-1、AC-3）。
- 正常保存也纳入持久幂等对账；否则无法可靠满足「已确认快照不再提示」及响应丢失状态（AC-1、AC-5、AC-6）。
- 不新增恢复历史中心；已确认副本清理失败时按回执识别已应用（AC-5）。

## 风险与回退

- 原生 WebView 存储的持久性、配额和长字幕快照成本必须实测；存储失败保持 Host 自动保存，并明确显示保护不可用。
- 仅使用前端测试不能证明 Host 崩溃对账正确；项目事务需要每个落盘步骤的故障注入。
- 本方案不依赖 F-0003；不能直接套用 ADR-0003 尚未实现的事务机制。后续合并时复用一个项目事务层，不能维护两套锁或恢复入口。
- 关闭恢复功能只能停止创建新记录，不能删除既有未处理副本；回退版本前保留副本原数据，未知 schema 不强行读取。
- F-0002 未验收且保存实现仍在变化；开发前确认最终 revision/duplicate 契约，并评估原有事务与本方案的接口衔接。如必须改变其既有语义，先报告维护者，不直接实施。

## 实现清单

- [ ] 1. **记录编辑副本与故障提示**：恢复 schema、Context 服务/store、IDB 事务适配、稳定 Host identity、订阅和调度、损坏/写入失败保护与 banner，带隔离及性能测试（AC-1、AC-10）。
- [ ] 2. **普通保存的精确确认**：Host 可恢复事务、saveRecoverable/operation 查询、客户端 pending 标记与条件清理；验证旧回执不删新副本，断线/崩溃不误判提交结果（AC-1、AC-5、AC-6）。
- [ ] 3. **打开与恢复成功路径**：检查状态、多个会话选择、稍后返回、冻结编辑、主动 apply、重新载入及媒体缺失衔接（AC-2–5）。
- [ ] 4. **失败与冲突恢复**：检查错误、结果不确定、目标不存在/无权限、重试、显式覆盖、幂等另存与取消；带真实双窗口竞争测试（AC-6、AC-7）。
- [ ] 5. **放弃副本**：二次确认、条件删除、等待/失败/取消、回到 Host 正式状态；不影响其他会话（AC-8、AC-9）。
- [ ] 6. **真实故障验收与规范同步**：两端强退/Host 强退/同时强退各 3 次，长视频记录时限、存储故障和明暗中英文证据；更新 decisions 的已批准例外、前端/Host 子系统规范（AC-1–10）。

## 验证计划

- 每个清单项跑关联测试并记录 commit/AC/验证。全量验收执行 `pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`、`cargo check --manifest-path src-tauri/Cargo.toml`、`pnpm test`、`pnpm test:architecture`，前端另跑 `pnpm build`。本次不计划改原生代码；若实际涉及 Tauri 改动追加 `pnpm build:funasr-sidecar` 及子系统检查。
- 状态机/调度测试注入时钟及失败存储，覆盖连续编辑、防抖最大等待、乱序回执、写旧清新竞态、损坏 schema、多窗口及同 URL 换 Host。恢复记录和普通保存测试需证明撤掉相关修复后行为断言失败（Red check）。
- Host 临时目录测试对事务准备、edits 写入、修订号/回执提交各点杀进程，重启后查询结果并验证编辑和回执一致；重复 operation、同 ID 不同内容、幂等另存和权限/不存在拒绝均覆盖。
- `tests/e2e/features/F-0004.spec.ts` 名称带 AC 编号，覆盖 PRD 每个界面状态及明暗、中英文，shot 保存截图。通过真实存储适配器预置副本；错误状态用受限测试注入，不暴露生产调试 RPC。`page.route` 只构造传输等待/失败，不能替代真实持久化测试。
- 执行 `pnpm e2e:evidence F-0004`，截图入 git、录屏本地留存。浏览器人工点主流程；真实 Tauri 和 Web 各测试客户端强退、Host 强退及同时强退，至少各 3 次，操作前记录已成功快照 ID，重启对比完整内容，再次重开核对 Host 数据。
- 使用已转写的真实 10–60 分钟口播测至少 20 次编辑及连续输入；记录序列化到持久完成的耗时，验收 1 秒/2 秒指标。真实双窗口冲突和媒体移走后的恢复不依赖 mock。未执行的写 Not run，不将流程自动确认解释为功能验证通过。

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | 稳定身份、完整事务快照、sequence、精确回执与对账，清单 1、2 |
| AC-2 | 打开检查屏障和无记录直接载入，清单 3 |
| AC-3 | 会话候选、时间展示、主动选择及稍后，清单 3 |
| AC-4 | apply 状态、重新核验、重复提交锁，清单 3 |
| AC-5 | 幂等保存、Host 重载、已应用副本识别和媒体缺失，清单 2、3 |
| AC-6 | 不确定结果查询、失败保留、权限/目标错误，清单 2、4 |
| AC-7 | 冲突选择、显式覆盖、幂等另存、取消，清单 4 |
| AC-8 | 放弃确认和取消，清单 5 |
| AC-9 | 条件删除、失败保留及读取 Host 正式内容，清单 5 |
| AC-10 | 本地写入错误 banner、重试与独立 Host 保存，清单 1 |

## 开发前置条件

F-0002 的测试验收须 approved（或需求已归档）。当前不满足；技术设计完成后不得创建开发阶段或开始实现。

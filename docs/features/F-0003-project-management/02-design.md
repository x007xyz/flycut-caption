---
id: F-0003
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-05
---

# F-0003 项目管理：一个项目多个视频：技术设计

## UI / UX

界面状态、文案和行为以已确认的 `01-spec.md` 为准，不另做原型。复用现有展示组件，接每个 ClientRuntime 的 `ctx.projects` 与 `projectStore`，不新增全局业务 Context。

| 界面 / 组件 | 数据与动作 | 状态构造 |
|---|---|---|
| ProjectsHome、ProjectActionsMenu、RenameProjectDialog | projects.list/createEmpty/rename/trash；排序、搜索和视图偏好；单视频进入编辑器，其他进入详情 | 拦截列表与创建、重命名、删除请求，构造等待、失败与成功；键盘聚焦菜单 |
| 新增 TrashPage、永久删除确认框 | trashList/restore/purge/emptyTrash；展示删除时间和剩余天数，撤销提示调用 restore | 固定时钟，构造空、加载、出错、有项目和当天到期；操作失败保留原行或对话框 |
| ProjectDetail | detail/addVideo/removeVideo；逐文件添加状态；打开视频调用现有打开流程 | 空、加载、失败、多视频、媒体丢失、添加部分失败、打开中；每个文件独立请求 |
| ProjectBreadcrumb | 项目详情入口、视频选择器、切换状态；只有单视频时保留原面包屑外观 | 打开请求挂起、保存失败、转写进行中；离开保护复用 F-0002 |
| 字幕样式面板 | 项目样式、独立样式、跟随切换；画幅始终属于视频 | 两种来源及恢复确认；项目提示关闭状态仅属于界面偏好 |
| 项目删除恢复对话框 | 保存返回 trashed/deleted 后暂停；恢复并保存、另存、放弃 | 两窗口真实流程及请求拦截；恢复后的保存仍需要冲突检测 |

路由增加 `#/projects/<id>` 和 `#/trash`，视频继续用 `#/projects/<id>/videos/<videoId>`。选文件或拖入多个文件时复用媒体加载逻辑，但不能用它逐个覆盖当前编辑器；先登记/上传，再逐个加入项目，不自动批量转写。桌面原生多选及拖入路径均由外壳登记到允许列表，RPC 仅传 mediaRef；Web 用 assetId。

## 技术方案

### 涉及的子系统

- Host 与协议：`docs/subsystems/cordis-host.md`、`docs/architecture-current.md`。
- UI、store 与本地化：`docs/subsystems/frontend.md`、`INTERNATIONALIZATION.md`。
- 媒体登记与桌面文件选择：`docs/subsystems/funasr-tauri.md`、ADR-0002。
- 存储：ADR-0001；格式与修订号的扩展见 ADR-0003（proposed）。

### 方案

在 F-0002 的 projects 插件和目录存储上扩展；RPC 由插件注册，协议声明在 `shared/protocol.ts`，schema/type 在 `shared/projects.ts`。不改变 Gateway 的业务边界，不新增 Tauri 业务接口。

**1. 格式 2 与并发单位**

保留目录结构和项目级 `revision` 的原有含义（每次成功写入递增），增加每视频 `videoRevision`、项目样式 `styleRevision`、项目元数据 `metadataRevision`。新方法分别提交对应 base revision；按视频写入只校验该视频，样式只校验样式版本，生命周期操作在同一项目队列下串行。原有 saveEdits 的 baseRevision 不改语义，保留给旧调用方；新客户端使用独立的 saveVideoEdits/saveProjectStyle。F-0002 的存储/RPC 完成验收前不实施这些扩展。

项目样式仅包含主、副字幕样式；视频保留画幅与 `styleSource: project | custom`。视频进入 custom 时复制当前生效样式；恢复跟随时确认后丢弃独立样式。前端将视频编辑与项目样式分别标 dirty，保存各自快照和版本，成功的部分不重复提交，冲突的部分暂停并提示，不用整个项目快照覆盖其他视频。

**2. 可靠写入与迁移**

v1 单视频原样式拆成项目样式和视频画幅；原视频标记跟随。迁移函数按实际 stylePair 类型拆字段，保留字幕、译文、删除标记、媒体及未识别数据，不把不认识字段静默清掉。未知更新版本仍拒绝写入。

`.tmp → rename` 只保证单文件原子性。涉及 edits 和 project.json 的修改增加项目事务恢复记录：写入目标文件快照和版本后，在同一项目队列内依次落盘，最后删除恢复记录；Host 重启先幂等完成事务，再开放该项目读写。迁移备份 v1 数据，完成后才提交 formatVersion=2；中断重试不重复迁移。列表与打开均须等待该项目恢复，不能看到半次保存。磁盘满或恢复失败应报错，不假装保存成功。

**3. 回收站与媒体保护**

项目不移动目录；project.json 增加 deletedAt 和 purgeAfter。普通 list/detail/open/写入/媒体流均检查项目是否活跃，回收站只返回摘要，不提供编辑或媒体播放。trash/restore 与所有保存、删除操作共用项目队列；恢复后重新读取当前修订号，不能把旧缓冲区直接 force 覆盖。

Host 启动和定时扫描到期项目，按锁内重新读取的截止时间判定，恢复先执行则清理不得再删。永久删除只删除受控项目目录及 stored 媒体，绝不沿 linked 路径、符号链接删除外部文件。删除中断用清理标记确保重启可继续，不把半删项目重新展示为活跃。清空回收站逐项目处理；部分失败返回失败项，界面重载当前列表并保留失败提示。

**4. 视频切换与异步隔离**

切换前 flush 当前视频和样式的保存，失败走 F-0002 离开保护。切换成功清空撤销栈，重置播放器/导出上下文；请求带项目、视频和会话 generation，旧请求/ASR 回调不能写入新视频。Host 记录转写所属视频，禁止转写中移除视频或绕过界面切换；不实现后台转写。移除其他视频不影响当前视频。

**5. 删除后的未保存修改**

客户端保留当前视频编辑、样式、转写及媒体引用快照。trashed 时先 restore，再以最新版本执行保存与冲突处理。deleted 时创建新项目并保存快照：linked 媒体由外壳重新登记；stored 媒体原文件已销毁时不得伪称恢复成功，保留可恢复的字幕和编辑数据并进入 F-0002 媒体丢失流程。实现前验证这一流程能够承载缺失媒体的新项目；恢复失败保持快照与对话框，不丢弃当前修改。

### 接口与数据

以下为计划新增协议，开发时以 F-0002 验收后的类型为准。

| RPC | 输入要点 | 输出 / 规则 |
|---|---|---|
| projects.createEmpty | name（本地化默认名由前端提供） | projectId、项目摘要 |
| projects.detail | projectId | 项目元数据、样式版本、视频摘要；不整批读取转写 |
| projects.rename | projectId、name、baseMetadataRevision | 更新摘要或冲突；名称 trim 后 1–200 字符 |
| projects.trash / restore | projectId、baseMetadataRevision | 生命周期变更或冲突；restore 可幂等返回当前活跃版本 |
| projects.trashList | 无 | 删除时间、到期时间、数量与摘要 |
| projects.purge / emptyTrash | projectId 或当前回收站项目快照 | 删除结果与失败项；不波及调用后才进入回收站的项目 |
| projects.addVideo | projectId、videoName、mediaSource、durationSeconds | videoId、新版本；单文件原子加入，失败不残留半个视频 |
| projects.removeVideo | projectId、videoId、baseVideoRevision | 更新摘要；转写中拒绝 |
| projects.saveVideoEdits | projectId、videoId、baseVideoRevision、edits、显式 force | saved / conflict / trashed / deleted / video-missing |
| projects.saveProjectStyle | projectId、baseStyleRevision、主副样式、显式 force | saved / conflict / trashed / deleted |

打开结果增加样式来源及对应修订号；空项目由 detail 打开，不改变旧 open 要返回 video 的契约。转写写入增加视频身份和生命周期校验。force 只绕过用户明确选择的目标版本冲突，不绕过项目删除、视频缺失或转写限制。不依赖跨进程事件保证一致性：操作后重查列表，保存前 Host 权威检查；未来需要即时推送再显式声明 RemoteEvents。

### 备选方案与取舍

| 选择 | 备选 | 取舍 |
|---|---|---|
| 视频/样式分别比较版本，项目内写入仍串行 | 项目级冲突检测 | 满足 AC-14，同时保持简单的磁盘写入顺序 |
| deletedAt 标记回收站 | 整个目录移到 trash/ | 保持媒体定位稳定；所有读取入口必须统一检查生命周期 |
| JSON + 可恢复事务记录 | 引入 SQLite | 沿用 F-0002 部署与打包，不增加原生数据库依赖；需补崩溃恢复测试 |
| 项目样式引用 | 复制样式到所有视频 | 无需批量重写视频，明确 custom 与跟随关系 |

## 架构决策

- [ADR-0003 多视频项目格式、并发保存与回收站](../../20-architecture/adr/0003-multi-video-projects.md)，proposed；维护者在验收时一并审阅。作为 ADR-0001 的格式 2 扩展，不重写已接受的格式 1 契约。

## 自行决定的事项

- 采用新增保存方法保留旧 baseRevision 语义，避免改写 F-0002 共用契约（AC-14、AC-16）。
- 回收站用标记，不移动目录；用可恢复事务记录解决跨文件一致性（AC-3–5、AC-16）。
- 排序/搜索/视图以及关闭项目样式提示是界面偏好，业务数据只存 Host（AC-6、AC-31）。
- 永久删除后的另存尽量保留字幕编辑；媒体已删除时沿用媒体丢失机制，不能恢复已销毁的源媒体（AC-32）。

## 风险与回退

- 当前 F-0002 正在开发，其真实契约可能变化；进入开发前重新对照其验收 commit，更新本设计中的接口映射。
- 格式 2 旧程序不能打开，不能靠降级二进制回退。迁移前保留 v1 备份；只有确认没有新编辑时才允许人工恢复备份，不覆盖新数据。
- 文件事务、删除与保存竞态最容易丢数据，须故障注入验证；删除绝不跟随外部路径。
- 范围较大，沿用维护者已确认的整体实现决定；按下面纵向清单提交，不拆成多个发布。

## 实现清单

- [x] 1. **空项目、重命名与排序**：定义格式 2、修订号及迁移/事务契约，实现 createEmpty/detail/rename，首页与对话框接真实数据，迁移和中断测试随代码提交（AC-1、AC-2、AC-6、AC-16、AC-18–21）。
- [x] 2. **项目删除与恢复**：trash/restore/trashList、首页删除提示和撤销、回收站各状态及恢复失败（AC-3、AC-4、AC-22、AC-23、AC-25）。
- [x] 3. **永久清理**：purge/emptyTrash、启动和定时到期清理、确认框、部分失败和崩溃恢复；验证所有 linked 原文件不受影响（AC-5、AC-24）。
- [x] 4. **项目详情与多视频添加**：多选/拖入登记、逐文件状态、视频列表、打开与移除；转写任务身份和移除保护（AC-7–9、AC-11、AC-19、AC-26–29）。
- [x] 5. **编辑器视频切换**：保存屏障、加载隔离、撤销清空、媒体及导出上下文、转写期间限制（AC-9、AC-10、AC-30）。
- [x] 6. **共享样式和并发保存**：主副样式与画幅拆分、独立/跟随切换、新保存 RPC 与版本冲突流程（AC-12–14、AC-31）。
- [x] 7. **项目被删除后的保护**：生命周期错误、恢复并保存、另存快照与媒体缺失回退、放弃修改（AC-15、AC-32）。
- [x] 8. **两端回归与性能验收**：Web 同 Host、桌面真实主流程、明暗及中英文端到端证据、10 视频详情及 60 分钟视频切换性能、F-0002 全部 AC 回归与文档更新（AC-1–32，重点 AC-17）。

## 验证计划

- 每项完成执行设计对应的 Host/纯逻辑测试与 E2E；全量验收执行 `pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`、`cargo check --manifest-path src-tauri/Cargo.toml`、`pnpm test`、`pnpm test:architecture`、`pnpm build`；修改桌面外壳时加 `pnpm build:funasr-sidecar`。
- Host 测试以临时目录和可注入时钟验证迁移不丢字段、事务每个断点重启、同视频冲突/不同视频成功/样式冲突、trash/save/purge/restore 串行竞态、原始文件及外部符号链接保护、部分添加/清理失败。行为改动做 Red check，记录撤掉实现后相关断言失败。
- `tests/e2e/features/F-0003.spec.ts` 测试名含 F-0003/AC-n；覆盖 AC-18–32 的每个界面状态，明暗主题及中英文；用 page.route 固定错误、挂起请求和时间，用 shot 保存每个状态截图；真实 Host 多窗口测试覆盖 AC-14、AC-15，不能只用 mock 证明存储一致性。
- 运行 `pnpm e2e:evidence F-0003`，截图入 git，录屏本地保存。在浏览器实际点完整主流程，再在 `pnpm tauri:dev` 用真实视频完成添加、转写、校对、样式共享、切换、逐段导出、删除和恢复；实际用播放器确认导出对应目标视频。
- 桌面分别验证内置 sherpa-onnx 与已配置 HTTP Provider，真实模型/接口不可用则记录 Not run。Web 连接同一 Host 验证 AC-1–13 和跨端打开；并发与生命周期路径同样回归。记录 10 视频详情加载、60 分钟视频切换耗时；验收固定 commit，改代码后重跑受影响检查。

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | createEmpty、空详情路由，清单 1 |
| AC-2 | rename、metadataRevision、各处重新取摘要，清单 1 |
| AC-3 | deletedAt 标记与活跃列表过滤，清单 2 |
| AC-4 | restore 与媒体原位保留，清单 2 |
| AC-5 | 锁内清理和 linked 保护，清单 3 |
| AC-6 | 首页排序与偏好，清单 1 |
| AC-7 | 单/多/空项目路由，清单 4 |
| AC-8 | addVideo、assetId/mediaRef 与部分失败，清单 4 |
| AC-9 | 按视频打开、转写身份和快照加载，清单 4、5 |
| AC-10 | 保存屏障、generation 与撤销清空，清单 5 |
| AC-11 | removeVideo、任务保护、末视频移除保留项目，清单 4 |
| AC-12 | 项目样式与 v1 迁移，清单 1、6 |
| AC-13 | styleSource、恢复确认、视频画幅隔离，清单 6 |
| AC-14 | videoRevision/styleRevision 独立检测，清单 6 |
| AC-15 | 生命周期检查与保存暂停，清单 7 |
| AC-16 | v1 备份、事务化迁移、新版本拒绝写入，清单 1 |
| AC-17 | Web 共用 RPC、同 Host 跨端验证，清单 8 |
| AC-18 | 首页新建按钮和创建中禁用，清单 1 |
| AC-19 | 卡片/行菜单、视频数与聚合时长，清单 1、4 |
| AC-20 | 排序控件与搜索组合，清单 1 |
| AC-21 | 重命名校验/等待/失败/取消，清单 1 |
| AC-22 | 删除确认和恢复撤销，清单 2 |
| AC-23 | TrashPage 全状态与到期时间，清单 2 |
| AC-24 | 单项目/清空确认、等待与失败，清单 3 |
| AC-25 | 恢复等待/成功/失败，清单 2 |
| AC-26 | ProjectDetail 全状态，清单 4 |
| AC-27 | 添加遮罩、逐文件状态与失败隔离，清单 4 |
| AC-28 | 移除确认/失败，清单 4 |
| AC-29 | 打开中状态与其他行禁用，清单 4 |
| AC-30 | 面包屑、视频切换和转写禁用，清单 5 |
| AC-31 | 样式来源、恢复确认和一次性提示，清单 6 |
| AC-32 | 删除错误分支、恢复保存/另存/放弃，清单 7 |

## 开发前置条件

F-0002 的 `04-test-report.md` 必须 approved（或需求已归档）。2026-11-05 已满足（F-0002 验收由 zhangxiang.chen 确认），开发阶段已开始；实现与本设计的差异见 03-implementation.md「与设计的偏差」和 ADR-0003。

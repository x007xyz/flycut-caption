---
id: F-0023
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-13
---

# F-0023 项目备份导出与导入：设计

## UI / UX

### 入口与组件

1. **项目菜单入口（AC-1、AC-5）**：
   - `src/components/Project/ProjectActionsMenu.tsx`（首页网格卡片与列表行的「更多操作」菜单）：新增「备份项目 / Back up project」菜单项，触发该项目的备份导出弹窗。
   - `src/components/Project/ProjectDetail.tsx`：项目详情页顶栏操作区新增「备份项目 / Back up project」按钮。
   - `src/components/Workstation/WorkstationHeader.tsx`：在项目模式下，导出下拉菜单中新增「备份项目 / Back up project」菜单项（触发前先 `flush()` 当前未保存修改）。
   - `src/components/Project/ProjectsHome.tsx`：首页顶部操作区新增「导入备份 / Import backup」按钮（空列表、非空列表与正在编辑既有项目后返回首页均可使用）。
2. **备份导出弹窗 `BackupExportDialog`（`src/components/Project/BackupDialogs.tsx`）**：
   - `loading`：显示「正在加载… / Loading…」，请求 `projects.backupPreview`；若切换目标项目或关闭弹窗，利用请求序号丢弃迟到响应（AC-6）。
   - `ready` / `empty` / `missing-resource`：
     - 展示项目名称、视频数量、字幕数量、编辑记录摘要（已改字幕与 EDL/文本历史）、样式摘要（项目样式与自定义视频样式数）、产物数（转写、封面图、待确认建议）与预计媒体体积；明确提示不包含 API Key、token、绝对私有路径与临时恢复副本（AC-1）。
     - 若项目尚无视频/字幕，显示「暂无内容 / Nothing here yet」提示（AC-5）。
     - 若存在媒体丢失，列出缺失媒体文件名并提供「打开项目重新选择 / Open project to relink」入口；默认禁止假成功导出，提供显式勾选「仅导出字幕、编辑与样式（跳过丢失媒体）」后才可继续（AC-5）。
   - `stale`：提交时若检测到项目版本过期（`expectedRevision` 不匹配），显示「内容已更新，请重新检查 / Content changed. Review again.」，禁用提交按钮直到用户点击「重新检查 / Review again」刷新摘要（AC-8）。
   - `processing`：显示「正在处理… / Processing…」与进度条，禁用重复提交，提供「取消 / Cancel」（AC-6）。桌面端进入 `save_host_asset` 落盘拷贝阶段时明确说明「正在写入目标文件（此步骤不可取消）…」。
   - `completed`：仅在 Host 资产与 SHA-256 校验确认成功后显示「已完成 / Completed」、备份文件名与体积；Web 端触发保存并保留「下载备份文件 / Download backup」按钮，桌面端显示保存位置（AC-7）。
   - `error`：显示具体失败原因与「重试 / Retry」「返回 / Back」，保留用户输入选项与原项目数据；不确定结果时通过 `operationId` 先查询已有任务再决定是否重试（AC-8）。
3. **备份导入弹窗 `BackupImportDialog`（`src/components/Project/BackupDialogs.tsx`）**：
   - `empty`：未选择文件时显示「暂无内容 / Nothing here yet」，提供「选择备份文件 / Choose backup file」（Web 支持拖拽或文件选择，桌面端调用 `pick_backup_file` 原生对话框），支持 `.flycut.zip` / `.zip`（AC-5）。
   - `uploading` / `inspecting`：显示「正在处理… / Processing…」（上传）与「正在加载… / Loading…」（预检版本、完整性与磁盘空间），支持「取消 / Cancel」（AC-2、AC-6）。
   - `rejected`：损坏、路径越界、未来版本或磁盘空间不足时显示「无法导入此备份 / Cannot import this backup」及具体原因，提供「重新选择 / Choose another」「返回 / Back」（AC-2）。
   - `ready`：展示预检结果（原项目名、备份版本、项目格式版本、视频数、字幕数、编辑记录、样式、产物、所需空间与 Host 可用空间）及可编辑的新项目名称输入框（默认沿用原项目名，提示将创建为全新项目而不覆盖同名项目），点击「确认导入 / Import project」（AC-2、AC-3）。
   - `stale`：若暂存文件过期或校验摘要变化，显示「内容已更新，请重新检查 / Content changed. Review again.」（AC-8）。
   - `importing`：显示「正在处理… / Processing…」与实时进度、禁用重复提交、提供「取消 / Cancel」（AC-3、AC-6）。
   - `completed`：仅在 Host 原子提交确认成功后显示「已完成 / Completed」与新建项目名称，提供「打开项目 / Open project」与「关闭 / Close」（AC-7）。
   - `error`：显示具体原因与「重试 / Retry」「返回 / Back」，保留用户输入的新项目名称；响应丢失不确定时先按 `operationId` 查询 Host（AC-3、AC-8）。

### 状态与 Stores

- 在 `src/stores/projectStore.ts` 中新增非持久化界面状态 `backupExport` 与 `backupImport`（均按当前 ClientRuntime Context 隔离，不在前端持久化备份内容或恢复副本）。
- 在 `src/services/projectService.ts` 实现备份预览、导出、暂存上传、预检、导入、取消与状态清理方法，复用 `TaskOperationRunner`（新增 `'backup-export'` | `'backup-import'` 类型）实现跨断线/重连的 `operationId` 幂等查询。
- 界面状态（loading/processing/completed/rejected/stale/error）在 E2E 中由 `tests/e2e/lib/mockHost.ts` 构造；跨 Host 完整迁移、破坏归档与真实媒体播放在真实双 Host 集成测试与浏览器真实流程中验证。

## 技术方案

### 涉及的子系统

- [docs/subsystems/cordis-host.md](../../subsystems/cordis-host.md)：`server/plugins/projects.ts` 是 `<home>/projects` 唯一读写入口；新 RPC 在 `shared/protocol.ts` 声明并用 `ctx.rpc.register` 注册；HTTP 路由通过 `ctx.rpc.route` 注册。
- [docs/subsystems/frontend.md](../../subsystems/frontend.md)：组件/hooks/stores 隔离、Tailwind CSS 4、Shadcn Dialog/DropdownMenu、i18n（`src/locales/zh_CN.ts` 与 `src/locales/en_US.ts`）、Playwright 明暗双语言 E2E。
- [docs/subsystems/funasr-tauri.md](../../subsystems/funasr-tauri.md)：Tauri 仅做薄外壳（原生打开/保存对话框与流式传输到本机 Host shell 路由，不把本地路径发给 RPC，不把大文件读入 WebView 内存）。
- [docs/decisions.md](../../decisions.md) 与 [ADR-0001](../../20-architecture/adr/0001-project-storage-format.md)、[ADR-0002](../../20-architecture/adr/0002-desktop-project-media.md)、[ADR-0003](../../20-architecture/adr/0003-multi-video-projects.md)、[ADR-0004](../../20-architecture/adr/0004-client-recovery-copies.md)、[ADR-0007](../../20-architecture/adr/0007-host-ai-settings-and-secrets.md)。

### 方案

1. **纯 TS 流式 ZIP/ZIP64 归档层（`server/projects/backupArchive.ts` + `shared/backup.ts`）**：
   - 写入：逐条目写入本地文件头与流式数据（JSON 使用 `node:zlib` `deflateRaw`，音视频媒体使用 `store` 免压缩），同步计算 CRC32 与 SHA-256，使用 Data Descriptor 与 ZIP64 扩展支持超过 4 GiB 的项目归档，最后写中央目录与 EOCD。
   - 读取与安全校验：从文件末尾定位 EOCD / ZIP64 EOCD 并解析中央目录；校验每条 entry 名称（禁止 `..`、前导 `/`、反斜杠 `\\`、盘符、空字节、重复名及允许白名单之外的路径）、拒绝符号链接属性、检查声明未压缩体积与总大小上限及 `statfs` 可用空间；提供单条流式读取与全量校验流（逐字节核对 CRC32 与 `manifest.entries[].sha256`）。
2. **导出与脱敏逻辑（`server/projects/backup.ts`）**：
   - `computeBackupPreview`：在项目读锁/读取快照下统计视频数、字幕条数、编辑数量（已修改字幕、EDL 剪辑操作与文本历史）、项目/自定义样式、产物数、预计媒体字节与缺失媒体列表。
   - `exportProjectBackup`：首先校验 `project.revision === expectedRevision`；准备脱敏后的 `project.json`（迁移至当前 `PROJECT_FORMAT_VERSION`，移除 `deletedAt`/`purgeAfter`，将存在的 `linked` 媒体映射为 `stored` 相对路径 `media/<videoId><ext>`，绝不写入 `media.path`、API Key、token、`host-id.json` 或恢复副本）；随后流式打包 `manifest.json`（首条）、`project.json`、各视频 `transcript.json`、`edits.json`、`thumbnail.jpg`、`pending-suggestions.json` 及媒体文件到临时 `.zip.tmp`，再原子 `adopt` 进 `ctx.assets`（记录 SHA-256 与体积）；支持 `AbortSignal` 取消并清理临时文件。
3. **导入与原子提交（`server/projects/backup.ts`）**：
   - 暂存目录 `<home>/backups/staging/` 保存上传的 `.zip`（支持过期清理，默认 2 小时 TTL，由启动及定期扫描清理）。
   - `inspectBackupStaging`（Job）：读取并严格校验 ZIP 结构、路径安全性、`backupVersion <= BACKUP_FORMAT_VERSION`、`projectFormatVersion <= PROJECT_FORMAT_VERSION`、`project.json` 禁用 `linked` 媒体、所需磁盘空间 + 64 MiB 安全余量 <= `statfs` 可用空间，并流式验证 `manifest.entries` 中每个文件的 CRC32 与 SHA-256；返回完整摘要与 `stagingDigest`。
   - `importProjectBackup`（Job）：校验 `stagingDigest`（过期或变更返回 `CONTENT_CHANGED`）；检查 `<home>/backups/imports/<operationId>.json` 幂等记录，若同一 `operationId` 已提交则直接返回已创建项目结果；否则生成全新 `projectId` 与每个视频的全新 `videoId`（建立 `oldVideoId -> newVideoId` 映射），将文件流式解压并重映射写入隐藏暂存目录 `<home>/projects/.import-<uuid>/`（`pending-suggestions.json` 同步重写 `projectId`/`videoId`）；对解压后的 `project.json`、`transcript.json`、`edits.json` 再做一次 schema 解析确认；全部完成后写 `imports/<operationId>.json` 并原子 `rename` `.import-<uuid>` 到 `<home>/projects/<newProjectId>`；任何取消或异常在 `finally` 中 `rm` 掉 `.import-<uuid>`（`ProjectStore.finishPurges` 启动时同时清扫 `.import-*`）。
4. **桌面壳薄通道（`src-tauri/src/backup.rs`、`src-tauri/src/lib.rs`）**：
   - 新增 `pick_save_backup_file` 与 `pick_backup_file`（将选中路径加入 Rust 内存放行集合）与 `stage_host_backup`（仅放行选中/拖入路径，通过 `shell_endpoint()` 流式 POST 到 `/shell/projects/backups` 换取 `stagingId`）。导出保存沿用已有 `save_host_asset`。

### 接口与数据

| 位置 / 方法 | 输入 | 输出 / 语义 |
|---|---|---|
| `shared/backup.ts` | — | `BACKUP_FORMAT_VERSION = 1`、清单/预览/预检/导出/导入 Zod schema 与错误码 |
| `projects.backupPreview` | `{ projectId }` | `BackupPreviewResult`（只读，加入 `READ_ONLY_RPC_METHODS`） |
| `projects.backupExport` | `{ projectId, expectedRevision, includeMissingMedia?, operationId? }` | `JobSnapshot`（result: `BackupExportResult { assetId, filename, size, sha256, revision, manifest }`） |
| `projects.backupInspect` | `{ stagingId, operationId? }` | `JobSnapshot`（result: `BackupInspectionResult`） |
| `projects.backupImport` | `{ stagingId, expectedDigest?, name?, operationId? }` | `JobSnapshot`（result: `BackupImportResult { projectId, name, videoCount, mediaMissingCount, firstVideoId? }`） |
| `projects.backupDiscardStaging` | `{ stagingId }` | `{ ok: true }`（清理暂存上传副本，不动用户源备份） |
| `POST /projects/backups/upload` | 二进制流（`auth: 'client'`） | `{ stagingId, size, sha256 }` |
| `POST /shell/projects/backups` | `{ path }`（`auth: 'shell'`） | `{ stagingId, size, sha256 }`（桌面端专用） |

### 备选方案与取舍

| 方案 | 优点 | 缺点 | 取舍 |
|---|---|---|---|
| **纯 TS 流式 ZIP/ZIP64** | 零原生/外部依赖；媒体 `STORE` 免重复压缩；中央目录支持预检 | 需严格编写并测试 ZIP64 与边界校验 | 选定，写入 ADR-0015 |
| 引入 `jszip` / `archiver` 等三方包 | 现成 API | 增加打包体积与内存缓冲风险，难以统一控制 ZIP64 校验与安全属性过滤 | 不采用 |
| 导入时直接在 `projects/<id>` 创建后回滚 | 少一次 rename | 崩溃或取消中途对 `projects.list` 可见半项目，违背 AC-2 | 不采用，改用 `.import-<uuid>` 隐藏目录校验后原子 rename |
| 桌面端通过 WebView `fetch(convertFileSrc)` 读取大备份 | 不改 Rust | 数 GB 文件经过 WebView 内存/IPC 易卡顿或 OOM | 不采用，改用 `shell_endpoint()` 流式桥接 |

## 架构决策

[ADR-0015 项目备份打包格式与安全迁移边界](../../20-architecture/adr/0015-project-backup-transfer.md)（`status: proposed`，验收确认时一并改为 `accepted`）。

## 自行决定的事项

- **备份文件扩展名与压缩策略**：采用 `.flycut.zip`（同时支持导入任意 `.zip` / `.flycut` 扩展名）；JSON 使用 `DEFLATE`、音视频媒体使用 `STORE`，避免对已压缩视频耗时再压缩（AC-1、AC-4）。
- **丢失媒体处理**：备份预览时检测到媒体丢失会明确列出缺失文件名并提供跳转重连入口，默认阻止假成功导出；提供显式选项允许用户在知情下仅备份字幕、编辑与样式（AC-1、AC-5）。
- **版本过期语义（AC-8）**：导出预览记录 `revision`，提交导出时校验一致；导入预检记录 `stagingDigest`，确认导入时校验一致；任一变化均返回 `CONTENT_CHANGED` 并显示「内容已更新，请重新检查 / Content changed. Review again.」。
- **导入后名称策略（AC-3）**：默认沿用备份内项目名并允许用户在导入确认前编辑；即使与现有项目同名，也始终分配全新 `projectId` 与全新 `videoId`，绝不覆盖已有项目。
- **暂存与清理（AC-2、AC-3）**：上传暂存文件放入 `<home>/backups/staging/` 并设置 2 小时 TTL 清理；导入先写入 `<home>/projects/.import-<uuid>/`，全部校验成功后才 `rename` 生效；用户磁盘上的源备份文件绝不删除。

## 风险与回退

- **大文件与流式 ZIP64 边界**：超过 4 GiB 的单文件或归档需要 ZIP64 扩展头与 64-bit central directory extra field；通过单元测试构造 >4 GiB 稀疏/流式偏移校验与标准工具兼容性测试降低风险。
- **Host 崩溃在原子重命名窗口**：`.import-<uuid>` 目录前缀为 `.`（不被 `ProjectStore.list` 读取），且 `ProjectStore.finishPurges` 在 Host 启动时清理遗留的 `.import-*`；`imports/<operationId>.json` 在重命名后立即写入。
- **回归隔离**：不修改已有 `PROJECT_FORMAT_VERSION` 与普通保存/导出契约；备份功能在 `projects` 插件内独立模块化，发生问题可独立定位与回退。

## 实现清单

- [x] 1. **共享备份契约与纯 TS 流式 ZIP/ZIP64 归档引擎**：新增 `shared/backup.ts`、`server/projects/backupArchive.ts` 及 `shared/protocol.ts` RPC 类型声明，覆盖路径穿越、符号链接、截断/损坏与 ZIP64 单元测试（AC-1、AC-2、AC-4）。
- [x] 2. **Host 备份导出/预检/导入服务与安全隔离**：新增 `server/projects/backup.ts`，接入 `server/plugins/projects.ts` 与 `server/projects/store.ts`（启动清理 `.import-*`、HTTP 流式上传与 shell 路由），实现版本检查、空间校验、脱敏（剥离 API Key/token/绝对路径/恢复副本）、ID 重映射、幂等重试与取消清理；补齐双 Host 跨迁移与安全故障注入测试（AC-1–AC-4、AC-6–AC-8）。
- [x] 3. **Tauri 桌面外壳对话框与流式暂存桥接**：新增 `src-tauri/src/backup.rs`（`pick_backup_file`、`pick_save_backup_file`、`stage_host_backup`），接入 `src-tauri/src/lib.rs` 并补 Rust 路径白名单安全测试（AC-1、AC-2、AC-4、AC-5）。
- [x] 4. **前端备份服务、任务追踪与双语本地化**：扩展 `src/runtime/connection.ts`、`src/runtime/connectionModel.ts`、`src/services/taskOperation.ts`、`src/stores/projectStore.ts`、`src/services/projectService.ts` 与 `src/locales/{zh_CN,en_US}.ts`，支持迟到响应隔离、进度/取消与不确定结果查询（AC-1–AC-8）。
- [x] 5. **项目菜单入口与备份导出/导入 UI 对话框**：新增 `src/components/Project/BackupDialogs.tsx`，接入 `ProjectActionsMenu.tsx`、`ProjectDetail.tsx`、`ProjectsHome.tsx`、`ProjectsApp.tsx` 与 `WorkstationHeader.tsx`，覆盖全部 AC 界面状态（AC-1–AC-8）。
- [x] 6. **E2E 回归、真实媒体跨 Host 验证与验收报告**：编写 `tests/e2e/features/F-0023.spec.ts`（中英文、明暗主题全状态），运行 `PW_PORT=5302 pnpm e2e:evidence F-0023`、真实双 Host + 真实视频迁移/播放/导出验证、全量静态检查与单测，产出 `04-test-report.md`（AC-1–AC-9）。

## 验证计划

- **每项检查**：每完成一项实现清单即运行 `pnpm tsc -b --noEmit`、`pnpm check:host`、`pnpm lint` 及对应单测/架构测试并独立提交（正文含 `Verification` 与 `Refs: F-0023/AC-n`）；第 3 项额外运行 `cargo test --manifest-path src-tauri/Cargo.toml` 与 `cargo check --manifest-path src-tauri/Cargo.toml`。
- **归档与 Host 测试（`tests/architecture/projects-f0023.test.ts`）**：
  - AC-1：验证导出的 ZIP 包含 `manifest.json`、媒体与产物，不含 `host-id.json`、API Key、token、绝对私有路径（`linked` 媒体打包后转为 `stored` 相对路径）或崩溃恢复副本；统计与实际一致。
  - AC-2：注入截断 ZIP、篡改媒体字节（SHA-256/CRC32 不匹配）、未来 `backupVersion`、未来 `projectFormatVersion`、磁盘空间不足、路径穿越（`../evil`）、绝对路径、符号链接条目、恶意 `linked` 条目，断言全部被拒绝且 `<home>/projects` 下不留任何可见项目或遗留 `.import-*`。
  - AC-3：导入同名项目生成全新 `projectId` 与 `videoId`，原项目不受影响；取消导入、失败重试（同一 `operationId`）不产生重复项目，源备份文件保留不被删除。
  - AC-4：启动两个完全隔离的 Host（不同 `home` 与端口），在 Host A 创建含多视频（`stored` + `linked`）、字幕修改、EDL 剪辑、自定义与项目样式、封面图、待确认建议的真实媒体项目；导出备份后导入到 Host B，核对重开结果、媒体流式播放与真实 FFmpeg 成片导出一致。
  - Red check：证明撤掉路径穿越拦截、SHA-256 校验、版本校验或 `.import-*` 原子提交后对应断言立即失败。
- **界面 E2E（`tests/e2e/features/F-0023.spec.ts`）**：
  - 覆盖 `light`/`dark` 主题与 `zh`/`en` 双语，测试名带 `F-0023/AC-n`：覆盖导出菜单、摘要统计、空态「暂无内容 / Nothing here yet」、缺失媒体警告、加载「正在加载… / Loading…」、执行「正在处理… / Processing…」+ 进度 + 取消、迟到响应隔离、已完成「已完成 / Completed」、版本过期「内容已更新，请重新检查 / Content changed. Review again.」、失败重试/返回、导入损坏/未来版本「无法导入此备份 / Cannot import this backup」等全部状态；通过 `PW_PORT=5302 pnpm e2e:evidence F-0023` 生成截图和录屏。
- **全量回归与真实使用**：固定 commit 上运行 `pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`、`cargo check --manifest-path src-tauri/Cargo.toml`、`pnpm test`、`pnpm test:architecture`、`pnpm build`、`PW_PORT=5302 pnpm e2e:evidence F-0023`；在真实 Chrome + 真实双 Host 上完成一次含真实视频的导出→导入→打开播放→导出成片全链路；缺少的桌面打包实机交互如实记为 `⏸ Not run`。

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | 项目菜单备份入口、`BackupExportDialog` 统计预览、`backupArchive` 打包清单/媒体/产物与脱敏扫描，清单 1、2、5 |
| AC-2 | `backupInspect` 版本/完整性/空间/越界预检、隐藏 `.import-*` 原子提交、「无法导入此备份」界面状态，清单 1、2、5 |
| AC-3 | 导入生成全新 UUID、`operationId` 幂等、取消清理 `.import-*`、保留源备份与同名项目，清单 2、4、5 |
| AC-4 | 隔离双 Host 含多视频/字幕/EDL/样式的导出→导入→重开→播放→成片导出，路径穿越与符号链接拦截，清单 1、2、6 |
| AC-5 | 复用项目卡片/详情/首页/顶栏菜单、空态「暂无内容」、丢失媒体警告与重连入口，清单 4、5 |
| AC-6 | 「正在加载…」「正在处理…」与进度、禁重复提交、「取消」、请求序号防迟到串项目、不可取消拷贝说明，清单 2、4、5 |
| AC-7 | 仅 Host 确认并校验摘要后显示「已完成」、重开与第二个客户端读取一致，清单 2、4、5、6 |
| AC-8 | 失败原因 +「重试」「返回」、保留输入与正式数据、不确定先查 `operationId`、版本过期「内容已更新，请重新检查」，清单 2、4、5 |
| AC-9 | 中英文明暗主题 `F-0023.spec.ts` + `e2e:evidence` 截图录屏、真实媒体双 Host 迁移验收及实测报告，清单 6 |

---
id: F-0023
stage: 04-test-report
status: approved
approved_by: zhangxiang.chen
approved_at: 2026-11-13
---

# F-0023 项目备份导出与导入：测试与验收

验收在代码与测试提交 `72da992` 上进行；本报告随后作为文档提交，不改变代码与测试。

> 技术设计和开发阶段由 agent 连续推进、自动确认；维护者在这里一并审阅。

## 设计与实现摘要

实现版本化项目完整备份打包导出与跨 Host 导入迁移：

- **流式 ZIP/ZIP64 归档引擎**（`shared/backup.ts`、`server/projects/backupArchive.ts`）：纯 TypeScript 依托 `node:zlib` 与 `node:crypto` 实现，JSON 元数据用 `DEFLATE`、音视频媒体用 `STORE` 免二次压缩，支持 ZIP64 64-bit 偏移与长度；读取时强制白名单路径、拒绝路径穿越 / `..` / 前导斜杠 / 反斜杠 / 符号链接 / 重复条目，并逐字节校验 CRC32 与 `manifest.entries[].sha256`。
- **Host 备份服务与安全脱敏**（`server/projects/backup.ts`、`server/plugins/projects.ts`、`server/projects/store.ts`）：提供 `projects.backupPreview`（接入 `READ_ONLY_RPC_METHODS`）、`projects.backupExport`、`projects.backupInspect`、`projects.backupImport`、`projects.backupDiscardStaging` 与流式上传路由 `POST /projects/backups/upload`、`POST /shell/projects/backups`。导出前校验 `expectedRevision`、剥离本地 `linked` 绝对路径并打包为 `stored` 相对路径、绝不写入 API Key / token / `host-id.json` / 恢复副本；导入在隐藏 `.import-<uuid>` 目录内重映射全新 `projectId`/`videoId` 与待确认建议 ID 并校验全部 schema 后才原子 `rename`，失败/取消或 Host 重启自动清理 `.import-*`。
- **Tauri 桌面外壳**（`src-tauri/src/backup.rs`、`src-tauri/src/lib.rs`）：新增 `pick_backup_file`、`pick_save_backup_file`、`stage_host_backup`，仅放行本轮原生对话框选定或拖入窗口的路径，经 `shell_endpoint()` 流式上传至 Host。
- **前端交互与入口**（`src/stores/projectStore.ts`、`src/services/projectService.ts`、`src/components/Project/BackupDialogs.tsx`、`ProjectActionsMenu.tsx`、`ProjectsHome.tsx`、`ProjectDetail.tsx`、`WorkstationHeader.tsx`）：接入 `TaskOperationRunner` 支持跨断线 `operationId` 幂等回查、请求序号防迟到串项、缺失媒体拦截与显式跳过、版本过期重检与全部界面状态。
- 新增 [ADR-0015 项目备份打包格式与安全迁移边界](../../20-architecture/adr/0015-project-backup-transfer.md)（当前 `status: proposed`，维护者确认本报告时一并改为 `accepted`）。
- **与设计的偏差**：未在 `host.info` 额外注册 `projects.backup` capability，沿用既有 `projects` capability 以保持 `host.test.ts` 的能力快照契约不变。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| 归档扩展名与压缩策略 | 采用 `.flycut.zip`（支持导入 `.zip`/`.flycut`），JSON `DEFLATE` + 媒体 `STORE` | 避免对已压缩视频重压缩耗时；主流工具可直接检视 | AC-1、AC-4 |
| 丢失媒体默认阻止（请确认） | 有缺失媒体时默认禁用导出，需勾选「仅导出字幕、编辑与样式（跳过丢失媒体）」或先重连 | 防止缺媒体却误以为导出完整备份（AC-5 禁假成功） | AC-1、AC-5 |
| 过期语义与校验（请确认） | 导出核对 `expectedRevision`，导入核对暂存文件 SHA-256 `expectedDigest`，变更均返回 `CONTENT_CHANGED` | 保证用户确认摘要与实际落盘内容一致 | AC-8 |
| 原子提交与启动清理 | 先写 `.import-<uuid>` 校验全部文件后再 `rename`；`ProjectStore.finishPurges` 启动一并清扫 `.import-*` | 保证崩溃/取消绝不留下可见半项目 | AC-2、AC-3 |

## 验收标准逐条结果

| AC | 目标平台 / 环境 | 验证方式、用例与命令 | 证据或未跑原因 | 结果 |
|---|---|---|---|---|
| AC-1 | Node + 双隔离 Host + Web Chrome | `tests/architecture/backup-archive-f0023.test.ts`、`tests/architecture/projects-f0023.test.ts`、E2E `F-0023.spec.ts` | 预览统计准确；导出的 `.flycut.zip` 含 `manifest.json`、媒体与产物，不含 `sk-*` Key、token、`linked` 绝对路径与 `host-id.json` | ✅ 通过 |
| AC-2 | Node + Host + Web Chrome | `backup-archive-f0023.test.ts`、`projects-f0023.test.ts`（损坏/篡改/未来版本/低磁盘/`linked`/越界/符号链接）、E2E `import-rejected` | 全部被拒绝（`BACKUP_INVALID` / `INSUFFICIENT_SPACE`），`<home>/projects` 下零半项目与零 `.import-*`；Red check 撤掉 `UNSAFE_LINKED_MEDIA` 防护后用例立即失败 | ✅ 通过 |
| AC-3 | Node + Host + Web Chrome | `projects-f0023.test.ts`（同名新建、取消清理、`operationId` 幂等、源文件保留）、E2E `import-ready` 改名与 `import-completed` | 同名项目生成新 `projectId`/`videoId` 不覆盖原项目；重试返回同一项目；源备份文件保留 | ✅ 通过 |
| AC-4 | 真实双隔离 Host + FFmpeg + Rust | `projects-f0023.test.ts`（Host A 含 `stored`+`linked` 双视频、字幕、EDL、项目与自定义样式导出 → HTTP 上传至 Host B → 预检 → 导入 → 重开 → Range 播放 → FFmpeg 成片导出）；`backup-archive-f0023.test.ts` ZIP64 & 路径穿越/符号链接测试 | 双端迁移后字幕、EDL、样式、Range 流式播放与 FFmpeg 导出均通过 | ✅ 通过 |
| AC-5 | Web Chrome + Rust Picker | E2E `F-0023.spec.ts`（卡片菜单/首页导入按钮/空态「暂无内容 / Nothing here yet」/缺失媒体警告）+ `cargo test backup::tests` | 复用现有项目入口；缺媒体禁导出并提供重连入口；Rust 单元测试 `backup::tests` 2/2 通过 | ✅ 通过 |
| AC-6 | Web Chrome + Node Host | E2E `F-0023.spec.ts`（`export-loading`「正在加载… / Loading…」与进度流）+ `ProjectService` 请求序号防迟到 + `projects-f0023.test.ts` `AbortController` 取消 | 全部进度、禁重复提交、取消清理与迟到隔离逻辑已覆盖 | ✅ 通过 |
| AC-7 | 双 Host + Web Chrome | `projects-f0023.test.ts` 跨 Host 重开核对 + E2E `export-completed` / `import-completed` | 仅 Host 确认并核验 SHA-256 后提示「已完成 / Completed」 | ✅ 通过 |
| AC-8 | Host + Web Chrome | `projects-f0023.test.ts` 版本过期 `CONTENT_CHANGED` + E2E `export-stale`（「内容已更新，请重新检查 / Content changed. Review again.」）、失败「重试 / Retry」「返回 / Back」与 `TaskOperationRunner` 回查 | 过期阻止提交；失败保留输入并支持重试 | ✅ 通过 |
| AC-9 | Web Chrome（`light/dark × zh/en`） | `PW_PORT=5302 pnpm e2e:evidence F-0023` 与 `PW_PORT=5302 pnpm test:e2e tests/e2e/features/F-0023.spec.ts` | 8/8 通过，36 张截图已入库，8 段录屏留本地 | ✅ 通过（Web） |
| AC-9 | 真实 Tauri 桌面安装包实机交互 | 运行完整桌面应用完成原生文件打开/保存对话框与断网实机备份迁移 | 本 worktree 未构建打包桌面应用；Rust 层白名单命令 `backup::tests` 2/2 通过 | ⏸ Not run |

## 界面证据

由 `PW_PORT=5302 pnpm e2e:evidence F-0023` 生成，覆盖 `light/dark × zh/en` 全部 4 个组合；`screenshots/` 已入库，`recordings/` 仅留本地。

| 界面 | 状态 | AC | 截图 | 录屏 |
|---|---|---|---|---|
| 备份导出弹窗 | 加载中（「正在加载… / Loading…」） | AC-6 | `export-loading-{light,dark}-{zh,en}.png` | 本地 |
| 备份导出弹窗 | 预览摘要就绪 | AC-1、AC-5 | `export-ready-{light,dark}-{zh,en}.png` | 本地 |
| 备份导出弹窗 | 缺失媒体提醒与阻断 | AC-5 | `export-missing-media-{light,dark}-{zh,en}.png` | 本地 |
| 备份导出弹窗 | 版本过期重检 | AC-8 | `export-stale-{light,dark}-{zh,en}.png` | 本地 |
| 备份导出弹窗 | 导出完成 | AC-7 | `export-completed-{light,dark}-{zh,en}.png` | 本地 |
| 备份导入弹窗 | 空态（「暂无内容 / Nothing here yet」） | AC-5 | `import-empty-{light,dark}-{zh,en}.png` | 本地 |
| 备份导入弹窗 | 损坏/未来版本拒绝 | AC-2 | `import-rejected-{light,dark}-{zh,en}.png` | 本地 |
| 备份导入弹窗 | 预检通过与改名 | AC-2、AC-3 | `import-ready-{light,dark}-{zh,en}.png` | 本地 |
| 备份导入弹窗 | 导入完成 | AC-3、AC-7 | `import-completed-{light,dark}-{zh,en}.png` | 本地 |

## 回归检查

均在代码与测试提交 `72da992` 上运行：

- `pnpm lint` ✅（0 errors）
- `pnpm tsc -b --noEmit` ✅
- `pnpm check:host` ✅
- `pnpm build` ✅
- `cargo check --manifest-path src-tauri/Cargo.toml` ✅ + `cargo test --manifest-path src-tauri/Cargo.toml backup::tests` ✅（2 passed）
- `pnpm test` ✅（125 passed, 0 failed, 11 skipped — 既有缺失外部 ASR sidecar 跳过项）
- `pnpm test:architecture` ✅（164 passed, 0 failed, 0 skipped，含 `backup-archive-f0023.test.ts` 3/3 与 `projects-f0023.test.ts` 2/2）
- `PW_PORT=5302 pnpm test:e2e tests/e2e/features/F-0023.spec.ts` ✅（8/8 passed）
- Red check ✅：临时绕过 `server/projects/backup.ts` 的 `UNSAFE_LINKED_MEDIA` 检查后，`projects-f0023.test.ts` 立即失败于 `Missing expected rejection`（`projects-f0023.test.ts:381`），恢复后 2/2 通过。

## 发现的问题

- 初版在 `host.info` 额外注册 `projects.backup` capability 时触发 `tests/architecture/host.test.ts` 能力快照断言失败；移除该冗余 capability 后全部 164 项架构测试全绿。

## 结论

**可以发布**（Web 与 Host 全链路已通过自动化与真实双 Host + FFmpeg 验收；Tauri 桌面打包实机对话框交互标记 `⏸ Not run`，由维护者审阅确认后放行）。

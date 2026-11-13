---
id: ADR-0015
status: proposed     # proposed → accepted → superseded / deprecated
date: 2026-11-13
deciders:
feature: F-0023
superseded_by:
---

# ADR-0015 项目备份打包格式与安全迁移边界

## 背景

创作者需要把包含多视频、字幕修改、EDL 剪辑决策、样式与媒体的完整项目打包备份，或迁移到另一台机器 / 另一个 Host（[F-0023](../../features/F-0023-project-transfer/01-spec.md)）。约束如下：

- 已拍板（[decisions.md](../../decisions.md)）：业务在 Host，Tauri 只做外壳，RPC 不接收任意本地路径；项目格式带版本号（[ADR-0001](0001-project-storage-format.md)）；桌面端可能使用 `linked` 外部媒体（[ADR-0002](0002-desktop-project-media.md)）；AI 密钥、token 与客户端 IndexedDB 崩溃恢复副本不能随项目导出（[ADR-0004](0004-client-recovery-copies.md)、[ADR-0007](0007-host-ai-settings-and-secrets.md)）。
- 10–60 分钟口播素材常达数 GB，打包和解包必须流式处理，不能整包读入内存，也不能引入需要跨平台编译的原生归档依赖。
- 导入前必须先校验版本、完整性和磁盘空间，拒绝损坏、越界路径或未来版本，不能留下可见半项目，也不能覆盖同名项目。

## 决策

**采用基于标准 ZIP/ZIP64 的版本化项目归档（`.flycut.zip`，`backupVersion: 1`），由 Host 流式读写并在隐藏暂存目录校验后原子提交为全新项目 ID。**

1. **归档布局与格式**：使用纯 TypeScript 实现的流式 ZIP / ZIP64 读写器（仅依赖 Node 内置 `node:zlib` 与 `node:crypto`）：
   - JSON 元数据使用 `DEFLATE`，音视频媒体使用 `STORE`（避免对已压缩媒体二次压缩导致 CPU 与耗时倍增）。
   - `manifest.json` 置于归档首条并记录 `backupVersion`、`projectFormatVersion`、应用版本、汇总统计（视频数、字幕数、编辑操作数、样式与产物数、媒体总字节、缺失媒体列表）及每个条目的 `size` 与 `sha256`。
   - `project.json` 导出前规范化为当前 `PROJECT_FORMAT_VERSION`，移除回收站字段（`deletedAt`/`purgeAfter`），并将存在的 `linked` 媒体打包进 `media/<videoId><ext>`、将 `media` 字段改写为 `{ kind: 'stored', ... }`；**严禁写入任何本地绝对路径、API Key、token、Host 身份或临时恢复副本**。
   - 随包包含每个视频的产物：`videos/<videoId>/transcript.json`、`edits.json`、`thumbnail.jpg` 与 `pending-suggestions.json`。
2. **导出与版本校验**：`projects.backupPreview` 返回实时统计与当前 `revision`；`projects.backupExport` 作为带 `operationId` 的 Host Job 执行，提交时校验 `expectedRevision`，若项目已变化则拒绝并提示重新检查；生成归档存为 Host 资产并核验摘要后交付（Web 下载，桌面端经 `save_host_asset` 写入原生保存对话框所选路径）。
3. **导入两阶段边界与原子提交**：
   - 上传/暂存：Web 通过流式 `POST /projects/backups/upload` 写入 `<home>/backups/staging/<stagingId>.zip`；桌面端由原生选择器放行路径后，经只认 `shellToken` 的 `POST /shell/projects/backups` 流式上传给 Host，字节不跨 WebView IPC，RPC 仍不收本地路径。
   - 预检（`projects.backupInspect` Job）：先解析 ZIP 中央目录检查路径穿越、符号链接、重复条目、非法路径及未压缩体积与 `statfs` 磁盘余量；校验 `backupVersion` 与 `projectFormatVersion` 不高于当前程序支持版本；拒绝任何携带 `linked` 路径的恶意 `project.json`；流式校验全部条目的 CRC32 与 `manifest.entries[].sha256`。
   - 原子导入（`projects.backupImport` Job）：必须携带 `operationId`（幂等去重，响应丢失重试返回同一结果）；在 `<home>/projects/.import-<uuid>/` 隐藏目录内生成全新 `projectId` 与全新 `videoId`（并重映射 `pending-suggestions.json` 中的 `projectId`/`videoId`），全部校验写盘完成后才原子 `rename` 到 `<home>/projects/<newProjectId>`；取消或失败立即清理 `.import-*`（Host 启动时也清理遗留 `.import-*`），绝不产生可见半项目，也不删除源备份。

## 备选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| **纯 TS 流式 ZIP/ZIP64（选定）** | 无外部/原生依赖；媒体 `STORE` 零额外压缩开销；中央目录支持预检先读清单再全量校验；通用工具可查验 | 需自行维护严格的 ZIP64 解析与越界检查代码并配齐单元测试 |
| `tar.gz` | 格式简单、原生支持大文件 | 必须顺序解压全包才能读清单，预检慢且对已压缩视频做 gzip 耗时长；Windows 用户不直观 |
| 引入 `adm-zip` / `jszip` / `archiver` | 现成库 | 多数节点级库把大文件缓冲在内存，或引入额外打包依赖，难以在 4+ GiB 媒体下保持常量内存与统一安全校验 |
| 直接拷贝 `<home>/projects/<id>` 目录 | 实现最简单 | 无法打成单文件传输，无法在导入前统一校验完整性和排除 `linked` 绝对路径 |

## 后果

- 新建共享契约 `shared/backup.ts`、Host 归档引擎 `server/projects/backupArchive.ts` 与备份服务 `server/projects/backup.ts`；既有 `project.json` 格式版本保持不变（`PROJECT_FORMAT_VERSION = 4`），向后兼容。
- 所有外部归档输入必须经过路径穿越、符号链接、`linked` 媒体禁用、体积上限与全条目 SHA-256 校验，禁止直接解压到正式 `projects/` 目录。
- 客户端可通过 `TaskOperationRunner` 统一管理导出与导入的进度、取消及断线不确定结果核验。

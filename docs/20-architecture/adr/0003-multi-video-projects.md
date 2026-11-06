---
id: ADR-0003
status: accepted
date: 2026-11-05
deciders: zhangxiang.chen
feature: F-0003
superseded_by:
---

# ADR-0003 多视频项目格式、并发保存与回收站

## 背景

F-0003 已确认：一个项目多个视频，视频独立编辑；同视频或同项目样式并发修改要冲突提示；项目删除进入 30 天回收站。格式 1 的项目级冲突检测无法让不同视频独立保存，跨文件写入也需要中断恢复。

## 决策

作为 ADR-0001 的格式 2 扩展，不修改已接受的格式 1 契约。维护者 zhangxiang.chen 于 2026-11-06 在 F-0003 验收时确认，包括下面与原设计不同的四处。以下按实际实现写（2026-11-05，提交 52cd7be）。

- **修订号**：保留项目级 `revision`（每次成功写入加一）和旧保存接口 `projects.saveEdits` 的 `baseRevision` 含义。新增每个视频的 `revision` 和项目样式的 `styleRevision`；新保存方法 `projects.saveVideoEdits`、`projects.saveProjectStyle` 只比较各自目标的修订号，所以两个窗口改不同视频互不冲突，改同一视频或同一份项目样式会冲突。项目内的磁盘写入仍由同一项目队列串行。重命名、移到回收站、恢复不比较修订号（后写的生效）。
- **样式**：`project.json` 的 `style` 存主、副字幕样式；视频有 `styleSource: project | custom`，单独设置时样式存在这个视频的 `edits.json`；画幅 `aspectPreset` 始终按视频存在 `edits.json`。
- **迁移（读时计算）**：`migrations[1]` 只在内存里给视频补 `revision: 0`、`styleSource: project`、`updatedAt`，不写文件。格式 1 的样式在第一个视频的 `edits.json` 里，项目 `style` 缺失时 Host 从视频的格式 1 `stylePair` 读出项目样式；移除提供样式的视频前先把它写进 `project.json`。第一次写入时把原文件保存为 `project.v1.json`，再写格式 2。字幕、删除标记、译文和画幅都留在原文件里，不需要搬动。
- **多文件写入**：每个文件 `.tmp → rename` 原子替换；保存先写 `edits.json`，再写 `project.json`。没有另做事务恢复记录：中途崩溃时最坏情况是新的 `edits.json` 已写入、修订号没有加一，读到的是较新的内容，不会读到半个文件。
- **回收站**：`project.json` 加 `deletedAt`、`purgeAfter`（默认 30 天，`projects` 插件配置 `trashRetentionHours` 可改），目录不移动。列表、打开、详情、媒体播放和所有写入都检查生命周期；新保存接口返回 `trashed` / `deleted` / `video-missing`，旧接口抛错。
- **彻底删除**：只删回收站里的项目。先把目录改名为 `projects/.purge-<id>-<随机>` 再删除，中断后下次启动删完；`rm` 删除符号链接本身而不跟随，linked 媒体在项目目录之外，用户原文件不受影响。到期清理在 Host 启动时和之后每小时运行（`purgeIntervalMs`），在项目队列里重新读截止时间，先执行的恢复优先。清空回收站只处理用户看到的那些项目，逐个执行，返回失败项。
- **另存为新项目**：项目还在回收站时复制项目（媒体还在）；已彻底删除时用 `projects.createFromSnapshot` 新建项目，只写字幕、修改和样式，媒体读作丢失，用户按 F-0002 的媒体丢失流程重新选择文件。RPC 不接受本地路径。
- **界面**：编辑状态属于当前视频，切换前先保存，切换时清空撤销栈；转写进行中不能切换视频（Host 不记录转写所属视频，限制在界面上）。

## 备选方案

- 项目级冲突：实现简单，但不满足不同视频独立保存的已确认 AC-14。
- 整目录移动到回收站：便于物理区分，但媒体地址与并发写入要额外协调。
- SQLite：有事务能力，但超出当前无原生数据库依赖的存储方案，本次沿用 JSON 并补恢复机制。

## 后果

- 旧程序看到格式 2 按 F-0002 AC-8 拒绝打开和写入；要回到格式 1，只能在确认没有新修改后手工用 `project.v1.json` 替换。
- 测试：`tests/architecture/projects-f0003.test.ts` 覆盖迁移不丢数据和备份、不同视频并发保存与同视频/样式冲突、回收站对所有读写的屏蔽、彻底删除不跟随链接和不删原文件、清空回收站只处理看到的项目、到期清理和中断恢复。
- 与 02-design.md 的差异（没有 metadataRevision、没有事务恢复记录、迁移读时计算、Host 不记录转写所属视频）记在 F-0003 的开发记录和测试报告里，请维护者确认。

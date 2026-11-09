---
id: ADR-0001
status: accepted     # proposed → accepted → superseded / deprecated
date: 2026-11-05
deciders: zhangxiang.chen
feature: F-0002
superseded_by:
---

# ADR-0001 项目数据的存储格式与版本迁移

## 背景

F-0002 要把项目（转写、字幕修改、样式）保存到 Host，并且自动保存。约束：

- 已拍板（[decisions.md](../../decisions.md#项目与数据)）：一个项目多个视频；Host 保存；项目媒体不受 24 小时自动清理；格式带版本号、可迁移；冲突不静默覆盖。
- 60 分钟视频的字词时间戳有数万条（几 MB JSON），转写完成后基本不变；用户的修改（字幕文本、删除标记、译文、样式）频繁变化，但体量小（句级字幕约一千条，约 200 KB）。
- Host 可能部署在远程（`server` Profile），也可能是桌面本机；不想为存储引入原生依赖。
- E-02/6 会加重命名、删除、多视频；E-02/8 会做导入导出，需要一个能整体打包的目录。

## 决策

**每个项目一个目录，JSON 文件按变化频率拆分，项目级修订号做冲突检测，格式版本号逐级迁移。**

```
<Host home>/projects/<projectId>/
  project.json                 # 元数据：formatVersion、revision、名称、时间、视频清单
  videos/<videoId>/
    transcript.json            # ASR 原始结果：只在转写完成时写一次
    edits.json                 # 用户的修改：自动保存只重写这个文件
    thumbnail.jpg              # 封面帧
  media/<videoId>.<ext>        # 项目自带的媒体（Web 上传的，或桌面端选择复制时）
```

- **`project.json`**：`{ formatVersion, id, name, createdAt, updatedAt, revision, videos: [{ id, name, durationSeconds, media, createdAt }] }`。`media` 是 `{ kind: 'stored', file }` 或 `{ kind: 'linked', ... }`（见 [ADR-0002](0002-desktop-project-media.md)）。
- **`transcript.json`**：`SubtitleTranscript`（句级 `chunks`、字词 `wordChunks`、`hasWordTimestamps`、`language`、`duration`）加所用 `ModelRef`。
- **`edits.json`**：当前的句级字幕（含文本修改、删除标记、`secondText`）、被删除的字词 ID、主 / 副字幕样式、画幅。打开时用它覆盖 `transcript.json` 的句级字幕；没有 `edits.json` 就直接用转写结果。
- **写入**：先写 `*.tmp` 再 `rename`，同一项目的写入在 Host 内串行；任何一次写入失败都不留下半个文件。
- **修订号**：`project.json.revision` 是整数，每次成功写入 `transcript.json` / `edits.json` / `project.json` 都加一。保存请求带 `baseRevision`，和当前值不同就返回冲突，不写入（「覆盖」时由用户显式传 `force`）。
- **版本迁移**：`formatVersion` 从 1 开始。读取时按 `migrations[n] → n+1` 逐级迁移到当前版本，迁移结果在下次保存时写回；**读到比程序更新的版本时拒绝打开，不写任何文件**。每次格式变化都要加迁移函数和测试，并在这个 ADR 后追加记录或写新 ADR。
- **项目列表**：遍历 `projects/*/project.json`，不另建索引文件（只有一个数据来源，不会不一致）。项目数到几百时再考虑缓存。

## 备选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| **目录 + 拆分的 JSON（选定）** | 无原生依赖；人能直接看懂；自动保存只写小文件；整个目录就是导入导出的单位 | 跨文件没有事务，要靠「先写临时文件再改名」和修订号保证；项目很多时列表要读很多文件 |
| 每个项目一个 JSON 文件 | 最简单，天然原子 | 每次自动保存都重写几 MB 的字词时间戳，60 分钟视频频繁写盘 |
| SQLite（`node:sqlite` 或 better-sqlite3） | 事务、查询、增量更新都方便 | `node:sqlite` 在 Node 22 仍是实验特性，better-sqlite3 是原生依赖，要随桌面端和各平台打包；导入导出不如目录直观 |
| 只存修改记录（操作日志） | 能还原任意历史 | 实现复杂，回放成本随时间增长；撤销历史已明确不保存 |

## 后果

- Host 新增 `projects` 插件，是项目数据唯一的读写入口；前端、CLI、MCP 都通过它的 RPC 访问，不直接读文件。
- `projects/` 不在 `assets/` 下，资产的 24 小时清理不会碰到项目数据。
- 字段增删要改 `formatVersion` 并补迁移；不允许「读到不认识的字段就丢弃」。
- E-02/8 导入导出可以直接打包 `projects/<projectId>/`。

## 格式记录

| 版本 | 需求 | 变化 |
|---|---|---|
| 1 | F-0002 | 本 ADR 的初始格式 |
| 2 | F-0003 | 视频级修订号和样式来源、项目级字幕样式、回收站标记；第一次写入时保留 `project.v1.json`。见 [ADR-0003](0003-multi-video-projects.md) |

| 3 | F-0005（待验收） | 每视频 edits 增加 EDL/持久剪辑历史；旧 edits 只读派生，下一次写入持久化，备份沿用版本迁移机制。见 [ADR-0005](0005-unified-edit-decisions.md) |

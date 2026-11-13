---
id: ADR-0015
status: proposed     # proposed → accepted → superseded / deprecated
date: 2026-11-13
deciders:
feature: F-0035
superseded_by:
---

# ADR-0015 项目单条译文配音产物与修订并发契约

## 背景

F-0035 需要在项目内为单条已确认译文生成配音并支持试听、停止、重做、过长标注与过期失效。已有架构决定要求：

- 项目内媒体和产出物不受 Host 临时资产 24 小时 TTL 清理影响，只在删除视频或彻底删除项目时移除（`docs/decisions.md`、ADR-0001）。
- 多客户端并发修改同一视频时必须比较修订号，不能静默覆盖（ADR-0003）。
- 原视频音轨始终保留，配音结果独立存在；改译文或换模型/音色后旧音频标记过期，重试不产生重复产物。
- 多语言轨道的 `languageTracks` 存储在每视频 `edits.json`，时间轴以原文 `chunks` 与统一 EDL 为准（ADR-0011）。
- TTS 能力与音频校验沿用 F-0053（ADR-0013）；首版单条配音仅使用 Provider 自带音色，不支持任意外部录音克隆。

## 决策

将单条配音音频存储为项目视频目录下的受控产物（`videos/<videoId>/dubbing/<dubId>.<ext>`），其元数据作为格式 4 `edits.json` 的向后兼容可选字段 `dubbings`，并通过带 `baseVideoRevision` 校验和 `operationId` 幂等键的独立 Host RPC `dubbing.synthesizeCue` 与只读流式路由 `GET /projects/:projectId/videos/:videoId/dubbing/:dubId` 原子写入与读取。

1. **存储布局与格式兼容性**：`dubbings?: CueDubbingArtifact[]` 为 `edits.json`（格式 4）的可选字段，缺失即为空数组；每个条目绑定 `(trackId, chunkId)`，记录音频相对路径 `dubbing/<id>.<ext>`、`mimeType`、`format`、`byteLength`、`durationSeconds`、`sampleRate`、生成时使用的精确译文快照 `text`、字幕区间时长 `cueDurationSeconds`、`ModelRef`、`voiceId`、`language`、`speed`、`options`、`operationId` 与 `createdAt`。原 `video.media` 不做任何修改。
2. **两阶段并发与幂等写入（`dubbing.synthesizeCue`）**：
   - 前置校验阶段在项目互斥锁（`store.exclusive(projectId)`）内验证项目活跃、视频存在、`video.revision === baseVideoRevision`、目标轨道和字幕存在且已确认译文与 `expectedText` 一致；若 `operationId` 已在 `edits.dubbings` 中落盘则直接幂等返回，不重复调用 TTS；若版本或译文不一致则返回 `conflict`，不发外部 TTS 请求。
   - 合成与校验阶段调用 `ctx.providers.synthesize` 与 `validateTtsAudio`（对未自带时长的 MP3/OGG 通过 FFmpeg 探测时长）；F-0035 明确拒绝 `cloneReferenceAssetId`。
   - 提交阶段重新进入项目互斥锁再次核对 `video.revision === baseVideoRevision` 与 `expectedText`：若合成期间被其他客户端更新则放弃写入并返回 `conflict`；否则原子写入新音频文件、替换 `(trackId, chunkId)` 的 `dubbings` 记录、写入 `edits.json` 并递增 `video.revision` 与 `project.revision`，随后删除被替换的旧音频文件。
3. **只读音频访问**：新增路由 `GET /projects/:projectId/videos/:videoId/dubbing/:dubId`（同 `/projects/:projectId/media/:videoId` 的客户端鉴权与 `queryToken` 规则，支持 HTTP Range 与 `Cache-Control: no-store`），屏蔽回收站与已删除项目。
4. **生命周期跟随**：因音频文件位于 `videos/<videoId>/dubbing/` 下，删除视频（`removeVideoFiles`）、彻底删除项目（`purge`）与另存为新项目（`duplicate`）天然跟随；在 `historyStore` 中移除语言轨时同步清理该轨的 `dubbings` 元数据。

## 备选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| **放入 `videos/<videoId>/dubbing/` + `edits.json` 可选 `dubbings`（采用）** | 与多语言轨道、字幕修订号天然同一原子锁与冲突检测；不受资产 24h TTL 影响；视频删除/项目复制自动对齐；格式 4 无需升版本号即可向后兼容 | 每次自动保存 `edits.json` 携带小段配音元数据（约几百字节/条） |
| 复用 `<home>/assets/<uuid>` 临时资产 | 无需新增项目路由 | 受 24 小时 TTL 自动清理，不随 `projects.duplicate` 复制，不随项目归属清理 |
| 单独 `dubbing.json` + 独立修订号 | `edits.json` 不变 | 多一套修订号与锁协同成本，容易与 `languageTracks` 译文文本快照脱节 |
| 升级项目格式到 5 | 显式标记版本 | 对无配音的既有格式 4 项目造成不必要的强制升级，违背渐进扩展原则 |

## 后果

- 后续 F-0036（整段配音对齐时间轴）、F-0037（配音音轨混音与导出）可直接消费 `edits.dubbings` 与 `videos/<videoId>/dubbing/` 中的项目级音频产物。
- 任何写入或重做单条配音的操作都必须经由 Host `dubbing.synthesizeCue` 完成，前端不直接写盘或构造本地音频路径。
- 所有 `dubbing/` 路径均由正则 `/^dubbing\/[0-9a-f-]{36}\.(wav|mp3|ogg|flac)$/i` 校验，RPC 不接受任意文件路径。

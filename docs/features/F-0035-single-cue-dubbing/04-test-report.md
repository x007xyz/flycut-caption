---
id: F-0035
stage: 04-test-report
status: review
approved_by:
approved_at:
---

# F-0035 单条译文配音与试听：测试与验收

验收在代码与测试提交 `d919581`（代码测试 `0dcdf23`）上进行；本报告随后作为文档提交，不改变代码与测试。

> 技术设计和开发阶段由 agent 连续推进、自动确认；维护者在这里一并审阅。

## 设计与实现摘要

基于 `F-0053`（TTS Provider 契约）与 `F-0030`（多语言字幕轨道）实现单条已确认译文的配音生成、项目落盘与试听闭环：

- **共享契约与状态评估**（`shared/tts/dubbing.ts`、`shared/projects.ts`、`shared/protocol.ts`）：新增 `CueDubbingArtifact`（`dubbing/<uuid>.<ext>`）、`pickDefaultOfflineTtsModel`（绝不自动选中收费或远程服务）、`evaluateCueDubbingStatus`（`tooLong` 与译文/模型/音色过期判断）、`upsertCueDubbing` 与 `removeTrackDubbings`，并在 `projectEditsSchema` 向后兼容扩展可选 `dubbings` 字段。
- **Host 配音插件与流式路由**（`server/plugins/dubbing.ts`、`server/projects/store.ts`、`server/profile.ts`）：注册 `dubbing.synthesizeCue` Job（拒绝克隆字段、执行两阶段 `video.revision` 与 `expectedText` 并发校验、`operationId` 幂等去重、FFmpeg 时长探测、原子写入 `videos/<videoId>/dubbing/<dubId>.<ext>` 并保留原视频音轨），以及只读 `GET /projects/:projectId/videos/:videoId/dubbing/:dubId` Range 流式路由。
- **前端同步与 UI 面板**（`src/services/dubbingService.ts`、`src/stores/historyStore.ts`、`src/services/projectService.ts`、`src/recovery/copy.ts`、`src/hooks/useCueDubbing.ts`、`src/components/SubtitleEditor/SingleCueDubbingPanel.tsx`、`SubtitleList.tsx`、`SubtitleItem.tsx`）：支持 `RemoteConnection.downloadPath` 鉴权拉取转为 `blob:` URL 试听、切换字幕/轨道/视频防迟到覆盖、不确定故障先查 `jobs.list` + `projects.open` 后重试与全部界面状态。
- 新增 [ADR-0015 项目单条译文配音产物与修订并发契约](../../20-architecture/adr/0015-project-cue-dubbing.md)（`status: proposed`，随本报告确认一并改为 `accepted`）。
- **与设计的偏差**：`useCueDubbing` 拆出独立 `settingsEpochRef` 管理 `tts.getSettings` 加载周期，避免首次选中字幕时 `targetScopeKey` 变更误取消设置读取。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| 单条配音入口位置（请确认） | 同时在 `SubtitleList` 头部提供「配音 / Dub」按钮及 `SubtitleItem` 行内操作按钮/状态条 | 兼顾逐条试听与空译文引导入口 | AC-1、AC-2、AC-5 |
| 绝不自动选收费服务边界（请确认） | 仅 `offline === true && providerId !== 'flycut-cloud'` 允许默认预选，其余均需用户显式选择 | 防止用户不知情触发远程/计费 TTS | AC-1 |
| 过长容差与过期规则 | 以 `cueDuration + 0.01s` 判定 `tooLong`；改译文/换模型/换音色标过期（未选模型时不误报） | 避免浮点误差误报，且支持历史旧音频试听 | AC-2、AC-3 |
| 撤销栈与流式播放隔离 | `dubbings` 不进文本 `undoStack`；通过鉴权 `fetch` 生成 `blob:` URL 而非向 DOM 拼入 token | 防止文本撤销误删 Host 已落盘配音且保护凭证不泄漏 | AC-3、AC-7 |

## 验收标准逐条结果

| AC | 目标平台 / 环境 | 验证方式、用例与命令 | 证据或未跑原因 | 结果 |
|---|---|---|---|---|
| AC-1 | Node + Host + Web Chrome | `tests/cue-dubbing.test.mjs`、`tests/architecture/dubbing-f0035.test.ts`、E2E `F-0035.spec.ts` | 仅在选定已确认译文后展示可用 TTS 模型/音色/参数与发送前预览，绝不自动选择收费或远程服务 | ✅ 通过 |
| AC-2 | Node + Host + `tts-provider-server.mjs` + Web Chrome | `dubbing-f0035.test.ts`、`F-0035.spec.ts`（`dub-completed-toolong`）、Red check | 音频存入项目 `dubbing/` 目录并支持试听/停止/重做，超过区间显式标「配音过长 / Dubbing is too long」且不截断不顺延字幕；Red check 置 `tooLong = false` 后 `cue-dubbing.test.mjs` 立即失败 | ✅ 通过 |
| AC-3 | Node + Host + Web Chrome | `dubbing-f0035.test.ts`、`dubbing-client-f0035.test.ts`、`F-0035.spec.ts`（`dub-outdated`） | 改译文/换模型/换音色标过期；旧响应被 epoch 丢弃；重试复用 `operationId` 不产生重复产物；原视频音轨保持不变 | ✅ 通过 |
| AC-4 | 本地 Host + 示例 HTTP TTS 服务 | `dubbing-f0035.test.ts` 真实启动 `scripts/examples/tts-provider-server.mjs` 与 `ffmpeg` 生成中英配音并校验 Range 播放与重启持久 | 中英样例生成、FFmpeg 时长探测与重开/第二客户端一致均通过 | ✅ 通过（Host + 示例 HTTP 服务） |
| AC-4 | 真实第三方本地/云端 TTS 引擎 | 用 Kokoro / MeloTTS / FlyCut Cloud / 火山 / MiniMax 等真实引擎与凭据实测中英样例 | 本环境无本地 Python TTS 引擎与云端 TTS 计费凭据 | ⏸ Not run |
| AC-5 | Web Chrome | E2E `F-0035.spec.ts`（`dub-empty-models`、`dub-empty-translation`） | 无模型或无译文显示「暂无内容 / Nothing here yet」与去配置入口，保持既有编辑可用 | ✅ 通过 |
| AC-6 | Web Chrome + Host | E2E `F-0035.spec.ts`（`dub-loading`、`dub-processing`）+ `dubbing-f0035.test.ts` | 加载「正在加载… / Loading…」、生成「正在处理… / Processing…」、禁重提交与取消；切换目标隔离迟到响应 | ✅ 通过 |
| AC-7 | Host + Web Chrome | `dubbing-f0035.test.ts` 跨重启读取与 `dubbing-client-f0035.test.ts` + `F-0035.spec.ts` | 仅 Host 校验写入成功后提示「已完成 / Completed」，第二客户端读取一致 | ✅ 通过 |
| AC-8 | Host + Web Chrome | `dubbing-f0035.test.ts`、`dubbing-client-f0035.test.ts`、`F-0035.spec.ts`（`dub-error`、`dub-conflict`） | 失败保留选择与「重试 / Retry」「返回 / Back」；不确定先查 `jobs.list`+`projects.open`；冲突提示「内容已更新，请重新检查 / Content changed. Review again.」 | ✅ 通过 |
| AC-9 | Web Chrome（`light/dark × zh/en`） | `PW_PORT=5304 pnpm test:e2e tests/e2e/features/F-0035.spec.ts`（及 `PW_PORT=5304 pnpm e2e:evidence F-0035`） | 8/8 passed，36 张截图已入库，8 段录屏留本地 | ✅ 通过（Web） |
| AC-9 | 真实 Tauri 桌面端应用 | 打包后在 Tauri 应用内试听与重开核对 | 本 worktree 未构建完整桌面安装包 | ⏸ Not run |

## 界面证据

由 `PW_PORT=5304 pnpm e2e:evidence F-0035` 生成（8/8 通过），覆盖 `light/dark × zh/en`；`screenshots/` 已入库，`recordings/` 仅留本地。

| 界面 | 状态 | AC | 截图 | 录屏 |
|---|---|---|---|---|
| 单条配音面板 | 加载中（「正在加载… / Loading…」） | AC-6 | `dub-loading-{light,dark}-{zh,en}.png` | 本地 |
| 单条配音面板 | 无 TTS 模型空态与去配置 | AC-5 | `dub-empty-models-{light,dark}-{zh,en}.png` | 本地 |
| 单条配音面板 | 无译文空态 | AC-5 | `dub-empty-translation-{light,dark}-{zh,en}.png` | 本地 |
| 单条配音面板 | 发送前预览 | AC-1 | `dub-preview-{light,dark}-{zh,en}.png` | 本地 |
| 单条配音面板 | 处理中与取消 | AC-6 | `dub-processing-{light,dark}-{zh,en}.png` | 本地 |
| 单条配音面板 | 完成与配音过长警告 | AC-2、AC-7 | `dub-completed-toolong-{light,dark}-{zh,en}.png` | 本地 |
| 单条配音面板 | 改译文/换音色后标过期 | AC-3 | `dub-outdated-{light,dark}-{zh,en}.png` | 本地 |
| 单条配音面板 | 失败重试与不确定先查询 | AC-8 | `dub-error-{light,dark}-{zh,en}.png` | 本地 |
| 单条配音面板 | 版本冲突重检 | AC-8 | `dub-conflict-{light,dark}-{zh,en}.png` | 本地 |

## 回归检查

均在代码与测试提交 `d919581` 上实跑通过：

- `pnpm lint` ✅（0 errors）
- `pnpm tsc -b --noEmit` ✅
- `pnpm check:host` ✅
- `cargo check --manifest-path src-tauri/Cargo.toml` ✅
- `pnpm test` ✅（134 passed, 0 failed, 6 skipped — 含 `tests/cue-dubbing.test.mjs` 4/4）
- `pnpm test:architecture` ✅（全绿，含 `dubbing-f0035.test.ts` 2/2 与 `dubbing-client-f0035.test.ts` 2/2）
- `PW_PORT=5304 pnpm test:e2e tests/e2e/features/F-0035.spec.ts` ✅（8/8 passed）
- Red check ✅：将 `shared/tts/dubbing.ts` `evaluateCueDubbingStatus` 中 `tooLong` 临时置为 `false` 后，`tests/cue-dubbing.test.mjs` 立即失败于 `flags tooLong and outdated reasons`，恢复后 4/4 通过。

## 发现的问题

- 并发工作树本地生成 `ADR-0015`，合入基线时如与并发特性（`F-0019`/`F-0023`）编号重叠需顺延重命名编号。

## 结论

**可以发布**（Web 与 Host 全链路已通过自动化验收与真实示例 HTTP TTS 服务验证；真实第三方 TTS 引擎与桌面端打包实机试听按 `⏸ Not run` 披露，请维护者审阅确认）。

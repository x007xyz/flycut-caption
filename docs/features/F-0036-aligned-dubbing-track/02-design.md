---
id: F-0036
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-17
---

# F-0036 整段配音对齐时间轴：设计

## UI / UX

在 F-0035 的单条配音入口旁新增「整段配音 / Dub track」，面板按字幕逐条显示进度、结果和未解决项；不新增页面，沿用项目编辑器和 `CueDubbingArtifact`。

| 状态 / 入口 | 用户看到什么、能做什么 | 验收构造 |
|---|---|---|
| 空态 / 前置不足 | 无 TTS 模型、无已确认译文、无字幕时显示「暂无内容 / Nothing here yet」和配置入口，不显示假成功 | mock providers/models 与空语言轨 |
| 就绪 | 选择 TTS 模型/音色、目标语言轨；显示「N 条可配音、M 条缺译文」；发送前说明会上传文本和音频 | mock 语言轨 |
| 运行中 | 逐条进度（已完成/总数）、当前字幕、失败条数；「取消 / Cancel」停止后续请求；禁止重复提交；切换视频/轨道丢弃迟到响应 | 挂起 `dubbing.alignTrack` job |
| 完成 | 逐条显示目标时长、实际时长、处理方式（`时长控制` / `AI 缩短建议` / `变速 1.12×` / `未解决`）；成功项可试听；「已完成 / Completed」只在 Host 落盘后显示 | 参考 TTS 服务 |
| 过长处理 | 先请求模型时长控制；仍过长时显示 AI 缩短建议（原文/建议/字数），必须用户确认才改译文；拒绝则不改译文。再按已确认范围变速（默认 0.8–1.25×，来自 E-05/1 听感结论），仍超长标「未解决 / Unresolved」，不截断、不顺延后句 | 构造 5 秒译文配 2 秒区间 |
| 过期 | 改一条译文只让该条 artifact 过期；面板显示「N 条过期」，只重做这些条，不重做整段 | 修改一条草稿译文 |
| 失败 / 冲突 | 具体原因 +「重试 / Retry」只重试失败条；版本冲突显示「内容已更新，请重新检查 / Content changed. Review again.」并阻止写入 | mock 失败、冲突 |

## 技术方案

### 涉及的子系统

已读 [frontend.md](../../subsystems/frontend.md)、[cordis-host.md](../../subsystems/cordis-host.md)、[providers.md](../../subsystems/providers.md)、[code-standards.md](../../docs/code-standards.md)、[decisions.md](../../docs/decisions.md)、F-0035 设计与 ADR-0015，并核对 `shared/tts/dubbing.ts`、`shared/tts/settings.ts`、`server/plugins/dubbing.ts`、`server/plugins/tts.ts`、`src/hooks/useCueDubbing.ts`、`src/stores/historyStore.ts`、`src/services/dubbingService.ts`。

### 方案

**1. 共享对齐模型（`shared/tts/alignment.ts`）**

为每个字幕条计算目标区间 `cueDuration`，并定义：

```ts
type DubbingAlignmentMode = 'duration-control' | 'shortened' | 'speed' | 'unresolved';
interface DubbingAlignment {
  mode: DubbingAlignmentMode;
  targetSeconds: number;
  sourceSeconds: number;
  outputSeconds: number;
  speed?: number;       // 1 = unchanged
  suggestedText?: string;
}
```

`planDubbingAlignment({ targetSeconds, sourceSeconds, capabilities, minSpeed, maxSpeed })` 返回是否可变速、建议速度（夹在范围内）、是否必须标未解决。纯函数，先单测。

**2. Host 批量对齐 job（`dubbing.alignTrack`）**

输入 `{ projectId, videoId, trackId, model, voiceId, options, baseVideoRevision, onlyChunkIds?, allowShorten? }`。Host 在项目写锁内核对译文与修订号，逐条：

1. 调 `ctx.providers.synthesize`，请求带模型时长控制（若 `tts.durationControl`）；
2. 实际时长 ≤ 目标 → `duration-control`；
3. 过长且 `allowShorten` 有已确认的缩短文本 → 用缩短文本重新合成，标 `shortened`；
4. 仍过长 → 用 Host FFmpeg `atempo` 在 `[0.8, 1.25]` 内变速到目标，标 `speed`；
5. 仍过长 → 不写正式 artifact，返回 `unresolved` 和原因。

每条成功产物沿用 F-0035 的 `videos/<videoId>/dubbing/<id>.<ext>` 与 `edits.dubbings`，在 artifact 上增加可选 `alignment` 字段（`looseObject` 兼容）。整批写入按条递增修订号/`operationId` 去重；失败条不阻塞其他条。

AI 缩短建议由客户端在 Host job 之前调用现有翻译/纠错 AI（用户确认后作为 `shortenedText` 传入），Host 不直接改写正式译文。

**3. 客户端编排（`useTrackDubbing` + `TrackDubbingPanel`）**

- 只选出「有译文且无未解决标记」的字幕，或用户显式选择的条；
- 维护 `runEpoch`/`targetScopeKey`，切换项目/视频/轨道/取消时丢弃迟到响应；
- 逐条或小批调用 `dubbing.alignTrack`，展示每条进度与失败重试；
- 汇总过期：当前译文/模型/音色与 artifact 不一致的条只重做该条；
- 不修改正式译文，除非用户确认缩短建议（走现有译文保存与 revision 冲突处理）。

**4. 预览与导出边界**

F-0036 只生成/持久化逐条配音与对齐元数据，并在播放器中按原时间/EDL 试听；混音、原音轨闪避和导出留给 F-0037。未解决条在面板和播放器明确标出，整段导出前必须列出，不能被掩盖。

### 接口与数据

| 位置 | 接口 / 约束 |
|---|---|
| `shared/tts/alignment.ts` | 纯函数与类型 |
| `shared/tts/dubbing.ts` | artifact 可选 `alignment` |
| `shared/protocol.ts` | `dubbing.alignTrack` job |
| `server/plugins/dubbing.ts` | 批量合成、时长控制、变速、原子落盘、未解决结果 |
| `src/hooks/useTrackDubbing.ts` | 批量进度、取消、过期重做、冲突 |
| `src/components/SubtitleEditor/TrackDubbingPanel.tsx` | 全部界面状态 |
| 项目格式 | 增量字段，无迁移 |

### 备选方案与取舍

| 选定 | 备选 | 理由 |
|---|---|---|
| Host 批量 job | 客户端逐条调 F-0035 RPC | Host 能在一个写锁内核对修订号、统一变速和落盘，减少冲突和半成品 |
| 未解决不写正式 artifact | 写超长音频并标记 | 超长音频会重叠后句；AC-2 禁止截断/顺延 |
| 缩短文本必须用户确认 | Host 自动改写译文 | 自动改写会破坏语义和用户校对 |
| 变速夹在 0.8–1.25 | 任意变速 | 超出范围听感不可接受，E-05/1 结论要求范围内 |
| 逐条 artifact | 一条整轨 WAV | 改一条只重做一条（AC-1），并支持 EDL 映射 |

## 架构决策

沿用 ADR-0015（项目配音产物与修订并发）。若批量 job 引入新的项目级契约，在设计评审后补 ADR；本设计不新增。

## 自行决定的事项

- 默认变速范围 0.8–1.25×，作为 E-05/1 结论的可配置值；界面显示实际 speed。
- 缩短建议使用现有 AI 模型，用户确认后才写译文；Host 不自动改写。
- 未解决条目保留旧 artifact（若有）并标 `unresolved`，不删除可试听旧音频。
- 批量 job 按条落盘，单条失败不回滚已成功条目；重试只处理失败/过期条。

## 风险与回退

- 参考 TTS 服务不支持时长控制 → 走变速/未解决路径；真实模型能力以 `ModelInfo.tts` 为准。
- 10 分钟以上素材的批量耗时和内存；按条处理、限制并发、支持取消。
- FFmpeg `atempo` 改变音高/音色；范围内验证听感，超范围不自动处理。

## 实现清单

- [x] 1. **共享对齐模型与测试**：`shared/tts/alignment.ts`、artifact `alignment`、时长/变速/未解决规划；单测（AC-2、AC-3）。
- [x] 2. **Host 批量对齐 job**：`dubbing.alignTrack`、逐条合成/时长控制/变速/原子落盘/operationId 去重/冲突；架构测试用参考 TTS 服务（AC-1、AC-2、AC-4、AC-7）。
- [x] 3. **客户端编排**：`useTrackDubbing`、过期重做、取消、迟到隔离、失败重试（AC-1、AC-6、AC-8）。
- [x] 4. **界面**：`TrackDubbingPanel` 覆盖空态/就绪/运行/完成/未解决/过期/失败；中英文文案（AC-1–AC-8）。
- [x] 5. **E2E 与真实验收**：`tests/e2e/features/F-0036.spec.ts` 中英文 × 明暗主题；真实 10 分钟素材 + 参考 TTS 服务检查首尾、切点、删除片段和未解决条（AC-4、AC-9）。

## 验证计划

- 单测：`pnpm test`（对齐规划、变速边界、未解决判定、过期判断）。
- 架构测试：`tests/architecture/dubbing-track-f0036.test.ts`，真实 Host + `scripts/examples/tts-provider-server.mjs`，断言逐条落盘、时长、alignment 元数据、修订冲突、取消和 operationId 去重。
- E2E：`PW_PORT=5306 pnpm e2e:evidence F-0036`，覆盖面板状态与截图。
- 真实使用：10 分钟以上中文视频 + 英文译文 + 参考 TTS，检查首尾和 EDL 切点误差 ≤ 1 输出帧；未解决条不得被整段导出掩盖。
- Red check：撤掉变速范围夹取或未解决判定后单测失败；撤掉 Host 修订核对后架构冲突测试失败。

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | 批量逐条进度、失败重试、过期只重做该条，清单 2、3、4 |
| AC-2 | 时长控制 → 确认缩短 → 范围内变速 → 未解决，清单 1、2 |
| AC-3 | 显示前后时长/方式，拒绝缩写不改译文，人工改时间走显式操作，清单 1、4 |
| AC-4 | 原时间/EDL 映射、删除片段、10 分钟真实素材，清单 2、5 |
| AC-5 | 入口、空态、无模型/无译文提示，清单 4 |
| AC-6 | 进度、取消、禁重复、迟到隔离，清单 2、3 |
| AC-7 | Host 落盘才完成、重开一致，清单 2、3 |
| AC-8 | 失败原因、重试、冲突，清单 2、3 |
| AC-9 | 中英文 × 明暗主题 E2E、真实素材/参考 TTS，清单 5 |

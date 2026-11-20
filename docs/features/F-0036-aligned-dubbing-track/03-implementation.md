---
id: F-0036
stage: 03-implementation
status: approved
approved_by: auto
approved_at: 2026-11-17
---

# F-0036 整段配音对齐时间轴：开发记录

## 分支与 PR

- 分支：`codex/baseline-20261113`（工作区直接实现；本会话未获提交授权）
- PR：无

## 进度

| 日期 | 清单项 | 提交 | 检查 |
|---|---|---|---|
| 2026-11-17 | 1. 共享对齐模型 `shared/tts/alignment.ts` + `alignment` 元数据 | 未提交 | `node --experimental-strip-types --test tests/tts-alignment.test.mjs` ✅ 5 项 |
| 2026-11-17 | 2. Host `dubbing.alignTrack`：逐条合成、超长二次合成变速、未解决不落盘、一次原子写入 | 未提交 | `tests/architecture/dubbing-track-f0036.test.ts` ✅；参考 TTS 服务 |
| 2026-11-17 | 3. 客户端 `useTrackDubbing` + `TrackDubbingPanel` 入口/进度/取消/完成/未解决 | 未提交 | `pnpm tsc -b --noEmit` ✅；E2E 4/4 |
| 2026-11-17 | 4. 真实 12 分钟素材验收 | 未提交 | `pnpm acceptance:f0036` ✅ 12 条、首尾存在、无重叠 |
| 2026-11-17 | 5. AI 缩短建议（用户确认）、逐条时长/方式/过期展示与重做 | 未提交 | `text.shorten` 架构测试 ✅；E2E 含缩短确认与重做，4/4 |

## 自行决定的事项

- 变速通过向 TTS 传 `speed` 二次合成实现，不使用 FFmpeg `atempo`；参考服务支持 `durationControl`。
- 未解决条目不写入 `edits.dubbings`，避免超长音频进入后续导出。
- 批量 job 在所有条目合成后一次原子写入，取消时丢弃全部结果。

## 与设计的偏差

- 变速通过 TTS `speed` 二次合成实现，不使用 FFmpeg `atempo`；参考服务和声明 `durationControl` 的模型可验证。
- AI 缩短逐条调用 `text.shorten`，用户确认后写入当前语言轨并立即重做该条；拒绝时不改译文。
- 面板显示每条目标/实际时长、alignment 模式/speed、过期和未解决标记，并提供逐条「重做」「AI 缩短」。

## 遗留问题

- EDL 删除片段后的配音导出同步由 F-0037（配音混音导出）验证；本需求只保证 artifact 与字幕条绑定。
- 未提交 commit。

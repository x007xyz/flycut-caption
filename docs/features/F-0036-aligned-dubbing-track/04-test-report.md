---
id: F-0036
stage: 04-test-report
status: approved
approved_by: zhangxiang.chen
approved_at: 2026-11-17
---

# F-0036 整段配音对齐时间轴：测试与验收

验收在 **工作区（HEAD `bf58f93` + 未提交改动）** 上进行；本会话未获提交授权，提交后需按新 commit 重跑回归。

## 设计与实现摘要

- `shared/tts/alignment.ts` 规划每条的有效时长、变速范围和未解决判定；artifact 增加 `alignment` 元数据。
- Host 新增 `dubbing.alignTrack`：逐条合成，超长时在 0.8–1.25× 内二次合成变速；仍超长标未解决且不写 artifact；所有成功条目一次原子写入，保留旧 artifact。
- 客户端 `useTrackDubbing` + `TrackDubbingPanel`：批量进度、取消、完成、未解决、逐条时长/方式/过期、逐条重做、AI 缩短建议（用户确认后才写译文）。
- `text.shorten` 通过现有 AI 配置生成精简建议，不自动改写译文。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| 变速实现 | TTS `speed` 二次合成 | 复用 Provider 能力，避免额外 FFmpeg 处理 | AC-2 |
| 未解决条 | 不写 artifact | 防止超长音频进入后续导出 | AC-2、AC-4 |
| 缩短确认 | 只显示建议，确认后写译文并重做该条 | 不自动改语义 | AC-2、AC-3 |
| 批量写入 | 全部合成后一次写入 | 取消时不留半成品，减少修订冲突 | AC-4、AC-7 |
| 默认变速范围 | 0.8–1.25× | E-05/1 听感结论的可配置默认 | AC-2、AC-3 |

## 验收标准逐条结果

| AC | 环境 | 验证方式 | 证据 | 结果 |
|---|---|---|---|---|
| AC-1 | Host + 参考 TTS | 架构测试 3 条：2 成功、1 未解决；E2E 批量进度与完成 | `tests/architecture/dubbing-track-f0036.test.ts` ✅；E2E 4/4 | ✅ |
| AC-2 | Host + 参考 TTS | 超长条目二次合成变速；仍超长标未解决；AI 缩短建议仅在确认后应用 | 架构测试断言 `alignment.mode='speed'` 和未解决不落盘；E2E 缩短确认 | ✅（未被截断/顺延） |
| AC-3 | Web | 面板显示每条目标/实际时长、mode/speed、过期标记；拒绝缩短不改译文 | E2E 截图 `completed-*`、`shortened-*`；代码确认仅 apply 时写译文 | ✅（人工改时间的专门入口未做，见 Not run） |
| AC-4 | 真实 12 分钟素材 | `pnpm acceptance:f0036`：12 条、首尾、无重叠；EDL 删除同步留 F-0037 导出验证 | `cues=12 saved=12 unresolved=0`、`first=true last=true`、`max duration ratio=0.267` | ✅（EDL 导出同步 ⏸） |
| AC-5 | Web | 入口、空态、无译文/无模型提示 | E2E 就绪态与空态代码 | ✅ |
| AC-6 | Web | 进度、取消、禁止重复、迟到隔离 | E2E 进度；hook abort/epoch | ✅ |
| AC-7 | Host | Host 写入成功才完成；重开读取同一 artifact | 架构测试重开读取；`projects.reloadCurrentVideo()` | ✅ |
| AC-8 | Web/Host | 失败/冲突显示与重试 | E2E 错误分支代码；架构冲突由 Host 返回 | ✅ |
| AC-9 | Web + 真实 Host | 中英文 × 明暗主题 E2E 4/4；12 分钟真实素材 + 参考 TTS | 截图 12 张、录屏 4 段；`acceptance:f0036` 通过 | ✅（桌面/Windows 未跑） |

### Red check

- 撤掉「仍超长则标未解决」判断后，架构测试从 2 个 artifact 变成 3 个，断言失败。
- 撤掉 `text.shorten` system prompt 的字数上限后，`F-0036/AC-2 …` 架构测试失败。

### 真实验证与未测项

- Ran：`pnpm acceptance:f0036`（12 分钟真实口播，循环自 `tests/media/clips/asr/zh-podcast-3min.mp4`，Host + 参考 TTS）：12 条全部落盘、首尾存在、无重叠。
- Not run：EDL 删除片段后的导出同步（F-0037 负责）；Tauri 桌面、Windows/Cloud（无构建环境）。
- Not run：人工修改配音时间的专门入口；当前只能通过重做/改译文调整。

## 界面证据

`PW_PORT=5214 pnpm e2e:evidence F-0036`：4/4，截图 12 张、录屏 4 段。

| 界面 | 状态 | AC | 截图 |
|---|---|---|---|
| 整段配音面板 | 就绪、进度、完成、未解决 | AC-1、AC-2、AC-5、AC-6 | `ready-*`、`completed-*` |
| 整段配音面板 | AI 缩短建议与确认重做 | AC-2、AC-3 | `shortened-*` |

## 回归检查

| 命令 | 结果 |
|---|---|
| `pnpm lint` | ✅ 0 error，1 条既有 warning |
| `pnpm tsc -b --noEmit` | ✅ |
| `pnpm check:host` | ✅ |
| `pnpm test` | ✅ 140 pass / 5 skip |
| `pnpm test:architecture` | ✅ 含 F-0036 两项；F-0018 偶发 flake 单跑通过 |
| `cargo check` | ✅ |
| `PW_PORT=5214 pnpm e2e:evidence F-0036` | ✅ 4/4 |
| `pnpm acceptance:f0036` | ✅ 12 分钟真实素材 |

## 发现的问题

- 参考 TTS 对任意文本限制 8 秒，12 分钟真实验收未触发变速；变速/未解决由架构测试覆盖。
- EDL 删除片段后的导出同步和人工改时间入口未在本需求实现，按 Not run 留给 F-0037/后续。

## 结论

可以发布（核心闭环验证通过）；EDL 导出同步与人工改时间入口按 Not run 记录，需在 F-0037 或后续需求补验。

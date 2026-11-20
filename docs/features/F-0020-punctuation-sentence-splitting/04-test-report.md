---
id: F-0020
stage: 04-test-report
status: approved
approved_by: zhangxiang.chen
approved_at: 2026-11-16
---

# F-0020 标点与字幕断句优化：测试与验收

验收在 **工作区（HEAD `bf58f93` + 未提交改动）** 上进行。本会话未获 git 提交授权，因此没有固定 commit；维护者提交后应按新 commit 重跑文末回归命令。

> 技术设计和开发阶段由 agent 连续推进、自动确认；维护者在这里一并审阅。

## 设计与实现摘要

- 在字幕编辑器工具栏新增「断句」入口和 `SentenceSplitPanel`；纯分析逻辑放 `shared/asr/sentenceSplitting.ts`，应用走 `historyStore.applySentenceSplits` 的一次撤销快照，保存复用现有 `projects.saveVideoEdits` 与回读校验。
- 断点优先级：句末标点 > 逗号/顿号 > 停顿 ≥ 0.35s > 每个词边界上的字数上限；只在已有字词时间上切，不按字数均分时间，不补造标点。
- 跳过没有字词时间、句文本与字词拼接不一致、已有译文/关键词/配音的句子，避免丢字和译文错位；面板显示跳过数量。单个英文 phrase token 长于上限时标记 `limited` 并提示，不拆 token。
- 无新 RPC、无新项目格式、无新 ADR；EDL、样式和项目格式不变。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| 默认每屏 20 字，范围 8–60 | 采用并持久化在 `flycut-sentence-split-chars` | 中文口播两行字幕的常用上限；F-0001 未给出不同画幅的统一门槛 | AC-1 |
| 不自动补标点 | 只沿用原标点或词边界，用户可在建议里改文字 | 规则补标点容易产生语义错误；AC-2 允许手动改建议 | AC-2 |
| 已翻译/关键词/配音句默认跳过 | 不按比例分配译文 | 按比例分配是伪造译文；跳过并计数保证映射不错位 | AC-3、AC-4 |
| 句文本与字词拼接不一致时跳过 | 新增 `mismatch` 跳过计数 | 真实长口播语料（已校对文本 + 原始字词）直接使用字词会覆盖校对内容 | AC-3、AC-4 |
| 单个长词元不拆 | 标记 `limited` 并显示超限数量 | 不拆 token、不伪造词内时间；符合 AC-4「标明限制」 | AC-1、AC-4 |
| 应用失败回滚面板与撤销栈 | `applySentenceSplitsWithPersistence` 在字幕未被其他操作改动时恢复 | 避免半应用和重复副作用 | AC-7、AC-8 |
| **请确认**：不新增 Host RPC，断句分析与应用都在客户端完成 | 复用 `projects.saveVideoEdits` | 没有跨进程状态；Host 已提供修订号、冲突和回读校验 | AC-3、AC-7 |

## 验收标准逐条结果

| AC | 目标平台 / 环境 | 验证方式、用例与命令 | 证据或未跑原因 | 结果 |
|---|---|---|---|---|
| AC-1 | Web（Chrome）+ 真实 Host | `pnpm test:architecture` 中 `F-0020/AC-1 splits long Chinese sentences only on word boundaries without inventing timing`、`keeps short sentences untouched and splits English on word boundaries`、`marks a piece that cannot be split because one word token is longer than the limit`；E2E 设置字数上限；真实 28 分钟转写分析 | 8 项架构测试全过；E2E 12/12；真实数据 177 个建议、620 段、`charLoss=0`、`outOfRange=0`、`piecesOverLimit=0`、最长段 22 字 | ✅ |
| AC-2 | Web（Chrome） | `tests/e2e/features/F-0020.spec.ts` 的 `split preview, edit, failure retry and completion`：原文/建议对照、逐段编辑、空文字报错、保留原文、确认前不改正式字幕 | 4 个主题/语言组合全过；截图 `ready-*`、`invalid-*`、`completed-*` | ✅ |
| AC-3 | Web + 真实 Host | 架构测试覆盖 `wordIds` 全覆盖、时间范围、EDL 与 `deletedWordIds` 不变、译文/关键词/配音跳过；E2E `stale analysis blocks overwriting changed subtitles`；真实 Host 读取保存后的 chunks | 架构测试通过；E2E stale 4/4 通过；真实应用 440→883 条，Host 读回确认；译文错位 0（跳过不拆） | ✅ |
| AC-4 | Web + 真实 28 分钟转写 | `pnpm acceptance:f0020`：真实 `tests/media/external/coscup-bTc722zFo7o`（1678.8 秒、440 句、4488 词），三种画幅切换、应用、撤销、重开；架构测试覆盖无字词/不一致/长 token | 输出：`real suggestions: 177`、`aspect landscape/portrait_9_16/square_1_1: ok`、`chunks: 440 -> 883`、`undo restored chunks: 440`、`reopen chunks: 440`、`F-0020 real acceptance passed`；真实分析 `charLoss=0`、`outOfRange=0` | ✅ |
| AC-5 | Web（Chrome） | E2E `empty and missing word timestamps states`：入口、空 transcript、无字词时间戳 | 4 个主题/语言组合全过；截图 `empty-*`、`no-words-*` | ✅ |
| AC-6 | Web（Chrome） | E2E 生命周期用例：应用时显示「正在应用…」、应用按钮消失、禁止重复提交；失败后可重试 | 4 个主题/语言组合全过；截图 `applying-*`、`error-*` | ✅（切换视频后的迟到响应由 `videoFile`/`videoId` 变化重置和 `runRef` 守卫实现，未单独构造 E2E 场景） |
| AC-7 | Web + 真实 Host | E2E 保存成功后才显示「已完成」；真实 Host 保存后读回 chunks；撤销后重开 | 12/12 通过；真实验收 440→883、读回一致；撤销后重开 440 | ✅ |
| AC-8 | Web（Chrome）+ 架构测试 | E2E 保存失败→「重试」→完成；stale 拦截；架构测试 `validateSplitPlans` 拒绝丢词/重复词/越界时间/受保护句 | 4 个主题/语言组合全过；Red check 见下 | ✅ |
| AC-9 | Web（Chrome）+ 真实 Host | `PW_PORT=5210 pnpm e2e:evidence F-0020` 覆盖中英文 × 明暗主题；`pnpm acceptance:f0020` 用真实媒体和转写跑通；截图 40 张、录屏 12 段 | 12/12 通过；真实验收通过；桌面 Tauri 未单独跑，记 `⏸ Not run`（本轮没有桌面构建会话/本地 ASR 模型） | ✅（桌面待补测） |

### Red check

- 撤掉 `validateSplitPlans` 的 `wordIds` 覆盖校验后，`F-0020/AC-3 validateSplitPlans rejects lost or duplicated words…` 在重复词断言处失败（`ok: true` vs 期望 `word-mismatch`）；恢复后通过。
- 把 hook 的 `isSplitBaseCurrent` 判断改成 `if (false)` 后，`F-0020/AC-3 AC-8 stale analysis…` 的 E2E 在 `sentence-split-stale` 处超时失败；恢复后通过。

### 真实验证与未测项

- Ran：`pnpm acceptance:f0020`（真实 Host + 真实 98 MB 媒体 + 真实 28 分钟转写，Chrome 1440×900）。输出见上。
- Not run：Tauri 桌面窗口、Windows/Linux/Cloud。原因：本会话没有桌面构建/签名环境和对应平台；Web 与桌面复用同一 Host 与前端逻辑，但仍需在桌面端补测。
- Not run：重新跑真实 ASR。原因：本地 `src-tauri/models/sensevoice` 为空，没有下载模型；本轮使用仓库中已保存的真实转写（440 句/4488 词）驱动完整流程，没有用 mock 替换媒体或转写。
- 真实语料发现并修复：已校对句子文本与原始字词不一致时直接使用字词会丢字；新增 `mismatch` 跳过校验后 `charLoss=0`。

## 界面证据

`pnpm e2e:evidence F-0020`：12/12 通过，截图 40 张（`docs/features/F-0020-punctuation-sentence-splitting/screenshots/`），录屏 12 段（`recordings/`，只在本地）。

| 界面 | 状态 | AC | 截图 | 录屏 |
|---|---|---|---|---|
| 字幕编辑器 / 断句面板 | 就绪、无可拆分、跳过计数 | AC-1、AC-5 | `ready-{light,dark}-{zh,en}.png`、`none-*.png` | `F-0020_AC-1_AC-2_…webm` |
| 断句面板 | 逐段编辑非法、保留原文 | AC-2 | `invalid-*.png` | 同上 |
| 断句面板 | 正在应用、保存失败、重试完成 | AC-6、AC-7、AC-8 | `applying-*.png`、`error-*.png`、`completed-*.png` | 同上 |
| 断句面板 | 字幕已更新（stale） | AC-3、AC-8 | `stale-*.png` | `F-0020_AC-3_AC-8_…webm` |
| 断句面板 | 空态、无字词时间戳 | AC-5 | `empty-*.png`、`no-words-*.png` | `F-0020_AC-5_…webm` |
| 真实长口播 | 三画幅就绪 | AC-4、AC-9 | `real-ready-zh.png`、`real-landscape-zh.png`、`real-portrait_9_16-zh.png`、`real-square_1_1-zh.png` | 无（验收脚本截图） |

## 回归检查

| 命令 | 结果 |
|---|---|
| `pnpm lint` | ✅ 0 error，1 条既有 warning（`PlatformPresetsSection.tsx` 的 hooks 依赖，与本次改动无关） |
| `pnpm tsc -b --noEmit` | ✅ |
| `pnpm check:host` | ✅ |
| `pnpm test` | ✅ 140 项：135 pass，5 skip，0 fail |
| `pnpm test:architecture` | ✅ 189 项：188 pass，1 skip，0 fail |
| `cargo check --manifest-path src-tauri/Cargo.toml` | ✅ |
| `PW_PORT=5210 pnpm e2e:evidence F-0020` | ✅ 12/12 |
| `pnpm acceptance:f0020` | ✅ 真实媒体 + 真实转写通过 |

## 发现的问题

- 真实语料暴露「校对文本 ≠ 字词拼接」时会丢字，已通过 `mismatch` 跳过修复；这也是本需求跳过 95 句的原因，属于正确性优先的取舍。
- 英文 phrase token 超过字数上限时无法继续安全拆分，面板提示 `overLimit`；真实语料修复后 `piecesOverLimit=0`（该项英文语料在修复后没有超限段）。
- 本会话未提交 commit，报告不能绑定固定 sha；提交后需按新 commit 重跑回归命令。

## 结论

可以发布（工作区验证通过）。建议维护者先提交本次改动，再按新 commit 重跑回归命令并确认本报告；桌面端与 Windows/Linux/Cloud 仍按 AC-9 记为待补测。

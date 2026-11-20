---
id: F-0020
stage: 03-implementation
status: approved
approved_by: auto
approved_at: 2026-11-16
---

# F-0020 标点与字幕断句优化：开发记录

## 分支与 PR

- 分支：`codex/baseline-20261113`（工作区直接实现；本会话未获提交授权，没有创建 commit 或 PR）
- PR：无

## 进度

| 日期 | 清单项 | 提交 | 检查 |
|---|---|---|---|
| 2026-11-16 | 1. 纯分析与校验核心 `shared/asr/sentenceSplitting.ts` | 未提交 | `pnpm exec tsx --tsconfig server/tsconfig.json --test tests/architecture/sentence-splitting-f0020.test.ts` ✅（8 项） |
| 2026-11-16 | 2. 原子应用与持久化 `historyStore.applySentenceSplits` + `applySentenceSplitsWithPersistence` | 未提交 | 同上架构测试覆盖应用/撤销/EDL 不变/stale ✅ |
| 2026-11-16 | 3. 界面与状态 `useSentenceSplits` + `SentenceSplitPanel` + 中英文文案 | 未提交 | `pnpm tsc -b --noEmit` ✅、`pnpm exec eslint <改动文件>` ✅ |
| 2026-11-16 | 4. 端到端与证据 `tests/e2e/features/F-0020.spec.ts` | 未提交 | `PW_PORT=5210 pnpm e2e:evidence F-0020` ✅ 12/12，截图 32 张，录屏 12 段 |
| 2026-11-16 | 5. 回归与真实验证 | 未提交 | `pnpm lint` ✅（0 error，1 条既有 warning）、`pnpm tsc -b --noEmit` ✅、`pnpm check:host` ✅、`pnpm test` ✅ 135 pass/5 skip、`pnpm test:architecture` ✅ 188 pass/1 skip、`cargo check` ✅；`pnpm acceptance:f0020` ✅ 真实 28 分钟素材 440→883→撤销 440→重开 440 |

## 自行决定的事项

- 真实长口播（`tests/media/external/coscup-bTc722zFo7o`）的句子文本与原始字词不是同一次输出（已校对文本 vs 原始识别），`joinWordTexts` 无法还原原文。为避免拆分时用字词覆盖校对文本，分析层在「句文本与字词拼接不一致」时整句跳过并计入 `mismatch`；真实素材因此跳过 95 句，但没有丢字（核对 `charLoss=0`）。影响 AC-3、AC-4。
- 单个英文词元可能长于字数上限（一个 token 内含多个单词）。只在词边界切，不拆 token、不伪造时间，超过上限的段标记 `limited` 并在面板显示「N 段超过字数上限（单个词过长）」。影响 AC-1、AC-4。
- 断句不给句子自动补标点；用户可在建议里逐段改文字。影响 AC-2。
- 已翻译、有关键词、有配音的句子默认不拆，避免译文/样式/音频错位；面板显示跳过数量。影响 AC-3、AC-4。

## 与设计的偏差

- 设计里 `analyzeSentenceSplits` 直接按字数/标点切；实现增加了「句文本与字词拼接一致性」校验和 `mismatch` 跳过计数。原因：真实长口播验证发现校对文本与原始字词可能不同，直接使用字词拼出的文本会丢掉校对内容，违反 AC-3/AC-4。
- 设计里的 `SplitAnalysis` 增加 `overLimit`，`SplitPiece` 增加 `limited`，面板增加超限提示。原因：英文 phrase token 无法在词边界内继续切，必须如实标明限制而不是伪造切点。
- 设计里考虑复用 `groupWordsIntoSentences`；实现没有直接复用，因为现有函数按 VAD/时长分组，无法表达「字数上限 + 只在词边界切 + 保留原句文本」。断点规则（句末标点、逗号、停顿）保持一致。

## 遗留问题

- 真实桌面 Tauri 窗口未单独跑；本轮真实验收在 Chrome + 真实 Host + 真实媒体/转写上完成，桌面复用同一 Host/前端代码，按 `docs/30-engineering/acceptance-testing.md` 在测试报告记 `Not run`（缺桌面构建会话/模型下载环境）。
- 未提交 commit：本会话未获得 git 提交授权，工作区改动保持未提交状态。

---
id: F-0031
stage: 03-implementation
status: draft
approved_by:
approved_at:
---

# F-0031 带上下文的分批翻译：开发记录

## 分支与 PR

- 分支：codex/f0031-batched-translation
- PR：

## 进度

<!-- 每完成实现清单的一项，在 02-design.md 勾选，并在这里追加一行：日期、清单项、提交 sha、跑过的检查。
换会话接着做时，先读 02-design.md 和这里。 -->

| 日期 | 清单项 | 提交 | 检查 |
|---|---|---|---|
| 2026-11-13 | 1. 语义句合并、上下文分批、严格校验与行字数/读速纯逻辑 | a67b443 | pnpm test (112 passed, 5 skipped for missing optional ASR models) |
| 2026-11-13 | 2. 扩展 textInputSchema、OpenAICompatibleEngine 与 Host text 插件 | 98f7a53 | pnpm check:host, pnpm test (114 passed, 5 skipped) |
| 2026-11-13 | 3. 扩展 stores/aiService/useAI 与 translationPersistence 持久化回查回滚 | 7a2fe2c | pnpm tsc -b --noEmit, pnpm test:architecture (145/145 passed) |
| 2026-11-13 | 4. 实现 useBatchTranslation、TranslationPanel、文案与编辑器入口接入 | ecd7406 | pnpm lint, pnpm tsc -b --noEmit, pnpm build |
| 2026-11-13 | 5. 编写架构测试、Playwright 端到端测试与截图/录屏证据 | 待提交 | pnpm test:architecture (batched-translation-f0031 3/3), PW_PORT=5191 pnpm e2e:evidence F-0031 (24/24, 40 shots, 24 videos) |
| 2026-11-13 | 6. 完成全量静态检查、测试回归与 04-test-report.md 整理 | 待提交 | 见 04-test-report.md |

## 自行决定的事项

- **默认约束阈值**：每行字数上限 `42` 字符、读速上限 `20` 字符/秒，保存在 `appStore.translationLimits` 中，面板内可实时调整。影响 AC-4。
- **分批与上下文参数**：默认每批最多 `25` 条 / `2400` 字符，按语义句边界切分（句末标点、停顿 `>= 1.2s` 或上限 6 条/220 字符切句），前后各附带最多 `3` 条只读上下文。影响 AC-1。
- **`SubtitleItem` 实时超限提示**：除 `TranslationPanel` 草稿列表外，在 `SubtitleItem` 副字幕区也根据当前 `translationLimits` 展示「译文过长 / Translation too long」提示，方便应用后继续人工精修。影响 AC-4。

## 与设计的偏差

- **`tests/e2e/features/F-0017.spec.ts` 对齐**：由于 `SubtitleList` 顶栏「翻译」按钮由直接全量翻译升级为打开 `TranslationPanel`（与 `F-0013` 纠错入口一致），同步更新了 `F-0017.spec.ts` 中 AC-9 用例的翻译触发步骤（`translation-open` → `translation-start` → `translation-apply` → `translation-close`）。

## 遗留问题

- 真实外部 OpenAI 兼容 API（60 分钟真实口播在线请求）与 Tauri 桌面端真机实测因当前沙箱环境缺失外部 API Key 与桌面 GUI 交互窗口，已在 `04-test-report.md` 中如实记为 `⏸ Not run` 并注明阻塞原因。

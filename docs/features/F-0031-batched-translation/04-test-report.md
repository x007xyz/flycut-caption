---
id: F-0031
stage: 04-test-report
status: review
approved_by:
approved_at:
---

# F-0031 带上下文的分批翻译：测试与验收

验收在代码与测试提交 `34bda71` 上进行；本报告随后作为文档提交，不改变代码与测试。

> 技术设计和开发阶段由 agent 连续推进、自动确认；维护者在这里一并审阅。

## 设计与实现摘要

沿用 F-0030 的多语言轨道与 F-0056 的 Host AI 配置（`configId`），把原来「点一次按钮就全量翻译」改成可编排的分批流程：

- **语义句合并与上下文分批**（`shared/text/translation.ts`）：按句末标点、`>= 1.2s` 停顿和上限（6 条 / 220 字符）把相邻字幕合成语义句，再按语义句边界切批（默认 25 条 / 2400 字符），每批附带前后各最多 3 条只读上下文。只重翻选定过期条目时同样带上紧邻上下文。
- **双端严格校验**：`validateTranslationResults` 同时被 Host 与前端使用，缺条、多余、重复 ID、未知 ID、空译文任一出现即整批失败并提示「翻译结果无效 / Invalid translation result」，不以原文回填。
- **可编排执行**（`src/hooks/useBatchTranslation.ts`）：`runRef` + `AbortController` 管理执行周期，取消或切换项目/视频后迟到响应直接丢弃；`manuallyEdited` 标记保护人工修改，单批重试不会覆盖；源字幕或目标轨道版本变化即置 stale 并锁定提交。
- **安全持久化**（`src/services/translationPersistence.ts`、`historyStore.applyLanguageTranslations`）：只在用户点击应用时写入所选条目与精确 `sourceText` 快照，保存失败或结果不确定时先回查 Host（`verifyCurrentEditsSaved`），确认未写入才回滚 store，面板草稿保留可重试。
- 未新增 ADR，继续沿用 ADR-0007（Host 侧密钥）与 ADR-0011（语言轨）。`text.start` 仅增加可选字段，保持旧三参调用兼容。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| 默认约束阈值 | 每行 42 字符、读速 20 字符/秒，面板内可调，存入 `appStore.translationLimits` | 覆盖中英双语口播常见的单行宽度与 20 CPS 读速标准 | AC-4 |
| 分批与上下文窗口 | 每批最多 25 条 / 2400 字符，按语义句边界对齐；前后各 3 条只读上下文；1.2s 停顿或句末标点切句，无标点长段 6 条 / 220 字符兜底 | 避免把一句完整的话拆到两批，同时控制单次请求体积与成本 | AC-1 |
| 翻译入口形态 | 顶栏「翻译」按钮改为打开 `TranslationPanel`（与 F-0013 纠错面板一致），不再一键直翻 | 需要先让用户确认发送范围、模型与目标语言；一键直翻无法满足 AC-1/AC-5 | AC-1、AC-5 |
| 超限提示位置 | 除面板草稿列表外，`SubtitleItem` 副字幕区也按当前 limits 显示「译文过长」 | 应用后继续精修时仍能看到超限状态 | AC-4 |
| F-0017 E2E 对齐 | 同步修改 `tests/e2e/features/F-0017.spec.ts` 的翻译触发步骤为 open → start → apply → close | 入口变更属于设计内偏差，需保持全仓 E2E 通过 | AC-9 回归 |

## 验收标准逐条结果

| AC | 目标平台 / 环境 | 验证方式、用例与命令 | 证据或未跑原因 | 结果 |
|---|---|---|---|---|
| AC-1 | Node + 真实 Host + Web Chrome | `pnpm test`（`tests/batched-translation.test.mjs` 语义句合并/上下文分批）；`tests/architecture/batched-translation-f0031.test.ts`「F-0031/AC-1 AC-4 AC-7 60-minute Chinese transcript…」；E2E「F-0031/AC-1 AC-6 semantic batch progress, cancel ignores late response…」 | 60 分钟央视级口播转写按批映射 100% ID；面板展示源/目标语言、模型、发送范围与批次进度 | ✅ 通过 |
| AC-2 | Node + Host + Web Chrome | `pnpm test`（`validateTranslationResults` 缺条/多余/重复/未知/空译文）；架构测试「F-0031/AC-2 text.start rejects missing or empty translations…」；E2E「F-0031/AC-2 AC-3 invalid batch fails without fallback…」 | 整批失败并显示「翻译结果无效 / Invalid translation result」，未用原文填补 | ✅ 通过 |
| AC-3 | Web Chrome | E2E「F-0031/AC-2 AC-3 invalid batch fails without fallback, single-batch retry keeps manual edits」「F-0031/AC-1 AC-6 … cancel ignores late response」；`useBatchTranslation` 单测 | 已成功批保留可编辑；取消后迟到响应被丢弃；单批重试保留人工修改；stale 时锁定提交 | ✅ 通过 |
| AC-4 | Node + 真实 Host + Web Chrome | `pnpm test`（`evaluateTranslationConstraints`）；架构测试「F-0031/AC-4 AC-7 AC-8 selective outdated translation updates only chosen IDs…」；E2E「F-0031/AC-4 selective outdated retranslation and translation-too-long warning…」 | 只重翻勾选的过期条目；行字数/读速超限标「译文过长」并可人工修改 | ✅ 通过 |
| AC-5 | Web Chrome | E2E「F-0031/AC-5 empty subtitles shows Nothing here yet」「F-0031/AC-5 missing AI model and empty scope show guidance and keep editor usable」 | 空字幕显示「暂无内容」；缺模型给出设置入口且编辑器保持可用 | ✅ 通过 |
| AC-6 | Web Chrome | E2E「F-0031/AC-1 AC-6 semantic batch progress, cancel ignores late response, and navigation isolates projects」 | 显示「正在处理…」与 `done/total` 进度、可取消、禁用重复提交；切换项目不串台 | ✅ 通过 |
| AC-7 | 真实 Cordis Host | 架构测试「F-0031/AC-1 AC-4 AC-7 60-minute… persists across reopen and second client」「F-0031/AC-4 AC-7 AC-8 …persistence verifies uncertain writes」 | 写入格式 4 语言轨并保存 `sourceText` 快照，重开与第二客户端读取一致 | ✅ 通过 |
| AC-8 | 真实 Host + Web Chrome | E2E「F-0031/AC-3 AC-7 AC-8 stale source guard, save failure retry/back preserving edits, and persistence on reload」；架构测试同名 AC 覆盖 | 保存失败显示原因并可重试/返回，面板草稿保留；结果不确定先回查；stale 提示「内容已更新，请重新检查」 | ✅ 通过 |
| AC-9 | Web Chrome（中英文 × 明暗） | `PW_PORT=5291 pnpm test:e2e tests/e2e/features/F-0031.spec.ts tests/e2e/features/F-0017.spec.ts tests/e2e/features/F-0030.spec.ts --workers=1` | 58/58 通过；本需求 24 个用例覆盖 4 种语言/主题组合，产出 40 张截图与 24 段本地录屏 | ✅ 通过（Web） |
| AC-9 | 真实外部 LLM API（60 分钟在线翻译） | 用真实 OpenAI 兼容服务翻译 60 分钟中文口播并核对完整映射与重开 | 当前环境无授权的外部模型 API Key 与计费账号，未发起真实商业/官方接口请求 | ⏸ Not run |
| AC-9 | 真实 Tauri 桌面端 | 在打包后的 macOS/Windows 应用中完成同一批翻译流程 | 当前 worktree 未构建桌面安装包，未做桌面端实机点击 | ⏸ Not run |

## 界面证据

由 `PW_PORT=5191 pnpm e2e:evidence F-0031` 生成，覆盖 `light/dark` × `zh/en`；`screenshots/` 已入库，`recordings/` 仅留本地（25 个文件，含 `summary.json`）。

| 界面 | 状态 | AC | 截图 | 录屏 |
|---|---|---|---|---|
| 翻译面板 | 空字幕 | AC-5 | `empty-{light,dark}-{zh,en}.png` | 本地 |
| 翻译面板 | 缺 AI 模型 / 范围无条目 | AC-5 | `missing-model-{light,dark}-{zh,en}.png` | 本地 |
| 翻译面板 | 分批处理中（进度 + 取消） | AC-1、AC-6 | `processing-{light,dark}-{zh,en}.png` | 本地 |
| 翻译面板 | 取消后部分完成 | AC-3、AC-6 | `cancelled-partial-{light,dark}-{zh,en}.png` | 本地 |
| 翻译面板 | 单批校验失败 | AC-2 | `batch-invalid-{light,dark}-{zh,en}.png` | 本地 |
| 翻译面板 | 过期条目勾选重翻 | AC-4 | `outdated-select-{light,dark}-{zh,en}.png` | 本地 |
| 翻译面板 | 译文过长标注 | AC-4 | `too-long-{light,dark}-{zh,en}.png` | 本地 |
| 翻译面板 | 源文/轨道过期守卫 | AC-3、AC-8 | `stale-guard-{light,dark}-{zh,en}.png` | 本地 |
| 翻译面板 | 保存失败可重试 | AC-8 | `apply-failed-{light,dark}-{zh,en}.png` | 本地 |
| 翻译面板 | 已完成 | AC-7 | `completed-{light,dark}-{zh,en}.png` | 本地 |

## 回归检查

全部运行于提交 `34bda71`：

- `pnpm lint` ✅
- `pnpm tsc -b --noEmit` ✅
- `pnpm check:host` ✅
- `cargo check --manifest-path src-tauri/Cargo.toml` ✅（先 `pnpm package:host` 生成 `src-tauri/host`）
- `pnpm test` ✅：119 tests，114 passed，0 failed，5 skipped（未下载 fire_red_asr / moonshine / nemo_transducer / paraformer / whisper 额外模型）
- `pnpm test:architecture` ✅：148/148 passed
- `PW_PORT=5291 pnpm test:e2e tests/e2e/features/F-0031.spec.ts tests/e2e/features/F-0017.spec.ts tests/e2e/features/F-0030.spec.ts --workers=1` ✅：58/58 passed
- Red check ✅：把 `validateTranslationResults` 的 id 集合比较退化成「只比条数」后，`tests/batched-translation.test.mjs` 中缺条与错 ID 用例立即失败；恢复后重新全绿

## 发现的问题

- 原「翻译」按钮直接全量翻译并写 store，无法满足分批、单批重试与人工修改保护；本次改为面板编排 + 显式应用，并同步更新了 `F-0017` 的翻译触发步骤。
- 60 分钟口播全量请求会超长且失败后无法定位批；现按语义句切批，单批失败只影响该批。

## 结论

本地自动化（lint、类型检查、Host 类型检查、cargo check、单测、架构测试、中英文 × 明暗 Playwright）全部通过，AC-1 至 AC-8 与 AC-9 的 Web 部分已验证；真实外部 LLM API 与 Tauri 桌面实机两项受当前环境缺少 API Key 与桌面构建条件限制，如实记为 `⏸ Not run`。

本报告等待维护者审阅确认；未自行执行 `pnpm feature approve`。


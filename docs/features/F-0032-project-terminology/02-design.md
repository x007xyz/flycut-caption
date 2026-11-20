---
id: F-0032
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-17
---

# F-0032 项目术语表与译名一致性：设计

## UI / UX

沿用 F-0019 的「热词 / 术语表」弹窗，在同一份项目级词表上增加译名编辑；翻译面板显示生效术语版本与不一致提示，不新增第二份词库。

| 状态 / 入口 | 用户看到什么、能做什么 | 验收构造 |
|---|---|---|
| 术语表弹窗 | 每条词条显示源词、热词开关、权重和已保存译名（如 `en:Subtitle`）；新增/编辑时可用「每行 语言=译名」输入多条译名 | mock 项目带一条带译名的术语 |
| 译名校验 | 语言码不是 2–8 位字母（可带 `-`/`_`）或译名为空时就地报错；重复源词沿用 F-0019 的冲突提示 | 输入 `xx`、`en=`、空行 |
| 翻译面板 · 版本 | 「术语表 v{revision} · {count} 条」，鼠标提示「已要求模型采用指定译名」 | 项目 terminologyRevision=3、1 条译名 |
| 翻译面板 · 术语不一致 | 完成后显示「N 条译文未遵循术语表，请核对后再应用」，列出字幕 id 和缺失的源词；对应草稿行显示「术语不一致」徽标；不自动全局替换 | 模型返回缺少译名的文本 |
| 翻译请求 | 发送前进面板显示当前术语版本；请求带上目标语言译名；术语版本变化时沿用 stale 拦截，禁止直接应用旧结果 | 翻译中改词表 → stale |
| 空态 / 失败 | 无术语时显示「术语表 vN · 0 条」，翻译照常；保存/加载/冲突沿用 F-0019 的既有状态 | 空词表、保存失败 |

## 技术方案

### 涉及的子系统

已读 [frontend.md](../../subsystems/frontend.md)、[cordis-host.md](../../subsystems/cordis-host.md)、[providers.md](../../subsystems/providers.md)、[code-standards.md](../../code-standards.md)、[decisions.md](../../decisions.md)，并核对 `shared/terminology.ts`、`shared/protocol.ts`、`shared/text/OpenAICompatibleEngine.ts`、`server/plugins/text.ts`、`src/services/aiService.ts`、`src/hooks/useBatchTranslation.ts`、`src/components/Project/HotwordsDialog.tsx`、`src/components/SubtitleEditor/TranslationPanel.tsx`、`src/services/projectService.ts`。

### 方案

**1. 复用 F-0019 的项目术语实体**

`ProjectTermEntry.translations?: Record<string, string>` 已由 F-0019 写入 `project.json` 并保留。F-0032 只在同一实体上编辑译名，不新增词库、不新增 Host RPC；`projects.getTerminology` / `saveTerminology` 继续负责版本号、冲突和重启保持。

**2. 术语表弹窗编辑译名**

`HotwordsDialog` 新增「译名（每行 语言=译名）」文本域；编辑词条时回填 `en=Subtitle` 形式。保存时解析成 `translations`，非法语言码或空译名就地报错；`projectService.addHotwordEntry/updateHotwordEntry` 透传translations，保存词表时沿用 F-0019 的 `projects.saveTerminology`。

**3. 翻译请求携带术语**

- `textInputSchema` 增加 `terms: Array<{ term, translation }>`（最多 500 条）。
- `OpenAICompatibleEngine.translate` 的 `TranslateOptions` 增加 `terms`，system prompt 追加「术语表（必须使用指定译名，不要改写）：…」。
- `useBatchTranslation` 从 project store 读取 `terminology` 和 `terminologyRevision`，按目标语言（含 `en-US` → `en` 回退）筛出译名，调用 `aiService.translate` 时带上；所有批次使用同一次运行开始时捕获的术语版本。
- `BaseSnapshot` 增加 `terminologyRevision`：运行期间词表版本变化时 `staleNow=true`，沿用现有 stale 提示阻止应用旧结果。

**4. 术语不一致标记**

新增 `findTerminologyIssues(items, terms)`：源文包含源词、译文中不包含对应译名时，返回 `{ id, terms }`；英文比较忽略大小写并接受简单复数（`subtitle`/`subtitles`、`glossary`/`glossaries`），不做自动替换。`useBatchTranslation` 在 review/partial/applying 阶段计算并暴露 `terminologyIssues`；`TranslationPanel` 显示汇总和逐条徽标。

**5. 真实 API 验证**

使用 opencode go 的 `deepseek-v4.1-flash`（`https://opencode.ai/zen/go/v1`，需要 `x-opencode-session` 请求头；AI 设置已支持自定义请求头）对两批中英/中日样例记录术语遵循率。

### 接口与数据

| 位置 | 接口 / 约束 |
|---|---|
| `shared/terminology.ts` | `findTerminologyIssues`；译名沿用 `ProjectTermEntry.translations` |
| `shared/protocol.ts` | `text.start` 增加 `terms` |
| `shared/text/OpenAICompatibleEngine.ts` | `TranslateOptions.terms` 与 system prompt |
| `src/hooks/useBatchTranslation.ts` | 术语筛选、版本捕获、stale、`terminologyIssues` |
| `src/components/Project/HotwordsDialog.tsx` | 译名输入、校验、回填与展示 |
| `src/components/SubtitleEditor/TranslationPanel.tsx` | 版本、提示、不一致汇总与徽标 |
| 项目格式 | 无变化；`translations` 已存在 |

### 备选方案与取舍

| 选定 | 备选 | 理由 |
|---|---|---|
| 复用 F-0019 词表实体 | 新建术语库 | AC-2 明确要求同一实体，避免两份数据漂移 |
| 术语以 system prompt 注入 | 译后全局替换 | 全局替换会破坏语境；AC-3 要求不偷偷替换 |
| 只标记不一致 | 自动重译/替换 | 模型输出不确定，标记后让人核对更安全 |
| 版本变化即 stale | 静默用最新词表 | 旧响应可能在旧词表下生成，必须重新核对（AC-4） |

## 架构决策

不新增 ADR。沿用 ADR-0001 的项目增量字段和 F-0019 的术语表契约。

## 自行决定的事项

- 译名输入用「每行 语言=译名」文本格式，支持一次编辑多语言；不新增独立表格。
- 不一致判断只针对「源文包含源词」的条目；英文忽略大小写和简单复数，避免把 `glossaries` 误报。
- 术语版本在每次翻译运行开始时捕获；运行中改词表→stale，不自动合并。
- 不做自动替换或自动重译；用户可在草稿里手动改，再应用。

## 风险与回退

- 模型可能忽略 system prompt；不一致标记会暴露问题，不会静默改文案。
- 译名格式输入对非技术用户略复杂；后续可改为语言下拉+输入框，不影响存储契约。
- 术语数量大时 prompt 变长；单次最多 500 条，超限由 schema/界面限制。

## 实现清单

- [x] 1. **共享契约**：`text.start.terms`、`TranslateOptions.terms`、`findTerminologyIssues`；架构测试覆盖 prompt 注入与不一致判断（AC-3）。
- [x] 2. **翻译链路**：`useBatchTranslation` 读取项目术语、按语言筛选、运行期捕获版本、stale 与不一致列表；`TranslationPanel` 显示版本/提示/徽标（AC-3、AC-4）。
- [x] 3. **术语表 UI**：`HotwordsDialog` 译名输入、回填、校验与展示；`projectService` 透传 translations（AC-1、AC-2）。
- [x] 4. **真实 API 与 E2E**：opencode go 两批真实翻译记录遵循率；E2E 中英文 × 明暗主题覆盖译名展示、保存、版本显示（AC-4、AC-9）。

## 验证计划

- 架构/单测：`tests/architecture/terminology-translation-f0032.test.ts` 断言术语映射出现在 system prompt；`findTerminologyIssues` 覆盖命中、缺失、大小写与复数。
- E2E：`tests/e2e/features/F-0032.spec.ts` 覆盖译名 chip、编辑回填、保存、翻译面板版本；中英文 × 明暗主题。
- 真实 API：`pnpm acceptance:f0032` 用 opencode go 跑英文/日文两批，记录 `followed/total`。
- Red check：撤掉 prompt 注入 → 架构测试失败；撤掉大小写/复数匹配 → 不一致测试失败。
- 回归：`pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`、`pnpm test`、`pnpm test:architecture`、`cargo check`。

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | 译名输入、校验、chip 展示，清单 3 |
| AC-2 | 复用项目术语实体和 Host 版本，清单 1、3 |
| AC-3 | 版本显示、prompt 注入、不一致标记，清单 1、2 |
| AC-4 | 版本捕获与 stale、真实 API 两批遵循率，清单 2、4 |
| AC-5 | 沿用热词弹窗入口和空态，清单 3 |
| AC-6 | 沿用 F-0019 加载/保存/禁用重复提交，清单 2、3 |
| AC-7 | Host 确认保存才完成，清单 3 |
| AC-8 | 沿用冲突/失败/重试，清单 3 |
| AC-9 | 中英文 × 明暗主题 E2E、真实 API 证据，清单 4 |

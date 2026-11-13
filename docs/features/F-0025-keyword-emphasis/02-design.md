---
id: F-0025
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-13
---

# F-0025 字幕关键词强调：设计

## UI / UX

沿用现有项目编辑器、播放器字幕遮罩、字幕样式面板与 Host AI 设置，不新增独立页面或独立设置存储。界面分为三处协作入口，所有新增文案进入中英文 locale（`src/locales/keywords.ts`、`zh_CN.ts`、`en_US.ts`）：

1. **关键词强调样式控制（`src/components/SubtitleSettings/SubtitleSettings.tsx`）**
   - 在主字幕样式 Tab 下新增「关键词强调 / Keyword emphasis」区块（副字幕 Tab 提示关键词强调作用于主字幕，与底边距锁定说明一致）：
     - **换色开关与颜色**：`keywordColorEnabled`（默认开启）+ 颜色选择与 HEX 输入（`keywordColor`，默认 `#FFE100`）。
     - **缩放比例**：滑块与数值输入（`keywordScale`，`100%`–`180%`，步长 `5%`，默认 `120%`）。
     - **底色填充**：颜色选择、HEX 输入、透明度滑块与「无 / None」快捷关闭（`keywordBackgroundColor` 默认 `#FF5B57`，`keywordBackgroundOpacity` 默认 `0`）。
     - **AI 推荐入口按钮**：点击触发打开编辑器内的「AI 推荐关键词」面板（`flycut:open-keyword-recommend`）。
   - 修改上述样式只更新 `subtitleStylePair.primary` 并触发项目自动保存，不改原文、时间戳或 EDL。

2. **字幕行内手动标记与取消（`src/components/SubtitleEditor/SubtitleItem.tsx`）**
   - 每条未删除的非空白主字幕支持两种手动标记方式（无词级时间戳、未配置 AI 模型时同样可用）：
     - **划选直标**：在主字幕 `<textarea>` 中选中一段文本后，行内出现「标为关键词 / Mark keyword」按钮（若选中区间恰好匹配已有关键词则显示「取消关键词 / Unmark keyword」），点击立即提交该句关键词变更。
     - **快捷分词点选**：点击每行工具区「关键词 / Keywords」按钮展开行内选词条，按 `Intl.Segmenter` 切分词片；单击词片切换单个关键词，支持点击起止词片或 Shift+单击标记连续短语。
   - 已标记的关键词以标签列表展示在字幕行下方，支持单击 `×` 立即取消。
   - 行内变更通过 `historyStore` 提交（`cuts = false`），支持撤销/重做与项目自动保存。

3. **可选 AI 推荐关键词审阅面板（`src/components/SubtitleEditor/KeywordEmphasisPanel.tsx` + `src/hooks/useKeywordRecommendation.ts`）**
   - 位于 `SubtitleEditorPanel.tsx` 工具条区域（即使当前无字幕也保留入口，以便覆盖空态与前置状态）：

| 状态 | 用户看到什么、能做什么 | 端到端构造方式 |
|---|---|---|
| 空态 / 无字幕（AC-5） | 显示「暂无内容 / Nothing here yet」，说明缺少可处理的字幕，禁止提交；已有项目编辑仍可用 | 打开无字幕项目，点击推荐入口并断言文案 |
| 未配置 AI 模型（AC-5） | 说明缺少 AI 模型并提供「打开 AI 设置 / Open AI settings」入口，手动标记与样式设置保持可用 | `aiSettings.list` 返回空列表，验证跳转与手动标记 |
| 发送前确认（AC-3） | 展示当前模型名称/模型 ID/地址、将发送的字幕条数与字数范围、仅发送文本不直接改动字幕的说明（远程 Host 增加发送确认勾选），提供「开始推荐 / Start recommendation」 | 配置 mock/真实 Host AI 模型后打开面板断言模型与范围 |
| 加载与执行中（AC-6） | 显示「正在加载… / Loading…」及「正在处理… / Processing…」与批次进度，禁用重复提交，提供「取消 / Cancel」与不可撤回外部请求的提示；切换项目/视频后丢弃迟到响应 | `text.suggestKeywords` 或 `jobs.get` 延迟返回，验证取消、禁重与切换隔离 |
| 推荐审阅（AC-3） | 推荐结果仅留在临时审阅层，不写入 `historyStore.chunks` 或导出；按句展示候选词，允许逐个勾选/排除、手动增删或改写范围、全选/清空，提供「确认应用 / Apply」和「取消 / Cancel」 | 返回固定候选词，编辑/排除后分别测试取消（0 变更）和确认 |
| 持久化与完成（AC-7） | 确认后写入 `historyStore` 并等待项目保存确认（或无项目模式本地提交），完成后显示「已完成 / Completed」及生效数；重开与第二个客户端读取一致 | 拦截 `projects.saveVideoEdits` 验证写入内容，重开页面核对关键词与样式 |
| 失败 / 版本过期（AC-4、AC-8） | 请求或校验失败显示具体原因与「重试 / Retry」「返回 / Back」，保留用户输入和正式数据；原文更新使快照基线变化时显示「内容已更新，请重新检查 / Content changed. Review again.」，阻止应用并要求重新检查 | 构造 RPC 错误/非法返回、以及审阅期间修改字幕原文 |

## 技术方案

### 涉及的子系统

已读 `AGENTS.md`、`LESSONS.md`、`docs/code-standards.md`、`docs/decisions.md`、`docs/30-engineering/acceptance-testing.md`、`docs/subsystems/frontend.md`、`docs/subsystems/cordis-host.md`、`docs/architecture-current.md`、`docs/20-architecture/adr/0006-subtitle-graphics-layer.md`、`docs/20-architecture/adr/0007-host-ai-settings-and-secrets.md`、`docs/20-architecture/adr/0001-project-storage-format.md` 与 `F-0024` / `F-0028` / `F-0056` 实现。

### 方案

1. **关键词数据结构与原文字偏移安全（`shared/text/keywords.ts`、`shared/subtitle-graphics/text.ts`）**
   - 关键词在 `SubtitleChunk` 上存为 `keywords?: SubtitleKeyword[]`，每项记录 `{ start, end, text, source? }`，其中 `start`/`end` 为原始 `chunk.text` 的 UTF-16 字符下标，`text` 为标记时的精确子串 `chunk.text.slice(start, end)`。
   - 任何时候 `chunk.text` 发生变化（手动编辑、查找替换、AI 纠错、历史回退或按词同步），`reconcileChunkKeywords(keywords, nextText)` 严格校验 `nextText.slice(kw.start, kw.end) === kw.text`，不匹配的旧偏移一律移除，绝不套给新原文。
   - 绘制前通过 `mapRawKeywordsToDisplay(rawText, rawKeywords)` 将 `chunk.text` 的区间逐字符映射到 `stripSubtitleDisplayPunctuation(rawText)` 之后的显示文本下标，确保标点剔除后关键词位置依然精确且不依赖重复词猜词。

2. **共用图形层混排与放大宽度预留（`shared/subtitle-graphics/`）**
   - `SubtitleGraphicStyle` 新增向后兼容的可选字段：`keywordColorEnabled`、`keywordColor`、`keywordScale`、`keywordBackgroundColor`、`keywordBackgroundOpacity`；`SubtitleGraphicCue` 新增可选 `keywords?: SubtitleGraphicKeyword[]`（校验有序、不重叠、不越界且子串匹配 `cue.text`）。`version` 保持 `1`。
   - **混排排版（`layout.ts`）**：当 `cue.keywords?.length` 非空时，利用已随包引入的 `@chenglou/pretext/rich-inline` 将每段文本切分为普通文本片段（`baseFontSize`）与关键词片段（`keywordFontSize = Math.round(baseFontSize * keywordScale)`）。对能放进单行 `maxWidth` 的关键词设置 `break: never` 保持词完整性，并注入 `extraWidth = reserveLeft + reserveRight` 为放大的描边与关键词底框预留水平宽度；若单个关键词本身超过 `maxWidth` 则回退为 `break: normal` 自动折行，保证三种画幅（16:9 `0.9`、9:16 `0.85`、1:1 `0.88`）均不超宽不碰撞。
   - **垂直行高与条带余量（`layout.ts`、`draw.ts`）**：每行记录自身有效 `fontSize` 与 `bgPadY`，行间距按上下行实际占用高度取最大值，防止多行字幕中放大关键词与上一行或副字幕碰撞；`subtitleBand` 的外边距加上放大描边余量与关键词底框圆角/内边距，确保 Skia 导出的条带不裁掉任何像素。
   - **分层绘制（`draw.ts`）**：含关键词的行按 Run 依次执行三遍绘制——行背景与关键词底框 → 手绘阴影 → 描边、填充与下划线（并保留 F-0024 逐字高亮裁剪通道）。`frameKey` 纳入 `cue.keywords` 状态。
   - 无关键词的字幕完全走原有 `layoutTextLines` 路径，保持 F-0028 / F-0024 行为零回退。

3. **Host AI 推荐关键词独立接口（`shared/protocol.ts`、`server/plugins/text.ts`、`shared/text/OpenAICompatibleEngine.ts`）**
   - 在 `textPlugin` 新增独立 RPC 方法 `text.suggestKeywords`（不改动 `text.start` 批翻译/纠错接口）。
   - 请求仅携带 `configId`（由 Host 通过 `ctx.aiSettings.resolve(configId)` 解析密钥，密钥不跨 RPC、不进日志）与 `request: { base, language?, items: [{ id, text }] }`（不含时间戳、项目 ID、媒体信息）。
   - 模型只需输出精确子串列表（而非易错的字符下标），Host 端 `validateKeywordModelResponse` 校验 `version === 1`、`base === request.base`、ID 归属与重复，并将子串在对应 `item.text` 中精确定位为不重叠 `{ start, end, text }`；找不到子串或格式异常即抛 `KeywordContractError`，不在前端猜测偏移。

4. **前端分批编排、版本校验与持久化（`src/hooks/useKeywordRecommendation.ts`、`src/stores/historyStore.ts`、`src/subtitle/graphicsScene.ts`）**
   - 长视频按 `splitKeywordBatches` 分批（每批最多 25 句 / 2400 字）顺序调用 `text.suggestKeywords`，支持取消与失败批次保留/重试。
   - 记录分析启动时的原文基线哈希 `base`；任何字幕原文、增删或 EDL 变动触发基线不一致时标记 `stale`，阻塞确认并提示「内容已更新，请重新检查 / Content changed. Review again.」。
   - 确认后通过 `historyStore.batchSetKeywords` 写入 `chunks`，由现有 `projectsClientPlugin` 自动同步崩溃恢复副本与 `projects.saveVideoEdits`（`edits.json` 的 `chunkSchema` 为 `z.looseObject`，同时补充可选 `keywords` 声明；`projectStyle` / `edits.stylePair` 保存样式字段，不升项目格式版本号）。

### 接口与数据

| 层 | 接口 / 约束 |
|---|---|
| `shared/text/keywords.ts` | `SubtitleKeyword` schema、偏移校验/调和、划选/词片切换、分批与 AI 响应校验 `validateKeywordModelResponse` |
| `shared/subtitle-graphics/scene.ts` | `SubtitleGraphicStyle` 新增可选 `keywordColorEnabled` / `keywordColor` / `keywordScale` / `keywordBackgroundColor` / `keywordBackgroundOpacity`；`SubtitleGraphicCue` 新增可选 `keywords` |
| `shared/subtitle-graphics/layout.ts` & `draw.ts` | `LayoutLine.runs` 混排几何与宽/高预留、Run 分层绘制、`frameKey` 关键词键、`subtitleBand` 放大余量 |
| `shared/protocol.ts` & `server/plugins/text.ts` | 新增 `text.suggestKeywords` RPC，入参 `{ configId, request }`，仅在 Host 解析密钥 |
| `src/subtitle/subtitleStyle.ts` & `graphicsScene.ts` | `SubtitleStyle` 新增关键词样式字段与默认值；预览/导出场景映射剔除标点后的关键词区间 |
| `src/stores/historyStore.ts` | 新增 `setChunkKeywords` / `batchSetKeywords`（`cuts = false`）；文本变更入口自动清理失效偏移 |

### 备选方案与取舍

| 选定 | 备选 | 理由 |
|---|---|---|
| 关键词存为 `chunk.keywords: [{ start, end, text }]` 字符区间 | 复用 `wordChunks` 的 `keyword: boolean` | 口播项目可能无字词时间戳（VAD 分段、未开启词对齐或用户手改过原文）；字符区间在任何转写模式下都能手动标记与持久化，同时 `text` 快照可精准检测原文变更失效 |
| 基于 `@chenglou/pretext/rich-inline` 做多字号混排并注入 `extraWidth` | 自己重抄断行器或先按原字号换行再硬放大 | `rich-inline` 复用 Pretext 同一套 Unicode 分词/Canvas 测量逻辑，可把 `keywordScale` 与底色内边距直接算进断行宽度，保证三画幅不遮挡且双端换行一致 |
| 让 AI 返回精确子串再由校验器定位于 `item.text` | 让 LLM 直接输出 `start`/`end` 数字下标 | LLM 对 UTF-16 字符下标极易算偏，返回原句精确子串并由确定性校验器定位与拒收幻觉词，可靠度远高于模型计数 |
| 在 `server/plugins/text.ts` 新增 `text.suggestKeywords` | 复用 `text.start` 加新 mode | 遵守需求分工要求「不改动批翻译接口」，独立方法与 schema 边界更清晰，可独立演进与测试 |

## 架构决策

沿用已接受的 [ADR-0006](../../20-architecture/adr/0006-subtitle-graphics-layer.md)（共用 Canvas 2D 与 Host Skia 条带）、[ADR-0007](../../20-architecture/adr/0007-host-ai-settings-and-secrets.md)（Host `aiSettings` 解析与密钥隔离）及 [ADR-0001](../../20-architecture/adr/0001-project-storage-format.md)（向后兼容扩展 `edits.json` 与 `stylePair`），无需推翻已有决定或新增突破边界的 ADR。

## 自行决定的事项

- **关键词作用于主字幕**：双语模式下主字幕承载原语言口播内容，副字幕为译文；关键词标记与样式控制仅作用于主字幕（`primary`），副字幕样式 Tab 显示说明提示。影响 AC-1、AC-3。
- **默认值设定**：默认开启关键词换色（`#FFE100`）与适度放大（`120%` / `1.2`），默认底色透明度为 `0`（按需开启），使标记关键词后立即可见且不破坏常规透明背景字幕观感。影响 AC-1。
- **关键词底框圆角与内边距随字号等比计算**：按 `keywordFontSize` 比例计算圆角与内边距，避免在不同分辨率（720p/1080p/4K）和缩放倍率下出现过大或贴字问题。影响 AC-2。
- **原文编辑时精确子串匹配调和**：已保存的关键词在原文被编辑后，仅当新原文同一 `[start, end)` 仍等于原 `text` 时保留，否则丢弃不沿用旧偏移；未应用的 AI 推荐在任何原文/EDL 变更后整体标为过期并要求重检。影响 AC-4、AC-8。
- **单行长关键词超宽回退**：常规关键词设置 `break: never` 防止被拆断；当单个关键词本身宽度超过画幅 `maxWidth` 时自动允许折行，确保不溢出画面边界。影响 AC-2。

## 风险与回退

- **Canvas 抗锯齿差异**：Browser Canvas 2D 与 Skia 在放大字号边缘存在亚像素抗锯齿差异；布局与字体文件完全共用，1080p 包围盒偏移控制在 `≤ 2px` 内并在架构测试实测。
- **换行与 `rich-inline` 空格处理**：需测试中英混排、带空格英文短语（如 `React 19`）、连续标点剔除、多行关键词在三种画幅下的排版与包围盒，避免边界空格被吞掉或错位。
- **回退方式**：新增样式字段与 `chunk.keywords` 均为可选扩展，旧版本/回退后可直接忽略未知字段，不影响正文、时间戳和 EDL。

## 实现清单

- [x] 1. **关键词数据模型、偏移安全与图形层混排渲染**：新增 `shared/text/keywords.ts` 与 `shared/subtitle-graphics/` 关键词样式/区间/混排/分层绘制/`frameKey`/`subtitleBand` 扩展，编写架构单测验证三种画幅宽度预留、不遮挡不裁边、1080p 包围盒偏移 `≤ 2px` 与旧场景兼容（AC-1、AC-2）。
- [x] 2. **Host AI 推荐接口与协议校验**：在 `shared/protocol.ts`、`server/services.ts`、`shared/text/OpenAICompatibleEngine.ts`、`server/plugins/text.ts` 实现独立 `text.suggestKeywords` RPC，不改动 `text.start`，编写真实 Host RPC 与校验测试（AC-3、AC-4、AC-8）。
- [x] 3. **前端样式、预览、历史与持久化接线**：扩展 `SubtitleStyle`、`SubtitleChunk`、`graphicsScene.ts`（剔除标点后的区间映射与 EDL 投影）、`historyStore.ts`（关键词标记/取消不改原文/时间戳/EDL、原文编辑后调和失效偏移）与 `SubtitleSettings.tsx`（换色、缩放、底色控制），确认样式与标记自动保存及重开恢复（AC-1、AC-4、AC-7）。
- [x] 4. **字幕行内手动标注与 AI 推荐审阅 UI**：在 `SubtitleItem.tsx` 实现划选标注/取消、分词点选与标签移除；新建 `useKeywordRecommendation.ts` 与 `KeywordEmphasisPanel.tsx` 接入 `SubtitleEditorPanel.tsx`，完整覆盖空态、无模型、发送前模型/范围确认、加载/处理/取消/防重复/切项目隔离、手改/排除/确认生效、失败重试与内容更新重检，补充中英文 `locales`（AC-1、AC-3、AC-4、AC-5、AC-6、AC-7、AC-8）。
- [x] 5. **端到端验收、真实 Host 导出验证与文档更新**：新增 `tests/architecture/keyword-emphasis-export-f0025.test.ts`（真实 Host Skia + FFmpeg 导出三种画幅及重开持久化）与 `tests/e2e/features/F-0025.spec.ts`（覆盖所有状态与中英文、明暗主题），运行全量静态检查、单测与 `PW_PORT=5192 pnpm e2e:evidence F-0025`，更新子系统文档并提交审核（AC-1～AC-9）。

## 验证计划

- 每完成清单一项运行受影响范围的 `pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host` 与对应测试；最终在固定 commit 上运行全部静态检查、`pnpm test`、`pnpm test:architecture`、`pnpm build`。
- `tests/architecture/keyword-emphasis-f0025.test.ts`：
  - 验证关键词映射（含标点剔除、多处重复词、原文变化后旧偏移不套用）；
  - 验证 16:9（`1920x1080`）、9:16（`1080x1920`）、1:1（`1080x1080`）三种画幅下放大关键词预留宽度、不超 `maxWidth`、相邻文本水平无碰撞、多行垂直不碰撞；
  - 验证完整画布与 Skia `subtitleBand` 的 1080p 包围盒偏移 `≤ 2px`、换色/缩放/底色及 `frameKey` 刷新；
  - 验证 `text.suggestKeywords` RPC 契约、密钥隔离、严格子串校验与拒绝幻觉/过期基线。
- `tests/architecture/keyword-emphasis-export-f0025.test.ts`：
  - 驱动真实 Host `export.start` + Skia 条带 + bundled FFmpeg，在 16:9 / 9:16 / 1:1 导出成片并解码帧像素，断言放大关键词高度/像素面积、底色/换色像素及无描边裁剪，且无 `.ass` 临时文件。
- `tests/e2e/features/F-0025.spec.ts`：
  - 测试名均带 `F-0025/AC-n`，覆盖中英文与 `light`/`dark` 主题；
  - 覆盖手动划选/点选标记与取消、设置换色/缩放/底色、播放器 Canvas 预览实时更新、项目保存与刷新重开保留；
  - 覆盖 AI 推荐完整状态：无字幕空态（暂无内容）、无模型提示与跳转 AI 设置、发送前展示模型与文本范围、加载/处理中防重复与取消、切项目不串结果、推荐审阅编辑/排除/取消（0 变更）、确认生效、原文修改后失效提示重检、失败与重试/返回。
- Red check：临时破坏排版中的关键词宽度预留（仍按普通字号测宽）或跳过 `cue.keywords` 的 `frameKey` / 原文过期校验，确认对应单测与架构测试必失败并指出具体缺陷。
- 使用 `PW_PORT=5192 pnpm e2e:evidence F-0025` 生成截图与本地录屏。需要真实外部商用 LLM API 或真机桌面打包才能覆盖的部分，若环境缺凭据或桌面测试入口则实事求是记为 `⏸ Not run` 并写明阻塞原因。

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | `SubtitleStyle` 与 `SubtitleSettings` 换色/缩放/底色控件；`SubtitleItem` 手动划选与分词点选标记/取消；`historyStore` 仅改样式与 `chunk.keywords`，不改原文、时间戳与 EDL |
| AC-2 | `shared/subtitle-graphics/layout.ts` 基于 `rich-inline` 预留放大宽度与底框内边距、动态行高、`subtitleBand` 描边余量；三画幅架构测试 + 1080p `≤ 2px` 包围盒 + 真实 Host Skia 导出像素验证 |
| AC-3 | `text.suggestKeywords` 独立 Host RPC；`KeywordEmphasisPanel` 发送前展示模型与文本范围、临时审阅层编辑/排除、确认后生效；无模型时手动标记完全可用 |
| AC-4 | `reconcileChunkKeywords` 与审阅基线校验防止旧偏移套用新原文；真实 Host 导出与项目重开保留标记与样式 |
| AC-5 | 复用项目/字幕/样式/AI 设置入口；无字幕「暂无内容 / Nothing here yet」、无模型说明与设置入口、原有编辑可用 |
| AC-6 | 加载/处理中文案与进度、禁用重复提交、取消按钮、跨项目/切目标防串响应、不可撤回外部调用说明 |
| AC-7 | 仅确认写入后提示「已完成 / Completed」；重开与第二个客户端读取同 Host 一致 |
| AC-8 | 失败展示具体原因、`重试 / Retry`、`返回 / Back`，保留用户编辑与正式数据；原文更新提示「内容已更新，请重新检查 / Content changed. Review again.」 |
| AC-9 | `F-0025.spec.ts` 中英文 × 明暗主题覆盖与截图录屏；真实 Host 导出验收；环境受限外部服务/桌面端如实标注 `Not run` |

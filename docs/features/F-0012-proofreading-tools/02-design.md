---
id: F-0012
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-09
---

# F-0012 校对体验：设计

## UI / UX

### 入口

- 编辑器载入字幕后，`SubtitleEditorPanel` 监听 Cmd/Ctrl+F。输入法组合中不抢占；字幕输入框内允许打开应用内查找，普通页面仍保留浏览器查找。
- 原语言视图收到 Cmd/Ctrl+F 时先切到「编辑模式」，再打开查找条；不改变当前视频、播放位置或选中删除状态。
- 查找条放在 `CutHistoryPanel` 下方、字幕列表上方，不遮挡播放器。关闭后清除查询、命中、预览和当前定位，不修改字幕。

### 组件

| 组件 | 责任 |
|---|---|
| `FindReplaceBar` | 查询、区分大小写、上一处/下一处、替换输入、单处替换、全部替换预览、关闭 |
| `useFindReplace` | 纯 UI 状态与命中计算；不写 store，不直接保存项目 |
| `SubtitleList` | 把命中信息传给行组件；当前命中滚动到可视区并标记 `aria-current` |
| `SubtitleItem` | 查找打开时在主字幕上方显示只读命中片段，用 `<mark>` 标出匹配文字；不替换可编辑 textarea |
| `ReplacePreviewDialog` | 全部替换的命中数、涉及字幕、替换前后预览、确认/取消 |

### 状态与文案

| 状态 | 界面 | 文案（中文 / English） | AC |
|---|---|---|---|
| 初始 | 查找条展开，输入框聚焦 | 查找 / Find | AC-1 |
| 无查询 | 不匹配空字符串，替换按钮禁用 | 输入要查找的文字 / Type to find | AC-1 |
| 有命中 | 显示 `{current}/{total}`，上下箭头可循环 | `{current}/{total}` | AC-1、AC-3 |
| 无命中 | 输入框下方提示，替换禁用 | 没有匹配结果 / No matches | AC-3 |
| 当前命中 | 字幕行滚动到中间，行有非颜色标记和 `aria-current` | 第 {n} 处 / Match {n} | AC-3 |
| 全部替换预览 | 模态框列出数量和前后文本 | 替换全部 / Replace all；确认替换 / Confirm replacement | AC-5 |
| 过期 | 确认前发现原文已变，预览不提交 | 字幕已更新，请重新检查替换 / Subtitles changed. Review replacements again. | AC-6 |
| 提交中 | 按钮禁用，显示进度 | 正在替换… / Replacing… | AC-6 |
| 失败 | 保留原文和预览，可重试 | 替换失败，请重试 / Replace failed. Try again. | AC-6 |
| 输入焦点 | 查找/替换框内 Space、Delete、普通字符不触发播放器或删除快捷键 | — | AC-8 |

### 匹配与高亮

- 只在 `chunks.filter(c => !c.deleted && !c.isBlankSpacer)` 的原文中匹配；已删除内容和空白占位段不参加。
- 默认不区分英文大小写；开关打开后按原字符比较。中文按实际字符匹配，不做繁简、同音或正则解释。
- 每个句子单独匹配，不跨句拼接。一个句子内允许多个命中；`{current}/{total}` 的总数是命中实例数，不是句子数。
- 命中片段是只读的 `<mark>` 预览，不替换 textarea 的可编辑文本；提交后 textarea 才更新。这样不会破坏输入法组合和光标。
- `SubtitleItem` 的命中片段带 `aria-label`，例如「匹配：项目名称」，不只靠颜色区分。

## 技术方案

### 涉及的子系统

- `src/components/SubtitleEditor/**`、`src/components/VideoPlayer/**`：界面与快捷键。
- `src/stores/historyStore.ts`：`batchUpdateText` 一次提交、一次撤销；不改时间戳、ID、译文或 EDL。
- `src/services/projectService.ts`：既有 autosave、离开保护和冲突处理，不新增保存路径。
- `src/locales`：中英文文案。

### 方案

1. 纯函数 `shared/text/findReplace.ts`：
   - `findMatches(chunks, query, { matchCase }): FindMatch[]`；`FindMatch` 包含 `chunkId`、`start`、`end`、`text`。
   - `replaceOne(text, match, replacement)`、`replaceAll(chunks, matches, replacement)`。
   - 用转义后的普通文本构造 `RegExp`，只用来定位；用户输入不当作正则。
2. `useFindReplace` 在 `SubtitleEditorPanel` 中创建，持有查询、当前命中、预览和状态；
   查询或字幕版本变化时重算命中，当前命中按 chunk 顺序夹紧。
3. `SubtitleEditorPanel` 把 `find` 状态传给 `FindReplaceBar` 与 `SubtitleList`；
   `SubtitleList` 用 `data-chunk-id` 找到当前命中行并 `scrollIntoView({ block: 'center' })`。
4. 单处替换：只替换当前命中所在 chunk 的当前区间；调用 `updateChunkText(id, next)`。
5. 全部替换：先构建 `ReplacePreview`，包含每个受影响 chunk 的 before/after 和总命中数；确认时再次读取当前 chunks，比较预览基准，任何受影响 chunk 的原文变化都判过期；通过后调用一次 `batchUpdateText(updates)`，由 historyStore 产生一个 undo action。
6. 预览基准用 `JSON.stringify` 的受影响 chunk 原文摘要，不保存完整项目快照；提交前重新计算。
7. 快捷键只在编辑器挂载时绑定；查找条输入元素设置 `data-find-input`，全局 keydown 先检查 `event.target.closest('[data-find-input]')` 和输入法 `isComposing`。

### 接口与数据

- 不新增 RPC，不修改项目格式。
- 新增前端类型：

```ts
export interface FindMatch { chunkId: string; start: number; end: number; text: string }
export interface ReplacePreview { query: string; replacement: string; base: string;
  rows: Array<{ chunkId: string; before: string; after: string }>; total: number }
```

- `FindMatch` 的 `start/end` 是 JS 字符串下标（UTF-16 code unit），与 textarea 的选择区间一致。
- 全部替换只改 `chunks[].text`；`secondText`、`timestamp`、`id`、`wordIds`、`edlWordProjection`、`deleted`、EDL 均不变。
- 字词关联：如果 chunk 的 `text` 与 `wordIds` 投影不再一致，沿用 F-0005 的 `edlWordProjection` 门禁；本次不重排 wordChunks，也不按字数猜时间。
- 切换视频、关闭项目或 `setTranscript` 时，`useFindReplace` 由组件卸载/依赖变化清空；迟到预览通过 `base` 比较失效。

### 备选方案与取舍

| 方案 | 结论 |
|---|---|
| 直接在 textarea 内用 CSS 高亮 | 不可行：textarea 不能混排 `<mark>`；contenteditable 会破坏输入法和现有编辑行为 |
| 每次替换立即 autosave | 会产生多个保存/撤销边界；改用 `batchUpdateText` 一次提交，沿用项目 autosave |
| 使用正则用户输入 | 违反 AC-2；只把用户输入当普通文本 |
| 在 Host 做查找替换 | 当前视频字幕已在内存，Host 往返不会增加正确性，还会引入并发版本问题；继续在客户端做，保存仍走 Host |

## 架构决策

无新增 ADR。沿用 F-0005「字幕文本编辑不改时间戳/EDL」和 F-0002/F-0003「Host 是正式数据来源」。

## 自行决定的事项

- 当前命中用「只读命中片段 + 行标记」呈现，不在 textarea 内做富文本高亮；原因是保持输入法、光标和现有编辑行为。
- 全部替换预览只要求比较受影响 chunk 的原文，不比较整个视频；这能满足 AC-6 的冲突检测，也避免把无关编辑误判为过期。
- Cmd/Ctrl+F 在原语言视图会切到编辑模式；这是为了覆盖「字幕编辑场景」，不改变原文或选中状态。

## 风险与回退

- 大小写折叠在极少数 Unicode 字符上可能改变长度；实现用 `RegExp` 定位而不是 `toLowerCase()` 下标映射，避免错位。
- 查找条打开时行高增加；字幕列表滚动位置可能跳动。当前命中滚动只在 `current` 变化时触发，关闭查找不清空列表。
- 若 `batchUpdateText` 保存失败，沿用项目 autosave 的失败/重试界面；查找预览保留，不假装已保存。
- 不新增存储格式；若后续需要持久化文字操作历史（F-0013），另开格式迁移，不在本需求里做。

## 实现清单

- [x] 1. 新增 `shared/text/findReplace.ts` 纯函数与单元测试：空查询、大小写、中文、多命中、跨句不匹配、替换单处/全部、特殊字符转义。
- [x] 2. 新增 `FindReplaceBar` 和 `useFindReplace`，接入 `SubtitleEditorPanel`；Cmd/Ctrl+F、关闭、上下定位、输入焦点保护。
- [x] 3. `SubtitleList`/`SubtitleItem` 接入命中片段、`aria-current`、当前命中滚动和 `<mark>` 可访问名称。
- [x] 4. 单处替换与全部替换预览/确认/过期/失败；全部替换一次 `batchUpdateText`，一次撤销恢复。
- [x] 5. 中英文文案、明暗主题、60 分钟字幕性能检查；Playwright 覆盖 AC-1..AC-10 的关键状态并保存截图。

## 验证计划

- `pnpm test` 中的 `find-replace.test.mjs`（纯函数）；`pnpm test:architecture`（若 store 行为有改动）。
- `pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm build`。
- `pnpm test:e2e -- tests/e2e/features/F-0012.spec.ts`，测试名带 `F-0012/AC-n`；覆盖查找、无结果、上下定位、单处替换、全部替换预览、过期、撤销、输入焦点、明暗主题和中英文。
- 真实使用：打开 60 分钟项目，查找一个反复出现的专有名词，预览全部替换，确认后撤销一次，核对时间戳、译文、EDL 和保存状态未变。
- Not run 时必须写明原因；mock 只能覆盖 UI 状态，不能替代真实保存/重开验证。

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | 入口、Cmd/Ctrl+F、`{current}/{total}`、空查询 |
| AC-2 | 纯文本、默认不区分大小写、中文按字符、正则开关不提供 |
| AC-3 | 上一/下一处、滚动、`aria-current`、无结果文案 |
| AC-4 | 单处替换、空替换预览、时间戳/ID/译文/EDL 不变 |
| AC-5 | 全部替换预览、命中数、确认/取消、查询变化失效 |
| AC-6 | 提交前基准比较、过期文案、禁用重复、失败重试 |
| AC-7 | `batchUpdateText` 一次操作、一次撤销、沿用项目保存 |
| AC-8 | `data-find-input`、`isComposing`、Esc 关闭、平台快捷键显示 |
| AC-9 | 只搜索未删除原文；不重排 wordChunks；保持 `edlWordProjection` 门禁 |
| AC-10 | 切换视频/关闭清空、迟到预览失效、60 分钟性能、加载/失败文案 |

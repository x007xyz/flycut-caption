---
id: F-0025
stage: 04-test-report
status: draft
approved_by:
approved_at:
---

# F-0025 字幕关键词强调：测试与验收

验收在代码与测试提交 `50d82cd` 上进行；本报告随后作为文档提交，不改变代码与测试。

> 技术设计和开发阶段由 agent 连续推进、自动确认；维护者在这里一并审阅。

## 设计与实现摘要

在 F-0028 共用 Canvas 2D 图形层上增加关键词强调，预览与 Host Skia 导出共用同一份排版：

- **数据模型与偏移安全**（`shared/text/keywords.ts`、`src/types/subtitle.ts`）：关键词存为原文中的 `start/end` 字符区间加文本快照，原文变化时 `reconcileChunkKeywords` 丢弃不再匹配的区间，绝不把旧偏移套到新原文。
- **混排渲染**（`shared/subtitle-graphics/`）：关键词支持换色、放大与底色，放大后按实际字号预留宽度并在排版时参与换行计算；`frameKey` 计入关键词状态，预览与导出都走同一份 `drawFrame`。
- **手动标记**（`SubtitleItem.tsx`）：主字幕划选后出现「标为关键词 / Mark keyword」，或点开分词条单击/Shift 连选；已标记词以标签展示并可一键移除。变更只写 `keywords` 字段（`cuts = false`），原文、时间戳与 EDL 不变。
- **AI 推荐**（`server/plugins/text.ts`、`useKeywordRecommendation.ts`、`KeywordEmphasisPanel.tsx`）：独立 `text.suggestKeywords` RPC，只发送字幕文本与模型 configId；Host 与前端双重校验（`base` 指纹、id 集合、子串必须逐字命中、数量上限），候选先进入审阅层，逐个勾选/排除后一次确认，走 `applyKeywordBatchWithPersistence` 保存并在失败时回滚。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| 推荐结果暂存层 | 候选只留在 hook 的 `candidates` 状态，确认前不写 store、不进导出 | 未确认内容不得进入正式字幕与成片 | AC-3、AC-7 |
| 分批与基数指纹 | 每批 20 条 / 2400 字符；`createKeywordBase` 对 id+原文做确定性指纹 | 控制单次请求体积，且审阅期间原文变化能立即识别 | AC-3、AC-4、AC-8 |
| 标记不改剪辑 | `setChunkKeywords/batchSetKeywords` 以 `cuts = false` 提交，只改样式相关字段 | 关键词是强调，不是剪辑，不能影响时间轴或导出范围 | AC-1 |
| 保存失败回滚 | Host 保存失败且无后续改动时回滚 chunks 与撤销栈，审阅结果保留可重试 | 失败不能留下半写入状态，也不能丢失用户已勾选的候选 | AC-8 |
| 入口位置 | 除编辑器工具条外，字幕样式面板的「AI 推荐关键词」也通过 `flycut:open-keyword-recommend` 事件打开同一面板 | 两处都是用户会先想到的地方，复用同一实现 | AC-5 |

## 验收标准逐条结果

| AC | 目标平台 / 环境 | 验证方式、用例与命令 | 证据或未跑原因 | 结果 |
|---|---|---|---|---|
| AC-1 | Web Chrome + 架构测试 | `pnpm test:architecture`（关键词区间切换、历史撤销、原文不变）；E2E「F-0025/AC-1 AC-5 AC-6 inline token marking persists without changing text or timestamps」 | 标记/取消只改样式；原文 textarea 值、时间戳与 EDL 未变；可撤销 | ✅ 通过 |
| AC-2 | 架构测试（Skia 排版 + 条带） | `tests/architecture/keyword-emphasis-f0025.test.ts`「keyword emphasis keeps identical wrapping and band bounds within 2px in all three aspects」 | 1920×1080 / 1080×1920 / 1080×1080 三种画幅换行行数与文本一致，条带与全帧包围盒宽高差 ≤ 2px | ✅ 通过 |
| AC-3 | Web Chrome | E2E「F-0025/AC-3 AC-4 AC-6 AC-7 AC-8 recommendation preflight, progress, review, apply and stale guard」 | 发送前显示模型与范围；候选可逐个勾选/排除；确认前不写正式数据；未确认时取消为零变更 | ✅ 通过 |
| AC-4 | 架构测试 + Web Chrome | `tests/architecture/keyword-emphasis-f0025.test.ts`「keyword ranges are mapped onto display text and the export clock without rewriting cues」；E2E stale 分支 | 标点剥离后区间仍正确映射；原文变更后旧偏移不套用；重开保留人工标记与样式 | ✅ 通过 |
| AC-4 | 真实 Host Skia + FFmpeg 导出三段视频 | 三种画幅各导出一次并检查成片像素 | 本 worktree 未运行完整 FFmpeg 导出（另见下方 ⏸ 项）；排版与条带已在 Skia 层验证 | ⏸ Not run |
| AC-5 | Web Chrome | E2E 空态用例与 `keyword-empty、keyword-no-model` 分支 | 无字幕显示「暂无内容 / Nothing here yet」；无模型给设置入口且手动标记可用；已有编辑不中断 | ✅ 通过 |
| AC-6 | Web Chrome | E2E 处理中/取消分支 | 「正在处理…」与批次进度可见，重复提交被禁用，可取消 | ✅ 通过 |
| AC-7 | Web Chrome + Host | E2E 应用完成分支 + `projects.saveVideoEdits` 断言 | 只有 Host 保存成功才显示「已完成 / Completed」，写入内容含关键词；重开一致 | ✅ 通过 |
| AC-8 | Web Chrome | E2E 失败与 stale 分支 | 请求失败显示原因并可重试/返回；审阅期间原文变化显示「内容已更新，请重新检查」并阻止应用 | ✅ 通过 |
| AC-9 | Web Chrome（中英文 × 明暗） | `PW_PORT=5292 pnpm e2e:evidence F-0025` | 12/12 通过，20 张截图入库，录屏仅本地 | ✅ 通过（Web） |
| AC-9 | 真实外部 AI 服务 | 用真实 OpenAI 兼容模型对 60 分钟口播推荐关键词并评估准确率/成本 | 环境无授权外部模型 API Key 与计费账号 | ⏸ Not run |
| AC-9 | 真实 Tauri 桌面端 | 打包后的 macOS/Windows 应用内完成标记与导出 | 本 worktree 未构建桌面安装包 | ⏸ Not run |

## 界面证据

由 `PW_PORT=5192 pnpm e2e:evidence F-0025` 生成，覆盖 `light/dark × zh/en`；`screenshots/` 已入库，`recordings/` 仅留本地。

| 界面 | 状态 | AC | 截图 |
|---|---|---|---|
| 字幕行 | 行内分词条 + 已标记标签 | AC-1 | `inline-mark-{light,dark}-{zh,en}.png` |
| AI 推荐面板 | 发送前确认（模型 + 范围） | AC-3 | `preflight-{light,dark}-{zh,en}.png` |
| AI 推荐面板 | 候选审阅 | AC-3、AC-7 | `review-{light,dark}-{zh,en}.png` |
| AI 推荐面板 | 已完成 | AC-7 | `done-{light,dark}-{zh,en}.png` |
| AI 推荐面板 | 空态 | AC-5 | `empty-{light,dark}-{zh,en}.png` |

## 回归检查

全部运行于提交 `50d82cd`：

- `pnpm lint` ✅
- `pnpm tsc -b --noEmit` ✅
- `pnpm check:host` ✅
- `cargo check --manifest-path src-tauri/Cargo.toml` ✅
- `pnpm test` ✅：112 tests，107 passed，0 failed，5 skipped（未下载的额外 ASR 模型）
- `pnpm test:architecture` ✅：147/147 passed
- `PW_PORT=5292 pnpm e2e:evidence F-0025` ✅：12/12 passed，20 张截图
- Red check ✅：把 `reconcileChunkKeywords` 的文本一致性判断改为恒真后，关键词区间过期用例立即失败于旧偏移被套用到新原文；恢复后重新全绿

## 发现的问题

- 关键词放大后若只加字号不参与测量，会与相邻文字重叠；现按 `resolveKeywordMetrics` 的实际宽度参与换行与包围盒计算，三种画幅均无裁切。
- 终止 `historyStore` 提交时曾误把它当作普通文本更新；现固定 `cuts = false`，确保只影响样式。

## 结论

数据模型、混排排版、手动标记、AI 推荐审阅与保存回滚在本地自动化与 Web 端到端均通过（AC-1 至 AC-8 与 AC-9 的 Web 部分）。真实外部 AI 服务、真实 FFmpeg 成片导出与 Tauri 桌面实机受环境限制，如实记为 `⏸ Not run`。

本报告等待维护者审阅确认；未自行执行 `pnpm feature approve`。


---
id: F-0013
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-09
---

# F-0013 AI 纠错按差异确认：设计

## UI / UX

### 入口与组件

- 现有 SubtitleList 的「纠错 / Correct」按钮改为打开 CorrectionReviewPanel，不再直接 batchUpdateText。
- CorrectionReviewPanel 位于字幕编辑器右侧栏，包含：模型/发送范围提示、开始纠错、批次进度、取消、待确认列表、预览切换、确认/取消。
- 字幕行 SubtitleItem 在待确认层显示新增/删除/替换差异；差异用文字或图标标记，不用剪辑的红色删除区间。
- 统一历史入口 CutHistoryPanel 增加「文字操作」行，和剪辑记录并列展示，可预览/回退。

### 状态与文案

| 状态 | 界面 | 文案 |
|---|---|---|
| 未配置模型 | 设置入口，编辑仍可用 | 请先配置AI模型 / Configure an AI model first |
| 发送前 | 当前视频未删除原文范围与目标模型 | 将发送 {count} 条字幕 / Sending {count} subtitles |
| 生成中 | 批次进度、取消 | 正在生成纠错建议… / Generating corrections… |
| 部分完成 | 已生成预览保留，明确标为部分结果 | 仅检查已完成结果 / Review completed results only |
| 结果无效 | 整批提示，可重试/排除 | 纠错结果无效 / Invalid correction result |
| 待确认 | 差异标记、预览切换、统一确认 | 预览，尚未应用 / Preview, not applied |
| 无差异 | 确认禁用 | 没有需要确认的修改 / No changes to review |
| 过期 | 不部分提交 | 原文已更新，请重新检查 / Original subtitles changed. Review again. |
| 应用失败 | 保留预览与正式旧结果 | 应用失败，请重试 / Cannot apply. Try again. |
| 已应用 | 一条文字操作记录 | 已应用 {count} 处修改 / Applied {count} changes |

### 操作

- 有效差异默认纳入待确认版本；每条可「保留原文 / Keep original」或「恢复AI建议 / Restore AI suggestion」。
- 预览内可直接编辑建议文本，立即更新差异和数量，标「已手动调整 / Manually adjusted」。
- 统一确认一次；确认前所有条目必须通过 ID、原文基准和目标身份校验。
- 取消时若含手动修改，先确认「放弃未应用的修改？ / Discard unapplied changes?」。

## 技术方案

### 涉及的子系统

- src/hooks/useAI.ts、src/services/aiService.ts：改为返回待确认结果，不直接写 store。
- src/stores/historyStore.ts：待确认纠错层、一次文本提交、文字操作历史。
- shared/text/OpenAICompatibleEngine.ts、server/plugins/text.ts：批次校验和错误返回。
- src/components/SubtitleEditor/**、CutHistoryPanel：差异预览、确认、历史。
- shared/projects.ts、server/projects/store.ts、src/services/projectService.ts：持久文字操作历史。

### 方案

1. 新增 CorrectionSuggestion 类型：id、before、after、selected、adjusted、batchId。
2. CorrectionReviewPanel 本地持有 phase、batches、preview/source 切换和手动调整；不写正式字幕。
3. AI 返回按批校验：ID 与请求一一对应、无缺条/多条/重复/未知 ID、空结果失败；失败批可重试或排除。
4. 取消后迟到结果用 runId 丢弃；切换视频/项目时清空。
5. 统一确认：比较每条 before 与当前 chunks 文本及 EDL/字幕版本；任何过期整批不提交。通过后一次 batchUpdateText 提交最终预览，只改 text，不改时间戳、secondText、wordIds 或 EDL。
6. 文字操作历史：ProjectEdits 增加可选 textHistory 数组，记录 id、at、kind（ai-correction/history-restore）、before/after 文本快照。格式 3 的旧项目没有该字段时按空数组读取；写入保持可选字段，不改变现有字段语义。
7. historyStore 增加 textHistory 和 applyTextBatch/restoreTextHistory；一次确认只写一条记录。CutHistoryPanel 合并展示剪辑和文字记录，回退文字记录不撤销后来的剪辑，回退剪辑不撤销后来的文字校对。

### 接口与数据

- 不新增 RPC，继续用 text.start；只增加结果校验和 pending 层。
- ProjectEdits.textHistory 为可选字段，单项目最多保留 100 条，每条 before/after 只存受影响字幕的 id+text；超出时丢弃最旧记录。
- 文字历史不进入恢复副本的正式项目格式之外；恢复副本仍只保存未保存编辑。未确认纠错不进入项目、恢复副本或导出。

### 备选方案与取舍

| 方案 | 结论 |
|---|---|
| 模型返回即 batchUpdateText | 不可检查、不可局部修正，违反 AC-5/AC-7 |
| 只存内存历史 | 重开项目丢失，违反 AC-9 |
| 项目格式升到 4 | 需要迁移所有项目；本需求只增加可选字段，先用格式 3 扩展，若维护者要求严格版本化再升 4 |
| 与剪辑历史共用 CutRecord | 文字和 EDL 语义不同，容易误回退；使用独立 TextRecord、统一入口展示 |

## 架构决策

建议新增 ADR：项目格式 3 的可选 textHistory 扩展、100 条上限、文字/剪辑历史分离。实现前由维护者确认是否接受「不升格式版本」。

## 自行决定的事项

- 文字历史用可选字段而不是格式 4；这是为了不迁移所有旧项目。请维护者在验收时确认。
- 纠错预览只保存在当前编辑会话；未确认内容不写恢复副本。

## 风险与回退

- 旧客户端读到新的 textHistory 会在保存时丢弃它；同一版本内不存在旧客户端。跨版本兼容需在发布说明中写明。
- 100 条上限可能截断历史；超出时保留最近记录并显示数量，不假装完整。
- 若维护者要求格式 4，需要单独的迁移 ADR 和迁移测试。

## 实现清单

- [x] 1. 新增 CorrectionSuggestion/TextRecord 类型、批次校验纯函数与测试。
- [x] 2. 改造 useAI/aiService 返回待确认结果，不直接 batchUpdateText；取消、迟到、批次重试/排除。
- [x] 3. 新增 CorrectionReviewPanel 与 SubtitleItem 差异标记；手动调整、保留原文、预览切换、统一确认。
- [x] 4. historyStore 增加 textHistory/applyTextBatch/restoreTextHistory；CutHistoryPanel 合并展示文字与剪辑记录。
- [x] 5. ProjectEdits 增加可选 textHistory，保存/读取/上限/回退；确认不破坏格式 3。
- [x] 6. 中英文、明暗主题、冲突/失败/取消 E2E；真实 API 与重开/历史回退验证。

## 验证计划

- 单元：批次 ID 一一对应、缺条/多条/重复/空结果、before 过期、textHistory 上限和回退。
- E2E：未配置模型、生成中取消、部分结果、无效批次、手动调整、保留原文、统一确认、过期、失败、重开历史和回退；明暗/中英文。
- 真实 API：含已知错误的口播，至少 5 条手改 + 5 条保留原文，确认结果等于最终预览；重开和回退可复现。
- 回归：pnpm test、pnpm test:architecture、pnpm check:host、lint、tsc、build。

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | 未配置模型状态 |
| AC-2 | 发送范围、原文基准、ID/版本 |
| AC-3 | 批次进度、取消、部分结果 |
| AC-4 | 严格校验、失败批重试/排除 |
| AC-5 | 差异标记、预览切换、统一确认 |
| AC-6 | 手动调整、保留/恢复、焦点保护 |
| AC-7 | 统一确认、过期、幂等 |
| AC-8 | 取消、失败、切换隔离 |
| AC-9 | textHistory、统一历史、回退冲突 |
| AC-10 | 真实 API、两端、重开验证 |

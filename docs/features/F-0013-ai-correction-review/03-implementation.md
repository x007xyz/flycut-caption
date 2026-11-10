---
id: F-0013
stage: 03-implementation
status: approved
approved_by: auto
approved_at: 2026-11-09
---

# F-0013 AI 纠错按差异确认：开发记录

## 分支与 PR

- 分支：当前工作区（未新建分支）
- PR：未创建；按要求未执行 git commit/tag/release

## 进度

| 日期 | 清单项 | 提交 | 检查 |
|---|---|---|---|
| 2026-11-09 | 1. CorrectionSuggestion/TextRecord 类型、批次校验与纯函数测试 | 未提交 | `node --test tests/text-correction.test.mjs` ✅ 6/6；`pnpm tsc -b --noEmit` ✅ |
| 2026-11-09 | 2. useAI/aiService 返回待确认结果；取消、迟到、重试/排除 | 未提交 | F-0013 Playwright 12/12 ✅（普通模式）；无模型、无效批次、生成中取消/部分结果 E2E ✅ |
| 2026-11-09 | 3. CorrectionReviewPanel、SubtitleItem 差异、预览/手改/保留原文/统一确认 | 未提交 | F-0013 Playwright 12/12 ✅（明暗 × 中英文） |
| 2026-11-09 | 4. historyStore textHistory/applyTextBatch/restoreTextHistory；统一历史面板 | 未提交 | `tests/architecture/text-history-f0013.test.ts` ✅ 3/3；F-0013 历史重开/回退 E2E ✅ |
| 2026-11-09 | 5. ProjectEdits 可选 textHistory、保存/读取/100 条上限、格式 3 扩展 | 未提交 | `tests/architecture/text-history-f0013.test.ts` ✅；`pnpm check:host` ✅ |
| 2026-11-09 | 6. 冲突/失败/取消 E2E、重开与历史回退 | 未提交 | F-0013 Playwright 12/12 ✅（普通模式）；真实 API ❌ 未运行（无真实模型配置） |

## 自行决定的事项

- `CorrectionSuggestion` 在设计的 id/before/after/selected/adjusted/batchId 之外增加了 `aiText`，用于「保留原文」后恢复 AI 原始建议，不依赖重新请求模型。
- 审阅状态放在 `src/hooks/useCorrectionReview.ts`，不写历史 store 的正式通道；`historyStore` 只接收一次确认后的 `applyTextBatch`，避免未确认内容进入项目。
- `textHistory` 加入 `RecoveryContent`（前端崩溃恢复副本），否则恢复副本写回时会丢掉已确认的文字历史；未确认审阅仍不进入副本。
- 项目格式保持 3，`textHistory` 为可选字段；Host 的 `ProjectStore` 读写都截断到最近 100 条，防止旧客户端或异常数据无限增长。
- 批次大小在共享纯函数中固定为 25 条/2400 字符，按字幕顺序切分；没有新增 RPC，仍调用现有 `text.start`。
- `src/runtime/client.ts` 对 `HostSessionController` 持有的连接使用不关闭的借用视图。F-0014 的 Runtime 在 React StrictMode 首次挂载/卸载时不能关闭共享连接，否则所有项目 E2E 都会在打开项目时得到 `SessionClosedError`。
- `tests/e2e/lib/mockHost.ts` 的假 WebSocket 现在发送 `host/ready` 和空的 `jobs/snapshot`，匹配 F-0014 新连接握手；这是测试替身必需的兼容修正。
- 快捷键在输入框、textarea、contenteditable 或输入法组合期间不再抢撤销/重做，保留原生文本撤销。

## 与设计的偏差

- CorrectionReviewPanel 挂在 SubtitleEditor 右侧同一栏、SubtitleList 顶部（字幕编辑区域内），没有另建独立右栏；行为与设计一致，布局复用现有编辑器宽度。
- 预览中的手动修改、保留原文、恢复 AI 建议只改 hook 里的待确认层；正式字幕、时间戳、secondText、wordIds、EDL 和剪辑历史在确认前不变。
- 统一历史入口里文字记录的预览在历史面板内展开前后文本；剪辑记录仍复用 `historyPreview` 的 EDL 预览。
- 未新增 ADR 文件。`textHistory` 是格式 3 的可选扩展，这一取舍已按维护者本次实现指令执行；如果维护者要求严格版本化，应单独补 ADR 和格式 4 迁移。

## 遗留问题

- **真实 API 未运行**：没有可用的真实 OpenAI 兼容模型配置。AC-10 要求对含已知错误的口播执行真实请求、至少 5 条手改 + 5 条保留原文、重开和回退；本轮只完成 mock Host E2E。这也是 02-design 清单第 6 项仍未勾选的原因。
- **证据运行未全绿**：`pnpm e2e:evidence F-0013` 本次 6/12 通过、6/12 超时；失败都是等待 `选择语言` 或 `correction-open` 超时，说明录屏/并行下页面尚未完成编辑器挂载，而不是批次校验或文字应用断言失败。普通 `pnpm exec playwright test tests/e2e/features/F-0013.spec.ts` 已 12/12 通过。现有截图和部分录屏在 `screenshots/`、`recordings/`，需要重跑证据。
- **全量架构测试被其他改动阻塞**：`pnpm test:architecture` 69/70，唯一失败是 `F-0002/AC-5 AC-6` 的媒体 Range 响应缺少 `accept-ranges: bytes`，属于 F-0014/服务响应头范围；F-0013 新增的 3 个架构测试全部通过。
- **未执行**：`pnpm feature review F-0013`；因为清单第 6 项未完成，且 03 按当前状态保留 draft。

## 已运行检查

- `pnpm tsc -b --noEmit` ✅
- `pnpm lint` ✅
- `pnpm check:host` ✅
- `pnpm test` ✅ 93 passed / 3 skipped / 0 failed
- `tests/text-correction.test.mjs` ✅ 6/6
- `tests/architecture/text-history-f0013.test.ts` ✅ 3/3
- F-0013 Playwright（普通模式）✅ 12/12

## 未完成/失败项

- 真实 API 实测：Not run（无真实模型配置）。
- 最终验证：pnpm tsc -b --noEmit ✅、pnpm lint ✅、pnpm check:host ✅、pnpm test 93 passed/3 skipped、pnpm test:architecture 81/81、pnpm build ✅。
- F-0013 Playwright 12/12；pnpm e2e:evidence F-0013 12/12（28 张截图、12 段录屏）。
- 全量页面回归 F-0002/0003/0004/0005/0006/0007/0012/0013/0028 189/189。
- 唯一未完成：真实 OpenAI 兼容模型 API 的 AC-10 实测（没有真实模型配置）；其余 AC 由 mock Host 页面测试和架构测试覆盖。
- 真实 API（DashScope qwen-plus）：10 句合成口播 → 10 条纠错建议；保留前 5 句原文，应用后 5 句（分享/帮助/再见/频道/评论），最终 edits 与 textHistory 均记录 5 处修改。
- 真实页面/重开历史：首个真实 API 项目应用 3 处、保留 2 处；重开后字幕为最终版本，操作历史显示「AI 纠错」，回退后原文恢复。

---
id: F-0009
stage: 04-test-report
status: review
approved_by:
approved_at:
---

# F-0009 去口癖语义层实现：测试与验收

验收代码固定在 commit bd12520（最终代码提交）；本报告与截图由后续文档提交固定。

> 技术设计和开发阶段已由 agent 连续推进并自动确认；请维护者在本次 04 审阅中一并查看设计与实现。

## 设计与实现摘要

F-0009 在现有 F-0007 规则去口癖旁增加显式“语义去口癖”入口。规则按钮和规则候选行为保持不变；语义分析必须先经过发送范围、目标 Host AI 配置和远程外发提示。语义请求只携带 F-0056 的 configId 和最多 20 个目标句的窗口，Host 通过 aiSettings.resolve 读取已保存模型和密钥，RPC/job 不含明文 Key。

模型只返回词 ID；Host 从权威字词表派生时间并整批校验未知/重复/越界/不连续/半句/重叠/非 deletable 范围。客户端逐批运行、显示总批次/完成数、支持取消和只重试失败批次。成功、失败和取消结果合并进 F-0005/F-0007 的同一 pendingSuggestions；语义候选默认不勾选，确认前不写正式 EDL/导出，确认时一次写 EDL、字词投影与剪辑历史。

新增 [ADR-0010](../../20-architecture/adr/0010-semantic-cut-word-ranges.md)，状态 proposed。已合入 F-0056 的 Host AI configId/secret 实现，未改变其已验收行为。实现顺序、长口播窗口调整和 E2E 英文修复等偏差见 [03-implementation.md](03-implementation.md)。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| 规则/语义入口 | 两个独立按钮；规则层无需模型 | 保持 F-0007 已验收行为，避免未请求就外发文本 | AC-1、AC-2 |
| 语义发送范围 | 只分析有易混标记、改口、重复或残句线索的句子；间隔 ≤4 句合并，每窗最多 20 个目标句，前后各 1 个上下文句 | 对齐 F-0008“规则默认、LLM 可选语义 pass”，限制成本和外发面 | AC-2、AC-10 |
| 长口播 | 不设任意窗口总数上限；目标词数只统计 deletable 目标句 | 两段真实素材分别产生 30/26 批，不能因视频长直接失败 | AC-2、AC-10 |
| 双 base | 模型/Host 用 SHA-256 base；historyStore 用可选 stateKey 做精确 JSON 快照校验 | 保持 F-0005/F-0007 既有 base 兼容，同时满足 F-0008 的 opaque base | AC-7、AC-8 |
| 语义默认选择 | 所有语义候选默认不勾选；confidence 只显示 high/medium/low | F-0008 没有真实质量门槛，不能把等级伪装成概率 | AC-5、AC-8 |
| 精确重叠 | 同范围跨规则/语义合并并显示两个来源；部分重叠仍分别展示，区间并集只扣一次 | 保留解释能力，避免重复删除 | AC-5、AC-8 |
| 声音试听 | 沿用 F-0007 单条剪前/剪后试听和集合预览 | 统一人工确认流程，不另建预览通道 | AC-6 |
| 远程隐私 | 只传 configId；Host 预检显示目标模型/文本范围，远程 Host 需主动勾选确认 | F-0056 已保存密钥，Key 不再经浏览器 RPC | AC-2、AC-9 |

## 验收标准逐条结果

| AC | 验证方式 | 证据 | 结果 |
|---|---|---|---|
| AC-1 | E2E no-model + 规则按钮；规则单测/架构回归 | tests/e2e/features/F-0009.spec.ts「AC-1 AC-2 no-model…」；tests/filler-rules.test.mjs 7/7；F-0007 filler-export 2/2 | ✅ 中文明暗通过；English E2E 最后一次完整复跑待父代理 |
| AC-2 | Host configId-only 架构测试；预检/远程确认 E2E；请求载荷检查 | semantic-filler-f0009.test.ts「AC-2 AC-4 AC-9 Host resolves…」「AC-2 AC-9 semantic RPC accepts configId only…」；模型用户载荷不含时间戳/Key | ✅ |
| AC-3 | 批次队列单测；E2E 进度、取消、部分失败重试 | semantic-filler-queue.test.mjs 2/2；F-0009 E2E「progress, invalid retry…」「cancellation…」 | ✅ 中文明暗通过；英文最终证据待复跑 |
| AC-4 | 纯协议严格拒绝测试；Host 坏 JSON/未知 ID；invalid UI | semantic-fillers.test.mjs 7/7；architecture 3/3 | ✅ |
| AC-5 | 来源/类别/原因/high-medium-low UI；精确去重单测；红标 | semantic-fillers.test.mjs crossing-source merge；review/provenance 截图 | ✅ 中文明暗通过；英文截图待复跑 |
| AC-6 | 单条试听、集合预览、空结果；pending 不写正式 EDL | F-0009 architecture 断言 pending/preview 前后 EDL/cutHistory 不变；F-0009 E2E preview/empty | ✅ |
| AC-7 | SHA base 随文本/时间戳/EDL 变化；迟到/过期不应用 | semantic-fillers.test.mjs「the base changes…」；F-0009 E2E stale disable；Red check 失败于 Suggestions are outdated | ✅ |
| AC-8 | 原子确认、一次历史、保存失败保留、拒绝不改正式项目 | F-0009 architecture「SHA base plus exact history snapshot and apply once」；F-0009 E2E apply/save-failed | ✅ |
| AC-9 | configId-only、RPC/job 无 Key、错误脱敏；F-0005/F-0007 历史回退回归 | architecture Host test；F-0056 全组架构测试；F-0005/F-0007 回归测试 | ✅ |
| AC-10 | 两段真实转写窗口；本地真实 HTTP OpenAI-compatible Host fixture；真实模型质量 | BWgFrY91F_I: 8321 words → 30 batches / 279 target sentences / 4670 target words；3UegVxMFyeo: 6693 words → 26 batches / 275 / 3884；Host 真实 HTTP fixture 通过 | ⏸ 质量项 Not run：没有可外发的用户模型与素材授权；fixture 不代表模型准确率/成本 |

## 界面证据

官网命令曾生成 12 个状态 × 中英/明暗，但视觉检查发现当时的 en 截图实际仍是中文（URL lang 未切界面），这些 18 张错误英文截图和对应录屏已删除。当前保留 18 张中文明暗截图；英文 18 张与最终录屏必须在 5173 交还后由父代理用真实语言菜单切换重新运行 pnpm e2e:evidence F-0009 生成。

| 界面 | 状态 | AC | 截图中文明暗 | 录屏 |
|---|---|---|---|---|
| 去口癖面板 | no-model、规则仍可用 | AC-1 | screenshots/no-model-light-zh.png、screenshots/no-model-dark-zh.png | 待复跑 |
| 语义预检 | 模型/范围/媒体不上传/远程确认 | AC-2 | screenshots/preflight-light-zh.png、screenshots/preflight-dark-zh.png | 待复跑 |
| 批次运行 | 进度与取消 | AC-3 | screenshots/cancelled-light-zh.png、screenshots/cancelled-dark-zh.png | 待复跑 |
| 无效/部分失败 | 分析结果无效与失败批次重试 | AC-3、AC-4 | screenshots/partial-invalid-light-zh.png、screenshots/partial-invalid-dark-zh.png | 待复跑 |
| 语义候选 | 来源、类别、原因、可信等级、原文 | AC-5 | screenshots/review-light-zh.png、screenshots/review-dark-zh.png | 待复跑 |
| 临时预览 | Preview, not applied | AC-6 | screenshots/provenance-preview-light-zh.png、screenshots/provenance-preview-dark-zh.png | 待复跑 |
| 过期 | 建议已过期、应用禁用 | AC-7 | screenshots/stale-light-zh.png、screenshots/stale-dark-zh.png | 待复跑 |
| 保存失败 | 保留候选和正式项目 | AC-8 | screenshots/save-failed-light-zh.png、screenshots/save-failed-dark-zh.png | 待复跑 |
| 语义为空 | 没有语义口癖 | AC-6 | screenshots/empty-light-zh.png、screenshots/empty-dark-zh.png | 待复跑 |

已人工查看 no-model、preflight、review、stale 代表截图：状态与关键文字可见；英文截图问题即由此发现并修正测试。

## 回归检查

- pnpm lint ✅
- pnpm tsc -b --noEmit ✅
- pnpm check:host ✅
- pnpm build ✅
- cargo check --manifest-path src-tauri/Cargo.toml ✅（先使用自包含 Node 打包 Host）
- pnpm test ✅：101 passed / 11 skipped / 112 total。跳过项是本机缺少既有的 FunASR 模型/资源，不是 F-0009 测试。
- pnpm test:architecture ✅：100 passed / 0 failed。先补齐本地复用 FSMN-VAD 模型文件后全绿。
- F-0009 targeted architecture ✅ 3/3
- F-0007 rule tests ✅ 7/7；F-0007 export/confirmation ✅ 2/2
- F-0009 Playwright：中文 zh 明暗 6/6 通过；加入真实 English 语言切换后，最新未中止运行达到 10/12，两个失败均为测试断言未接受现有“Repeated word”英文文案，该断言已修正；最终 12/12 和 evidence 尚未复跑（父代理暂停 5173 给 F-0024）。
- pnpm e2e:evidence F-0009：早先 12/12 生成 36 张截图/12 录屏，但 en 截图实际为中文，证据已删除；当前不能用它宣称英文验收。

## 发现的问题

- 视觉检查发现 lang URL 参数不能让现有界面切到 English；已改为操作语言菜单。这个问题说明仅断言测试名称/URL 不足以证明中英文状态。
- 真实长转写首次触发了人为 100 窗口上限；已取消上限并改为受控近邻分组。同时 Host 新增 non-deletable 上下文保护。
- SHA base 与 historyStore 原 JSON base 语义不同；以可选 stateKey 兼容，没有改 F-0005/F-0007 共用 batch.base 解释。
- 外部模型质量、误删率、成本和默认类别仍没有实测数据。

## 结论

需要父代理完成最后的中英文 12 例 E2E 与 e2e:evidence 复跑，并补真实用户模型的质量验收后，才能确认 AC-10。代码、静态检查、单元/架构、Host configId/密钥边界、人工确认与中文明暗界面证据已通过；请维护者在最终 E2E 结果补齐后再确认本报告。


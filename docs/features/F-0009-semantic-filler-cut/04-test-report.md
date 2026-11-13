---
id: F-0009
stage: 04-test-report
status: approved
approved_by: zhangxiang.chen
approved_at: 2026-11-13
---

# F-0009 去口癖语义层实现：测试与验收

验收固定 commit 5d4e2b8；产品代码自 bd12520 后未再变化，5d4e2b8 只提交了本次证据实际使用的 E2E reload 后语言切换修复。

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
| AC-1 | E2E no-model + 规则按钮；规则单测/架构回归 | tests/e2e/features/F-0009.spec.ts「AC-1 AC-2 no-model…」；tests/filler-rules.test.mjs 7/7；F-0007 filler-export 2/2 | ✅ 中英文明暗全部通过 |
| AC-2 | Host configId-only 架构测试；预检/远程确认 E2E；请求载荷检查 | semantic-filler-f0009.test.ts「AC-2 AC-4 AC-9 Host resolves…」「AC-2 AC-9 semantic RPC accepts configId only…」；模型用户载荷不含时间戳/Key | ✅ |
| AC-3 | 批次队列单测；E2E 进度、取消、部分失败重试 | semantic-filler-queue.test.mjs 2/2；F-0009 E2E「progress, invalid retry…」「cancellation…」 | ✅ 中英文明暗全部通过 |
| AC-4 | 纯协议严格拒绝测试；Host 坏 JSON/未知 ID；invalid UI | semantic-fillers.test.mjs 7/7；architecture 3/3 | ✅ |
| AC-5 | 来源/类别/原因/high-medium-low UI；精确去重单测；红标 | semantic-fillers.test.mjs crossing-source merge；review/provenance 截图 | ✅ 中英文明暗全部通过 |
| AC-6 | 单条试听、集合预览、空结果；pending 不写正式 EDL | F-0009 architecture 断言 pending/preview 前后 EDL/cutHistory 不变；F-0009 E2E preview/empty | ✅ |
| AC-7 | SHA base 随文本/时间戳/EDL 变化；迟到/过期不应用 | semantic-fillers.test.mjs「the base changes…」；F-0009 E2E stale disable；Red check 失败于 Suggestions are outdated | ✅ |
| AC-8 | 原子确认、一次历史、保存失败保留、拒绝不改正式项目 | F-0009 architecture「SHA base plus exact history snapshot and apply once」；F-0009 E2E apply/save-failed | ✅ |
| AC-9 | configId-only、RPC/job 无 Key、错误脱敏；F-0005/F-0007 历史回退回归 | architecture Host test；F-0056 全组架构测试；F-0005/F-0007 回归测试 | ✅ |
| AC-10 | 两段真实转写窗口；本地真实 HTTP OpenAI-compatible Host fixture；真实模型质量 | BWgFrY91F_I: 8321 words → 30 batches / 279 target sentences / 4670 target words；3UegVxMFyeo: 6693 words → 26 batches / 275 / 3884；Host 真实 HTTP fixture 通过 | ⏸ 质量项 Not run：没有可外发的用户模型与素材授权；fixture 不代表模型准确率/成本 |

## 界面证据

父代理串行完成 pnpm e2e:evidence F-0009：12 passed（15.8s），36 张截图、12 段录屏。视觉检查发现 no-model 用例 reload 后语言回退，测试中已改为 reload 后重新选择 English，并完成修正后的 12/12 evidence（15.2s）。最终 36 张截图覆盖中英文和明暗主题，已提交；12 段录屏只在本地 recordings/，按约定不提交。

| 界面 | 状态 | AC | 截图（中英/明暗） | 录屏 |
|---|---|---|---|---|
| 去口癖面板 | no-model、规则仍可用 | AC-1 | screenshots/no-model-{light,dark}-{zh,en}.png | 本地 |
| 语义预检 | 模型/范围/媒体不上传/远程确认 | AC-2 | screenshots/preflight-{light,dark}-{zh,en}.png | 本地 |
| 批次运行 | 进度与取消 | AC-3 | screenshots/cancelled-{light,dark}-{zh,en}.png | 本地 |
| 无效/部分失败 | 分析结果无效与失败批次重试 | AC-3、AC-4 | screenshots/partial-invalid-{light,dark}-{zh,en}.png | 本地 |
| 语义候选 | 来源、类别、原因、可信等级、原文 | AC-5 | screenshots/review-{light,dark}-{zh,en}.png | 本地 |
| 临时预览 | Preview, not applied | AC-6 | screenshots/provenance-preview-{light,dark}-{zh,en}.png | 本地 |
| 过期 | 建议已过期、应用禁用 | AC-7 | screenshots/stale-{light,dark}-{zh,en}.png | 本地 |
| 保存失败 | 保留候选和正式项目 | AC-8 | screenshots/save-failed-{light,dark}-{zh,en}.png | 本地 |
| 语义为空 | 没有语义口癖 | AC-6 | screenshots/empty-{light,dark}-{zh,en}.png | 本地 |

已人工查看 no-model、preflight、review、stale 的代表截图；修正后英文预检确认显示 English，状态与关键文字可见。

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
- F-0009 Playwright：✅ 12/12，覆盖中英文和明暗主题。
- pnpm e2e:evidence F-0009：✅ 父代理 12 passed（15.8s）；修正 reload 后语言回退再验 12 passed（15.2s）；36 截图、12 本地录屏。

## 发现的问题

- 视觉检查发现 lang URL 参数不能让现有界面切到 English；已改为操作语言菜单。这个问题说明仅断言测试名称/URL 不足以证明中英文状态。
- 真实长转写首次触发了人为 100 窗口上限；已取消上限并改为受控近邻分组。同时 Host 新增 non-deletable 上下文保护。
- SHA base 与 historyStore 原 JSON base 语义不同；以可选 stateKey 兼容，没有改 F-0005/F-0007 共用 batch.base 解释。
- 外部模型质量、误删率、成本和默认类别仍没有实测数据。

## 结论

AC-1 至 AC-9 的代码、静态检查、单元/架构、中英文与明暗 E2E 和 evidence 均已通过。AC-10 的外部真实模型质量项仍为 Not run，需要维护者用授权模型与字词级基准补测；完成前本报告不能确认 AC-10。


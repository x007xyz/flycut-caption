---
id: F-0001
stage: 02-research
status: approved
approved_by: zhangxiang.chen
approved_at: 2026-11-08
---

# F-0001 中文口播转写质量基准：调研报告

## 验收范围与维护者确认

2026-11-08，维护者在获知其余三模型重跑、独立字词时间误差、最终推荐尚未完成后回复：「那确认吧」。按该上下文接受当前两模型文字评测及已披露缺项，结束本轮调研；不是把原计划全部实验标为通过。此前维护者已明确要求「把精校文案作为 确认版本」。

## 研究问题与结论

| 问题 | 本轮结论 | 限制 |
|---|---|---|
| 模型字错率 | SenseVoice汇总CER为6.29%，Paraformer 2023为7.20% | 精校文本源于SenseVoice，有来源偏差；其余三模型本轮未重跑 |
| 语气词召回 | 两者均146/148=98.65%；额外语气词分别12和44个 | 文本对齐口径，不是±0.5秒时间窗口召回 |
| 字词时间误差及是否需要校准 | 没有独立时间真值，不能量化MAE/p95或确认必须强制对齐 | 原ASR时间不能测自身误差，维持未验证 |
| 60分钟稳定性 | 2026-11-05已记录两模型完整跑完，分别286秒和243秒，峰值约2.4–2.5GB | 本轮未重跑，不外推任意长音频 |
| 默认推荐及可用标准 | 本次维持现有默认，SenseVoice可优先试用；Paraformer较快但插入较多 | 不宣称无偏最优模型；本轮不确立新的全局质量门槛 |

## 已确认文字基准结果

两份确认文本共1028句，直接取维护者接受的精校JSON，来源路径及SHA-256在参考文件元数据中。status为reviewed表示文字被接受，不表示agent逐句听校。原媒体与精校源文件不改写。

| 样本 | 模型 | CER | 文本对齐语气词召回 | 额外语气词 | 耗时 | 峰值内存 |
|---|---|---|---|---|---|---|
| coscup-3UegVxMFyeo | SenseVoice | 4.37% | 93/94 | 6 | 142.0s | 1.96 GiB |
| coscup-3UegVxMFyeo | Paraformer 2023 | 5.54% | 92/94 | 12 | 119.2s | 1.94 GiB |
| coscup-BWgFrY91F_I | SenseVoice | 8.00% | 53/54 | 6 | 112.0s | 1.68 GiB |
| coscup-BWgFrY91F_I | Paraformer 2023 | 8.67% | 54/54 | 32 | 98.5s | 1.64 GiB |

CER使用精确Levenshtein距离，汉字按字、英文按词，繁简/大小写等归一化规则沿用referenceDraft；去掉标点与单字语气词。汇总按参考词元数加权，不简单平均百分比。SenseVoice文字来源偏差在所有模型比较中保留说明。

## 可复现命令与证据

- 就绪检查：pnpm eval:asr --check-reference。
- 本轮重跑：pnpm eval:asr --models sensevoice-small-int8-zh-en-ja-ko-yue-2024-07-17,paraformer-zh-int8-2023-09-14。
- 指标测试：node --test tests/asr-eval.test.mjs。
- 本地原始输出在test-results/asr-eval/cache/，汇总在report.json与report.md，共4次成功的真实识别。
- 参考文本：[3UegVxMFyeo](../../../../tests/fixtures/asr-reference/coscup-3UegVxMFyeo.md)、[BWgFrY91F_I](../../../../tests/fixtures/asr-reference/coscup-BWgFrY91F_I.md)。
- [完整历史实验记录](research-history.md)及[文字参考确认说明](reference-review.md)。

## 对后续需求的影响

- 本轮验收解除F-0001的流程依赖门禁，但没有补齐证据的专用条件仍有效。
- F-0018不能把本报告当作全模型无偏排名；新推荐范围及质量门槛须在自身设计/验收中补证。
- F-0019、F-0020、F-0021仍需各自验证热词、断句和说话人能力，本轮没有测过这些能力。
- F-0007、F-0008、F-0024维持真实时间戳校验、人工确认和降级规则；文本召回率不证明剪辑切点准确。
- F-0022的条件尚未满足：未证明确需校准，也未确认可用align模型，不能因为本调研归档就直接实现。
- 其余模型重跑、独立参考时间、误差指标保留为明确未测项。下游需要这些结论时先补实验或提出调研，不假定已有结果。

## 验证与未测项

- Ran：本轮两模型四次真实识别、参考就绪检查、指标9条测试及1600对短文本距离校验、pnpm lint、pnpm feature check、git diff --check通过。
- Red check：旧CER对“甲乙丙→丙乙甲”报4次错误，新测试要求2次替换而失败；修复后通过。
- Earlier checks：上轮pnpm test为66通过/3跳过、架构44通过，TS及cargo check通过；作为历史验证，不冒充本次重跑。
- Not run：Paraformer 2024、Whisper、FireRedASR未按确认文字重跑；Cloud/FunASR未测；独立字词时间、50处抽查、MAE/p95及时间窗口召回未完成；本轮未重跑60分钟和产品UI验证。
- 首次沙箱内推理受计时工具sysctl权限限制而失败，获准沙箱外重跑后成功；仅成功数据进入本轮结果。

## 结论

维护者明确接受现有结果和缺项，本轮按受限范围验收归档。原计划研究问题没有全部获得完整答案；不修改token_timestamp_verified、不宣布字词精剪已验证、不替代下游功能验收。本次没有选定新的模型默认值或架构方案，因此没有新建模型选型ADR。

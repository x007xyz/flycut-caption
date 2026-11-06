---
id: F-0001
stage: 02-research
status: draft
approved_by:
approved_at:
---

# F-0001 中文口播转写质量基准：调研报告

## 要回答的问题

来自 [01-spec.md](01-spec.md)：

1. 各模型 / Provider 在中文口播上的字错率。
2. 语气词召回率：嗯 / 啊 / 呃 / 额 / 那个 / 就是 等是否被原样转写。
3. 字词时间戳误差（整体和短词），是否需要 E-01/6 强制对齐。
4. 60 分钟长音频能否稳定跑完，耗时和内存。
5. 桌面端默认推荐哪个模型，「可用标准」怎么定义。

## 评估标准

- **字错率（CER）**：对照逐字参考文本，去掉标点和语气词后按词元计算（一个汉字一个词元，英文按词）。比较前统一写法：繁简统一为简体、英文小写、全角转半角；读音相同听不出区别的写法视为相同（他 / 她 / 它，的 / 地 / 得，中文数字与阿拉伯数字，逐个字母读出的缩写如 a i 与 AI）。初稿生成用的是同一套规则（`tests/lib/referenceDraft.mjs` 的 `canonical`、`normalizeWithMap`），评测命令要复用它。
- **语气词召回率**：参考文本里每个语气词，识别结果在 ±0.5 秒内是否出现同一个语气词（嗯 / 呃 / 额 视为同一类）。
- **字词时间戳误差**：识别出的字与参考对齐后，起止时间的平均绝对误差和 95 分位；单字语气词单独统计。
- **速度和资源**：实时率（处理时长 / 音频时长）、峰值内存，在维护者的 Mac 上测。
- **许可与可用性**：模型许可是否允许商用；是否能随桌面端分发（只内置 sherpa-onnx）。

## 候选方案

| 方案 | 说明 | 资料来源 |
|---|---|---|
| SenseVoice small int8（sherpa-onnx） | 当前默认推荐；中英日韩粤；已下载 | `models.json`（`recommended`） |
| Paraformer zh int8 2023-09-14（sherpa-onnx） | 中文推荐；已下载 | `models.json` |
| Paraformer zh int8 2024-03-09 / small | 新版 Paraformer，约 997 MB / 较小 | `models.json`，**未下载** |
| Zipformer CTC zh int8 2025-07-03 | 约 301 MB | `models.json`，**未下载** |
| TeleSpeech CTC int8 zh | 约 183 MB | `models.json`，**未下载** |
| FireRedASR large zh_en | 约 1.47 GB，中英 | `models.json`，**未下载** |
| Whisper small / medium multilingual | 约 639 MB / 1.93 GB | `models.json`，**未下载** |
| FlyCut Cloud | 需要服务地址和 API Key | 未测：本机没有配置 |
| FunASR Provider | 需要单独的 Python 环境 | 未测：本机没有配置 |

`models.json` 里所有中文模型的 `timestamp.token_timestamp_verified` 都是 `false`：字词时间戳都没有经过校验，这直接关系到问题 3。

## 实验

### 样本（2026-11-05）

| 样本 | 时长 | 用途 | 参考文本 |
|---|---|---|---|
| `external/coscup-BWgFrY91F_I.mp4` | 28.5 分钟 | 主样本：单人、未剪辑、语气词多 | 入库（CC BY，署名 COSCUP） |
| `external/coscup-3UegVxMFyeo.mp4` | 31.4 分钟 | 主样本：单人、未剪辑、中英混说 | 入库（CC BY，署名 COSCUP） |
| `clips/asr/zh-podcast-3min.mp4`、`external/bili-BV1Rex26dEWF.mp4` | 3 + 20 分钟 | 本地补测大陆口音 | 只放本地 |
| AliMeeting / AISHELL-4 片段 | — | 语气词召回辅助样本 | 自带人工转写；许可核实后再用 |

已核实：两段 COSCUP 素材抽样转写（第 300、900 秒各 60 秒）为华语，画面为单人演讲。`coscup-bTc722zFo7o` 标题是中文但讲英文，不进中文评测。`3UegVxMFyeo` 第 900 秒附近 SenseVoice 输出了日文假名和乱码片段，是中英混说的难点，参考文本要重点听校。

### 步骤

1. **定评测片段**：去掉开场和问答，每段取连续的演讲主体（各约 25 分钟）。
2. **参考文本初稿**：用 SenseVoice 和 Paraformer 分别转写，按时间对齐合并；两者不一致的地方标出来，交维护者逐句听校，语气词和口误按实际读音保留。
3. **参考时间戳**：用强制对齐工具对听校后的文本生成字级时间戳，人工抽查 50 处。
4. **评测命令**：`pnpm eval:asr`，读取样本清单和参考文本，对每个模型输出 CER、语气词召回率、时间戳误差、实时率，写成 JSON 和 Markdown 报告。
5. **跑对比**：内置 sherpa-onnx 的各模型系列；FlyCut Cloud、FunASR Provider 能接上就测，接不上标「未测」。
6. **长音频**：把两段 COSCUP 拼成约 60 分钟跑一次，记录耗时和峰值内存。

### 进度（2026-11-05）

**步骤 1、2 已完成，等待听校。**

- 评测片段：`coscup-BWgFrY91F_I` 取 00:48.5–23:52.5（讲者自我介绍起，到「现场 QA」前），`coscup-3UegVxMFyeo` 取 00:42.1–31:09.5（主持人介绍后，到讲者说「谢谢大家」为止）。
- 参考文本初稿：[tests/fixtures/asr-reference/](../../../tests/fixtures/asr-reference/)，由 `scripts/asr-reference-draft.mjs` 生成（合并逻辑在 `tests/lib/referenceDraft.mjs`，测试 `tests/reference-draft.test.mjs`）。整段按词元对齐，分歧处标 `{A|B}`。
- 2026-11-05 第二版：底稿 A 从 SenseVoice 原始输出换成 `external/coscup-*.transcript.json` 的「精校版」（在 SenseVoice 结果上修正了专有名词、同音字和标点，时间戳未变；原始输出保留为 `*.raw.transcript.json`）。精校版没有逐句听音频，语气词基本沿用 SenseVoice（例如 `BWgFrY91F_I` 的「呃」：SenseVoice 53、Paraformer 79、精校版 52），所以仍需听校。

| 样本 | 句数 | 第一版分歧（SenseVoice vs Paraformer） | 第二版分歧（精校版 vs Paraformer） | 其中语气词分歧 |
|---|---|---|---|---|
| `coscup-BWgFrY91F_I` | 486 | 228 句 / 483 处 | 201 句 / 387 处 | 20 |
| `coscup-3UegVxMFyeo` | 542 | 157 句 / 249 处 | 135 句 / 211 处 | 16 |

第二版同时改了比较规则：按词元而不是按字比较英文，读音相同的写法不算分歧（见「评估标准」）。语气词分歧只统计两边都是单个语气词（嗯、呃、额、啊、哦、诶、哎）或缺失的情况。

**顺带得到的速度和内存**（维护者的 Mac，整段约 30 分钟音频，含 FSMN VAD）：

| 模型 | `BWgFrY91F_I`（28.6 分钟） | `3UegVxMFyeo`（31.4 分钟） | 峰值内存 |
|---|---|---|---|
| SenseVoice small int8 | 134 秒（实时率约 0.08） | 147 秒 | 约 2.0–2.2 GB |
| Paraformer zh int8 | 118 秒 | 126 秒 | 约 2.1 GB |

峰值内存用 `/usr/bin/time -l` 测，包含 Node 和 sidecar 子进程。

### 评测命令（步骤 4，2026-11-05 完成）

- `pnpm eval:asr`：读 `tests/fixtures/asr-reference/*.md`，用已下载的 sherpa-onnx 模型转写每段评测范围（FSMN VAD），输出字错率（替换 / 删除 / 插入）、语气词召回与多出的语气词、口头禅（那个、就是）召回、实时率、峰值内存；结果在 `test-results/asr-eval/report.{md,json}`，模型输出缓存在 `cache/`。
- 参考文本还有未听校的 `{A|B}` 时命令拒绝运行；`--allow-draft` 分歧处取 A 试算，报告顶部标明「不能当结论」。
- `pnpm eval:asr --long`：两段 COSCUP 全片拼成约 60 分钟，只记耗时、内存和是否跑完。
- 指标实现在 `tests/lib/asrEval.mjs`（写法统一复用 `tests/lib/referenceDraft.mjs`），单元测试 `tests/asr-eval.test.mjs`。
- 尚未实现：字词时间戳误差（步骤 3 的参考时间戳要在听校之后用强制对齐生成）。

### 结果

**初稿试算（2026-11-05，`--allow-draft`，不能当结论）**：

| 样本 | 模型 | 字错率 | 替换 / 删除 / 插入 | 语气词召回 | 多出的语气词 | 实时率 | 峰值内存 |
|---|---|---|---|---|---|---|---|
| `coscup-3UegVxMFyeo` | SenseVoice small int8 | 4.4% | 145 / 68 / 65 | 98.9%（93/94） | 6 | 0.078 | 1.91 GB |
| `coscup-3UegVxMFyeo` | Paraformer zh int8 2023 | 5.6% | 154 / 70 / 131 | 97.9%（92/94） | 12 | 0.066 | 1.95 GB |
| `coscup-BWgFrY91F_I` | SenseVoice small int8 | 8.0% | 243 / 232 / 99 | 98.1%（53/54） | 6 | 0.082 | 1.69 GB |
| `coscup-BWgFrY91F_I` | Paraformer zh int8 2023 | 8.7% | 260 / 76 / 287 | 100%（54/54） | 32 | 0.070 | 1.65 GB |

为什么不能当结论：初稿的底稿 A 是在 SenseVoice 输出上精校的，分歧处又取 A，数字天然偏向 SenseVoice；语气词更明显——精校版的「呃」基本沿用 SenseVoice（52 个），Paraformer 识别出 79 个，「多出的 32 个」里很可能有真实语气词被 SenseVoice 漏掉。听校之后重跑同一命令即可得到正式结果。

**长音频（问题 4，2026-11-05，`pnpm eval:asr --long`）**：两段 COSCUP 全片拼成 60.0 分钟，维护者的 Mac：

| 模型 | 耗时 | 实时率 | 峰值内存 | 句数 | 是否跑完 |
|---|---|---|---|---|---|
| SenseVoice small int8 | 286 秒 | 0.079 | 2.39 GB | 1173 | ✅ 最后一句结束于 60.0 分钟 |
| Paraformer zh int8 2023 | 243 秒 | 0.068 | 2.47 GB | 425 | ✅ 最后一句结束于 60.0 分钟 |

Paraformer 输出不带标点，按标点断句后每句平均 8.5 秒（SenseVoice 约 3 秒），直接当字幕会太长，需要额外断句。

能先看出的方向：两个模型字错率在同一量级（4–9%），差距小于初稿偏差；两者都会转写语气词，没有观察到自动删除；实时率都在 0.07–0.08，约 30 分钟音频 2 分钟多跑完。

## 结论

**进行中（2026-11-05）**：问题 1–3、5 要等参考文本听校完成；问题 4 已有结论。

1. 字错率：待听校。初稿试算 SenseVoice 与 Paraformer 在 4–9% 之间，差距小于初稿偏差。其他模型待下载（约 3.6 GB，需维护者同意）。
2. 语气词召回：待听校。已确认两个模型都会转写语气词，没有自动删除。
3. 字词时间戳误差：待听校后用强制对齐生成参考时间戳；`models.json` 里所有中文模型都标着 `token_timestamp_verified: false`。
4. **长音频：可以稳定跑完。** 60 分钟音频两个模型都完整跑完，4–5 分钟、峰值内存约 2.4–2.5 GB，满足桌面端使用。
5. 默认推荐与「可用标准」：待 1–3 的正式结果；届时写 ADR。

## 对后续需求的影响

待结论确定后填写。目前可以先说的：长音频不需要另做分段处理（E-01 相关候选不用为此加工作量）；Paraformer 作为字幕源需要断句。

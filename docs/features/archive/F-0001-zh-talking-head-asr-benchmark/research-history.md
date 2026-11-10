# F-0001 历史实验与推进记录

以下是验收前的历史内容。当前状态与结论以 [02-research.md](02-research.md) 为准；“等待听校”“仍未完成”等描述是历史状态。

# F-0001 中文口播转写质量基准：调研报告

> 最新状态（2026-11-08）：维护者已明确将现有精校文案作为确认版本。两份文字参考共1028句、0处分歧，就绪检查通过，后续不再等待人工听校。本轮已完成SenseVoice与Paraformer 2023各两段的文字指标重算，见文末最新对照；下文2026-11-05表格仍为历史初稿试算。其余模型与独立时间参考仍待完成。

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
- 参考文本初稿：[tests/fixtures/asr-reference/](../../../../tests/fixtures/asr-reference)，由 `scripts/asr-reference-draft.mjs` 生成（合并逻辑在 `tests/lib/referenceDraft.mjs`，测试 `tests/reference-draft.test.mjs`）。整段按词元对齐，分歧处标 `{A|B}`。
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

**初稿试算（2026-11-05，`--allow-draft`，不能当结论）**：7 个内置 sherpa-onnx 模型 × 2 段 COSCUP（各约 25–30 分钟，FSMN VAD，维护者的 Mac）。字错率为 `3UegVxMFyeo` / `BWgFrY91F_I`。

| 模型 | 字错率 | 主要错误 | 语气词召回 | 多出的语气词 | 字词时间戳 | 实时率 | 峰值内存 |
|---|---|---|---|---|---|---|---|
| SenseVoice small int8 | 4.4% / 8.0% | 替换、删除 | 98.9% / 98.1% | 6 / 6 | 有 | 0.08 | 1.7–1.9 GB |
| Paraformer zh int8 2023 | 5.6% / 8.7% | 插入 | 97.9% / 100% | 12 / 32 | 有 | 0.07 | 1.7–2.0 GB |
| Paraformer zh int8 2024 | 6.3% / 9.6% | 插入 | 98.9% / 100% | 10 / 33 | **无**（只有句级） | 0.06 | 1.6–1.8 GB |
| FireRedASR large zh_en | 5.0% / 12.0% | 插入、替换 | 96.8% / 98.1% | 9 / 33 | **无** | **0.45–0.63** | **4.2–4.9 GB** |
| Whisper small multilingual | 19.2% / 25.8% | **大量删除** | **3.2% / 5.6%** | 1 / 0 | **无** | 0.23–0.28 | 2.4 GB |
| TeleSpeech CTC int8 | 26.9% / 52.9% | 大量删除、错字 | 73.4% / 59.3% | 6 / 10 | 有 | 0.09–0.10 | 3.3–3.8 GB |
| Zipformer CTC zh int8 2025 | 295% / 295% | **输出乱码**（见发现 2） | 0% | 0 | 有 | 0.06 | 2.3–2.6 GB |

完整报告：`test-results/asr-eval/report.md`（本地生成，不入库）。

**评测中发现的产品问题**：

1. **多语 Whisper 在应用里每次都识别失败**（`Invalid language: auto`）：`models.json` 给的 `language: auto` 原样传给 sherpa-onnx，而它只认空字符串表示自动检测；sidecar 对 Whisper 又忽略了 `--language`。已修复（`5038934`），并经开发模式 Host 的 `workflow.start`（与应用相同的路径）验证 `zh`、`auto` 都能识别。
2. **Zipformer CTC zh 2025-07-03 在应用里输出乱码**：模型用 byte-level BPE，输出 `Ɛģň Əťļ …` 这类字节符号，sidecar 没有把它们还原成汉字。维护者 2026-11-05 决定：TeleSpeech、Zipformer CTC 后续不再考虑，不修解码、不再评测。

**能先看出的方向**（不依赖初稿偏差的部分）：

- **Whisper 不适合口播剪辑**：几乎不转写语气词（召回 3–6%），还整段漏掉内容（删除是主要错误），去口癖和逐字剪辑都用不了。
- **TeleSpeech、Zipformer CTC 不再考虑**（维护者 2026-11-05 决定）：TeleSpeech 字错率 27–53%，Zipformer 输出乱码。
- **能做字词级剪切的只有 SenseVoice、Paraformer 2023**：Paraformer 2024、FireRedASR、Whisper 只有句级时间戳。
- **FireRedASR 字错率与前两名同一量级，但慢 6–8 倍、内存 4–5 GB**，不适合作桌面端默认。
- 真正的竞争在 SenseVoice 和 Paraformer 2023 之间，差距小于初稿偏差，要等听校后的正式结果决定。

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

1. 字错率：待听校。初稿试算 7 个模型：SenseVoice、Paraformer 2023/2024、FireRedASR 在 4–12%；Whisper 19–26% 明显落后；TeleSpeech（27–53%）和输出乱码的 Zipformer CTC 按维护者决定不再考虑。正式评测只跑其余 5 个。前四名之间的差距小于初稿偏差。FlyCut Cloud、FunASR Provider 未测（本机没有配置）。
2. 语气词召回：待听校。**Whisper 几乎不转写语气词（3–6%）**，其余可用模型都保留语气词，没有自动删除。
3. 字词时间戳误差：待听校后用强制对齐生成参考时间戳；`models.json` 里所有中文模型都标着 `token_timestamp_verified: false`。
4. **长音频：可以稳定跑完。** 60 分钟音频两个模型都完整跑完，4–5 分钟、峰值内存约 2.4–2.5 GB，满足桌面端使用。
5. 默认推荐与「可用标准」：待 1–3 的正式结果；届时写 ADR。

## 对后续需求的影响

待结论确定后填写。目前可以先说的：长音频不需要另做分段处理（E-01 相关候选不用为此加工作量）；Paraformer 作为字幕源需要断句。

## 继续执行记录（2026-11-08）

维护者确认：「尚未听校，先完成评测准备」。未替维护者听校、未把任何参考文本改成reviewed，调研仍保持draft。

- 新增 `pnpm eval:asr --check-reference`：不依赖模型即可检查参考文本状态、分歧数及媒体存在情况。两份主样本实际仍有211+387=598处分歧，共1028句，退出码1符合预期。
- 修复评测门禁：即使分歧全部删除，status不是reviewed仍不能用于正式评测；无效范围与空讲者文本拒绝运行。
- 听校操作与恢复步骤、现有环境、尚未实现指标见 [reference-review.md](reference-review.md)。本机模型和媒体存在，但此前评测输出目录未找到；本轮没有重跑COSCUP正式质量评测或刷新历史质量数字；回归另用demo素材验证真实ASR。
- 指标口径补记：目前语气词召回实现是文本对齐统计，不是计划中的±0.5秒时间窗口统计；字词参考时间与误差计算仍待完成。未经听校的文本不能用于宣布模型质量或默认推荐。

### 本次验证（2026-11-08，当前未提交工作区）

- Ran：`pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`、`cargo check --manifest-path src-tauri/Cargo.toml` 均通过。
- Ran：`pnpm test` 66通过、0失败、3跳过；`pnpm test:architecture` 44通过、0失败。架构测试首次因沙箱IPC权限EPERM无法启动，在获准的沙箱外环境重跑通过。
- Red check：先加入「未听校但无分歧仍拒绝」及「无效范围/空讲者文本拒绝」测试，旧实现均失败于Missing expected exception；修复后两条通过，连同CLI就绪检查与原指标测试共19条通过。
- Real use：对两份真实参考文件运行`pnpm eval:asr --check-reference`，输出draft/211及draft/387、两段媒体均存在，退出码1符合预期。`pnpm test`同时用demo真实运行SenseVoice、Paraformer、FireRedASR及VAD集成路径，均通过；这不替代COSCUP正式质量评测。
- Not run：moonshine、nemo_transducer、whisper-tiny-en的family测试因对应模型未下载被跳过；不代表已下载的whisper-small质量已在本轮重新评测。
- Not run：逐句人工听校、参考字词时间生成与抽查、正式CER/时间窗召回/字词时间误差，等待按维护者选择先完成听校前准备后续接续；Cloud/FunASR真实服务未配置验证。本次无产品UI改动，未做UI与桌面端人工操作。

## 精校文字确认（2026-11-08，最新）

- 维护者原话：「把精校文案作为 确认版本」。已更新两份参考为reviewed并记录确认人、日期、精校源文件与SHA-256；正文直接取精校JSON评测范围内的486和542句，原视频及精校源文件不改写。
- 此次确认解除文字基准等待，不宣称完成逐句听校。比较报告必须披露SenseVoice来源偏差；原始ASR字词/句段时间不能当独立时间参考。
- `pnpm eval:asr --check-reference`通过：两份参考ready=true、1028句、0分歧、媒体存在。参考解析/就绪检查的7条测试通过；后续正式文字指标重算与独立时间参考准备继续按顺序执行。

## 正式文字评测推进（2026-11-08）

已开始对本次确认的两份精校参考重跑SenseVoice small int8及Paraformer 2023，先比较两种带字词时间输出的主要候选。此前历史初稿数字不作为本次正式文字结果。

发现并修正指标实现问题：原CER以最长公共子序列的编辑片段近似，可能高估最小编辑距离，例如「甲乙丙」→「丙乙甲」错误地记成2插入+2删除，实际仅2替换。改为精确Levenshtein动态规划，保留两行内存；替换/删除/插入分类同成本时按固定优先级确定。对应回退测试在旧实现报4/3而不是2/3；修复后通过，并用1600对短文本与独立矩阵实现交叉核对。

首次推理尝试被资源计时工具阻断：`/usr/bin/time`在沙箱中读取`sysctl kern.clockrate`遭拒，脚本失败且未保存可用缓存，不能把本轮当成成功结果。已获准在沙箱外重跑本地模型与素材。

## 已确认文字基准的主要候选对照（2026-11-08）

本轮已完成两种主要候选×两段素材共4次真实识别，未使用`--allow-draft`。数据来自`test-results/asr-eval/report.json`，模型原始结果缓存在同目录`cache/`；相对当前确认文字基准计算，仍有SenseVoice来源偏差，不是独立人工真值排名。

| 样本 | 模型 | CER | 语气词召回（文本对齐） | 额外语气词 | 耗时 | 峰值内存 |
|---|---|---|---|---|---|---|
| coscup-3UegVxMFyeo | SenseVoice | 4.37% | 93/94（98.94%） | 6 | 142.0s | 1.96 GiB |
| coscup-3UegVxMFyeo | Paraformer 2023 | 5.54% | 92/94（97.87%） | 12 | 119.2s | 1.94 GiB |
| coscup-BWgFrY91F_I | SenseVoice | 8.00% | 53/54（98.15%） | 6 | 112.0s | 1.68 GiB |
| coscup-BWgFrY91F_I | Paraformer 2023 | 8.67% | 54/54（100.00%） | 32 | 98.5s | 1.64 GiB |

按参考词元数加权汇总（不能简单平均两个百分比）：

- `paraformer-zh-int8-2023-09-14`：CER 974/13537 = 7.20%；语气词召回 146/148 = 98.65%；额外语气词共44个。
- `sensevoice-small-int8-zh-en-ja-ko-yue-2024-07-17`：CER 852/13537 = 6.29%；语气词召回 146/148 = 98.65%；额外语气词共12个。

解释：两者都保留绝大多数本基准中的语气词，Paraformer推理较快但插入更多；精校基准源于SenseVoice，不能只凭CER领先确定SenseVoice客观更准。未进行±0.5秒窗口召回、独立字词时间误差评测，也未据此把模型token_timestamp_verified设为true。

F-0001仍未完成：Paraformer 2024、FireRedASR、Whisper尚未针对本次确认版本重跑；独立参考时间与字词误差、默认模型及可用门槛仍待完成。历史60分钟稳定性记录保留为2026-11-05结果，不伪装为本轮新测。调研报告继续保持draft，不提前提交最终验收或解除其下游依赖。

本轮验证：指标测试9条全部通过，含旧实现失败的回退测试和1600对小样本距离校验；pnpm lint、pnpm feature check、git diff --check通过。未重跑其余全量构建/架构/桌面UI检查（仅变更实验指标与报告；上轮已跑，不能当作本轮重新执行）。

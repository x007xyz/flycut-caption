---
id: F-0034
stage: 02-research
status: approved
approved_by: zhangxiang.chen
approved_at: 2026-11-09
---

# F-0034 TTS与人声分离选型调研：调研报告

> 调研日期：2026-11-09。检索方式：Exa 网页检索、GitHub 仓库元数据、model card/README、CAC 官方页面。没有运行任何 TTS/分离模型，质量与成本数字一律不编造。

## 结论摘要

建议把 TTS 和人声分离分成两条独立决策：

- 本地固定音色优先 Kokoro（Apache-2.0）或 MeloTTS（MIT）；两者都不做参考音频克隆，适合作为默认离线路径。
- 需要跨语言克隆时，优先评估 CosyVoice（Apache-2.0）或 Qwen3-TTS（Apache-2.0）；具体 checkpoint 的权重许可必须逐个核对。
- F5-TTS、Fish Speech、IndexTTS 不能作为默认商用路径：F5-TTS 官方权重是 CC-BY-NC-4.0，Fish Speech 是 research/non-commercial，IndexTTS 有单独的 Model Use License 和商业规模条件。
- Piper 要特别小心：当前维护仓库 OHF-Voice/piper1-gpl 是 GPL-3.0，旧的 rhasspy/piper 才是 MIT；每个 voice 的 model card 还可能不同。
- 人声分离优先 Demucs/HTDemucs（MIT）；UVR/MDX-Net 的代码许可较清楚，但具体模型权重（如 Kim Vocal 2）必须逐模型确认，不能默认随包分发。
- 首版不建议内置大模型或 Python。TTS 走 Provider/HTTP 服务，分离可以作为 Host 的独立 job；安装包体积和跨平台构建要单独验收。

## 要回答的问题

1. 哪些本地/云端 TTS 和分离候选可用，代码、权重、商业使用和样本保留条款是什么？
2. 用许可可用的真实中英素材，如何测回识别字错率、听感、音色相似度、时长控制、耗时和成本？
3. 人声分离对真实背景音乐/环境声的残留、串音、耗时、内存和本地运行可行性如何？
4. 现行 AI 内容标识要求和目标平台规则是什么，显式/隐式标识怎么实现？
5. 推荐/不可用/待验证矩阵、Provider 接口、质量门槛、成本上限和后续需求边界是什么？

## 评估标准

| 维度 | 说明 |
|---|---|
| 许可证 | 代码许可与权重许可分开；商业使用、再分发、样本保留、署名要求逐项记录 |
| 质量 | 回识别 CER/WER、主观听感、音色相似度、韵律/停顿、时长可控性 |
| 语言 | 中文、英文、中英混排；方言/口音单独标注 |
| 工程 | macOS/Windows、CPU/GPU、RTF、内存、安装包增量、是否需要 Python |
| 成本 | 本地硬件成本、云服务每分钟/每百万字符成本、并发与失败重试 |
| 隐私 | 文本/音频是否离开本机、服务商保留与训练条款、密钥边界 |
| 可控性 | 语速、音色、情感、发音纠错、长文本分块、流式输出 |

## 候选方案

### TTS

| 候选 | 代码许可 | 权重/模型许可 | 能力 | 结论 |
|---|---|---|---|---|
| [Kokoro](https://github.com/hexgrad/kokoro) | Apache-2.0 | Apache-2.0（以 model card 为准） | 82M、CPU 可跑、固定音色、含中文，无参考音频克隆 | 本地默认候选 |
| [MeloTTS](https://github.com/myshell-ai/MeloTTS) | MIT | MIT（以 model card 为准） | 中英日韩等、CPU 实时、固定音色、中英混读 | 本地默认候选 |
| [CosyVoice](https://github.com/funaudiollm/cosyvoice) | Apache-2.0 | 逐 checkpoint 核对 | 9 语言、18+ 中文方言、zero-shot 克隆、流式 | 克隆/多语候选 |
| [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) | Apache-2.0 | 逐 checkpoint 核对 | 10 语言、Base 克隆、CustomVoice、VoiceDesign、流式 | 克隆/多语候选 |
| [Chatterbox](https://github.com/resemble-ai/chatterbox) | MIT | MIT（含 watermark 说明） | 23+ 语言、跨语言克隆、副语言标签 | 备选克隆候选 |
| [Piper](https://github.com/OHF-Voice/piper1-gpl) | GPL-3.0 | 每个 voice 的 model card 不同 | 轻量、CPU、固定音色、多语言 | 许可复杂，非默认 |
| [F5-TTS](https://github.com/SWivid/F5-TTS) | MIT | CC-BY-NC-4.0 | 零样本克隆、中英 | 非商用权重，默认排除 |
| [Fish Speech](https://github.com/fishaudio/fish-speech) | Fish Audio Research License | research/non-commercial | 多语、克隆、情绪标签 | 商用需另行授权 |
| [IndexTTS](https://github.com/index-tts/index-tts) | Bilibili Model Use License | 同上 | 中英克隆、情绪控制 | 有条件，需法务确认 |

说明：Kokoro/Piper/MeloTTS 的具体 voice 或 checkpoint 可能附带不同的 model card；上表的“权重许可”必须在打包前逐个文件复核，不能只看主仓库 LICENSE。

### 人声分离

| 候选 | 代码许可 | 权重许可 | 能力 | 结论 |
|---|---|---|---|---|
| [Demucs / HTDemucs](https://github.com/facebookresearch/demucs) | MIT | 随仓库权重，需保留许可 | 人声/鼓/贝斯/其他分离，质量与速度平衡 | 首选基线 |
| [UVR / MDX-Net](https://github.com/Anjok07/ultimatevocalremovergui) | MIT（GUI/代码） | 逐模型核对 | 多种 MDX 模型、UVR 生态 | 只作参考，权重逐个确认 |
| Kim Vocal 2 | 未核实 | 未核实 | 社区常用人声模型 | 默认排除，先查作者授权 |

## 实验

### 已运行

- 完成候选仓库/README/model card 的许可证与能力核对，记录来源 URL 和访问日期。
- 没有运行 TTS 或分离推理；没有产生 CER、RTF、音色相似度或成本数字。

### 实验计划（Not run）

E0 许可审计：

- 对每个准备打包的权重记录 URL、版本、SHA-256、LICENSE、model card、样本/训练数据条款。
- 代码许可与权重许可分栏；GPL/AGPL、NC、research-only 单独标红。

E1 固定音色 TTS：

- 20 条中文、20 条英文、10 条中英混排；每条 5–30 秒。
- 指标：回识别 CER/WER、主观 1–5 分、时长偏差、RTF、峰值内存。
- 候选：Kokoro、MeloTTS；可选 Piper（仅许可确认后）。

E2 克隆 TTS：

- 同一说话人 3 段参考音频（3–10 秒），固定文本 20 条；比较 CosyVoice、Qwen3-TTS、Chatterbox。
- 指标：音色相似度（ECAPA/x-vector 余弦，仅作辅助）、回识别 CER、听感、跨语言口音、时长控制。
- 任何样本上传前记录服务商保留/训练条款；没有授权不测试。

E3 人声分离：

- 真实口播 + 背景音乐/环境声各 3 段；Demucs 与一个许可清楚的 MDX 模型对比。
- 指标：人声残留、伴奏串音、SI-SDR（有参考时）、RTF、峰值内存、输出是否可直接给 F-0037 混音。

E4 成本：

- 本地：按 RTF 和硬件功耗估算；云：按实际账单/分钟记录，不引用未核实的价目表。

## AI 内容标识

已核对 CAC《人工智能生成合成内容标识办法》（国信办通字〔2025〕2 号，2025-03-14）：

- 标识分显式标识和隐式标识。
- 视频应在起始画面和播放周边适当位置添加显著提示，可在末尾/中间补充；音频可在起始、末尾或中间加语音/节奏提示，或在交互界面提示。
- 文件数据中应保留隐式标识；具体元数据字段和平台落地方式要按目标平台规则再核实。

本报告只记录公开办法，不替代法务意见。FlyCut 的“AI 配音”角标/字幕默认开启，导出时同时写可见标识和可实现的元数据；抖音/视频号/小红书等平台的具体字段要求标为待核实。

## 结论

**Q-1 许可与候选**：本地固定音色选 Kokoro/MeloTTS；克隆选 CosyVoice/Qwen3-TTS；Piper 因 GPL 和 voice 许可差异不作为默认；F5-TTS/Fish Speech/IndexTTS 默认排除或需单独授权；分离首选 Demucs，UVR/MDX 只作参考。

**Q-2 质量评测**：必须用真实中英素材做回识别 CER、听感、音色相似度、时长偏差、RTF 和内存；本轮全部 Not run，不能声称任何模型“更好”。建议先做 50 条固定文本的离线对比，再做克隆。

**Q-3 人声分离**：Demucs 是许可证最清楚的基线；真实背景音乐/环境声残留和串音必须实测。安装包不内置 Python，分离作为 Host job 或 HTTP Provider，结果资产进入项目。

**Q-4 AI 标识**：显式标识 + 隐式元数据都要考虑；“AI 配音”默认开启；平台规则和法务适用性待核实。

**Q-5 推荐矩阵**：本地固定音色 = 可推荐（许可确认后）；CosyVoice/Qwen3 克隆 = 有条件推荐（真实质量与条款确认后）；F5/Fish/IndexTTS = 默认不可用；Demucs = 有条件推荐；UVR/MDX/Kim Vocal 2 = 待核实。

## 对后续需求的影响

| 需求 | 影响 |
|---|---|
| F-0035 单条译文配音 | 先用 Kokoro/MeloTTS 的固定音色做单条试听；克隆另开开关 |
| F-0036 整段配音对齐 | TTS 必须返回时长/可调速信息；超长条目按现有 AC 标记，不自动截断 |
| F-0037 配音音轨混音与导出 | 分离结果作为独立音轨；Demucs 输出格式和采样率要统一 |
| F-0038 授权声音克隆 | 只在 CosyVoice/Qwen3/Chatterbox 等许可确认后接入；授权记录仍按 decisions.md |
| F-0041 人声与背景声分离 | Demucs 是首选基线；UVR/Kim Vocal 2 需逐个权重确认 |
| F-0053 TTS Provider 能力 | Provider 声明固定音色/克隆/语言/流式/时长控制；不按 Provider ID 写分支 |

## 建议的 ADR

建议在报告确认后写两份 ADR：

1. TTS Provider 契约：固定音色与克隆能力、长文本分块、时长控制、音频资产存储、AI 标识默认值。
2. 人声分离边界：Host job vs HTTP Provider、模型权重分发、输出音轨格式、失败回退。

## 验证记录

| 来源 | URL | 访问日期 | 核实状态 |
|---|---|---|---|
| CosyVoice | https://github.com/funaudiollm/cosyvoice | 2026-11-09 | Apache-2.0、能力/语言已核对 |
| Kokoro | https://github.com/hexgrad/kokoro | 2026-11-09 | Apache-2.0、固定音色/无克隆已核对（model card 仍需逐 voice 复核） |
| MeloTTS | https://github.com/myshell-ai/MeloTTS | 2026-11-09 | MIT、中英混读已核对 |
| Qwen3-TTS | https://github.com/QwenLM/Qwen3-TTS | 2026-11-09 | Apache-2.0、克隆/流式已核对 |
| Chatterbox | https://github.com/resemble-ai/chatterbox | 2026-11-09 | MIT、23+ 语言/watermark 已核对 |
| Piper | https://github.com/OHF-Voice/piper1-gpl | 2026-11-09 | GPL-3.0；旧 rhasspy/piper 为 MIT |
| F5-TTS | https://github.com/SWivid/F5-TTS | 2026-11-09 | 代码 MIT、官方权重 CC-BY-NC-4.0 |
| Fish Speech | https://github.com/fishaudio/fish-speech | 2026-11-09 | research/non-commercial |
| IndexTTS | https://github.com/index-tts/index-tts | 2026-11-09 | Bilibili Model Use License |
| Demucs | https://github.com/facebookresearch/demucs | 2026-11-09 | MIT |
| UVR | https://github.com/Anjok07/ultimatevocalremovergui | 2026-11-09 | 代码 MIT；权重逐个核对 |
| CAC 标识办法 | https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm | 2026-11-09 | 显式/隐式标识要求已核对 |

**Not run**：真实 TTS 推理、克隆、分离、跨平台打包、成本/延迟实测、平台标识规则、法务审查。报告不把候选能力当成已验收质量。

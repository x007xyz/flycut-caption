# F-0001 已确认文字参考与评测恢复

2026-11-08最新决定：维护者要求「把精校文案作为 确认版本」。已直接采用视频同目录的精校JSON句段文字，生成两份已确认的文字参考，取代598处模型分歧草稿。本需求的调研报告仍是draft，尚未完成验收。

## 当前已确认文件

| 文件 | 评测范围（原视频时间） | 句数 | 未处理分歧 |
|---|---|---:|---:|
| [COSCUP 3UegVxMFyeo](../../../../tests/fixtures/asr-reference/coscup-3UegVxMFyeo.md) | 00:42.1–31:09.5 | 542 | 0 |
| [COSCUP BWgFrY91F_I](../../../../tests/fixtures/asr-reference/coscup-BWgFrY91F_I.md) | 00:48.5–23:52.5 | 486 | 0 |

两份参考的status均为reviewed，确认人为zhangxiang.chen，日期2026-11-08。`reference_basis: maintainer-accepted-corrected-asr`明确说明这是维护者接受的精校文案，不表示agent完成了人工听校。源JSON路径及SHA-256保存在每份参考的元数据中，正文逐句取源文件，不再任取模型分歧。

原视频、精校JSON/TXT/SRT/MD均保持不变。文字来自SenseVoice精校，评测需披露来源偏差。`timestamp_basis: original-asr-unverified`：句段与字词时间完全沿用原始ASR，只作定位，不作为独立时间标注或解锁字词剪切的依据。

此前「尚未听校，先完成评测准备」为同日较早的决定；其文字基准阻塞已由这次明确接受解除，没有据此宣称实际听校已完成。

## 就绪检查

```bash
pnpm eval:asr --check-reference
```

此命令不下载模型、不推理、不发网络请求，JSON列出每份文件的状态、句数、未处理分歧、媒体可用性。退出码0仅表示参考文本已获确认且无分歧；不代表时间标注、模型或全部评测已就绪。任何草稿、分歧、解析失败返回1。

单独检查一份文件：

```bash
pnpm eval:asr --check-reference --reference tests/fixtures/asr-reference/coscup-BWgFrY91F_I.md
```

2026-11-08接受精校版后实际检查：两份文件均为reviewed，共1028句、0处分歧、两段媒体均存在，退出码0。此前草稿检查退出码1的历史记录不再代表当前状态。

## 文字确认后的恢复顺序

1. 已按维护者指令确认现有精校文字并通过就绪检查，不再等待逐句听校。
2. `pnpm eval:asr` 重算已确认精校文本的文字指标；现有模型输出缓存若存在且与输入/配置相符才可复用。本轮确认前未找到此前输出，现已重新生成两种主要模型×两段素材的4份缓存及report.md/report.json；其余模型尚未重跑，历史数字仍不能冒充本轮结果。
3. 生成参考字词对齐时间，并人工抽查至少50处。对齐工具生成的时间不是独立人工真值，报告需披露偏差。
4. 补齐字词起止误差（整体/单字语气词）及时间窗口语气词召回的评测。现有语气词实现按文本对齐统计，尚不等同研究计划的±0.5秒时间窗口口径；两种结果不可混称。
5. 综合正式CER、语气词和时间误差，再提出默认模型与是否需要强制对齐的结论，完成调研报告后交维护者确认。

现有 `--allow-draft` 仅供排查，报告必须保持provisional，不能作为正式排名、默认模型或解锁字词剪切的依据。

## 本机环境盘点

2026-11-08只读检查：sidecar、FFmpeg、FSMN VAD和两段主素材均已存在；以下五个模型目录存在（未因目录存在而宣称本轮推理成功）：

- SenseVoice small int8。
- Paraformer zh int8 2023-09-14。
- Paraformer zh int8 2024-03-09。
- Whisper small multilingual。
- FireRedASR large zh_en 2025-02-16。

TeleSpeech、Zipformer CTC继续按已有维护者决定排除。Cloud和独立FunASR服务的真实可用性本轮未探测；没有有效配置时保持未测。

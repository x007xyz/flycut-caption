# 真实场景测试素材

素材清单在 [`tests/media.manifest.json`](../tests/media.manifest.json)，文件本身不入库（`tests/media/` 已 gitignore）。

```bash
pnpm fetch:test-media
```

这条命令会下载 Commons 素材，并按 `clips` 切出测试片段。视频片段用流复制，保留原始编码；参考音频转成 24kHz 单声道 WAV。依赖 X 视频（`external`）的片段需要先按清单里的 `fetch` 命令手动下载，否则会跳过。

- `tests/media/SOURCES.md`：出处与许可，脚本生成。
- `tests/media/baselines/*.json`：SenseVoice（`language=auto`、FSMN VAD）识别结果，用作回归对照。

下文路径都相对 `tests/media/`。

## 1. ASR

| 文件 | 语言 | 时长 | 测什么 |
|---|---|---|---|
| `nasa/nasa-kepler-452b-briefing.webm` | en | 1.7 分钟 | 单人旁白、录音室音质，冒烟用 |
| `zh-press/zh-mfa-briefing-2021-04-08.webm` | zh | 5.9 分钟 | 单人、语速快、书面语 |
| `zh-press/zh-consulate-ny-press.webm` | zh | 1.9 分钟 | 新闻旁白 + 现场发言 |
| `clips/asr/en-apollo11-noisy-3min.webm` | en | 3 分钟 | 1969 年老录音、噪声 |
| `clips/asr/en-punch-phone-3min.webm` | en | 3 分钟 | 电话会议窄带音质、数字（0.1%、99.9%） |
| `clips/asr/en-wikimania-accents-3min.webm` | en | 3 分钟 | 多口音、口头语 |
| `clips/asr/zh-podcast-3min.mp4` | zh | 3 分钟 | 口语、语气词、数字（6 位数 / 1 万块） |
| `nasa/nasa-punch-teleconference.webm` | en | 28 分钟 | 长音频性能、多人问答 |
| `external/x-isnail-2115609565043597572.mp4` | zh | 46 分钟 | 长音频性能、多人对谈 |

用这批素材发现并已修复的问题（sidecar 的 `assemble_word_chunks` / `join_word_texts`，前端的 `shared/text/joinWords.ts`）：

- 英文句子 `chunks[].text` 里的空格全部丢了，例如 `NASA'sKeplermission...`。
- 英文 `wordChunks` 是按子词切的（`N`、`A`、`S`、`Ke`、`pl`…），不是按单词。
- 小数和千分位会被断句切开：`0.` / `1%`、`1,` / `400`。中文结果里的 `2.1%` 也一样。

仍然存在的问题：

- 整段没有人声时，sidecar 直接报"未检测到语音段"并以退出码 1 退出，没有返回空结果。

## 2. 删除静音

项目里的删除静音是根据 ASR 句子之间的空隙计算的（`smartCutSilenceThreshold` 默认 1.5s），不是按音量判断。下表里，"能量静音"是 `ffmpeg silencedetect=-35dB:d=1.5` 测出来的，"ASR 空隙"来自基线。

| 文件 | 能量静音 | ASR 空隙 ≥1.5s | 预期 |
|---|---|---|---|
| `clips/silence/en-wikimania-gaps-2.5min.webm` | 6 段 | 5 段 / 19s | 删除轮流发言之间的停顿 |
| `clips/silence/en-punch-tail-2min.webm` | 结尾 33s | 1 段 + 尾部 | 删除结尾静音 |
| `zh-press/zh-cppcc-press-2020.webm` | 无 | 4 段 / 42s | 有底噪但没有人声的片段也要删掉 |
| `vlog/en-vlog-china-shamian.webm` | 无（全程背景音乐） | 40 段 / 793s | 21 分钟里只有约 6 分钟人声：有音乐盖着也要删 |
| `clips/silence/zh-airport-ambient-4min.webm` | 多段 | 只识别出 4 句 | 几乎整段都会被删，界面要能正常处理 |
| `clips/silence/zh-airport-no-speech-3.5min.webm` | 有 | —— | 完全没有人声。sidecar 目前报"未检测到语音段"并退出码 1，应改成返回空结果并给出友好提示 |
| `zh-press/zh-mfa-briefing-2021-04-08.webm` | 无 | 4 段 / 9s | 对照组：几乎不应删除 |

## 3. 翻译与双语字幕

| 文件 | 方向 | 说明 |
|---|---|---|
| `nasa/nasa-kepler-452b-briefing.webm` | en → zh | 专有名词：Kepler-452b、Cygnus（ASR 识别成了 Cygness） |
| `clips/asr/en-wikimania-accents-3min.webm` | en → zh | 口语短句多，测断句后的翻译对齐 |
| `zh-press/zh-consulate-ny-press.webm` | zh → en | 人名、机构名（黄屏，ASR 识别成了"黄平"） |
| `clips/asr/zh-podcast-3min.mp4` | zh → en | 口语、俚语 |
| `vlog/zh-vlog-film-making.webm` | zh → en | 中新网剪辑片，画面里可能已经压了中文字幕，测副字幕的位置避让 |

建议的流程：先删除几句话或一段静音，再导出双语的 SRT 和 MP4，检查主字幕和副字幕的时间轴是否仍然对齐。

目前缺少真正的中英混说素材：`en-vlog-china-shamian` 里的中文很少，识别出来也是乱码，不适合拿来测这一项。

## 4. 换语言配音（IndexTTS 类）

用参考音色合成目标语言的语音，再替换原声。参考音频是 8–9 秒、单个说话人的干净片段。

| 原视频 | 参考音色 | 方向 |
|---|---|---|
| `nasa/nasa-kepler-452b-briefing.webm` | `clips/dub/ref-en-kepler-narrator.wav` | en → zh，旁白类，最容易 |
| `clips/dub/zh-mfa-spokesperson-1min.webm` | `clips/dub/ref-zh-mfa-spokesperson.wav` | zh → en，单人正式讲话 |
| `clips/dub/zh-podcast-host-1min.mp4` | `clips/dub/ref-zh-podcast-host.wav` | zh → en，口语语速快，测时长对齐 |

需要检查：

- 译文语音比原句长或短时，怎么处理（变速，还是调整片段）。
- 背景声要保留，只替换人声。
- 口型不同步可以接受，但每句的起止时间要和字幕一致。

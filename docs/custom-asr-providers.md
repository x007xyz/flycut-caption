# 自定义 ASR 模型与 Provider

桌面版现在按模型的 `provider` 选择推理程序。下载源的 `download_sources[].provider`
仅标记镜像来源，与推理 Provider 无关。

| Provider | 模型格式 | 运行环境 |
| --- | --- | --- |
| `sherpa-onnx` | 当前 sidecar 支持的 ONNX family | 内置 `funasr-asr`、FFmpeg 和 VAD |
| `qwen-asr` | 官方 qwen-asr 包使用的 Qwen3-ASR 0.6B / 1.7B 检查点 | 用户安装的 Python、`qwen-asr`，以及内置 FFmpeg |

旧版 models.json 不填写 `provider` 时默认使用 `sherpa-onnx`。浏览器版继续使用
Transformers.js；此功能不把 Python 模型放到浏览器执行。除了本地模型，也可以把识别
交给远程 ASR API（见“ASR API”一节），此时不下载任何本地权重。

## 使用 Qwen-ASR

1. 按 [Qwen 官方说明](https://github.com/QwenLM/Qwen3-ASR#environment-setup)
   创建独立 Python 环境并安装 `pip install -U qwen-asr`。官方建议 Python 3.12。
2. 在桌面版的设置 → 模型列表 → **自定义模型 / Provider** 中选择 0.6B 或 1.7B 模板。
3. 两种方式任选其一：
   - 已自行下载模型：选择包含 config、tokenizer、权重的完整本地目录。
   - 应用内下载：本地目录留空，添加配置后点击模型卡片的“下载”。可在 JSON 中修改下载镜像前缀。
4. 如果 Python 不在应用的 PATH 中，填写环境内 Python 可执行文件的绝对路径。
   macOS 桌面应用通常不会继承终端激活的虚拟环境。
5. 点击“检查运行环境”，然后在卡片点击“使用此模型”，或者在识别选项中选择模型。
   本地目录导入成功时会自动选中该模型。

检查运行环境会验证文件存在并导入 Python 依赖；完整加载及内存、设备兼容性仍在首次识别时确认。
Qwen 推理以离线模式读取本地文件，不会在识别时自动补下缺失权重。
`device` 默认 `auto`（有 CUDA 时用 CUDA，否则 CPU），也可显式配置 `cpu`、`mps`、`cuda:0`。
MPS 取决于当前 PyTorch 与模型算子的兼容性；CPU 更通用，大模型在 CPU 上较慢。

模板对应官方 [0.6B 文件](https://huggingface.co/Qwen/Qwen3-ASR-0.6B/tree/main)
和 [1.7B 文件](https://huggingface.co/Qwen/Qwen3-ASR-1.7B/tree/main)。
`*-hf` 原生 Transformers 检查点是另一种集成方式，不属于该 Provider 模板。

## 时间戳与剪切能力

没有对齐模型时，音频按最多 25 秒窗口识别，字幕时间范围采用音频窗口边界，
属于粗粒度分段字幕，并非句子或字词的精确边界。窗口边界可能切开词语，暂不做重叠合并。

要精细剪切，按官方说明另行下载 `Qwen/Qwen3-ForcedAligner-0.6B`，
填写本地 ForcedAligner 目录。该模型支持的语言比 ASR 少，具体见官方文档。
Provider 使用其真实 `start_time` / `end_time`，加上音频窗口偏移，输出编辑器的
`wordChunks`、`sentenceId` 和 `wordIds`。只有全部非空字幕段都有有效对齐数据时，
才设置 `hasWordTimestamps=true`。不会均分句子时间来伪造字词时间戳。
模型清单中的自定义能力声明不会直接开启字词剪切，实际能力以识别结果为准。

## 自定义其他模型

展开“模型清单 JSON”编辑模型定义。可复制已有 ONNX 模型清单，改为
`provider: "sherpa-onnx"`，保留与 sidecar 匹配的 `family` 和 `recognizer_config`。
支持 sense_voice、paraformer、whisper、moonshine、telespeech_ctc、zipformer_ctc、
nemo_transducer、fire_red_asr。任意架构不能仅靠更换模型 ID 接入，需要新增推理适配器。

- 自定义 ID 必须以 `custom-` 开头，只允许字母、数字、`-`、`_`，且不能重复。
- `files` 必须完整列出权重、tokenizer 等必需文件。嵌套相对路径可用，绝对路径和 `..` 不可用。
- 自定义下载源仅支持 HTTP(S) 文件目录前缀，`download_mode` 必须为 `files`。
  例如 `https://huggingface.co/Qwen/Qwen3-ASR-0.6B/resolve/main/`。
- 下载检查 HTTP 错误、HTML 页面、空文件、响应长度；当前不支持自定义 SHA256 校验，
  `sha256` 请使用 `null`。请选用可信模型源。
- 新 Provider 在 `model_manifest::ASRProvider` 注册，并在 `asr_provider.rs` 实现适配，
  返回统一 `TranscriptResult`。当前没有任意用户脚本或 shell 命令执行接口。

配置存储在 Tauri 用户数据目录下的 `custom-models.json`，下载文件存于 `models/<id>/`。
导入后即时生效。外部本地目录只作引用；“移除配置”保留原始文件与已下载文件。
修改配置可先移除再添加。原生 Provider 名称通过模型元数据管理；现有
`funasr-tauri` 前端引擎 ID 和 Tauri command 名称保留兼容，内部根据模型分发。

## 本地模型文件夹

设置 → 模型列表 → **本地模型文件夹** 可以把一个已有的模型根目录整体登记进来：

- 根目录会被规范化（解析符号链接）；向下最多扫描 6 层、2000 个目录，跳过隐藏目录，
  不跟随目录符号链接。
- 扫描只登记路径，不复制、不移动、也不加载权重；识别时才加载当前选中的模型。
- 识别规则按目录内容判断，不靠 `model.onnx` + `tokens.txt` 这种通用文件名猜测架构：
  - `flycut-model.json` 描述文件优先，格式与自定义模型清单一致；
  - `config.json` 中 `model_type` / 架构含 forced_aligner 时识别为**对齐模型**；
    `architectures` 或 `model_type` 指向 Qwen 系列时识别为 Qwen ASR，并检查
    `model.safetensors` 或分片索引里的权重文件；
  - sherpa-onnx 目录按官方解压目录名匹配清单中的 `extract_dir` / 模型 ID，
    校验权重与 tokenizer 是否齐全；
  - 只含 VAD 文件（`silero_vad.onnx`、`vad.onnx`、`vad.mvn`）的目录标记为 VAD 资源，
    当前不会被当作 ASR 加载；
  - 看起来像模型但缺文件或不认识的目录会显示“不支持或文件不完整”，并说明原因。
- 扫描结果的 ID 由目录路径稳定生成（`custom-folder-…`），重复扫描同一目录不会重复登记；
  已登记的目录会显示“已添加”。
- 勾选后“添加所选模型”写入 `custom-models.json`，随即出现在模型列表，可直接选用。
  添加时可以为 Qwen 模型统一填写 Python 路径与 ForcedAligner 目录。
- 根目录记录在用户数据目录的 `model-library.json`，下次打开面板时自动回填。

推荐清单（设置 → 模型列表 → **推荐模型与下载指引**）只提供官方下载入口和适配方向，
不代替用户下载。列表覆盖 SenseVoice、Paraformer、Whisper、Qwen3-ASR 与
Qwen3-ForcedAligner、FSMN VAD / Silero VAD，并注明各自的时间戳能力。
推荐不等于已验证：识别质量、语言支持和速度仍需用自己的音频确认。

## ASR API（OpenAI 兼容）

## 客户端 Python Runtime

桌面客户端会自动启动“Python 本地服务”作为主要识别来源。开发环境也可以手动启动：

```sh
pnpm runtime:dev
```

服务默认监听 `http://127.0.0.1:8765`。客户端将 Tauri 模型清单中的本地模型同步到
Runtime，然后提交本地媒体转换后的音频数据。模型权重、Python 推理和 FFmpeg 都留在
本机。Runtime 执行受控的 qwen-asr runner 或 sherpa-onnx sidecar，不接受任意 shell
命令。识别通过异步 job API 执行，客户端轮询任务状态。

设置 → **ASR API 配置** 可添加任意 OpenAI 兼容的 `/audio/transcriptions` 服务；
识别选项里的“识别来源”可以在本地模型和已保存的 API 配置之间切换。

| 配置项 | 说明 |
| --- | --- |
| Base URL | 会自动补上 `/audio/transcriptions`；也可直接填写完整接口地址 |
| 模型名称 | 原样作为 `model` 字段发送 |
| API Key | 只留在当前进程内存，**不写入 localStorage**，重启后需重填 |
| 时间戳格式 | `word` 请求 segment + word；`segment` 只请求 segment；`none` 只取纯文本 |
| 请求超时 | 10～600 秒，单段请求级超时，不整段重试 |

传输与安全规则：

- 只允许 HTTPS；`localhost`、`127.0.0.1`、`::1` 可用 HTTP。
- URL 不能携带账号密码、查询参数或锚点，避免把密钥写进地址。
- 桌面版由 Rust 侧上传（`transcribe_asr_api`），不受浏览器 CORS 限制；
  浏览器版直接 `fetch`，需要服务允许 CORS。
- 桌面版用 FFmpeg 转 16 kHz 单声道并按 300 秒分段；浏览器版 5 分钟一段。
  单段音频上限 24 MB，响应体上限 16 MB，超出即报错而不是截断。
- 已计费的请求不会自动重试；HTTP 失败只显示状态码，不回显服务端响应体。

时间戳能力：

- 只接受完整、递增、落在音频时长内的片段/词级时间；重叠、越界或倒序的条目会被丢弃。
- 词级时间必须覆盖所有字幕段：缺一个就整体降级为分段字幕，
  `hasWordTimestamps=false`，编辑器随之关闭按词精剪，不会均分句子时间来伪造时间。
- `none` 模式生成单段粗粒度字幕（0 → 音频时长），仅用于出文字稿。

失败信息会区分超时、无法连接、HTTP 状态码、非 JSON 响应和缺少有效字段，
便于判断是网络、密钥、模型名还是输出格式的问题。

## 验证

```sh
node --test tests/custom-model-catalog.test.mjs tests/asr-api-protocol.test.mjs
python3 -m unittest discover -s tests -p 'test_qwen_asr_runner.py'
cargo test --manifest-path src-tauri/Cargo.toml --lib commands::custom_models::tests
cargo test --manifest-path src-tauri/Cargo.toml --lib commands::asr_api
pnpm build:funasr-sidecar
cargo check --manifest-path src-tauri/Cargo.toml
pnpm tsc -b --noEmit
pnpm lint
```

清单、转换和 API 协议测试都不需要下载大模型，也不发网络请求：它们只覆盖路径校验、
响应解析、时间戳降级和多段合并。真实 Qwen 识别需安装 Python 依赖、下载完整权重；
真实 API 识别需一个可用的转写服务和密钥，并用实际音频验证识别质量与硬件兼容性，
模型文件夹扫描需要在真实模型目录上人工确认一次。

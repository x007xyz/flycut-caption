> 当前 Python Runtime 是 Cordis Host 的内部 worker。前端通过 Host RPC 调用，不再直接连接 8765。下文保留 worker 协议供开发与诊断使用；启用内部令牌时请求必须携带 Authorization。当前架构见 [architecture-current.md](architecture-current.md)。

# Python Runtime API

The browser build talks to a local process at `http://127.0.0.1:8765`.

## Health and models

```http
GET /health
GET /v1/models
GET /v1/models/discover
POST /v1/models/register
Content-Type: application/json

{"id":"custom-qwen3-asr","name":"Qwen3-ASR","provider":"qwen-asr","path":"/models/Qwen3-ASR-0.6B","config":{"device":"auto"}}
```

浏览器版不负责选择或上传本机模型。Runtime 启动后直接读取默认目录中的
`models.json`；Web 只通过 `/v1/models` 读取清单并提交模型 ID。目录和清单位置可通过
`GET /v1/runtime/config` 查看，但 Web 只把它作为提示展示。

桌面客户端可以使用原生目录选择器和 JSON 编辑器修改这些配置。`upload-file` 和
`commit` 接口仍作为受控导入能力保留给未来的管理工具，不作为 Web 主流程。

更推荐让 Runtime 扫描本机模型根目录。根目录由 `FLYCUT_MODEL_ROOTS` 配置（多个目录用
系统路径分隔符连接），默认扫描 `~/.flycut-caption/models` 和 `~/models`。浏览器调用
`GET /v1/models/discover` 得到候选模型，再用候选 ID 登记；绝对路径只在 Runtime 内部
使用，不返回给 Web UI。

Only model IDs beginning with `custom-` and existing directories are accepted.
The runtime dispatches `funasr` to the official Python FunASR `AutoModel`,
`qwen-asr` to the Python Qwen runner and
`sherpa-onnx` to the packaged `funasr-asr` sidecar (override its path with
`FLYCUT_FUNASR_SIDECAR`).
The runtime stores the catalog under `FLYCUT_RUNTIME_HOME` (default:
`~/.flycut-caption/models.json`).

## Transcription jobs

The request body is a 16 kHz mono WAV. Metadata is carried in headers so the
runtime has no multipart dependency:

```http
POST /v1/asr/jobs
Content-Type: audio/wav
X-Flycut-Model: custom-qwen3-asr
X-Flycut-Language: zh
```

The response is `202` with a job ID. Poll `GET /v1/asr/jobs/{id}` until the
status is `complete` or `error`; the complete response contains the same
`SubtitleTranscript` shape used by the browser and Tauri engines.

The service invokes only registered Provider adapters. Model configuration is
data, and the browser cannot submit shell commands.

## FunASR：选择主模型和配套模型

使用启动 Runtime 的同一 Python 环境安装依赖，并确保 FFmpeg 在 PATH 中（或设置
`FFMPEG_PATH`）。推荐 Python 3.11，并用虚拟环境避免影响其他 ASR 依赖：

```sh
python3.11 -m venv .venv-funasr
.venv-funasr/bin/python -m pip install -r python/requirements-funasr.txt
.venv-funasr/bin/python python/funasr_runner.py --check
.venv-funasr/bin/python python/flycut_runtime.py
```

推理子进程默认继承 Runtime 的 Python 解释器；`FLYCUT_PYTHON` 可以覆盖它。
`--check` 只验证 FunASR 导入，不会加载权重或验证具体模型组合。

参考 `python/models.funasr.example.json`，将需要的条目合并到
`~/.flycut-caption/models.json`，并将示例路径替换为实际下载目录。
每个条目对应一套独立模型组合；界面的「Python Runtime 模型」刷新后即可选择。
主模型必须是 FunASR Python 格式，例如 Paraformer 或 SenseVoice 的完整 checkpoint，
不能使用 sherpa-onnx 的 int8 ONNX 目录。

`config` 支持：

| 字段 | 用途 |
| --- | --- |
| `device` | 默认 `cpu`；也支持 `cuda` / `cuda:N` |
| `vad_model` | 可选，本地 FSMN-VAD checkpoint 目录 |
| `punc_model` | 可选，本地 CT-Punc checkpoint 目录 |
| `spk_model` | 可选，本地 CAM++ checkpoint 目录；需要 VAD |
| `batch_size_s` | FunASR 批量音频时长，默认 60 秒，上限 600 秒 |
| `hotword` | 可选，模型支持时使用的热词字符串 |

未设置的辅助模型不会加载。当前适配器只接受本地模型目录，不自动下载模型，
也不启用 `trust_remote_code`。需要自定义 Python 模型代码的 checkpoint
（例如部分 Fun-ASR-Nano 版本）尚不在此适配器的支持范围内。
Paraformer + FSMN-VAD + CT-Punc + CAM++ 是首选验证组合；
其他主模型不保证支持相同的时间戳或说话人流程。

FunASR 的毫秒时间戳转换为字幕协议的秒。`sentence_info[].spk` 保存在句段和字词的
`speaker` 字段中（例如 `SPEAKER_0`），字幕编辑器显示该编号，不将它写进字幕正文。
这些编号只在当前录音内有效。请求了说话人模型却未返回说话人结果时，任务明确报错。

只有模型实际返回时间戳且能与全部句段的文本字词对应时，才设置
`hasWordTimestamps=true`。缺少时间戳时保留粗粒度整段范围；不会通过插值构造逐字时间。

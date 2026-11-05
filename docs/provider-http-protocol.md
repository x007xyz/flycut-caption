# FlyCut Provider 协议 v1

用自己的模型接入 FlyCut，不需要改 FlyCut 代码：运行一个实现本协议的 HTTP 服务，在「设置 → 模型 → 添加服务」里填写地址即可。服务可以跑在本机，也可以跑在局域网或云上的 GPU 机器。

[FunASR Provider](https://github.com/x007xyz/flycut-funasr-provider)（`funasr_service.py`）就是本协议的一个完整实现，可以直接当作模板；内置的 FlyCut Cloud 也使用本协议。架构上的位置见 [subsystems/providers.md](subsystems/providers.md)。

## 约定

- 所有路径以 `/v1/` 开头，请求和响应都是 UTF-8 JSON（音频上传除外）。
- 鉴权可选：配置了 API Key 时，Host 每个请求都带 `Authorization: Bearer <key>`。
- 错误统一返回非 2xx 状态码和 `{ "error": "可读的错误信息" }`。错误信息会展示给用户，不要带密钥或服务器路径。
- 耗时操作（识别、模型下载）都是异步任务：创建时返回 `202 { "id": "<job-id>" }`，Host 轮询任务状态，用户取消时调用取消接口。

## 接口

### 健康检查与版本

```http
GET /v1/health
```

```json
{ "protocol": "flycut-provider", "version": 1, "name": "FunASR", "capabilities": ["asr"] }
```

`protocol` 和 `version` 必须匹配，否则 Host 拒绝接入并提示版本不兼容。`capabilities` 列出服务实现了哪些能力接口，当前定义的只有 `asr`。

### 模型列表

```http
GET /v1/models
```

```json
{
  "models": [
    {
      "id": "paraformer-zh",
      "name": "Paraformer 中文",
      "role": "asr",
      "languages": ["zh"],
      "timestampLevel": "word",
      "size": "950 MB",
      "status": "download",
      "options": {
        "vad": { "type": "select", "label": "VAD", "default": "fsmn-vad",
                 "options": [{ "value": "fsmn-vad", "label": "FSMN-VAD" }, { "value": "none", "label": "不使用" }] },
        "hotword": { "type": "string", "label": "热词", "description": "空格分隔" }
      }
    }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 服务内唯一，只含字母、数字、`.`、`-`、`_`、`+`，最长 100 |
| `name` | 是 | 展示名 |
| `role` | 是 | `asr`、`vad`、`punc`、`speaker`、`align`、`tts` 之一。只有 `asr` 会出现在识别模型列表里，其余是可被选项引用的配套模型 |
| `languages` | 否 | 支持的语言代码；包含 `auto` 表示能自动识别语言。缺省视为只支持 `auto` |
| `timestampLevel` | 否 | `none`、`segment`、`word`，是模型**通常**能给出的级别，仅用于界面提示 |
| `size` | 否 | 展示用的大小文本 |
| `status` | 是 | `ready` 可直接使用；`download` 需要先下载；`unavailable` 不能使用（同时给出 `reason`） |
| `reason` | 否 | `unavailable` 的原因，例如缺少依赖 |
| `options` | 否 | 识别时可调的选项，字段定义见下表 |

选项字段：

| 字段 | 说明 |
|---|---|
| `type` | `string`、`number`、`boolean`、`select` |
| `label` / `description` | 界面文案 |
| `default` | 默认值，用户不改时 Host 不发送该选项 |
| `options` | `select` 的候选值 `[{ value, label }]` |
| `min` / `max` / `step` | `number` 的范围 |

### 下载模型（可选）

`status` 为 `download` 的模型需要实现这个接口；所有模型都随服务就绪时可以不实现。

```http
POST /v1/models/{id}/prepare
→ 202 { "id": "<job-id>" }
```

任务完成后，该模型在 `/v1/models` 中变为 `ready`。

### 创建识别任务

请求体是 **16 kHz、单声道、16 位 PCM 的 WAV**，由 Host 用 FFmpeg 转好，服务不需要处理视频或其他格式。参数放在请求头里，避免 multipart 依赖：

```http
POST /v1/asr/jobs
Content-Type: audio/wav
X-Flycut-Model: paraformer-zh
X-Flycut-Language: zh
X-Flycut-Options: {"vad":"fsmn-vad","hotword":"飞剪 字幕"}

<wav bytes>
→ 202 { "id": "<job-id>" }
```

- `X-Flycut-Language` 是语言代码或 `auto`。
- `X-Flycut-Options` 是 JSON 对象，只包含模型声明过的选项；服务遇到未声明的选项应返回 `400`。HTTP 头只能放 ASCII，所以非 ASCII 字符（例如中文热词）会以 `\uXXXX` 转义，标准 JSON 解析器能直接还原。
- 音频上限 500 MB，超过时服务返回 `413`。

### 查询和取消任务

```http
GET /v1/jobs/{id}
```

```json
{ "id": "…", "status": "running", "progress": 42, "message": "识别中" }
```

| 字段 | 说明 |
|---|---|
| `status` | `queued`、`running`、`complete`、`error`、`cancelled` |
| `progress` | 0–100，可选 |
| `message` | 当前阶段的可读描述，可选 |
| `result` | `complete` 时必填：识别任务为字幕结果，下载任务可省略 |
| `error` | `error` 时必填 |

```http
POST /v1/jobs/{id}/cancel
→ 200 { "id": "…", "status": "cancelled" }
```

完成、失败或取消的任务至少保留 10 分钟，之后服务可以清理。

## 识别结果

```json
{
  "text": "大家好 今天介绍飞剪",
  "language": "zh",
  "duration": 5.2,
  "chunks": [
    { "id": "s0", "text": "大家好", "timestamp": [0.12, 0.98], "speaker": "SPEAKER_0", "wordIds": ["w0", "w1", "w2"] }
  ],
  "wordChunks": [
    { "id": "w0", "text": "大", "timestamp": [0.12, 0.40], "sentenceId": "s0" }
  ],
  "hasWordTimestamps": true
}
```

- 时间单位是**秒**，`timestamp` 为 `[开始, 结束]`，必须 `0 ≤ 开始 < 结束 ≤ duration`，句段按开始时间递增。
- `speaker` 可选，是当前录音内的匿名编号（如 `SPEAKER_0`），不代表真实身份。
- 只有每个句段都有真实、递增、落在句段范围内的字词时间戳时，才返回 `wordChunks` 并设置 `hasWordTimestamps: true`。**不要**按字数均分句子时间来伪造字词时间戳。
- 没有可靠字词时间戳时省略 `wordChunks`、`wordIds`，`hasWordTimestamps` 设为 `false`。

Host 会再校验一次：越界、倒序、重叠的句段直接判为失败；字词时间戳有任何一处不合规，整份结果降级为句段级（关闭按字精剪），不会因为服务声明了 `word` 就开启。

## 安全与部署

- Host 只向用户填写的地址发请求，不跟随重定向。
- `server` Profile（Host 部署在远程）默认不允许填写回环和内网地址，避免 Host 被当成访问内网的跳板；需要时由部署者在 Profile 补丁里放开。
- API Key 只保存在 Host 进程内存里，重启后需要重新填写；服务地址等其他配置保存在 Host 数据目录。

## 用 OpenAI 兼容服务接入

已有 OpenAI 兼容 `/audio/transcriptions` 接口的服务（各家云 ASR、自建 whisper 服务等）不需要实现本协议，添加服务时把协议选为「OpenAI 兼容」，并填写模型名和时间戳级别即可。细节见 [custom-asr-providers.md](custom-asr-providers.md)。

# 接入自己的 ASR 模型

FlyCut 的模型都由 Provider 提供（规范见 [subsystems/providers.md](subsystems/providers.md)）。内置的 sherpa-onnx 随应用发布，在「设置 → 模型」里点下载即可使用；FunASR 是一个现成的 HTTP Provider，接入方法见 [funasr-provider.md](funasr-provider.md)。

想用内置列表以外的模型，有两种方式，都**不需要修改 FlyCut 代码**：

| 你手上有 | 做法 |
|---|---|
| 自己的模型或推理代码 | 包一个实现 [FlyCut Provider 协议](provider-http-protocol.md) 的 HTTP 服务，在 FlyCut 里添加该服务 |
| 已有的 OpenAI 兼容转写服务 | 直接添加，协议选「OpenAI 兼容」 |

> 旧版本的「自定义模型 JSON」和「本地模型文件夹扫描」已经移除。升级后旧的 `custom-models.json` 不再读取，模型文件本身不会被删除；需要继续使用的模型请改用 HTTP 服务接入。

## 添加服务

设置 → 模型 → **添加服务**：

| 配置项 | 说明 |
|---|---|
| 名称 | 只含小写字母、数字、`-`，会成为 Provider ID 的一部分（如 `flycut:gpu-box`） |
| 协议 | `FlyCut Provider` 或 `OpenAI 兼容` |
| 地址 | 服务根地址，例如 `http://192.168.1.20:9000`。FlyCut 协议填根地址；OpenAI 兼容会自动补上 `/audio/transcriptions`，也可以直接填完整接口 |
| API Key | 可选。只保存在 Host 进程内存里，重启后需要重填 |
| 模型（仅 OpenAI 兼容） | 模型名（原样作为 `model` 字段发送）和时间戳级别；FlyCut 协议的模型由服务的 `/v1/models` 提供 |

保存后，服务的模型会出现在模型列表里，和内置模型一样选用。

## 写一个 FlyCut Provider 服务

最快的起点是复制 [flycut-funasr-provider](https://github.com/x007xyz/flycut-funasr-provider) 的 `funasr_service.py`：它只依赖 Python 标准库的 HTTP 服务器，协议相关的部分（任务表、轮询、取消、结果格式）都可以照搬，只需要替换「加载模型」和「识别」两段。

必须实现的接口：`GET /v1/health`、`GET /v1/models`、`POST /v1/asr/jobs`、`GET /v1/jobs/{id}`、`POST /v1/jobs/{id}/cancel`。需要在 FlyCut 里点下载的模型再实现 `POST /v1/models/{id}/prepare`。完整定义见 [provider-http-protocol.md](provider-http-protocol.md)。

自测：

```bash
curl http://127.0.0.1:9000/v1/health
curl http://127.0.0.1:9000/v1/models
curl -X POST http://127.0.0.1:9000/v1/asr/jobs -H 'Content-Type: audio/wav' \
  -H 'X-Flycut-Model: my-model' -H 'X-Flycut-Language: auto' --data-binary @sample-16k.wav
curl http://127.0.0.1:9000/v1/jobs/<job-id>
```

## OpenAI 兼容服务

传输与安全：

- 只允许 HTTPS；`localhost`、`127.0.0.1`、`::1` 可用 HTTP。
- URL 不能带账号密码、查询参数或锚点，避免把密钥写进地址。
- Host 把音频转成 16 kHz 单声道后按 300 秒分段上传，单段上限 24 MB，响应上限 16 MB，超出直接报错。
- 已计费的请求不会自动重试；HTTP 失败只显示状态码，不回显服务端响应体。

时间戳级别：

| 级别 | 请求 | 结果 |
|---|---|---|
| `word` | `verbose_json` + segment + word | 字词时间戳覆盖全部句段时才开启按字精剪，否则降级为句段 |
| `segment` | `verbose_json` + segment | 句段字幕 |
| `none` | `json` | 一整段字幕（0 → 音频时长），只适合出文字稿 |

失败信息会区分超时、无法连接、HTTP 状态码、非 JSON 响应和缺少有效字段。

## 验证

```bash
pnpm test:architecture
node --test tests/asr-api-protocol.test.mjs
```

协议和解析测试不下载模型、不发外部请求。真实服务需要用实际音频验证识别质量和时间戳。

# Python Worker

Python 不是独立的服务端，而是 Host 管理的推理进程。前端只通过 Host RPC 使用它们，不直接连接 Python 端口。Provider 的整体规则见 [subsystems/providers.md](subsystems/providers.md)。

| 脚本 | Provider | 运行方式 |
|---|---|---|
| `python/funasr_service.py` | `funasr` | 常驻 HTTP 服务，实现 [FlyCut Provider 协议 v1](provider-http-protocol.md)：ASR、VAD、标点、说话人识别，模型从 ModelScope 下载并常驻内存 |
| `python/qwen_asr_runner.py` | `qwen-asr` | 每次识别由 Host 启动一个子进程，stdout 输出一份字幕 JSON；取消即结束进程 |

sherpa-onnx 模型不经过 Python，由 Host 直接调用 `funasr-asr` sidecar。

## 启动与连接

Host 在第一次需要时用随机端口启动 FunASR 服务，并生成仅本次有效的内部令牌（`Authorization: Bearer`）。服务启动时只用标准库，没装 funasr 也能回应，模型会标为不可用并说明缺什么。相关环境变量：

| 变量 | 作用 |
|---|---|
| `FLYCUT_PYTHON` | 启动 FunASR 服务的 Python 解释器，缺省 `python3`（Windows 为 `python`） |
| `FLYCUT_QWEN_PYTHON` | 运行 Qwen runner 的 Python（需安装 `qwen-asr`），缺省同 `FLYCUT_PYTHON` |
| `FLYCUT_FUNASR_DEVICE` | FunASR 推理设备，缺省有 CUDA 用 `cuda:0`，否则 `cpu` |
| `FLYCUT_FUNASR_URL` / `FLYCUT_FUNASR_TOKEN` | 连接已有的 FunASR 服务，不再由 Host 启动 |
| `FLYCUT_FUNASR_HOME` | FunASR 模型缓存目录，缺省 `<Host home>/funasr` |

手动运行 FunASR 服务（开发或部署到 GPU 机器）：

```sh
python3.11 -m venv .venv-funasr
.venv-funasr/bin/python -m pip install -r python/requirements-funasr.txt
.venv-funasr/bin/python python/funasr_service.py --host 0.0.0.0 --port 9000 --token <随机字符串>
```

然后在 Host 上设置 `FLYCUT_FUNASR_URL=http://<机器>:9000`、`FLYCUT_FUNASR_TOKEN=<同一个字符串>`，或者在界面里把它当作 FlyCut Provider 服务添加。

## 安全

- worker 只接受协议规定的路由，模型 ID 必须来自它自己的 `/v1/models`，不接受客户端传来的路径或命令。
- FunASR 只从 ModelScope 下载内置列表中的模型，不启用 `trust_remote_code`。
- 本机托管时监听 `127.0.0.1`；对外部署时务必设置 `--token`。

## 取消

Qwen 识别是子进程，取消立即生效。FunASR 模型常驻在服务进程里，`generate` 调用无法中途打断：取消后 Host 立即结束任务，服务端在当前步骤（下载一个模型、识别一个 SenseVoice 片段或整段 Paraformer）结束后丢弃结果，在此之前下一个识别任务会排队等待。

## 时间戳与说话人

两个脚本都遵守协议里的结果规则：时间单位是秒；只有模型真实返回且能与文本逐字对应的时间戳才作为字词时间戳，不插值；说话人编号（`SPEAKER_0`）只在当前录音内有效，写在 `speaker` 字段，不写进字幕正文。

## 验证

```bash
python3 -m unittest discover -s tests -p 'test_*.py'
```

单元测试不加载模型。真实识别需要安装依赖、下载模型后用 demo 素材跑一遍，见 [subsystems/providers.md](subsystems/providers.md) 的验证要求。

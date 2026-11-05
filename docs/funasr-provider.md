# 接入 FunASR（Python）

FlyCut 安装包只内置 sherpa-onnx 离线识别，不带 Python。如果你需要以下任一能力，就自己运行 [FlyCut FunASR Provider](https://github.com/x007xyz/flycut-funasr-provider)，再在 FlyCut 里把它添加为服务：

- Qwen3-ASR、Fun-ASR-Nano
- Paraformer 说话人识别
- 用 GPU 识别

它是一个 Python 服务，用官方 `funasr.AutoModel` 实现 [FlyCut Provider 协议](provider-http-protocol.md)。可以跑在本机，也可以跑在局域网或云上的 GPU 机器。

## 1. 安装

需要 Python 3（建议 3.11）。

```bash
git clone https://github.com/x007xyz/flycut-funasr-provider.git
cd flycut-funasr-provider
python3.11 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
# 可选：Qwen3-ASR、Whisper
.venv/bin/python -m pip install -r requirements-extras.txt
```

Windows 把 `.venv/bin/python` 换成 `.venv\Scripts\python`。

## 2. 启动

本机使用：

```bash
.venv/bin/python funasr_service.py --port 9000
```

给其他机器使用时必须带令牌，否则服务拒绝启动：

```bash
.venv/bin/python funasr_service.py --host 0.0.0.0 --port 9000 --token <随机字符串>
```

## 3. 在 FlyCut 里添加

打开「设置 → 模型」，在「添加服务」里填写：

| 字段 | 填写 |
|---|---|
| 显示名称 | `FunASR` |
| ID | `funasr` |
| 协议 | FlyCut Provider |
| 地址 | `http://127.0.0.1:9000`，远程机器填它的地址 |
| API Key | 启动时的 `--token`，没设就留空 |

保存后，模型面板里会出现 FunASR 分组。点「下载」从 ModelScope 下载模型，下载完点「使用」。

API Key 只保存在 Host 内存里，重启 FlyCut 后要重新填写。

## 可用模型

| 模型 | 时间戳 | 说明 |
|---|---|---|
| Paraformer（中文 / 英文） | 字 | 中文版支持热词 |
| SenseVoice Small | 句段 | |
| Fun-ASR-Nano / MLT-Nano | 字 | 支持热词 |
| Qwen3-ASR 0.6B / 1.7B | 字 | 配合对齐模型 |
| Whisper large-v3 / turbo | 句段 | |

所有模型都可以开说话人识别。完整列表、选项和识别行为见 Provider 仓库的 README。

## 常见问题

- **模型显示「不可用」**：提示里写了缺什么包。按提示 `pip install`，然后重启服务。
- **FlyCut 提示协议版本不兼容**：FlyCut 和 Provider 的版本不匹配，两边都更新到最新版。
- **识别很慢**：CPU 上 Qwen3-ASR 和 Whisper 比较慢。可以换 Fun-ASR-Nano 或 Paraformer，也可以部署到有 CUDA 的机器。有 CUDA 时服务自动使用 `cuda:0`，也可以用 `FLYCUT_FUNASR_DEVICE` 指定设备。
- **不想自己部署**：FlyCut Cloud（官方付费服务）开放后，在「设置 → 模型」里填 API Key 即可使用。

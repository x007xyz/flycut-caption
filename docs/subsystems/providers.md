# 模型 Provider

适用范围：`server/plugins/asr.ts`、`server/plugins/providers.ts`、`server/plugins/models.ts`、`server/plugins/endpoints.ts`、`server/providers/**`、`shared/providers.ts`、`shared/asr/**`、`python/**`，以及前端选择模型、下载模型、添加服务的组件和 store。

已拍板的原则见 [decisions.md](../decisions.md)「模型 Provider」；给外部服务作者看的协议见 [provider-http-protocol.md](../provider-http-protocol.md)。

## 核心概念

```ts
/** 调用方只认这个：哪个 Provider 的哪个模型。 */
type ModelRef = { providerId: string; modelId: string };

interface ModelInfo {
  id: string;
  name: string;
  role: 'asr' | 'vad' | 'punc' | 'speaker' | 'align' | 'tts';
  languages?: string[];                 // 含 'auto' 表示能自动识别
  timestampLevel?: 'none' | 'segment' | 'word';
  size?: string;
  status: 'ready' | 'download' | 'unavailable';
  reason?: string;
  options?: Record<string, OptionField>; // 识别时可调的选项
}

interface Provider {
  id: string;
  name: string;
  /** builtin：插件 Provider；endpoint：用户添加的 HTTP Provider */
  kind: 'builtin' | 'endpoint';
  models(signal?: AbortSignal): Promise<ModelInfo[]>;
  /** 下载或准备模型；只有存在 status === 'download' 模型的 Provider 需要实现 */
  prepare?(modelId: string, signal: AbortSignal, report: ProgressReporter): Promise<void>;
  /** 能力按需实现：没有就不写，不写抛错的空方法 */
  transcribe?(request: AsrRequest, audioPath: string, signal: AbortSignal, report: ProgressReporter): Promise<SubtitleTranscript>;
}

interface AsrRequest extends ModelRef {
  language: string;                     // 语言代码或 'auto'
  options?: Record<string, string | number | boolean>;
}
```

类型定义在 `shared/providers.ts`，Host 注册表在 `server/plugins/providers.ts`。

## 规则

- **调用方只传 `ModelRef` 和选项。** 前端、流水线、Agent 工具不判断 Provider 的类型，不写 `if (providerId === ...)`。需要按模型区分的界面（语言列表、时间戳提示、可调选项）一律读 `ModelInfo`。
- **新增 Provider = 新增一个 Host 插件。** 插件里 `ctx.effect(() => ctx.providers.register(provider))`，并在 `server/profile.ts` 的 `BUILTINS` 中登记。Provider ID 是开放字符串，内置 Provider 用小写短横线命名，不带冒号。
- **模型清单跟着 Provider 走。** 内置模型写在 Provider 自己的清单里（例如 sherpa-onnx 的 `models.json`），不放进全局清单；`ctx.models` 只提供下载、解压、定位文件等公共工具，不再决定"有哪些模型"。
- **校验结果不信任 Provider。** 所有 `transcribe` 的返回都经过 `shared/asr/transcript.ts` 的 `validateTranscript`：句段越界或倒序直接失败；字词时间戳有任何不合规，整份降级为句段级。插件 Provider 也不例外。
- **音频统一由 Host 转换。** Host 用内置 FFmpeg 把资产转成 16 kHz 单声道 PCM16 WAV 后交给 Provider，Provider 不各自处理视频格式。
- **不执行用户提供的命令或路径。** 用户只能提供 HTTP 地址和 API Key；Provider 使用的可执行文件、Python 解释器、模型目录都由 Host 配置或 Provider 自己决定。
- **HTTP Provider 走同一个协议客户端。** 内置 FunASR 和用户添加的服务都用 `server/providers/httpProvider.ts`，不另写一套请求和轮询代码。

## 内置 Provider

| ID | 实现 | 能力 | 模型来源 |
|---|---|---|---|
| `sherpa-onnx` | Host 直接调用 `funasr-asr` sidecar（Rust） | ASR | `models.json`（SenseVoice、Paraformer、Whisper 等 ONNX 模型），应用内下载 |
| `funasr` | HTTP Provider，连接 `python/funasr_service.py` | ASR，配套 VAD、标点、说话人 | ModelScope，首次使用前通过 `prepare` 下载 |
| `qwen-asr` | 每次识别启动 `python/qwen_asr_runner.py` 子进程（`FLYCUT_QWEN_PYTHON`） | ASR，配套字词对齐 | Provider 内置清单（ModelScope 优先、HuggingFace 兜底），应用内下载 |
| `transformers` | Host 进程内 Transformers.js（CPU） | ASR | `shared/asr/webModels.ts`，镜像优先、回退 HuggingFace |

用户添加的服务 ID 为 `<协议>:<名称>`，例如 `flycut:gpu-box`、`openai:groq`，由 `server/plugins/endpoints.ts` 管理：

- 地址、名称、协议、OpenAI 兼容服务的模型名和时间戳级别保存在 `<appData>/endpoints.json`；API Key 只在 Host 内存中。
- `server` Profile 下默认拒绝回环和内网地址（`endpoints: { privateNetwork: false }`）。

### FunASR

- 服务：`python/funasr_service.py`，基于官方 `funasr.AutoModel`，实现协议 v1 的全部接口。依赖见 `python/requirements-funasr.txt`。
- 托管方式：默认由 Host 用 `FLYCUT_PYTHON`（缺省 `python3`）在本机随机端口启动；设置 `FLYCUT_FUNASR_URL`（及可选 `FLYCUT_FUNASR_TOKEN`）则改为连接已有服务，例如 GPU 服务器上的同一个脚本。
- 模型：ASR 为 `paraformer-zh`（支持热词和字级时间戳）、`paraformer-en`、`sensevoice-small`（多语种）；配套模型 `fsmn-vad`、`ct-punc`、`cam++`。模型从 ModelScope 下载到 `FLYCUT_FUNASR_HOME`（缺省 `<Host home>/funasr`）。
- 选项：`vad`、`punc`、`speaker`（选择配套模型或 `none`）、`hotword`、`batch_size_s`。说话人识别依赖 VAD；请求了说话人但模型没返回时任务报错，不静默丢弃。
- 加载过的模型组合常驻内存复用（同时只保留一组），不在每次识别时重新加载；取消是尽力而为，见 [python-runtime-api.md](../python-runtime-api.md)。
- SenseVoice 没有句子信息：先按 VAD 切段，再用它自己的逐字时间戳在标点处断句。ITN 把字改成数字等无法逐字对应的句子只保留句段时间。
- Paraformer 不用 FunASR 自带的 `sentence_info` 断句（它会把字和时间戳分到错误的句子里），而是用顶层 `text` 与逐字 `timestamp` 一一对应后自己断句：每个标点处断开，说话人变化处也断开，说话人按时间取自 `sentence_info`。字数和时间戳数对不上时退回 `sentence_info`，此时只要有一句对不上，整份结果降级为句段级（协议规则，不插值）。
- 不启用 `trust_remote_code`，需要远程代码的 checkpoint（例如部分 Fun-ASR-Nano 版本）不在内置列表里。

## 前端

- 识别配置只有 `{ model: ModelRef, language, options }`，存在 app store 里。
- 模型选择、下载、添加服务都在同一个「模型」面板：按 Provider 分组列出 `providers.models` 的结果，显示就绪状态和下载按钮；「添加服务」填写协议、地址、API Key。
- 语言选择器、时间戳提示、选项表单都由当前模型的 `ModelInfo` 生成。

## RPC

| 方法 | 说明 |
|---|---|
| `providers.list` | 已注册的 Provider（`id`、`name`、`kind`） |
| `providers.models` | 所有 Provider 的模型，按 Provider 分组；单个 Provider 出错不影响其他 Provider，错误随分组返回 |
| `providers.prepare` | `{ providerId, modelId }`，创建下载任务 |
| `endpoints.list` / `endpoints.save` / `endpoints.remove` | 管理用户添加的服务 |

识别仍然通过 `workflow.start`，输入里的 `asr` 是 `AsrRequest` 加 `assetId`。

## 验证

```bash
pnpm test:architecture
pnpm check:host
pnpm tsc -b --noEmit
python3 -m unittest discover -s tests -p 'test_*.py'
```

真实使用（[code-standards.md](../code-standards.md) 第 4 条）：

- 动了某个 Provider，就用它的真实模型识别一次 demo 素材，检查字幕和时间戳。
- 动了 HTTP 协议客户端，内置 FunASR 至少跑通一次：下载 `paraformer-zh` → 带 VAD、标点识别 → 开启说话人识别再识别一次。
- 动了 sherpa sidecar，再满足 [funasr-tauri.md](funasr-tauri.md) 的验证要求。

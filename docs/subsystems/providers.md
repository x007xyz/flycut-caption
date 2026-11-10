# 模型 Provider

适用范围：`server/plugins/asr.ts`、`server/plugins/providers.ts`、`server/plugins/models.ts`、`server/plugins/endpoints.ts`、`server/providers/**`、`shared/providers.ts`、`shared/asr/**`，以及前端选择模型、下载模型、添加服务的组件和 store。

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
- **Provider 收到的总是 16 kHz 单声道 PCM16 WAV。** 前端（`src/services/asrService.ts`）把媒体解码、编码成这种 WAV 再上传为资产，Provider 不各自处理视频格式。
- **不执行用户提供的命令或路径。** 用户只能提供 HTTP 地址和 API Key；Provider 使用的可执行文件、Python 解释器、模型目录都由 Host 配置或 Provider 自己决定。
- **HTTP Provider 走同一个协议客户端。** 内置的 FlyCut Cloud 和用户添加的服务都用 `server/providers/httpProvider.ts`，不另写一套请求和轮询代码。

## 内置 Provider

| ID | 实现 | 能力 | 模型来源 |
|---|---|---|---|
| `sherpa-onnx` | Host 直接调用 `funasr-asr` sidecar（Rust） | ASR | `models.json`（SenseVoice、Paraformer、Whisper 等 ONNX 模型），应用内下载 |
| `flycut-cloud` | HTTP Provider（`server/plugins/cloud.ts`），连接官方付费服务 | 服务端声明 | 服务端 |

客户端不内置 Python Provider。FunASR 是独立仓库 [flycut-funasr-provider](https://github.com/x007xyz/flycut-funasr-provider)，用户自己运行后按下面的方式添加，接入说明见 [funasr-provider.md](../funasr-provider.md)。

用户添加的服务 ID 为 `<协议>:<名称>`，例如 `flycut:gpu-box`、`openai:groq`，由 `server/plugins/endpoints.ts` 管理：

- 地址、名称、协议、OpenAI 兼容服务的模型名和时间戳级别保存在 `<appData>/endpoints.json`；API Key 只在 Host 内存中。
- `server` Profile 下默认拒绝回环和内网地址（`endpoints: { privateNetwork: false }`）。

### FlyCut Cloud

- 地址来自插件配置 `asr-cloud.baseUrl`，缺省读环境变量 `FLYCUT_CLOUD_URL`；都没有时不注册 Provider，界面上也不出现。地址由发行配置决定，不让用户填写。
- 用户在模型面板里填 API Key（RPC `cloud.setApiKey`），以 `Authorization: Bearer` 发送；和用户服务的 Key 一样只在 Host 内存中。没有 Key 时 `models()` 报错，不发出请求。
- 协议就是 FlyCut Provider 协议 v1，结果同样经过 `validateTranscript`。计费、额度不足等错误由服务端通过协议的 `error` 字段返回，客户端原样显示。

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

## F-0006 VAD

sherpa-onnx 额外暴露两个 role: 'vad' 模型：fsmn-vad（默认、中文优先）和 silero-vad。Provider 实现可选的 detectVoice，输入 16 kHz 单声道 WAV，返回 { vadType, duration, segments }（秒）。注册表只接受 role === 'vad' 且 status === 'ready' 的模型，并用 voiceActivityResultSchema 校验顺序、范围和时长；HTTP Provider 没有 detectVoice 时不会出现在去静音的可用模型里。

server/plugins/silence.ts 注册 silence.analyze job，只接收 projectId/videoId，用 ProjectStore 解析媒体、提取 WAV、调用 ctx.providers.detectVoice，再用 shared/editing/silence.ts 生成候选。不要把 VAD 结果直接写成 EDL。

## 验证

```bash
pnpm test:architecture
pnpm check:host
pnpm tsc -b --noEmit
```

真实使用（[code-standards.md](../code-standards.md) 第 4 条）：

- 动了某个 Provider，就用它的真实模型识别一次 demo 素材，检查字幕和时间戳。
- 动了 HTTP 协议客户端或「添加服务」，用 [flycut-funasr-provider](https://github.com/x007xyz/flycut-funasr-provider) 跑通一次：添加服务 → 下载 `paraformer-zh` → 带 VAD、标点识别 → 开启说话人识别再识别一次。
- 动了 sherpa sidecar，再满足 [funasr-tauri.md](funasr-tauri.md) 的验证要求。

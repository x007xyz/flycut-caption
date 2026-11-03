# FunASR 客户端本地接入方案

> 历史方案文档：其中「前端直接跑模型、无服务端」的路线已不再采用。当前 FunASR 是通过 HTTP 协议调用的 Provider，见 [subsystems/providers.md](subsystems/providers.md)。

## 目标

在 FlyCut Caption 中加入 FunASR 系模型的本地识别能力，并明确不依赖服务端。

本方案不使用：

- FunASR HTTP server
- FunASR WebSocket server
- 云端 ASR API
- 内网转写服务

所有识别都在用户设备上完成。

## 结论

| 环境 | 推荐方案 | 说明 |
| --- | --- | --- |
| Web 浏览器 | sherpa-onnx WASM | 最现实的纯前端 FunASR 系模型方案 |
| Web 浏览器 | onnxruntime-web | 可行，但要自己实现 ASR 前后处理 |
| Tauri 桌面端 | native sidecar | 最适合桌面客户端，性能和打包可控 |
| Tauri 桌面端 | WebView 内跑 WASM | 可复用 Web 方案，但性能弱于 native |

第一阶段建议：

1. Web 端用 `sherpa-onnx WASM` 接 SenseVoice / Paraformer ONNX。
2. Tauri 端用 native sidecar 接同一类模型。
3. 直接 `onnxruntime-web` 先作为备选路线，不作为第一版实现。

一句话：**不要在浏览器里跑 Python FunASR，要跑 FunASR 系模型的 ONNX/WASM 版本。**

## 当前项目接入点

现有 ASR 链路：

```txt
ASRPanel
  -> asrService
    -> TransformersASREngine
      -> asrWorker
        -> SubtitleTranscript
```

新增后：

```txt
ASRPanel
  -> asrService
    -> transformers | funasr-browser | funasr-tauri
      -> SubtitleTranscript
```

保持最终输出结构不变：

```ts
export interface SubtitleChunk {
  text: string;
  timestamp: [number, number];
  id: string;
  selected?: boolean;
}

export interface SubtitleTranscript {
  text: string;
  chunks: SubtitleChunk[];
  language: string;
  duration: number;
}
```

这样字幕编辑、视频预览、导出都不用改。

## 统一 Engine 接口

新增一个轻量接口即可，不需要复杂 factory。

```ts
export type ASREngineType =
  | 'transformers'
  | 'funasr-browser'
  | 'funasr-tauri';

export interface ASRInput {
  file: File;
  buffer: ArrayBuffer;
  path?: string;
}

export interface ASREngine {
  setProgressCallback(callback: (progress: ASRProgress) => void): void;
  loadModel(): Promise<void>;
  isReady(): boolean;
  transcribe(input: ASRInput, language: string): Promise<SubtitleTranscript>;
  destroy(): void;
}
```

`buffer` 给浏览器本地识别用，`path` 给 Tauri native sidecar 用。

## Web 方案一：sherpa-onnx WASM

这是纯浏览器客户端的推荐方案。

sherpa-onnx 已经包装了大量 ASR 前后处理，支持 WebAssembly，并支持 SenseVoice / Paraformer 这类适合 FunASR 方向的模型。它不是 FunASR Python 包，但它能在浏览器里运行 FunASR 生态模型，这是 Web 端最省事的本地路线。

### 架构

```txt
React UI
  -> FunASRBrowserEngine
    -> funasrBrowserWorker.ts
      -> sherpa-onnx WASM
        -> SenseVoice / Paraformer ONNX
      -> SubtitleTranscript
```

### 文件规划

```txt
src/services/asrEngines/FunASRBrowserEngine.ts
src/workers/funasrBrowserWorker.ts
public/models/funasr/sensevoice/
  model.int8.onnx
  tokens.txt
  config.json
public/wasm/sherpa-onnx/
  sherpa-onnx-wasm-main.js
  sherpa-onnx-wasm-main.wasm
```

大模型不要提交到 Git。用脚本下载到 `public/models`，或者生产环境放 CDN。

### 音频处理

浏览器输入保持复用现有工具：

```ts
import { processAudioForASR } from '@/utils/audioUtils';

const audio = await processAudioForASR(input.buffer);
```

它已经把音频转成 16kHz 单声道 `Float32Array`，适合继续喂给本地 ASR。

### Worker 消息

```ts
type WorkerMessage =
  | {
      type: 'load';
      data: {
        modelDir: string;
        model: 'sensevoice' | 'paraformer';
      };
    }
  | {
      type: 'run';
      data: {
        audio: Float32Array;
        language: string;
      };
    };
```

Worker 输出沿用 `ASRProgress`：

```ts
self.postMessage({ status: 'loading', data: '正在加载 FunASR 本地模型...' });
self.postMessage({ status: 'loaded' });
self.postMessage({ status: 'running', data: '正在本地识别...' });
self.postMessage({ status: 'complete', result: transcript });
```

### Engine 骨架

```ts
import type { ASRProgress, SubtitleTranscript } from '@/types/subtitle';
import { processAudioForASR } from '@/utils/audioUtils';
import funasrWorker from '@/workers/funasrBrowserWorker.ts?worker&inline';

export class FunASRBrowserEngine {
  private worker: Worker | null = null;
  private loaded = false;
  private onProgress: ((progress: ASRProgress) => void) | null = null;

  setProgressCallback(callback: (progress: ASRProgress) => void) {
    this.onProgress = callback;
  }

  isReady() {
    return this.loaded;
  }

  async loadModel() {
    const worker = this.getWorker();

    await new Promise<void>((resolve, reject) => {
      const off = this.listenOnce((progress) => {
        if (progress.status === 'loaded') {
          this.loaded = true;
          off();
          resolve();
        }

        if (progress.status === 'error') {
          off();
          reject(new Error(progress.error || 'FunASR 模型加载失败'));
        }
      });

      worker.postMessage({
        type: 'load',
        data: {
          model: 'sensevoice',
          modelDir: '/models/funasr/sensevoice',
        },
      });
    });
  }

  async transcribe(input: { buffer: ArrayBuffer }, language: string): Promise<SubtitleTranscript> {
    if (!this.loaded) throw new Error('FunASR 模型未加载');

    const audio = await processAudioForASR(input.buffer);
    const worker = this.getWorker();

    return new Promise((resolve, reject) => {
      const off = this.listenOnce((progress) => {
        if (progress.status === 'complete' && progress.result) {
          off();
          resolve(progress.result);
        }

        if (progress.status === 'error') {
          off();
          reject(new Error(progress.error || 'FunASR 识别失败'));
        }
      });

      worker.postMessage({ type: 'run', data: { audio, language } }, [audio.buffer]);
    });
  }

  destroy() {
    this.worker?.terminate();
    this.worker = null;
    this.loaded = false;
  }

  private getWorker() {
    if (!this.worker) {
      this.worker = new funasrWorker();
      this.worker.onmessage = (event) => this.onProgress?.(event.data);
    }

    return this.worker;
  }

  private listenOnce(listener: (progress: ASRProgress) => void) {
    const original = this.onProgress;
    this.onProgress = (progress) => {
      original?.(progress);
      listener(progress);
    };

    return () => {
      this.onProgress = original;
    };
  }
}
```

### Worker 骨架

```ts
import type { ASRProgress, SubtitleTranscript } from '@/types/subtitle';

let recognizer: unknown = null;

self.addEventListener('message', async (event) => {
  const { type, data } = event.data;

  try {
    if (type === 'load') {
      self.postMessage({
        status: 'loading',
        data: '正在加载 FunASR WASM 模型...',
      } satisfies ASRProgress);

      // 初始化 sherpa-onnx WASM recognizer
      // recognizer = await createRecognizer({ modelDir: data.modelDir });

      self.postMessage({ status: 'loaded' } satisfies ASRProgress);
      return;
    }

    if (type === 'run') {
      self.postMessage({
        status: 'running',
        data: '正在本地识别...',
      } satisfies ASRProgress);

      // const result = await recognizer.acceptWaveform(data.audio);
      const transcript: SubtitleTranscript = {
        text: '',
        chunks: [],
        language: data.language,
        duration: data.audio.length / 16000,
      };

      self.postMessage({
        status: 'complete',
        result: transcript,
      } satisfies ASRProgress);
    }
  } catch (error) {
    self.postMessage({
      status: 'error',
      error: error instanceof Error ? error.message : 'FunASR 本地识别失败',
    } satisfies ASRProgress);
  }
});

export {};
```

真正接 sherpa-onnx 时，只替换初始化和识别两处，不动外层 ASR 流。

### 时间戳策略

第一版只做句段级时间戳：

```ts
function toTranscript(result: any, language: string, duration: number): SubtitleTranscript {
  const segments = result.segments ?? [];

  return {
    text: result.text ?? segments.map((segment: any) => segment.text).join(''),
    language,
    duration,
    chunks: segments.map((segment: any, index: number) => ({
      id: `funasr-browser-${index}`,
      text: String(segment.text ?? '').trim(),
      timestamp: [
        Number(segment.start ?? 0),
        Number(segment.end ?? duration),
      ],
      selected: false,
    })),
  };
}
```

如果模型只能返回整段文本，先按 VAD 分段；不要手写“按字数平均切时间”的假时间戳，字幕编辑会很难用。

## Web 方案二：直接 onnxruntime-web

这条是纯前端，但不是第一版推荐。

`onnxruntime-web` 只负责跑 ONNX 图，不负责 FunASR 的完整 pipeline。你需要自己补：

```txt
音频解码
  -> 重采样到 16k mono
  -> fbank/log-mel 特征
  -> VAD 分段
  -> ONNX Runtime 推理
  -> tokenizer/decoder
  -> ITN/标点
  -> 时间戳
  -> SubtitleTranscript
```

### 依赖

```bash
pnpm add onnxruntime-web
```

### WASM 推理骨架

```ts
import * as ort from 'onnxruntime-web';

ort.env.wasm.wasmPaths = '/ort/';

const session = await ort.InferenceSession.create('/models/funasr/model.onnx', {
  executionProviders: ['wasm'],
});

const feeds = {
  speech: new ort.Tensor('float32', features, [1, frames, bins]),
  speech_lengths: new ort.Tensor(
    'int64',
    BigInt64Array.from([BigInt(frames)]),
    [1],
  ),
};

const outputs = await session.run(feeds);
```

### WebGPU 推理骨架

```ts
import * as ort from 'onnxruntime-web/webgpu';

const session = await ort.InferenceSession.create('/models/funasr/model.onnx', {
  executionProviders: ['webgpu'],
});
```

WebGPU 不是默认方案。先验证模型所有 ONNX op 是否支持，不支持就回退 WASM。

### Vite 头部

如果启用 WASM 多线程，需要跨源隔离：

```ts
// vite.config.ts
// 这里的 server 是 Vite 开发服务器配置名，不是 FunASR 服务端。
server: {
  headers: {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  },
}
```

### 什么时候选 onnxruntime-web

只有这些条件成立时才选：

- sherpa-onnx WASM 不满足包体或模型控制需求。
- 团队愿意维护特征提取、decoder、timestamp。
- 已经有确定可跑的 FunASR ONNX 模型输入输出说明。

否则它会比 sherpa-onnx 多很多胶水代码。

## Tauri 方案一：native sidecar

这是桌面客户端推荐方案。

Tauri 不是浏览器环境，没必要把所有推理塞进 WebView。用本地 sidecar 跑 ASR，前端通过 Tauri command 调用。

### 架构

```txt
React
  -> FunASRTauriEngine
    -> invoke('transcribe_with_funasr')
      -> Rust command
        -> native sidecar
          -> SenseVoice / Paraformer ONNX
        -> SubtitleTranscript
```

sidecar 推荐：

- `sherpa-onnx` native CLI
- 或自己封装一个极小 CLI，输入文件路径，输出 JSON

不推荐第一版使用 Python FunASR sidecar。能跑，但打包重，跨平台分发麻烦。

### 目录规划

```txt
src-tauri/
  binaries/
    funasr-asr-aarch64-apple-darwin
    funasr-asr-x86_64-apple-darwin
    funasr-asr-x86_64-pc-windows-msvc.exe
    funasr-asr-x86_64-unknown-linux-gnu
  models/
    sensevoice/
      model.int8.onnx
      tokens.txt
```

`tauri.conf.json`：

```json
{
  "bundle": {
    "active": true,
    "targets": "all",
    "externalBin": [
      "binaries/funasr-asr"
    ],
    "resources": [
      "models/sensevoice/*"
    ]
  }
}
```

### sidecar CLI 协议

只定义 stdin/stdout JSON，别搞本地端口。

命令：

```bash
funasr-asr \
  --input /path/to/audio-or-video.mp4 \
  --model /path/to/models/sensevoice \
  --language zh \
  --output-json
```

stdout：

```json
{
  "text": "完整识别文本",
  "language": "zh",
  "duration": 12.34,
  "chunks": [
    {
      "id": "funasr-tauri-0",
      "text": "第一句字幕",
      "timestamp": [0.12, 2.56],
      "selected": false
    }
  ]
}
```

stderr 只放日志。Rust 只解析 stdout。

### Rust 类型

```rust
#[derive(serde::Serialize, serde::Deserialize)]
pub struct SubtitleChunk {
    pub id: String,
    pub text: String,
    pub timestamp: [f64; 2],
    pub selected: bool,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct TranscriptResult {
    pub text: String,
    pub chunks: Vec<SubtitleChunk>,
    pub language: String,
    pub duration: f64,
}
```

### Rust command

新增：

```txt
src-tauri/src/commands/mod.rs
src-tauri/src/commands/asr.rs
src-tauri/src/models/mod.rs
src-tauri/src/models/transcript.rs
```

命令骨架：

```rust
#[tauri::command]
pub async fn transcribe_with_funasr(
    input_path: String,
    language: Option<String>,
) -> Result<TranscriptResult, String> {
    // 调 native sidecar
    // 读取 stdout
    // serde_json::from_str::<TranscriptResult>(&stdout)
    todo!()
}
```

注册：

```rust
tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
        app_ready,
        commands::asr::transcribe_with_funasr,
    ])
```

### 前端 Engine

```ts
import { invoke } from '@tauri-apps/api/core';
import type { ASRProgress, SubtitleTranscript } from '@/types/subtitle';

export class FunASRTauriEngine {
  private onProgress: ((progress: ASRProgress) => void) | null = null;

  setProgressCallback(callback: (progress: ASRProgress) => void) {
    this.onProgress = callback;
  }

  async loadModel() {
    this.onProgress?.({ status: 'loaded' });
  }

  isReady() {
    return true;
  }

  async transcribe(input: { path?: string }, language: string): Promise<SubtitleTranscript> {
    if (!input.path) throw new Error('缺少本地文件路径');

    this.onProgress?.({ status: 'running', data: '正在本地识别...' });

    const result = await invoke<SubtitleTranscript>('transcribe_with_funasr', {
      inputPath: input.path,
      language,
    });

    this.onProgress?.({ status: 'complete', result });
    return result;
  }

  destroy() {}
}
```

### 文件路径

当前 Web 上传得到的是 `File`，不是稳定本地路径。Tauri 下建议用文件选择插件拿路径，避免把大视频复制进前端内存。

流程：

```txt
Tauri file dialog
  -> input_path
  -> Rust sidecar
  -> TranscriptResult
```

Web 版本仍用 `ArrayBuffer`。

## Tauri 方案二：WebView 内跑 WASM

如果想最大复用 Web 方案，Tauri 可以直接使用 `FunASRBrowserEngine`。

优点：

- Web 和 Tauri 共用一套 worker。
- 不需要 Rust sidecar。

缺点：

- 性能通常不如 native。
- 大模型仍要进 WebView 缓存。
- 内存限制和浏览器方案一样。

这条适合作为 fallback，不作为桌面主路线。

## ASRService 改造

最小改法：

```ts
class ASRService {
  private engineType: ASREngineType = 'transformers';
  private transformersEngine = new TransformersASREngine();
  private funasrBrowserEngine = new FunASRBrowserEngine();
  private funasrTauriEngine = new FunASRTauriEngine();

  setEngineType(engineType: ASREngineType) {
    this.engineType = engineType;
  }

  private getEngine() {
    if (this.engineType === 'funasr-browser') return this.funasrBrowserEngine;
    if (this.engineType === 'funasr-tauri') return this.funasrTauriEngine;
    return this.transformersEngine;
  }
}
```

不要先上通用 factory。三个分支够清楚。

## UI 改动

在 `ASRPanel` 设置区增加：

```txt
识别引擎
  - Whisper 浏览器本地
  - FunASR 浏览器本地
  - FunASR Tauri 本地
```

显示规则：

| 引擎 | 设置 |
| --- | --- |
| Whisper 浏览器本地 | 语言、设备 webgpu/wasm |
| FunASR 浏览器本地 | 语言、模型 SenseVoice/Paraformer |
| FunASR Tauri 本地 | 语言、模型 SenseVoice/Paraformer |

Tauri 专属选项只在检测到 Tauri 环境时显示。

```ts
const isTauri = '__TAURI_INTERNALS__' in window;
```

## 模型选择

第一版：

| 模型 | 用途 |
| --- | --- |
| SenseVoice Small int8 | 多语种、中英日韩粤，客户端体积相对可控 |
| Paraformer int8 | 中文识别优先 |

建议默认 SenseVoice Small int8。中文效果不够时再给 Paraformer 选项。

## 实施顺序

### Phase 1：Web 本地 WASM

1. 下载并验证 sherpa-onnx WASM demo。
2. 新增 `FunASRBrowserEngine.ts`。
3. 新增 `funasrBrowserWorker.ts`。
4. 复用 `processAudioForASR()`。
5. 输出 `SubtitleTranscript`。
6. UI 加引擎选择。

验收：

- 断网后已缓存模型可识别。
- 识别过程不阻塞 UI。
- 结果能进入字幕编辑页。
- SRT/JSON 导出不改。

### Phase 2：Tauri native sidecar

1. 选定 native CLI：sherpa-onnx 或自封装 `funasr-asr`。
2. 定义 stdout JSON 协议。
3. 配置 `externalBin` 和 `resources`。
4. 新增 Rust command。
5. 新增 `FunASRTauriEngine.ts`。
6. Tauri 文件选择获取本地路径。

验收：

- macOS/Windows 至少各跑通一个样例。
- 大文件不复制进 WebView 内存。
- sidecar 异常能返回明确错误。

### Phase 3：直接 onnxruntime-web

只有需要进一步减少包体或深度定制时再做。

1. 确认模型输入输出。
2. 实现 fbank/log-mel。
3. 实现 tokenizer/decoder。
4. 实现 VAD 和时间戳。
5. WASM 跑通后再试 WebGPU。

## 风险

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| 浏览器本地模型很大 | 首次加载慢 | int8 模型、缓存、清晰进度 |
| 移动端性能差 | 识别慢或失败 | 允许回退 Whisper tiny 或提示用桌面端 |
| onnxruntime-web 只管推理 | 工程量大 | 第一版用 sherpa-onnx |
| WebGPU op 不完整 | 无法运行 | WASM 默认，WebGPU 可选 |
| Tauri sidecar 跨平台打包麻烦 | 发布成本增加 | 每个平台固定产物，stdout JSON 协议保持简单 |
| 时间戳不准 | 字幕编辑体验差 | 优先选支持分段/时间戳的模型路径 |

## 不做

第一版不做：

- FunASR HTTP server
- FunASR WebSocket server
- 云端识别
- 自己完整复刻 FunASR Python pipeline
- 说话人分离
- 热词 UI
- 实时麦克风字幕

## 参考资料

- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)
- [sherpa-onnx SenseVoice](https://k2-fsa.github.io/sherpa/onnx/sense-voice/index.html)
- [ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/)
- [ONNX Runtime WebGPU](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html)
- [Tauri sidecar](https://v2.tauri.app/develop/sidecar/)

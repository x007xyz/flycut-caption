# FunASR / Tauri

适用范围：`src-tauri/**`、`src-tauri/sidecars/funasr-asr/**`、`scripts/fetch-ffmpeg.sh`、桌面端媒体路径相关的前端代码。

## 规则

- **模型文件不等于可执行程序**：sherpa-onnx 模型目录只包含 `model.int8.onnx`、`tokens.txt` 等模型资产；真实识别还需要 `funasr-asr` sidecar 可执行程序。Host 的 `sherpa-onnx` Provider 直接调用它（路径来自 `FLYCUT_FUNASR_SIDECAR`），不经过 Python。名字里的 funasr 是历史原因，和 `funasr` Provider（Python FunASR 服务）无关。
- **sidecar 必须通过脚本构建**：运行 Tauri 前应使用 `pnpm build:funasr-sidecar`，它会构建 `src-tauri/sidecars/funasr-asr` 并复制到 `src-tauri/binaries/funasr-asr`。
- **FFmpeg 内置打包**：运行 Tauri 前使用 `pnpm fetch:ffmpeg`，将静态 FFmpeg 下载到 `src-tauri/binaries/ffmpeg`（Windows 为 `ffmpeg.exe`），随 `binaries/*` 打入安装包；Host 导出插件与 FunASR sidecar 通过 `FFMPEG_PATH` 优先使用内置副本。
- **Tauri 只做桌面外壳**：Rust 只保留 Host 启动（`ensure_host`）、原生对话框（`pick_media_file`、`pick_save_media_file`、`pick_model_directory`）、媒体暂存和 `save_host_asset`。ASR、模型清单/下载/扫描、视频导出都在 Host 插件中，不要再新增执行业务的 Tauri command。
- **桌面媒体文件使用原生路径**：前端通过 `pick_media_file` 获取路径写入 `VideoFile.path`，需要上传给 Host 时用 `convertFileSrc` 读取后走 `/assets`，RPC 不接收任意本地路径。
- **媒体文件识别前需转 WAV**：`sherpa-onnx` 读取 WAV；mp4/mov 等视频输入应由 sidecar 使用 `ffmpeg` 提取为 16k 单声道 WAV 后再识别。

## 验证

改动本子系统后至少运行：

```bash
pnpm build:funasr-sidecar
cargo check --manifest-path src-tauri/Cargo.toml
pnpm tsc -b --noEmit
```

动了 sidecar 的识别或 VAD 逻辑，再加 `pnpm test:funasr-sidecar`、`pnpm test:fsmn-vad`（需先 `pnpm download:test-models`）。真实使用验证见 [code-standards.md](../code-standards.md) 第 4 条。

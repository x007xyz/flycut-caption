# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Development Commands

- **Start development server**: `pnpm dev` - Starts Vite dev server with HMR
- **Build for production**: `pnpm build` - TypeScript compilation followed by Vite build
- **Lint code**: `pnpm lint` - Run ESLint on the codebase
- **Preview build**: `pnpm preview` - Preview the production build locally
- **Add Shadcn/ui components**: `pnpm dlx shadcn@latest add <component-name>` - Add specific components

## Architecture Overview

This is a React + TypeScript + Vite project with modern UI tooling:

- **Build System**: Vite with React plugin and Tailwind CSS 4 integration
- **Language**: TypeScript with strict configuration using project references
- **UI Framework**: React 19 with functional components and hooks
- **Styling**: Tailwind CSS 4 with Shadcn/ui component library
- **Icons**: Lucide React icons (integrated with Shadcn/ui)
- **Linting**: ESLint with React-specific rules and TypeScript integration
- **Package Manager**: pnpm (evidenced by pnpm-lock.yaml)

## Project Structure

- `src/App.tsx` - Main application component
- `src/main.tsx` - Application entry point
- `src/index.css` - Global styles with Tailwind imports and CSS variables
- `src/lib/utils.ts` - Utility functions (includes cn helper for class merging)
- `components.json` - Shadcn/ui configuration file
- `vite.config.ts` - Vite configuration with React plugin, Tailwind, and path aliases
- TypeScript uses project references with separate configs for app and node environments

## Key Configuration Notes

- Uses ES modules (`"type": "module"` in package.json)
- TypeScript project references split between `tsconfig.app.json` and `tsconfig.node.json`
- Path aliases configured: `@/*` maps to `./src/*`
- Shadcn/ui uses "new-york" style with neutral base color
- **Tailwind CSS v4.1.13**: Latest version with CSS-first configuration using `@theme` blocks
- **Zero-config setup**: No `tailwind.config.js` or `postcss.config.js` needed
- Uses `@tailwindcss/vite` plugin for optimal Vite integration
- No test framework currently configured

## UI Component Library

- **Tailwind CSS v4**: CSS-first configuration with `@theme` blocks
- **Vite Integration**: Uses `@tailwindcss/vite` plugin for better performance  
- **Theme system**: Built-in light/dark mode support via CSS variables and `oklch()` colors
- **Shadcn/ui**: Modern React components built on Radix UI primitives
- **Icons**: Lucide React icons integrated throughout components

## Tailwind CSS v4 Features

- **Simplified setup**: Single `@import "tailwindcss"` line in CSS
- **CSS-first config**: Define themes using `@theme` and `@theme dark` blocks
- **Modern colors**: Uses `oklch()` color space for better color consistency
- **Zero dependencies**: No need for PostCSS configuration or external config files
- **Better performance**: Native Vite plugin integration

## FlyCut Caption Application

这是一个智能视频字幕裁剪工具，支持：

### 核心功能
- **文件上传**: 支持视频/音频文件拖拽上传
- **ASR 语音识别**: 基于 Whisper 模型生成字级时间戳字幕
- **字幕编辑**: 可视化选择和删除字幕片段
- **视频播放**: 与字幕同步的视频播放器
- **字幕导出**: 支持 SRT/JSON 格式导出

### 技术架构
- **状态管理**: React Context + useReducer
- **组件化**: 模块化组件设计，清晰的职责分离
- **Web Workers**: ASR 处理在后台线程运行
- **TypeScript**: 完整的类型定义和类型安全

### 项目结构
- `src/components/` - UI 组件（文件上传、视频播放器、字幕编辑器等）
- `src/hooks/` - 自定义 Hooks（ASR、字幕管理等）
- `src/services/` - 业务服务层（ASR 服务等）
- `src/types/` - TypeScript 类型定义
- `src/utils/` - 工具函数（时间、文件、音频处理）
- `src/workers/` - Web Workers（ASR 处理）
- `src/contexts/` - React Context（全局状态管理）

## FunASR / Tauri 处理准则

- **模型文件不等于可执行程序**：FunASR 模型目录只包含 `model.int8.onnx`、`tokens.txt` 等模型资产；真实识别还需要 `funasr-asr` sidecar 可执行程序。
- **sidecar 必须通过脚本构建**：运行 Tauri 前应使用 `pnpm build:funasr-sidecar`，它会构建 `src-tauri/sidecars/funasr-asr` 并复制到 `src-tauri/binaries/funasr-asr`。
- **FFmpeg 内置打包**：运行 Tauri 前使用 `pnpm fetch:ffmpeg`，将静态 FFmpeg 下载到 `src-tauri/binaries/ffmpeg`（Windows 为 `ffmpeg.exe`），随 `binaries/*` 打入安装包；Host 导出插件与 FunASR sidecar 通过 `FFMPEG_PATH` 优先使用内置副本。
- **Tauri 只做桌面外壳**：Rust 只保留 Host 启动（`ensure_host`）、原生对话框（`pick_media_file`、`pick_save_media_file`、`pick_model_directory`）、媒体暂存和 `save_host_asset`。ASR、模型清单/下载/扫描、视频导出都在 Host 插件中，不要再新增执行业务的 Tauri command。
- **桌面媒体文件使用原生路径**：前端通过 `pick_media_file` 获取路径写入 `VideoFile.path`，需要上传给 Host 时用 `convertFileSrc` 读取后走 `/assets`，RPC 不接收任意本地路径。
- **媒体文件识别前需转 WAV**：`sherpa-onnx` 读取 WAV；mp4/mov 等视频输入应由 sidecar 使用 `ffmpeg` 提取为 16k 单声道 WAV 后再识别。
- **验证链路**：改动 FunASR/Tauri 后至少运行 `pnpm build:funasr-sidecar`、`cargo check --manifest-path src-tauri/Cargo.toml`、`pnpm tsc -b --noEmit`。

## Cordis / Host 架构（当前代码）

- 前后端是独立 Cordis Context。源码位于 `core/cordis`、`core/cosmokit`，来源与修改规则见 `core/UPSTREAM.md`；不要用自行实现的兼容类替换它们。
- Host 默认插件组合在 `server/app.ts`；LangGraph 同时提供 Workflow 与 Agent Loop。ASR Provider 在后端注册，前端通过 HTTP RPC / WebSocket 调用。
- **RPC 由插件自己注册**：在插件里 `ctx.effect(() => ctx.rpc.register(method, zodSchema, handler))`，并在 `shared/protocol.ts` 的 `RpcMethods` 中声明类型。不要在 `gateway.ts` 中加 `case`；Gateway 只负责传输、鉴权和分发。
- **事件跨进程需显式暴露**：Host 插件用 `ctx.emit` 发 Cordis 事件，需要推到前端的在 `RemoteEvents` 中声明并 `ctx.rpc.expose(name)`；前端用 `connection.on(name, ...)` 订阅。
- **扩展走注册表**：ASR Provider（`ctx.providers.register` / `describe`）、编辑分析（`ctx.editorPlugins.register`，自动成为 Workflow 步骤）、Agent 工具（`ctx.agentTools.register`）、工具策略（`agent/before-tool` 事件）。Provider ID 是开放字符串。
- 前端插件组合在 `src/runtime/client.ts`，React 通过 PluginSlot 渲染注册组件（`tools`、`options` 可多贡献）。ASR/AI 服务是 `ctx.asr` / `ctx.ai`，组件通过 `useClientRuntime()` 获取，不要再写模块级单例或全局连接。共享协议在 `shared/protocol.ts`，前后端共用的纯逻辑放 `shared/`。
- 视频导出通过后端 `server/plugins/export.ts` 的 Cordis 插件执行；前端只负责导出参数、任务进度和保存结果，Host 返回结果资产。Web 端 WebAV/FFmpeg 保留为明确的本地回退引擎；桌面只用 Host 导出，并通过 `save_host_asset` 复制到用户选定路径。
- `pnpm dev` 同时启动前端与 Host；`pnpm build:core` 构建 vendored 源码；`pnpm package:host` 为桌面部署后端及本机 Node。
- 修改运行时或通信后，至少执行 `pnpm test:architecture`、`pnpm check:host`、`pnpm tsc -b --noEmit`，保留 FunASR/Tauri 原有验证要求。
- Host 插件组合按 Profile 分层解析（`server/profile.ts`）：新内置插件要在 `BUILTINS` 登记 `provides`，否则依赖检查会把注入它的插件判为不满足。外部插件通过 `profile.patch.yml`（或 `.json`）的 `plugins` 加载。`js-yaml` 是 Host 包（`server/package.json`）的依赖，根包只放在 devDependencies。
- 业务 store 是每个 Context 一份：组件用 `useXStore(selector)`，回调里用 `useRuntimeStoreApi(key).getState()`；不要再写 `useXStore.getState()` 或在 runtime 外使用这些 store。
- 当前边界和未迁移部分以 `docs/architecture-current.md` 为准。

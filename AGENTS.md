# AGENTS.md

本文件是给 coding agent 的路由表：做什么事之前先读哪份文档。具体规则写在被引用的文档里，不写在这里。

FlyCut Caption 是智能视频字幕裁剪工具：上传视频/音频 → ASR 生成字级时间戳字幕 → 可视化删除字幕片段 → 导出裁剪后的视频和 SRT/JSON 字幕。前端 React 19 + Vite，后端是独立的 Cordis Host（Node），桌面端由 Tauri 包装，推理走 Python worker / FunASR sidecar。

## 每次开工

1. 读 [LESSONS.md](LESSONS.md)：之前踩过的坑和照做的做法。
2. 读 [docs/code-standards.md](docs/code-standards.md)：验收标准，写代码和交付前都要对照。

## 按改动范围读文档

| 要改的地方 | 先读 |
|---|---|
| `src-tauri/**`、`src-tauri/sidecars/**`、FFmpeg 打包、桌面媒体路径 | [docs/subsystems/funasr-tauri.md](docs/subsystems/funasr-tauri.md) |
| `server/plugins/{asr,providers,models,endpoints}.ts`、`server/providers/**`、`shared/providers.ts`、`shared/asr/**`、`python/**`、模型选择相关前端 | [docs/subsystems/providers.md](docs/subsystems/providers.md) |
| `core/**`、`server/**`、`shared/**`、`src/runtime/**`、RPC/事件/插件 | [docs/subsystems/cordis-host.md](docs/subsystems/cordis-host.md)，以及 [docs/architecture-current.md](docs/architecture-current.md) |
| `src/**` 的组件、Hooks、stores、样式 | [docs/subsystems/frontend.md](docs/subsystems/frontend.md) |
| 跨多个子系统 | 每个涉及的子系统文档都读，验证要求取并集 |
| 改变已有行为、交互或架构边界 | [docs/decisions.md](docs/decisions.md)：已拍板的决定不在 PR 里推翻 |
| 用户接入自己的模型、HTTP Provider 协议、Python worker | [docs/custom-asr-providers.md](docs/custom-asr-providers.md)、[docs/provider-http-protocol.md](docs/provider-http-protocol.md)、[docs/python-runtime-api.md](docs/python-runtime-api.md) |

## 按任务读文档

| 任务 | 先读 |
|---|---|
| 写代码、修 bug | 对应子系统文档 + [docs/code-standards.md](docs/code-standards.md) |
| 审查代码或 PR | [docs/code-standards.md](docs/code-standards.md) 逐条对照 + [docs/decisions.md](docs/decisions.md) |
| 合并、打 tag、发版 | [docs/code-standards.md](docs/code-standards.md) 第 6 条；发版只用 `pnpm release` |
| 复盘、更新错题本 | [LESSONS.md](LESSONS.md) 顶部的「怎么记」、[docs/agent/nightly-review-prompt.md](docs/agent/nightly-review-prompt.md) |
| 作为 loop 自动运行 | [docs/agent/loops.md](docs/agent/loops.md) |

## 常用命令

- `pnpm dev`：同时启动前端与 Host
- `pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`
- `pnpm test`、`pnpm test:architecture`
- `pnpm tauri:dev`：桌面端开发（会先打包 Host、构建 sidecar、拉取 FFmpeg）

完整命令列表见 `package.json` 的 `scripts`。

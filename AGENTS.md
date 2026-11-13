# AGENTS.md

本文件是给 coding agent 的路由表：做什么事之前先读哪份文档。具体规则写在被引用的文档里，不写在这里。

FlyCut Caption 是智能视频字幕裁剪工具：上传视频/音频 → ASR 生成字级时间戳字幕 → 可视化删除字幕片段 → 导出裁剪后的视频和 SRT/JSON 字幕。前端 React 19 + Vite，后端是独立的 Cordis Host（Node），桌面端由 Tauri 包装，推理走 Python worker / FunASR sidecar。

## 每次开工

1. 读 [LESSONS.md](LESSONS.md)：之前踩过的坑和照做的做法。
2. 读 [docs/code-standards.md](docs/code-standards.md)：验收标准，写代码和交付前都要对照。
3. 新功能和较大的改动走需求流程（[docs/00-process/README.md](docs/00-process/README.md)）：每个需求只有两个维护者确认点——需求说明（`01-spec`，立项和 PRD 合在一起，可以一批一起确认）和测试与验收，agent 不能自己确认；中间的技术设计 → 开发 → 测试由 agent 连续推进；发布、运维观察和复盘按版本做；依赖未完成的需求不能开始开发。小的 bug 修复和文档修正可以直接做。
4. 产品方向（目标用户：口播创作者；平台：先桌面端再 Web）见 [docs/10-product/vision.md](docs/10-product/vision.md)。
5. 每个任务都先按 [自动化验收方案](docs/30-engineering/acceptance-testing.md) 选择并运行可复现的检查，再补自动化覆盖不到的实机验证。交付时记录目标平台、命令、结果和未跑原因。

## 按改动范围读文档

| 要改的地方 | 先读 |
|---|---|
| `src-tauri/**`、`src-tauri/sidecars/**`、FFmpeg 打包、桌面媒体路径 | [docs/subsystems/funasr-tauri.md](docs/subsystems/funasr-tauri.md) |
| `server/plugins/{asr,cloud,providers,models,endpoints}.ts`、`server/providers/**`、`shared/providers.ts`、`shared/asr/**`、模型选择相关前端 | [docs/subsystems/providers.md](docs/subsystems/providers.md) |
| `core/**`、`server/**`、`shared/**`、`src/runtime/**`、RPC/事件/插件 | [docs/subsystems/cordis-host.md](docs/subsystems/cordis-host.md)，以及 [docs/architecture-current.md](docs/architecture-current.md) |
| `src/**` 的组件、Hooks、stores、样式 | [docs/subsystems/frontend.md](docs/subsystems/frontend.md) |
| 跨多个子系统 | 每个涉及的子系统文档都读，验证要求取并集 |
| 改变已有行为、交互或架构边界 | [docs/decisions.md](docs/decisions.md)：已拍板的决定不在 PR 里推翻 |
| 用户接入自己的模型、HTTP Provider 协议、FunASR | [docs/custom-asr-providers.md](docs/custom-asr-providers.md)、[docs/provider-http-protocol.md](docs/provider-http-protocol.md)、[docs/funasr-provider.md](docs/funasr-provider.md) |

## 按任务读文档

| 任务 | 先读 |
|---|---|
| 产品规划、拆 Epic、竞品与获客分析 | [docs/10-product/](docs/10-product/README.md)，用 `fc-plan` |
| 新需求：需求说明 → 设计 / 开发 / 验收 | [docs/00-process/README.md](docs/00-process/README.md)，用 `fc-spec` → `fc-build`（调研类 `fc-spec` → `fc-research`）；进度用 `fc-status` / `pnpm feature status` |
| 发版、发布后观察与复盘（按版本） | `fc-release`、`fc-retro`，文档在 [docs/40-ops/releases/](docs/40-ops/releases/) |
| 写代码、修 bug | 对应子系统文档 + [docs/code-standards.md](docs/code-standards.md) |
| 审查代码或 PR | [docs/code-standards.md](docs/code-standards.md) 逐条对照 + [docs/decisions.md](docs/decisions.md) |
| 合并、打 tag、发版 | [docs/code-standards.md](docs/code-standards.md) 第 6 条；发版只用 `pnpm release` |
| 复盘、更新错题本 | [LESSONS.md](LESSONS.md) 顶部的「怎么记」、[docs/agent/nightly-review-prompt.md](docs/agent/nightly-review-prompt.md) |
| 作为 loop 自动运行 | [docs/agent/loops.md](docs/agent/loops.md) |
| 记录架构决策 / 事故 | `pnpm feature adr` / `pnpm feature incident`，见 [docs/20-architecture/](docs/20-architecture/README.md)、[docs/40-ops/](docs/40-ops/README.md) |

## 常用命令

- `pnpm dev`：同时启动前端与 Host
- `pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`
- `pnpm test`、`pnpm test:architecture`
- `pnpm tauri:dev`：桌面端开发（会先打包 Host、构建 sidecar、拉取 FFmpeg）

完整命令列表见 `package.json` 的 `scripts`。

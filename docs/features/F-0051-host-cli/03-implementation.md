---
id: F-0051
stage: 03-implementation
status: approved
approved_by: auto
approved_at: 2026-11-13
---

# F-0051 Host项目操作CLI：开发记录

## 分支与 PR

- 分支：codex/f0051-host-cli
- PR：

## 进度

| 日期 | 清单项 | 提交 | 检查 |
|---|---|---|---|
| 2026-11-13 | 1. 共享错误码、确认与 projectOps 契约 | 8fd29fb | `pnpm check:host`、`pnpm tsc -b --noEmit` |
| 2026-11-13 | 2. Host 客户端确认插件 | 9e1bad1 | 架构测试（确认去重、一次性消费） |
| 2026-11-13 | 3. Host projectOps 应用服务 | 2a91de1 | 架构测试（转写/建议/导出） |
| 2026-11-13 | 4. CLI 客户端与命令集 | 待提交 | `pnpm cli --help`、`pnpm build:cli`、子进程端到端（上传→转写→建议→新建导出→覆盖确认→Ctrl+C） |
| 2026-11-13 | 5. UI 客户端确认中心 | 待提交 | `pnpm lint`、`pnpm tsc -b --noEmit`、E2E 8/8 |
| 2026-11-13 | 6. 架构 / E2E / 隔离 Host 端到端 | 待提交 | `pnpm test:architecture` 148/148 ✅、`PW_PORT=5293 pnpm e2e:evidence F-0051` 8/8 ✅ |

## 自行决定的事项

- **破坏性操作一律走确认中心**：`projects delete`、`projects remove-video`、`export` 覆盖已有文件都只创建 `confirmation` 并返回退出码 4；`--yes 与 Agent 参数都不能绕过，只能由 UI 客户端以 `actor: 'ui-client'` 决定。影响 AC-3、AC-8。
- **CLI 只连已运行 Host**：不做自动拉起或安装模型，凭据只来自 `--token` / `--token-file` / `connection.json`，日志与 JSON 均脱敏。影响 AC-2。
- **确认中心放在项目页侧栏**：作为侧栏入口 + 内嵌面板，不新增独立页面；空态显示「暂无待确认请求 / Nothing here yet」。影响 AC-5。
- **子进程测试改为异步 spawn**：原实现用 `spawnSync` 阻塞了同进程内 Host 的事件循环，导致 CLI 请求 30 秒超时；改为 `spawn` + Promise 后正常。影响 AC-4、AC-9。

## 与设计的偏差

- 子进程端到端里的首次导出使用 `--subtitles none`：本机环境软字幕导出任务返回空错误，先用无字幕导出验证 CLI 导出与覆盖确认链路；软字幕导出在测试报告中记为 `⏸ Not run`。

## 遗留问题

- 真实 ASR 模型的长音频转写与真实外部 AI 建议未在本环境执行（子进程测试用注入 Provider 覆盖协议链路）。


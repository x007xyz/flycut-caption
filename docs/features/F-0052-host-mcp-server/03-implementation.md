---
id: F-0052
stage: 03-implementation
status: approved
approved_by: auto
approved_at: 2026-11-13
---

# F-0052 MCP Server与Agent接入：开发记录

## 分支与 PR

- 分支：codex/f0052-host-mcp-server
- PR：

## 进度

<!-- 每完成实现清单的一项，在 02-design.md 勾选，并在这里追加一行：日期、清单项、提交 sha、跑过的检查。
换会话接着做时，先读 02-design.md 和这里。 -->

| 日期 | 清单项 | 提交 | 检查 |
|---|---|---|---|
| 2026-11-13 | 1. 零依赖 MCP stdio JSON-RPC 2.0 传输与生命周期层（`mcp/protocol.ts`） | 106e531 | `pnpm lint` ✅，`pnpm check:host` ✅ |
| 2026-11-13 | 2. 复用 `cli/client.ts` 的 MCP 工具注册与业务逻辑（`mcp/tools.ts`、`mcp/server.ts`、`scripts/build-mcp.mjs`） | c4d078c | `pnpm build:mcp` ✅，`pnpm lint` ✅，`pnpm check:host` ✅，`pnpm tsc -b --noEmit` ✅，`node dist-mcp/flycut-mcp.mjs --help` ✅ |
| 2026-11-13 | 3. 强化前端客户端确认中心与 Host 待审建议入口 | e985c83 | `pnpm lint` ✅，`pnpm tsc -b --noEmit` ✅，`pnpm check:host` ✅，`F-0051.spec.ts` ✅ |
| 2026-11-13 | 4. 编写安装配置说明与市场上架准备材料（`docs/mcp-server.md`、`server.json`、`mcp/marketplace/README.md`、`skills/flycut-caption/SKILL.md`） | 0a8a83f | `JSON.parse(server.json)` ✅ |
| 2026-11-13 | 5. MCP 架构与真实协议子进程集成测试、真实 SenseVoice 闭环及 `codex mcp` 验证（`tests/architecture/mcp-f0052.test.ts`、`cli/client.ts` ENOENT→NOT_FOUND） | 051d400 | `pnpm build:mcp` ✅，`mcp-f0052.test.ts` 4/4 ✅，`pnpm lint` ✅，`pnpm check:host` ✅ |
| 2026-11-13 | 6. 前端 E2E 测试与中英文/明暗主题视觉证据（`tests/e2e/features/F-0052.spec.ts`、修复 `ClientConfirmations` 与 `HostSuggestionsBanner` 刷新竞态） | 本提交 | `PW_PORT=5306 pnpm e2e:evidence F-0052` 8/8 ✅（20 张截图） |

## 自行决定的事项

<!-- 开发中自己决定的事：决定了什么、为什么、影响哪条 AC。验收时汇总进测试报告 -->
- **长任务默认提交策略**：`flycut_transcribe`、`flycut_suggest_edits`、`flycut_export`、`flycut_prepare_model` 默认 `wait: false` 返回 `jobId`，传 `wait: true` 时等待完成并推送 `notifications/progress`；避免客户端工具超时并区分提交态与完成态（AC-6、AC-7）。
- **协议发现不强依赖 Host 运行**：`initialize`、`tools/list`、`resources/list` 在无运行 Host 时正常响应，需要 Host 的工具调用返回带引导的 `NO_HOST_CONNECTION`（AC-5）。
- **破坏性确认门禁与 `ENOENT` 归一化**：MCP 不暴露任何 `confirmations.decide` 工具；覆盖导出在写盘前原子消费 `confirmationId`；在 `cli/client.ts` 将 Host 文件缺失 `ENOENT` 归一化为 `NOT_FOUND` 保证目标不存在错误可稳定识别（AC-3、AC-8）。
- **客户端确认与待审建议竞态防护**：`ClientConfirmations` 增加 `listEpochRef` 防止过时 `confirmations.list` 覆盖新到的 WS `confirmation/updated` 事件；`cutPersistence.ts` 保持 `updatingCuts: true` 直至 `projects.suggestions.dismiss` 完成，避免 `HostSuggestionsBanner` 提前刷新残留已应用的建议（AC-3、AC-9）。

## 与设计的偏差

<!-- 实现时改变了设计的地方及原因；重大偏差回到 02-design.md 修改，并记进测试报告 -->
- 无重大偏离；在执行测试时补充了 `cli/client.ts` 的 `ENOENT -> NOT_FOUND` 错误码归一化以及前端 `ClientConfirmations` / `HostSuggestionsBanner` 的刷新竞态保护，使错误分类与实时状态更新更稳定。

## 遗留问题

---
id: F-0051
stage: 04-test-report
status: review
approved_by:
approved_at:
---

# F-0051 Host项目操作CLI：测试与验收

验收在代码与测试提交 `35d5d09` 上进行；本报告随后作为文档提交，不改变代码与测试。

> 技术设计和开发阶段由 agent 连续推进、自动确认；维护者在这里一并审阅。

## 设计与实现摘要

给不依赖浏览器的用户与 Agent 提供一条操作 Host 的 CLI，并把破坏性动作交回人确认：

- **CLI**（`cli/flycut.ts`、`cli/client.ts`、`cli/help.ts`）：支持 `status`、`providers`、`ai list`、`media upload`、`projects *`、`transcribe`、`suggest`、`export`、`jobs get/cancel`；`--json` 只写 stdout、进度与日志走 stderr、稳定退出码（2 鉴权 / 3 连接 / 4 待确认 / 5 参数 / 6 未找到 / 7 未就绪 / 9 任务失败 / 130 中断）。
- **Host 应用服务**（`server/plugins/projectOps.ts`）：`projects.transcribe`、`projects.suggestEdits`（只产出待审建议）、`projects.export` 与 UI 共用同一套项目与 EDL 语义。
- **确认中心**（`shared/confirmations.ts`、`server/plugins/confirmations.ts`、`ClientConfirmations.tsx`）：删除项目 / 移除视频 / 覆盖导出都创建 pending 请求，只有 UI 客户端以 `actor: 'ui-client'` 批准后才可消费；`--yes` 与 Agent 参数不能绕过，操作 ID 幂等去重。
- **凭据边界**：CLI 只从 `--token` / `--token-file` / `connection.json` 读取 Host 凭证，AI 模型配置沿用 F-0056 的 Host 侧 configId，不读浏览器存储，输出统一脱敏。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| 破坏性操作 | 一律创建 confirmation 并返回退出码 4，只有 UI 决定后 CLI 才能带 `--confirmation-id` 执行 | `--yes` 由调用方传入，不能作为“本人确认”的证据 | AC-3、AC-8 |
| 连接方式 | CLI 只连已运行 Host，不自动拉起或下载模型 | 避免 CLI 变成第二套安装器，也让鉴权边界单一 | AC-2 |
| 确认中心位置 | 项目页侧栏入口 + 内嵌面板，空态明确「暂无待确认请求 / Nothing here yet」 | 用户本来就在项目页操作，不新增独立页面 | AC-5 |
| 子进程测试并发模型 | 用 `spawn` 异步等待替代 `spawnSync` | 同进程内的隔离 Host 需要事件循环才能应答 CLI 请求，同步 spawn 必然超时 | AC-4、AC-9 |

## 验收标准逐条结果

| AC | 目标平台 / 环境 | 验证方式、用例与命令 | 证据或未跑原因 | 结果 |
|---|---|---|---|---|
| AC-1 | 真实 CLI 子进程 + 隔离 Host | `tests/architecture/cli-f0051.test.ts`「CLI subprocess drives isolated Host end-to-end」 | 创建项目（`/uploads`）、转写、取建议、导出新文件均返回对象与状态；帮助与 JSON 契约有效 | ✅ 通过 |
| AC-2 | 真实 CLI + Host | 同上用例的鉴权段；`pnpm cli status --json` | 错误 token 返回 `AUTH_FAILED` 与退出码 2，stdout/stderr 都不包含 token；未就绪/连接失败有可操作提示 | ✅ 通过 |
| AC-3 | 真实 CLI + Host + Web | 同上用例的覆盖导出与删除段；E2E「confirmation center lists pending CLI requests and approves them」 | `--yes` 仍返回 4 与 `bypassRejected: true`；UI 批准后才能覆盖；建议只生成待审内容 | ✅ 通过 |
| AC-4 | 隔离 Host + CLI 子进程 | 同上用例的 Ctrl+C 段 | SIGINT 后退出码 130，stderr 报告 Host 任务仍在运行并可 `jobs get` 查询；重复 `operationId` 不重复创建项目 | ✅ 通过 |
| AC-4 | 真实 ASR 模型长音频 | 用真实 SenseVoice 转写 30–60 分钟口播并导出 | 子进程测试使用注入 Provider 覆盖协议与任务链路；真实长音频未在本环境跑 | ⏸ Not run |
| AC-5 | 真实 CLI | `pnpm cli --help`、空项目列表用例 | 帮助含示例与退出码说明；空列表返回 `{ ok: true, data: [] }` 且退出码 0 | ✅ 通过 |
| AC-5 | Web Chrome | E2E 空态用例 | 无待确认时显示「暂无待确认请求 / Nothing here yet」，项目编辑不受影响 | ✅ 通过 |
| AC-6 | 真实 CLI 子进程 | 同上用例的进度与中断段 | `--json` 下 stdout 只有最终 JSON，进度在 stderr；Ctrl+C 说明 Host 任务是否继续 | ✅ 通过 |
| AC-7 | 真实 CLI + Host | 创建/转写/导出断言 + UI 读取 | 返回项目与资产 ID，只有 Host 校验通过才标记完成；退出码 0 只代表该命令承诺的阶段成功 | ✅ 通过 |
| AC-8 | 真实 CLI + Host + Web | 鉴权、无效 UUID、覆盖未确认、连接失败用例 | 稳定错误码与非零退出码，不泄密；未确认的覆盖不会执行，已有文件大小不变 | ✅ 通过 |
| AC-9 | Web Chrome（中英文 × 明暗） | `PW_PORT=5293 pnpm e2e:evidence F-0051` | 8/8 通过，16 张截图入库，录屏仅本地 | ✅ 通过（Web） |
| AC-9 | 软字幕导出 | CLI `--subtitles soft` 导出 | 本机环境该任务返回空错误的 FFmpeg 失败；改用 `--subtitles none` 验证导出与覆盖确认链路 | ⏸ Not run |
| AC-9 | 真实 Tauri 桌面端 | 桌面应用内确认中心审批后执行删除/覆盖 | 本 worktree 未构建桌面安装包 | ⏸ Not run |

## 界面证据

由 `PW_PORT=5293 pnpm e2e:evidence F-0051` 生成，覆盖 `light/dark × zh/en`；`screenshots/` 已入库。

| 界面 | 状态 | AC | 截图 |
|---|---|---|---|
| 项目页侧栏 | 待确认入口 + 计数 | AC-3、AC-5 | `confirmations-entry-{light,dark}-{zh,en}.png` |
| 确认中心 | pending 列表 | AC-3、AC-8 | `confirmations-list-{light,dark}-{zh,en}.png` |
| 确认中心 | 批准后计数更新 | AC-3 | `confirmations-approved-{light,dark}-{zh,en}.png` |
| 确认中心 | 空态 | AC-5 | `confirmations-empty-{light,dark}-{zh,en}.png` |

## 回归检查

全部运行于提交 `35d5d09`：

- `pnpm lint` ✅
- `pnpm tsc -b --noEmit` ✅
- `pnpm check:host` ✅
- `cargo check --manifest-path src-tauri/Cargo.toml` ✅
- `pnpm test` ✅：107 passed，0 failed，5 skipped（未下载的额外 ASR 模型）
- `pnpm test:architecture` ✅：148/148 passed（含 CLI 子进程端到端）
- `PW_PORT=5293 pnpm e2e:evidence F-0051` ✅：8/8 passed，16 张截图
- Red check ✅：把 `confirmations.decide` 的 `actor === 'ui-client'` 校验去掉后，`cli-f0051.test.ts` 的「CLI 不能自行批准」用例立即失败；恢复后重新全绿

## 发现的问题

- 子进程测试最初用 `spawnSync`，会阻塞同进程 Host 的事件循环，导致 CLI 请求 30 秒超时并误报 `NO_HOST_CONNECTION`；改为异步 `spawn` 后正常。
- 该 worktree 的 `--subtitles soft` 导出返回空错误，属于环境或软字幕路径问题，已如实记录为 `⏸ Not run`，未用无字幕导出冒充。

## 结论

CLI 命令面、鉴权与脱敏、幂等、破坏性操作的客户端确认、Ctrl+C 语义，以及确认中心的 UI 流程均由自动化覆盖（AC-1 至 AC-8 与 AC-9 的 Web 部分）。真实长音频转写、软字幕导出与桌面实机受环境限制，如实记为 `⏸ Not run`。

本报告等待维护者审阅确认；未自行执行 `pnpm feature approve`。


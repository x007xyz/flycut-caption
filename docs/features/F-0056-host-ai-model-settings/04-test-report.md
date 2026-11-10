---
id: F-0056
stage: 04-test-report
status: review
approved_by:
approved_at:
---

# F-0056 AI模型配置与密钥保存到Host：测试与验收

验收在 commit `83059bd` 上进行。

> 技术设计和开发阶段由 agent 连续推进、自动确认；维护者在这里一并审阅。

## 设计与实现摘要

AI 配置元数据保存在 Host home 的版本化 JSON，API Key 由独立 secret backend 保存；RPC 只暴露
`hasApiKey`，文本纠错、翻译和 Agent 都按 `configId` 由 Host 解析 Key。桌面使用 macOS Keychain，
远程 Profile 使用 `FLYCUT_AI_SECRET_KEY` 加密文件；测试用 memory backend 只用于隔离场景。

浏览器旧配置在用户确认目标 Host 后按 `hostId + migrationId` 导入，失败保留本地副本并用同一请求
ID 重试，成功后才清理。所有面板写操作和根快照加载都绑定请求 generation；列表响应还核对
`hostId`，同地址 identity 变化时旧配置不会串入新 Host。编辑时可留空保留 Key，或显式清除。

架构决定见 [ADR-0007](../../20-architecture/adr/0007-host-ai-settings-and-secrets.md)，当前仍为
`proposed`，应在维护者确认本报告时一并决定是否转为 `accepted`。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| 清除 Key | 编辑表单增加显式清除按钮；空输入仍表示保留 | 避免只改名称时误删 Key，同时让用户能主动撤销已存 Key | AC-3、AC-4 |
| 迟到响应 | 所有操作绑定 request generation；列表还核对 response `hostId` | 切 Host 或 identity 变化时旧响应不能改写当前 store | AC-6、AC-7、AC-8 |
| 证据配置 | `e2e-evidence` 支持 `FLYCUT_E2E_CONFIG`，并改用 Playwright 1.64 的 JSON 输出变量 | 让验收固定走 localhost:5175，并实际产出录屏摘要 | AC-9 |
| 本机测试资源 | 全量架构测试从原仓库只读软链媒体、FFmpeg、FunASR 和 VAD 资源 | 目标 worktree 只有被 git 忽略的占位文件；未改写源文件 | 验证环境 |

## 验收标准逐条结果

| AC | 验证方式 | 证据 | 结果 |
|---|---|---|---|
| AC-1 | 架构测试、第二个 HTTP 客户端、真实本地 OpenAI 兼容 fixture | `F-0056/AC-1 AC-3 AC-7 AC-8 config IDs...`：第二客户端读到同一 revision，并用同一 `configId` 完成纠错；RPC/job 中不含明文 Key | ✅ |
| AC-2 | Playwright、失败重试 | `F-0056/AC-2 AC-6 AC-8 explicit Host-bound migration...`：失败后本地 Key 仍在，第二次请求复用同一 `migrationId`，成功后才清本地副本 | ✅ |
| AC-3 | Playwright、Red check | CRUD、测试连接、空 Key 保留、显式清除、遮罩和 revision 冲突覆盖 4 个主题/语言组合；撤掉冲突保护后测试以 `saved !== conflict` 失败 | ✅ |
| AC-4 | 架构测试、真实 macOS Keychain、本地严格回归 | 加密文件 0600/原子写/串行；元数据失败保留旧 ref；`OsAISecretStore` 唯一临时引用写入、读回、删除成功；本地 fixture 错误/job/RPC 不含 Key。付费外部 API 见 AC-9 | ✅（本地真实） |
| AC-5 | Playwright | 空配置显示添加入口，已有编辑界面可用；中英文与明暗主题全覆盖 | ✅ |
| AC-6 | Playwright | 加载显示处理中，刷新/添加/编辑/删除在忙碌期间禁用；错误 Host 响应和 identity 切换不写回旧数据 | ✅ |
| AC-7 | Playwright、Host 重启、第二个客户端 | 只有 Host 返回新 snapshot 才显示完成；重启与第二客户端读回同一 Host 配置 | ✅ |
| AC-8 | Playwright、架构 Red check | 迁移失败保留来源；revision 冲突保留表单并提示重新检查；错误 Host 响应保留当前列表 | ✅ |
| AC-9 | 40 张截图、8 段录屏、真实 Host/本地接口 | localhost:5175 UI 8/8；真实本地 Host、本地 OpenAI 兼容接口和 macOS 凭据后端通过。真实付费 AI 和完整 Tauri 窗口人工点击未跑 | ⏸ Not run |

## 界面证据

| 界面 | 状态 | AC | 截图 | 录屏 |
|---|---|---|---|---|
| AI 设置 | 空态、已保存、清除 Key、冲突已重编 | AC-3、AC-5、AC-8 | `screenshots/settings-{empty,saved,key-cleared,conflict-resolved}-{light,dark}-{zh,en}.png` | 2 段/主题语言组合 |
| AI 设置 | 加载、错误 Host 响应、identity 切换 | AC-6、AC-8 | `screenshots/settings-{loading,host-mismatch,host-switched}-{light,dark}-{zh,en}.png` | 同组录屏 |
| 旧配置迁移 | 核对、失败保留、成功清理 | AC-2、AC-6、AC-8 | `screenshots/migration-{review,failed,complete}-{light,dark}-{zh,en}.png` | 同组录屏 |

`docs/features/F-0056-host-ai-model-settings/screenshots/` 共 40 张 PNG；
`recordings/summary.json` 记录 commit `83059bd`、8 passed / 0 failed；8 段 WebM 仅保存在本地，已被 git 忽略。

## 回归检查

- `pnpm lint` ✅
- `pnpm tsc -b --noEmit` ✅
- `pnpm check:host` ✅
- `pnpm test`：95 passed、3 skipped；跳过项是未下载的可选 ASR 模型 moonshine、nemo_transducer、whisper，不计为通过
- `pnpm test:architecture`：96/96 ✅（只读复用本机媒体、FFmpeg、FunASR 和 VAD 资源）
- `pnpm exec playwright test tests/e2e/features/F-0056.spec.ts --config /private/tmp/f0056-playwright.config.ts`：8/8 ✅，localhost:5175
- `pnpm build` ✅；`pnpm build:lib` ✅；`pnpm package:host` ✅；`cargo check --manifest-path src-tauri/Cargo.toml` ✅
- Red check 1：撤掉 save 的 revision 检查，专项测试失败于 `saved !== conflict`
- Red check 2：让公开 snapshot 拼接 secret，专项测试失败于 `true !== false`（RPC 明文 Key 检查）
- 恢复后：F-0056 架构专项 5/5 ✅

## 发现的问题

- 无产品代码失败。首次全量架构测试缺媒体/二进制/VAD 资源，按授权从原仓库只读复用后 96/96 通过。
- `cargo check` 首次因 `src-tauri/host/**/*` 未生成而失败；运行 `pnpm package:host` 后通过。
- 未发现明文 Key 出现在 RPC、job、普通元数据或加密文件的可读内容中。

## 结论

本地实现、Host 架构、UI 矩阵和 macOS 凭据后端均已通过，未发现需要修复的代码问题。
真实付费外部 AI 与完整 Tauri 窗口人工点击仍是 `Not run`；完成授权后补测前，结论为
**需要补测后由维护者验收**。本报告不自行批准。

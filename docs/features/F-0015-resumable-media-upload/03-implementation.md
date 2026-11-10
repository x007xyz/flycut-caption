---
id: F-0015
stage: 03-implementation
status: draft
approved_by:
approved_at:
---

# F-0015 大文件断点续传与断线恢复：开发记录

## 分支与 PR

- 分支：`codex/f0015-resumable-upload`
- PR：未创建（本轮不推送、不合并）

## 进度

<!-- 每完成实现清单的一项，在 02-design.md 勾选，并在这里追加一行：日期、清单项、提交 sha、跑过的检查。
换会话接着做时，先读 02-design.md 和这里。 -->

| 日期 | 清单项 | 提交 | 检查 |
|---|---|---|---|
| 2026-11-10 | 1–3 共享契约、持久分片、完整性完成与竞态 | 本次提交 | `uploads-f0015` 13/13；`pnpm check:host` ✅ |
| 2026-11-10 | 4 项目/任务 operationId | 本次提交 | 项目、结构变更与 Job 幂等包含在 13 项架构测试中 ✅ |
| 2026-11-10 | 5–6 客户端上传器、恢复定位、项目面板 | 本次提交 | `pnpm tsc -b --noEmit` ✅；F-0015 E2E 22/22 ✅；F-0002 AC-17、F-0003 AC-27 回归 ✅ |
| 2026-11-10 | 8 真实网络与架构文档（部分） | 本次提交 | 真实 Host/Chrome/TCP 切断、刷新重选与最终 SHA 一致 ✅；架构测试 104/104 ✅；04 尚未创建 |

## 自行决定的事项

<!-- 开发中自己决定的事：决定了什么、为什么、影响哪条 AC。验收时汇总进测试报告 -->

- Web 项目导入统一切到 `/uploads`；Tauri 本地文件仍使用 F-0002 的 `mediaRef`，因此桌面路径不会进入浏览器的定位元数据。
- 暂停只中止当前请求并保留服务端会话；继续或重连后先 GET 会话，再从缺失分片开始。刷新后源文件句柄不可恢复，统一进入 `needs-file`，重新选择后比较大小与完整 SHA-256。
- `interrupted`、`paused` 和 `uploading` 都显示服务端确认字节；取消采用行内二次确认，完成后的资产不会被取消请求删除。
- 重启恢复时重新计算每个已确认分片摘要，损坏或未落盘的索引不进入确认列表，后续上传可覆盖该索引。

## 与设计的偏差

<!-- 实现时改变了设计的地方及原因；重大偏差回到 02-design.md 修改，并记进测试报告 -->

- 本轮未完成实现清单 7 的客户端 ASR/导出同一 `operationId` 重试与对应任务核验 UI；Host 端 `workflow.start`/`export.start` 幂等已经实现并有架构测试，但前端服务仍按新调用启动任务。AC-9 的 ASR/导出界面部分因此保留为验收门禁。
- UI 的检查、哈希、失败和过期状态用受控 Host mock 构造；真实 Host 浏览器验证覆盖 TCP 切断、重连、刷新重选和最终摘要。真实 Cloud 环境的账号/计费不在本仓库，未运行。

## 遗留问题

- 实现清单 7：把 ASR/导出客户端的 `operationId` 固定在同一用户操作上，响应不确定时从 `jobs.list`/`jobs.get` 核验并禁用重复启动。
- Red check 未完成：自动审批拒绝从生产代码临时移除分片 offset 校验，理由是这会持久削弱完整性边界。现有测试与代码审查证据保留，需维护者明确批准后再做生产代码回退验证。
- 未在真实 Cloud 账号、真实 10–60 分钟源视频和桌面 Tauri 全流程上验证；本轮真实浏览器素材为 5 MiB 多分片 fixture。
- `04-test-report.md` 尚未创建；03 仍有未完成清单项，不能运行开发阶段自动确认。

## 验证记录

- `pnpm lint` ✅
- `pnpm tsc -b --noEmit` ✅
- `pnpm check:host` ✅
- `pnpm test` ✅：94 passed，4 skipped（缺 moonshine、parakeet、whisper 和双 VAD 资产）
- `pnpm test:architecture` ✅：104 passed
- `pnpm build` ✅
- `cargo check --manifest-path src-tauri/Cargo.toml` ✅
- `F0015_REAL=1 UPDATE_SHOTS=1 pnpm exec playwright test tests/e2e/features/F-0015.real.spec.ts --workers=1` ✅
- `pnpm e2e:evidence F-0015` ✅：22 passed，29 screenshots，22 recordings（录屏不入 git）

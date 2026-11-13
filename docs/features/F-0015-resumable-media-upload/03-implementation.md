---
id: F-0015
stage: 03-implementation
status: approved
approved_by: auto
approved_at: 2026-11-10
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
| 2026-11-10 | 1–3 共享契约、持久分片、完整性完成与竞态 | `a569f15` | `uploads-f0015` 13/13；`pnpm check:host` ✅ |
| 2026-11-10 | 4 项目/任务 operationId | `a569f15` | 项目、结构变更与 Job 幂等包含在架构测试中 ✅ |
| 2026-11-10 | 5–6 客户端上传器、恢复定位、项目面板 | `a569f15` | `pnpm tsc -b --noEmit` ✅；F-0015 E2E 22/22 ✅；F-0002 AC-17、F-0003 AC-27 回归 ✅ |
| 2026-11-10 | 7 ASR/导出结果核验与客户端任务定位 | `0a2608b` | 任务故障注入 10/10；Host 上传架构 13/13；`pnpm tsc -b --noEmit` ✅ |
| 2026-11-10 | 8 真实网络与验收证据 | `0a2608b` | 60 分钟素材三次断网与刷新恢复通过；架构 114/114；F-0015 证据 22/22 |

## 自行决定的事项

<!-- 开发中自己决定的事：决定了什么、为什么、影响哪条 AC。验收时汇总进测试报告 -->

- Web 项目导入统一切到 `/uploads`；Tauri 本地文件仍使用 F-0002 的 `mediaRef`，因此桌面路径不会进入浏览器的定位元数据。
- 暂停只中止当前请求并保留服务端会话；继续或重连后先 GET 会话，再从缺失分片开始。刷新后源文件句柄不可恢复，统一进入 `needs-file`，重新选择后比较大小与完整 SHA-256。
- `interrupted`、`paused` 和 `uploading` 都显示服务端确认字节；取消采用行内二次确认，完成后的资产不会被取消请求删除。
- 重启恢复时重新计算每个已确认分片摘要，损坏或未落盘的索引不进入确认列表，后续上传可覆盖该索引。

## 与设计的偏差

<!-- 实现时改变了设计的地方及原因；重大偏差回到 02-design.md 修改，并记进测试报告 -->

- ASR 与导出都在客户端固定同一操作的 `operationId`。任务定位按 hostId 分隔，并在每次动作重新读取身份；同一地址切到另一 Host 时不会继续旧任务。等待任务期间发生不确定网络错误时保留定位，只有明确的 `error`/`cancelled` 终态或成功交付后才允许清理。
- ASR 输入键包含当前项目/视频、源内容 SHA-256、模型、语言和选项；导出裸文件包含内容 SHA-256，项目媒体使用受保护资产路径身份。同名同大小但内容变化不会误复用旧任务。
- ASR 继续通过既有 `flycut/transcribed` 事件通知第三方订阅者，并改为可等待的并行分发。项目监听器只在事件内保存一次；Host 保存失败时不清理任务定位，编辑器仍显示识别结果，用户重试可读取同一完成结果。
- UI 的检查、哈希、失败和过期状态用受控 Host mock 构造；真实 Host 浏览器验证覆盖三次 TCP 切断、重连、刷新重选和最终摘要。外部 Cloud 账号与计费不在本仓库。

## 遗留问题

- 未在外部 Cloud 账号、Windows 打包和桌面 Tauri GUI 完整流程上运行；真实网络证据使用维护者认可的本地 Host 契约与真实 Chrome。

## 验证记录

- `pnpm lint` ✅
- `pnpm tsc -b --noEmit` ✅
- `pnpm check:host` ✅
- `pnpm test` ✅：94 passed，4 skipped（缺 moonshine、parakeet、whisper 和双 VAD 资产）
- `pnpm test:architecture` ✅：114 passed（从原仓库复用忽略的真实测试媒体后重跑）
- `pnpm build` ✅
- `cargo check --manifest-path src-tauri/Cargo.toml` ✅
- `F0015_REAL=1 F0015_REAL_MEDIA=/absolute/path/60min.mp4 pnpm exec playwright test tests/e2e/features/F-0015.real.spec.ts --workers=1` ✅：1 passed；255,668,512 bytes；SHA-256 `f0e38bf3443df40ff8fa127933d98bce8fd17b5b83d4b155f4655d25ddf2a2d6`
- 真实断网：三次中断时 Host 已确认 8 MiB、16 MiB、24 MiB；刷新前 8 MiB，重新选择后最终 255,668,512 bytes，恢复后新发送 247,279,904 bytes，小于完整文件。
- `pnpm e2e:evidence F-0015` ✅：22 passed，29 screenshots，22 recordings（录屏不入 git）
- Red check（隔离副本，不改生产工作区）：移除分片 offset 比较后，`F-0015/AC-3 chunk offsets...` 失败为 `200 !== 409`；移除最终整体 SHA-256 比较后，`F-0015/AC-3/AC-7 final size/digest...` 失败为 `200 !== 422`。

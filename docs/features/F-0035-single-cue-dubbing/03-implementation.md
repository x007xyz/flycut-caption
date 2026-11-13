---
id: F-0035
stage: 03-implementation
status: draft
approved_by:
approved_at:
---

# F-0035 单条译文配音与试听：开发记录

## 分支与 PR

- 分支：codex/f0035-single-cue-dubbing
- PR：

## 进度

<!-- 每完成实现清单的一项，在 02-design.md 勾选，并在这里追加一行：日期、清单项、提交 sha、跑过的检查。
换会话接着做时，先读 02-design.md 和这里。 -->

| 日期 | 清单项 | 提交 | 检查 |
|---|---|---|---|
| 2026-11-13 | 清单 1：共享契约、状态评估与单元测试 | 1a50554 | pnpm tsc -b --noEmit ✅, pnpm check:host ✅, node --test tests/cue-dubbing.test.mjs ✅ |
| 2026-11-13 | 清单 2：Host 配音插件、项目产物落盘、并发锁与架构测试 | 284d325 | pnpm check:host ✅, tsx --test tests/architecture/dubbing-f0035.test.ts ✅ (2/2) |
| 2026-11-13 | 清单 3：前端 historyStore/ProjectService/recovery 与 DubbingService 同步 | a1c52e7 | pnpm tsc -b --noEmit ✅, pnpm check:host ✅, tsx --test tests/architecture/dubbing-client-f0035.test.ts ✅ (2/2) |
| 2026-11-13 | 清单 4：配音文案、useCueDubbing、SingleCueDubbingPanel 与字幕行入口 UI | 1425435 | pnpm lint ✅, pnpm tsc -b --noEmit ✅, pnpm check:host ✅ |
| 2026-11-13 | 清单 5：Web 端到端测试、Red check 与截图/录屏证据生成 | pending | PW_PORT=5304 pnpm e2e:evidence F-0035 ✅ (8/8, 36 screenshots, 8 recordings), Red check ✅ |

## 自行决定的事项

<!-- 开发中自己决定的事：决定了什么、为什么、影响哪条 AC。验收时汇总进测试报告 -->

1. 沿用 `02-design.md` 的五项自行决定：入口同时提供头部按钮与行内按钮、仅 `offline === true && providerId !== 'flycut-cloud'` 可自动预选、未选模型时不误报过期、过长容差 `0.01s`、`dubbings` 不进文本/剪辑撤销栈。
2. 新增 `RemoteConnection.downloadPath`（并在 `HostConnection` 实现）以通过鉴权 Header / Cookie 拉取 `/projects/:projectId/videos/:videoId/dubbing/:dubId` 并转成 `blob:` URL，避免把 bearer token 拼进 DOM。
3. `dubbing.synthesizeCue` 在 Zod schema 层直接拒绝携带 `cloneReferenceAssetId` 或 `cloneAuthorization` 的请求，确保单条配音首版只使用自带音色。

## 与设计的偏差

<!-- 实现时改变了设计的地方及原因；重大偏差回到 02-design.md 修改，并记进测试报告 -->

- 无重大架构偏差；`useCueDubbing` 使用独立的 `settingsEpochRef` 管理 `tts.getSettings` 加载生命周期，避免首次打开选中字幕时 `targetScopeKey` 变更误取消设置读取。

## 遗留问题

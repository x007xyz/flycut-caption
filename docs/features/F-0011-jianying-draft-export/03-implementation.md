---
id: F-0011
stage: 03-implementation
status: draft
approved_by:
approved_at:
---

# F-0011 剪映草稿导出：开发记录

## 分支与 PR

- 分支：`codex/f0011-jianying-export`
- PR：

## 进度

<!-- 每完成实现清单的一项，在 02-design.md 勾选，并在这里追加一行：日期、清单项、提交 sha、跑过的检查。
换会话接着做时，先读 02-design.md 和这里。 -->

| 日期 | 清单项 | 提交 | 检查 |
|---|---|---|---|
| 2026-11-10 | 1. 共享契约、候选生成器与回读验证器 | `5a886f8` | F-0011 架构测试 4/4；真实视频固定 EDL、跨切点字幕、回读与 SHA-256 通过 |
| 2026-11-10 | 2. 离线候选 harness | `5a886f8`, `d00c4f6` | 复制媒体、封面、三份 JSON、SHA-256、同名拒绝、取消与注入失败后的 staging 清理通过 |
| 2026-11-10 | 3. 只读能力 RPC 与无导出 RPC 门禁 | `5a886f8`, `d00c4f6` | `verifiedByImport:false`、`exportEnabled:false`；方法表无 start/preflight/export/grant/directory |
| 2026-11-10 | 4. 禁用态能力面板 | `c72cff2`, `d00c4f6` | 5179 隔离端口 Playwright 12/12；中英、明暗主题；普通导出调用 0 |
| 2026-11-10 | 5. 真实导入、两段口播与搬迁 | — | ⏸ Not run；真实 AC 与 04 验收门禁未完成，清单不勾 |

## 自行决定的事项

<!-- 开发中自己决定的事：决定了什么、为什么、影响哪条 AC。验收时汇总进测试报告 -->

- 能力对象按设计使用 `checkedAt`，并在矩阵中实际渲染调研日期；新增 Web 目标行，明确候选生成只支持桌面 Host。影响 AC-1。
- 检查失败页只提供重试，不显示生成按钮；加载中同样没有目录选择或导出动作。影响 AC-1、AC-5、AC-8。
- 候选 harness 在调用 FFmpeg 前先检查源媒体；文件缺失直接报 `Source media is missing`，便于区分媒体错误与解码失败。影响 AC-6。

## 与设计的偏差

<!-- 实现时改变了设计的地方及原因；重大偏差回到 02-design.md 修改，并记进测试报告 -->

- 设计中的“详情展开”当前改为在矩阵内直接显示候选范围与降级清单；没有新增隐藏交互。
- 增加 Web 行是补齐设计支持矩阵，不扩大生成范围；所有目标和按钮仍禁用。
- 产品导出、原生目录选择、shell grant 和 `jianying.start` 均未实现，按设计留在真实导入验证之后。

## 遗留问题

### 本机 macOS 11.7.0 兼容性复核

- 按维护者指示使用本机剪映专业版 11.7.0。只读检查带 `Timelines/project.json` 的五个本地样本：五个根 `draft_info.json` 和对应时间线 `draft_info.json` 均不是可直接解析的 JSON，外层为 Base64；其中两个另留有可解析的旧 `draft_content.json`。没有修改已有草稿。
- 用 `scripts/jianying-candidate.ts` 和仓库 demo 视频在临时目录生成 Windows 5.9.0 明文候选，生成器完成回读校验：3 段视频、4 段字幕、21,091,224 字节的媒体副本。现有本地草稿用于确认格式；候选产物用于测试 FlyCut 的输出。
- 在 Mac 剪映的「文件 → 找回草稿」进入候选目录并尝试打开 `draft_content.json`；随后桌面自动化超时，未观察到候选进入时间线，也未得到应用明确拒绝的证据。macOS 导入、播放、改字幕、保存重开仍未验证，产品导出继续禁用。

### 候选产物只读复核（2026-11-10）

- 沿用主 agent 已生成的 `/private/tmp/f0011-mac.l9QZ7q/F0011-Mac-Validation`，没有新建或修改剪映草稿，也没有修改本机五个用户样本。
- 用 `verifyJianyingDirectory` 只读复核：`draft_content.json` 与 `draft_info.json` 字节相同，SHA-256 都是 `d712cb235a970a4a3353994f619ec4abb8d5f44dbd1f5744aa7bb6ff55e5fa25`；3 个视频段、4 个投影文本段。
- 复制媒体为 21,091,224 字节，SHA-256 为 `ac51c81d497e6faafd4750615b89b2530d12e3f8077aff2eda10b597a3a7f90d`，与仓库 `src/assets/demo.mp4` 一致；封面是 1280x720 JPEG。
- 这证明候选结构、EDL 投影、媒体复制与回读校验一致，不证明任何剪映版本能导入、播放或编辑。

### 回归与证据（代码提交 `d00c4f6`）

- `pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`、`cargo check --manifest-path src-tauri/Cargo.toml` 通过。
- `pnpm test`：87 通过，11 个依赖 sidecar/模型/共享资源的既有集成测试跳过。
- `pnpm test:architecture`：92/95 通过；F-0011 4/4 通过。剩余 3 项是既有 F-0006/F-0007 缺少本地或外部测试素材。
- F-0011 Playwright 在临时 5179 隔离端口运行：12/12 通过，12 张截图提交在 `screenshots/`，12 段录屏与摘要留在本地忽略目录。端口覆盖只用于本轮验证，`playwright.config.ts` 已恢复，不纳入提交。

### 剩余门禁与下一步可行验证

- **AC-1/AC-8 产品门禁：** 当前只能验收禁用态矩阵和经验证不会调用生成方法的 UI；真实 Windows 5.9.0 导入通过前，导出保持禁用。
- **AC-7/AC-9/AC-10：** 仍需在 Windows 5.9.0 剪映中打开候选，核对三个保留区间、四个投影字幕、媒体路径和主字幕可编辑性；随后保存、重开、移动草稿目录再打开。
- **两段真实口播：** 生成新的两段素材候选并分别完成字幕校对与 EDL 粗剪后，在目标剪映中播放、改字幕、保存重开；不能用同一 `demo.mp4` 的多个输入冒充。
- **本机 macOS 11.7.0：** 现有“找回草稿”尝试 UI 超时，结果仍是不确定；不能记为通过或明确拒绝，也不能作为 macOS 支持证据。
- 完成上述实机证据、维护者审阅并确认 AC 后，才能勾第 5 项、创建/提交 04 测试报告并使 `03-implementation` 离开 draft；当前不自行批准、不推送、不合并。

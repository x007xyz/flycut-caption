---
id: F-0026
stage: 04-test-report
status: review
approved_by:
approved_at:
---

# F-0026 平台风格字幕预设与安全区：测试与验收

验收在代码与测试提交 `039e40f` 上进行；本报告随后作为文档提交，不改变代码与测试。

> 技术设计和开发阶段由 agent 连续推进、自动确认；维护者在这里一并审阅。

## 设计与实现摘要

在既有项目存储与共用图形层（ADR-0003、ADR-0004、ADR-0006）上实现 5 大平台风格预设与安全区参考辅助线，未修改跨边界存储格式与 Host RPC 协议，未新增 ADR：

- **单一真相预设目录与字体覆盖边界**（`shared/subtitle-graphics/platformPresets.ts`、`src/subtitle/platformPresets.ts`、`src/subtitle/subtitleStyle.ts`）：定义抖音（9:16）、视频号（9:16）、小红书（9:16）、B 站（16:9）、YouTube Shorts（9:16）5 套预设及安全区边距（0%–45% 限幅），明确 `verified: false`、参考日期 `2026-11-13` 与「参考，未验证 / Reference, unverified」说明；`defaultSubtitleStyle` 不写入可选键以保持崩溃恢复兼容；补齐 `shared/subtitle-graphics/projectExport.ts` 关键词与底框字段透传。
- **播放器纯预览安全区叠层**（`src/components/VideoPlayer/SafeZoneOverlay.tsx`、`src/components/VideoPlayer/SubtitleOverlay.tsx`）：在播放器字幕画布同尺寸矩形内用 `pointer-events-none` DOM 叠层绘制半透明遮挡区、虚线安全框、平台/画幅/参考日期/未验证角标，以及字幕进入底部遮挡区的高亮提醒；`SubtitleGraphicScene` 与 Host 导出不携带任何安全区字段，从机制上保证辅助线永不进入成片。
- **样式设置与生命周期 UI**（`src/components/SubtitleSettings/PlatformPresetsSection.tsx`、`src/components/SubtitleSettings/SubtitleSettings.tsx`、`src/locales/platformPresets.ts`）：复用编辑器「样式」Tab 展示画幅筛选（含 `1:1` 空筛选「暂无内容 / Nothing here yet」）、缩略图卡片、字体覆盖边界警告、安全区开关/参考平台/四向边距/对齐底边/重置、位置大小区 `16:9 / 9:16 / 1:1` 画幅切换，以及无字幕/缺媒体（AC-5）、加载/处理/取消（AC-6）、Host 确认才提示「已完成 / Completed」（AC-7）、失败先查后重试/返回与冲突「内容已更新，请重新检查 / Content changed. Review again.」（AC-8）。
- **Host 持久化与并发冲突辅助**（`src/services/projectService.ts`）：修复 `verifyCurrentEditsSaved()` 对 `styleSource === 'project'` 的`styleRevision` 与 `projectStyle` 同步校验；新增 `revertUnsavedStyle()`（取消未发送样式且保留字幕正文编辑）、`retryStyleSave()`（重试前先向 Host 查询避免重复写入）与 `recheckStyleConflict()`（读取 Host 最新基线与修订号并保留当前选择，核对后才能再次提交）。
- **与设计的偏差**：无重大架构偏差；在开发清单第 4 项将 `SubtitleSettings` 中「底边距」滑块上限从 `160` 放宽到 `540`（1080p 参考像素，即 50%），使竖屏平台（如抖音 25.5% ≈ 275px）微调不被输入上限截断，并在字体下拉触发器补充 `data-testid="subtitle-font-select"` 便于稳定定位。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| 5 平台默认校准状态 | 未取得各平台移动端真实截图标定前，统一标为 `verified: false`（「参考，未验证 / Reference, unverified」，参考日期 `2026-11-13`） | 本工作树无实机平台客户端界面，不能伪造已验证结论 | AC-4 |
| 安全区绘制机制 | 采用播放器同尺寸 `pointer-events-none` DOM 叠层而非写入 `drawFrame` | 彻底隔离辅助线与 `SubtitleGraphicScene`，零格式迁移成本且从机制杜绝泄漏到成片 | AC-2 |
| 预设逐字/关键词策略 | 5 平台均启用 `wordHighlightMode: 'word'` 与 `keywordColorEnabled: true`，缺可靠词时间时沿用 `word-highlight-fallback` 整句降级 | 复用 F-0024 与 F-0025 同一图形层与校验边界，不重复造渲染路径 | AC-3 |
| 画幅切换位置与底距上限 | 在「位置大小」内补充 `16:9 / 9:16 / 1:1` 切换，并将底距参考像素上限从 `160` 放宽至 `540` | 方便在单视频上验证三画幅预设与导出，并支持竖屏安全区以上位置微调 | AC-1、AC-3 |
| 字体失败重试按钮隔离 | 字体加载失败时 `PlatformPresetsSection` 仅作只读提示，唯一「重试」按钮留在 `SubtitleOverlay` | 保持 F-0028 既有「重试」按钮唯一性，仅在 Host 保存失败时显示预设区「重试 / 返回」 | AC-5、AC-8 |

## 验收标准逐条结果

| AC | 目标平台 / 环境 | 验证方式、用例与命令 | 证据或未跑原因 | 结果 |
|---|---|---|---|---|
| AC-1 | Web Chrome + 架构测试 | `pnpm test:architecture`（`platform-presets-f0026.test.ts`：5 平台预设、字体覆盖边界、不改文本与时间戳）；E2E「F-0026/AC-1 AC-2 AC-3 AC-4 AC-9」 | 展示 5 平台、画幅标签与效果缩略图；选择后支持微调与三画幅切换；切换不改字幕正文/时间戳/EDL；选用 `Inter` 渲染中文字幕时提示覆盖不足不作假承诺 | ✅ 通过 |
| AC-2 | Web Chrome + 真实 Host Skia+FFmpeg | E2E 安全区开关/四向边距/对齐/遮挡提醒；`tests/architecture/platform-presets-f0026.test.ts`「real Host Skia + FFmpeg exports platform presets across 16:9, 9:16, 1:1 with zero safe-zone guide leakage」 | 叠层展示 5 平台参考线与参考日期/画幅，支持开关与微调；导出 `subtitleScene` 不含安全区字段，开/关安全区导出场景完全一致，成片顶部无叠层像素且无 `.ass` 文件 | ✅ 通过 |
| AC-3 | 架构测试 + 真实 Host Skia+FFmpeg + Web Chrome | `platform-presets-f0026.test.ts`（5 预设 × 三画幅 `layoutScene` + `drawFrame`；真实 `bili-BV1Rex26dEWF.mp4` + `bili-BV1Rex26dEWF.transcript.json` 词元三画幅硬字幕导出）；E2E `word-highlight-fallback` | 预览与导出换行一致；16:9（B 站）、9:16（抖音）、1:1（YouTube Shorts）高亮/关键词像素命中字幕带；无可靠词元明确显示「使用整句高亮 / Using sentence highlighting」并整句渲染 | ✅ 通过 |
| AC-4 | Web Chrome + 架构测试 | `platform-presets-f0026.test.ts` 元数据断言；E2E 卡片与 `safe-zone-badge` 断言 | 5 平台卡片、安全区叠层与参考栏均明确标示「参考，未验证 / Reference, unverified」及参考日期 `2026-11-13`，不宣传零遮挡 | ✅ 通过 |
| AC-4 | 抖音 / 视频号 / 小红书 / B 站 / YouTube Shorts 移动端实机界面截图标定 | 用各平台当前实机客户端截图核对并标 `verified: true` | 本环境无各平台移动端实机应用界面截图资源，保留 `verified: false` 并在界面明确提示参考未验证 | ⏸ Not run |
| AC-5 | Web Chrome | E2E「F-0026/AC-5 AC-6 AC-9」及 `1:1` 空筛选检查 | 复用编辑器「样式」Tab；无字幕/无匹配显示「暂无内容 / Nothing here yet」；缺失媒体展示「定位视频文件 / Locate video」入口；不显示假「已完成」，原有编辑保持可用 | ✅ 通过 |
| AC-6 | Web Chrome + 架构测试 | E2E「F-0026/AC-5 AC-6 AC-9」（受控字体加载门控、提交防重、发送前取消回退、发送中取消提示）；`ProjectService` `revertUnsavedStyle` 单测 | 加载显示「正在加载… / Loading…」，提交显示「正在处理… / Processing…」并禁用重复提交；未发送取消回退样式且不丢正文编辑；已发出的 Host 写入提示无法在服务端撤回 | ✅ 通过 |
| AC-7 | 真实 Host + 双客户端架构测试 + Web Chrome | `platform-presets-f0026.test.ts` 双 `ProjectService` 连接真实 `createHost` 测试；E2E「F-0026/AC-7 AC-8 AC-9」 | 仅当 Host 返回 `saved` 后显示「已完成 / Completed」；`page.reload()` 与第二客户端连接同 Host 读取到的平台预设、画幅、安全区开关与边距完全一致 | ✅ 通过 |
| AC-8 | 真实 Host 架构测试 + Web Chrome | `platform-presets-f0026.test.ts`（丢回执重试、冲突锁定与 `recheckStyleConflict`）；E2E「F-0026/AC-7 AC-8 AC-9」 | 保存失败显示具体原因与「重试 / Retry」「返回 / Back」且保留当前输入；重试先查 `projects.open` 确认已落盘时不再重复写入；冲突提示「内容已更新，请重新检查 / Content changed. Review again.」，点击「重新检查 / Re-check」核对后才允许提交 | ✅ 通过 |
| AC-9 | Web Chrome（zh/en × light/dark）+ 真实媒体 Host | `PW_PORT=5303 pnpm e2e:evidence F-0026`；`tests/architecture/platform-presets-f0026.test.ts` 真实媒体导出 | 12/12 Web E2E 全部通过，覆盖 `zh/en × light/dark`，生成 24 张截图与 12 段录屏；真实 `bili-BV1Rex26dEWF.mp4` 三画幅 Host Skia+FFmpeg 导出通过 | ✅ 通过（Web & Host） |
| AC-9 | Tauri 桌面打包应用实机 | 在完整打包的 Tauri macOS/Windows 应用内操作并导出验证 | 本工作树未执行 `pnpm tauri:build` 与桌面 WebDriver 实机运行（桌面侧代码与 Web 复用同一前端组件与 Host 契约） | ⏸ Not run |

## 界面证据

由 `PW_PORT=5303 pnpm e2e:evidence F-0026` 生成，覆盖 `light/dark × zh/en`；`screenshots/`（24 张）已入库，`recordings/`（12 段 `.webm` 与 `summary.json`）保留在本地。

| 界面 | 状态 | AC | 截图 | 录屏（本地 `recordings/`） |
|---|---|---|---|---|
| 样式 Tab + 播放器叠层 | 平台预设、安全区与遮挡告警 | AC-1 ~ AC-4 | `screenshots/preset-safezone-{light,dark}-{zh,en}.png` | `*预设展示_字体覆盖提醒_安全区辅助线与三画幅微调-default.webm` |
| 样式 Tab | 空字幕 + 缺失视频提示（无假成功） | AC-5 | `screenshots/empty-missing-{light,dark}-{zh,en}.png` | `*空态_缺失视频_加载中与提交处理_取消-default.webm` |
| 样式 Tab | 字体加载中「正在加载… / Loading…」 | AC-6 | `screenshots/loading-{light,dark}-{zh,en}.png` | `*空态_缺失视频_加载中与提交处理_取消-default.webm` |
| 样式 Tab | Host 确认保存「已完成 / Completed」 | AC-7 | `screenshots/completed-{light,dark}-{zh,en}.png` | `*Host_持久化重开一致_失败查询重试_冲突重新检查-default.webm` |
| 样式 Tab | 保存失败保留输入与重试/返回 | AC-8 | `screenshots/failed-{light,dark}-{zh,en}.png` | `*Host_持久化重开一致_失败查询重试_冲突重新检查-default.webm` |
| 样式 Tab | 版本冲突提示与重新检查 | AC-8 | `screenshots/conflict-{light,dark}-{zh,en}.png` | `*Host_持久化重开一致_失败查询重试_冲突重新检查-default.webm` |

## 回归检查

全部运行于代码与测试提交 `039e40f`：

- `pnpm lint` ✅（0 error, 0 warning）
- `pnpm tsc -b --noEmit` ✅
- `pnpm check:host` ✅
- `pnpm test` ✅（136 tests：125 passed，0 failed，11 skipped——未构建完整外部 ASR 模型/sidecar 集成套件的常规跳过项）
- `pnpm test:architecture` ✅（165 tests：165 passed，0 failed，含 `platform-presets-f0026.test.ts` 全部 6 项）
- `PW_PORT=5303 pnpm e2e:evidence F-0026` ✅（12/12 passed，24 张截图，12 段录屏）
- 相关回归 `PW_PORT=5303 pnpm exec playwright test tests/e2e/features/F-0024.spec.ts tests/e2e/features/F-0028.spec.ts` ✅（20/20 passed）
- Red check ✅：临时撤回 `ProjectService.verifyCurrentEditsSaved()` 对 `styleSource === 'project'` 的 `style` 分支核对后，`platform-presets-f0026.test.ts` 在 `retryStyleSave()` 断言立即失败（`false !== true`）；恢复后 6/6 重新全绿。
- `cargo check --manifest-path src-tauri/Cargo.toml`：⏸ 未单独通过（本工作树未跑 `pnpm package:host` 生成 gitignored `src-tauri/host/`，build.rs glob 退出 101；本需求未改动 `src-tauri/` 下任何 Rust 文件）。

## 发现的问题

- 初始 `CJK_CHAR_RE` 使用了全角空格字面量触发 ESLint `no-irregular-whitespace`，已改为 Unicode 转义 `\\u3000-\\u303F`。
- `ProjectService.verifyCurrentEditsSaved()` 原仅更新 `video` 基线与修订号，导致 `styleSource === 'project'` 在保存回执丢失后重试时无法同步 `styleRevision`；已补齐双路基线核对并通过 Red check 验证。
- 原 `SubtitleSettings` 底边距滑块上限 `160` 会截断竖屏预设（如抖音 25.5% ≈ 275px）的微调输入，已放宽至 `540`。

## 结论

**可以发布**（平台预设库、纯预览安全区叠层、Host 持久化恢复与冲突重新检查、三画幅真实 Host Skia+FFmpeg 导出及 `zh/en × light/dark` Web 端到端全部通过；5 平台移动端实机截图标定与 Tauri 桌面安装包实机因当前环境条件限制已如实记为 `⏸ Not run`）。

本报告已提交待维护者审阅；未自行执行 `pnpm feature approve`。

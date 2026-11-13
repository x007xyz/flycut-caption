---
id: F-0026
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-13
---

# F-0026 平台风格字幕预设与安全区：设计

## UI / UX

### 入口与布局

复用编辑器左侧下方的「样式 / Style」Tab（`src/components/SubtitleSettings/SubtitleSettings.tsx`）与播放器叠加层（`src/components/VideoPlayer/SubtitleOverlay.tsx`），不新增孤立页面，也不影响现有的样式来源栏（`StyleSourceSlot`）、基础色卡预设与关键词/逐字高亮控制。

1. **平台风格预设库（`PlatformPresetsSection`，置于 `SubtitleSettings` 主区域内）**
   - 顶部工具条：标题「平台风格预设与安全区 / Platform presets & safe zones」+ 画幅筛选（全部 / 9:16 / 16:9 / 1:1）。当筛选结果为空（如 `1:1` 尚无默认平台模板）或当前项目无有效字幕时，展示「暂无内容 / Nothing here yet」及明确指引（AC-5），已有样式调整与字幕编辑保持可用。
   - 5 个平台预设卡片（抖音、视频号、小红书、B 站、YouTube Shorts），每张卡片展示：
     - 平台名称与推荐画幅标签（`9:16` 或 `16:9`）；
     - **效果缩略图**：按画幅比例绘制的微缩预览框，内含安全区虚线框、底部/右侧平台界面遮挡示意区以及该平台对应的字体/描边/底框/逐字高亮色/关键词强调预览示例；
     - **校准状态标签**：当前未取得各平台实测版本截图前，统一标注「参考，未验证 / Reference, unverified」，不宣传保证零遮挡（AC-4）。
   - 选择预设后：
     - 仅写入主字幕样式字段（颜色、描边、底框、字号比例、底边距比例、推荐画幅 `aspectPreset`、`wordHighlightMode`/`wordHighlightColor`、`keywordColorEnabled`/`keywordColor`/`keywordScale`/`keywordBackgroundColor`/`keywordBackgroundOpacity`），并设置 `platformPresetId`、开启 `safeZoneVisible`、写入默认 `safeZoneInsets`；
     - 绝不修改字幕正文、`timestamp`、`wordChunks` 或 `edl`（AC-1）；
     - 在面板中提示当前字体语言覆盖边界（例如 `Noto Sans SC` 覆盖 `zh / en`，`Inter / Arial / Georgia` 仅覆盖 `en`），当字幕含中文而选用了英文限定字体时明确提示不承诺未覆盖语言效果（AC-1）；
     - 若预设启用 `wordHighlightMode: 'word'` 但当前转写缺少可靠字词时间戳，复用 F-0024 的 `word-highlight-fallback`（「使用整句高亮 / Using sentence highlighting」）明确降级（AC-3）；
     - 选择后可继续使用画幅切换（16:9 / 9:16 / 1:1）、字号、颜色、关键词与位置滑块进行微调（AC-1、AC-3）。

2. **可见参考安全区辅助线与微调（`SafeZoneOverlay` + `PlatformPresetsSection` 安全区控制）**
   - 安全区控制条：安全区开关（`safe-zone-toggle`，开启/关闭）、参考平台切换下拉（可独立查看 5 个平台中任一安全区）、参考元数据标注（平台、画幅、参考日期 `2026-11-13`、「参考，未验证 / Reference, unverified」及「辅助线不进入导出成片」说明）。
   - 安全区边距微调：上 / 下 / 左 / 右安全区边界百分比输入与滑块（0%–45%），提供「对齐安全区底边 / Align above bottom zone」与「恢复平台默认 / Reset defaults」按钮（AC-2）。
   - 播放器画面叠加（`SubtitleOverlay` 内与字幕 `<canvas>` 同尺寸对齐的 `pointer-events-none` SVG/HTML 叠层 `data-testid="safe-zone-overlay"`）：
     - 当 `safeZoneVisible` 为 `true` 且视频尺寸就绪时绘制半透明边栏遮挡参考区、虚线安全框与顶部角标（`平台 · 画幅 · 参考 2026-11-13 · 参考，未验证`）；
     - 若当前字幕底边距进入底部参考遮挡区（`bottomOffsetRatio < safeZoneInsets.bottom`），安全区底部辅助线高亮提醒并在设置区给出调整建议，但不阻断用户自由微调或编辑；
     - **绝不**进入 `SubtitleGraphicScene`、`drawFrame` 或 Host 导出管道（AC-2）。

3. **画幅微调控件（`SubtitleSettings` 位置大小区）**
   - 在「位置大小 / Position & size」折叠区补充 `aspectPreset` 切换器（`16:9 横屏` / `9:16 竖屏` / `1:1 方形`），使用已有 `applyAspectPreset` 与 i18n 文案 `aspectPreset`，使创作者可在同一视频上直接验证三种画幅下的预览与导出一致性（AC-1、AC-3）。

4. **生命周期状态与文案（AC-5 ~ AC-8）**
   - **前置不足 / 空态（AC-5）**：无字幕显示「暂无内容 / Nothing here yet」，媒体丢失时提示缺少可用视频并提供重新选择/定位入口；无假「已完成」状态；现有项目/字幕编辑与预设浏览保持可用。
   - **加载与执行中（AC-6）**：字体加载中或项目切换加载时显示「正在加载… / Loading…」；点击「保存预设到项目 / Save to project」或自动保存提交 Host 时显示「正在处理… / Processing…」，禁用重复提交，并提供「取消 / Cancel」（取消未发出防抖保存或停止等待并恢复保存前样式快照；明确提示已发出的 Host 写入无法在服务端撤回）；切换视频或返回首页时按 `projectId + videoId` 与 `openGeneration` 丢弃迟到响应，避免串项目。
   - **正常与持久化（AC-7）**：仅当 Host `projects.saveProjectStyle` / `projects.saveVideoEdits` 返回 `saved`（且非无项目独立预览模式）后，显示「已完成 / Completed」与已保存摘要（平台、画幅、安全区开关）；重开或第二个客户端连接同 Host 读取 `projects.open` 还原完全一致的样式与安全区状态。
   - **失败、冲突与重试（AC-8）**：Host 保存失败时展示具体错误原因与「重试 / Retry」「返回 / Back」，保留当前选择的预设与安全区微调不丢失；点击「重试 / Retry」先通过 `projects.verifyCurrentEditsSaved()` 查询 Host 状态以确认前一次请求是否已落盘，再决定是否补写；返回 `conflict` 时提示「内容已更新，请重新检查 / Content changed. Review again.」，必须点击「重新检查 / Re-check」核对后再重新提交。
   - 字体加载错误仍保持 `SubtitleOverlay` 唯一「重试 / Retry」按钮，`SubtitleSettings` 内仅作只读提示，避免破坏现有测试对单一「重试」按钮的定位。

## 技术方案

### 涉及的子系统

- [前端（React / UI）](../../subsystems/frontend.md)：`src/subtitle/*`、`src/components/SubtitleSettings/*`、`src/components/VideoPlayer/SubtitleOverlay.tsx`、`src/services/projectService.ts`、`src/locales/*`
- [Cordis / Host 与共享契约](../../subsystems/cordis-host.md)：`shared/subtitle-graphics/*`（只扩展纯预设目录与 `projectExport.ts` 关键词字段透传；不新增 RPC、不修改 Host 导出协议）

### 方案

1. **单一真相预设目录（`shared/subtitle-graphics/platformPresets.ts`）**
   - 纯 TypeScript 定义 5 个平台的预设元数据、默认安全区边距（相对画面宽高的比例 `0..0.45`）、验证记录（`verified: boolean`、`referenceDate`、`aspectLabel`、`note`）以及安全区几何校验函数（`resolveSafeZoneInsets`、`isBottomInsideSafeZone`）。
   - 供前端 UI（缩略图、应用预设、安全区叠层）和 `tests/architecture` 共用。
   - `src/subtitle/platformPresets.ts`（及 `src/subtitle/index.ts`）将该目录映射为完整 `SubtitleStyle` patch，并实现 `applyPlatformPreset(style, platformId)`、`matchActivePlatformPreset(style)`、`fontLanguageCoverage(fontId, chunks)`（检测当前字幕是否包含当前字体未覆盖字符）。

2. **复用共用图形层（ADR-0006）**
   - `SubtitleStyle`（`src/subtitle/subtitleStyle.ts`）新增可选字段：
     - `platformPresetId?: PlatformPresetId`
     - `safeZoneVisible?: boolean`
     - `safeZonePlatformId?: PlatformPresetId`
     - `safeZoneInsets?: SafeZoneInsets`
   - `defaultSubtitleStyle` **不写入上述 undefined 键**，保持与现有 F-0004 崩溃恢复 `canonical()` / `seededStyle` 测试 100% 兼容。
   - `src/subtitle/graphicsScene.ts` 的 `toGraphicStyle` 保持仅抽取 `SubtitleGraphicStyle` 视觉渲染字段；安全区字段绝不进入 `SubtitleGraphicScene` 与 Host 导出。
   - 补齐 `shared/subtitle-graphics/projectExport.ts` 的 `toGraphicStyle` 与 `buildProjectExportSubtitleScene` 对 `keywordColorEnabled / keywordColor / keywordScale / keywordBackgroundColor / keywordBackgroundOpacity` 与 `keywords` 的透传，确保项目级导出入口与编辑器导出入口使用同一份关键词/逐字效果契约。

3. **持久化与并发安全（`src/services/projectService.ts`）**
   - 利用 F-0003 既有机制：`stylePair` 在 `styleSource === 'project'` 时通过 `projects.saveProjectStyle` 存进 `project.json`；`styleSource === 'custom'` 时通过 `projects.saveVideoEdits` 存进 `edits.json`；`aspectPreset` 始终按视频存在 `edits.aspectPreset`。
   - `ProjectService` 新增 `revertUnsavedStyle()`（恢复到上次 Host 确认的 `baseline` 样式，不抹除未保存的字幕正文编辑）和完善 `verifyCurrentEditsSaved()`（同时核对 `diff.video` 与 `diff.style`，并在已落盘时同步更新 `styleRevision`）。
   - `ProjectService` 增加 `recheckStyleConflict()`，使 AC-8 的「重新检查 / Re-check」能在不丢失用户当前输入的前提下查询 Host 最新快照与修订号、更新基线并解除提交锁定，供用户重新核对后提交。

### 接口与数据

- **Host RPC / 协议**：无新增或变更。继续使用 `projects.saveProjectStyle`、`projects.saveVideoEdits`、`projects.open` 与 `export.start`（`options.subtitleScene` v1）。
- **数据结构（向后兼容增量字段）**：
  - `SafeZoneInsets`：`{ top: number; bottom: number; left: number; right: number }`（`0..0.45` 比例）
  - `PlatformPresetId`：`'douyin' | 'wechat-channels' | 'xiaohongshu' | 'bilibili' | 'youtube-shorts'`
  - `SubtitleStyle` 新增可选属性 `platformPresetId?`、`safeZoneVisible?`、`safeZonePlatformId?`、`safeZoneInsets?`；旧项目读取时由 `fromProjectStyle` 自动兼容，无需升级 `PROJECT_FORMAT_VERSION`。

### 备选方案与取舍

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| A. 安全区辅助线用 `SubtitleOverlay` DOM/SVG 叠层绘制；预设与安全区元数据存 `SubtitleStyle` 可选字段 | 从机制上保证辅助线永不进入导出帧；复用 `projects.saveProjectStyle` / `saveVideoEdits` / 崩溃恢复与双端同步，零格式迁移成本 | `drawFrame` 单测无法直接测 SVG 辅助线，需要补充纯几何单测 + E2E 叠层断言 | **采用** |
| B. 在 `drawFrame` 里加 `showSafeZone` 选项并在导出时关闭 | 辅助线与字幕同画布 | 有将辅助线误传入导出选项的风险，且需要扩充图形层渲染代码 | 不采用 |
| C. 为平台预设新建独立 Host RPC 与 `platformPresets.json` 存储文件 | 独立存储 | 增加不必要协议与版本迁移，割裂 `styleSource` 与单视频画幅/项目样式规则 | 不采用 |

## 架构决策

继续遵循已批准的 [ADR-0006 共用字幕图形层](../../20-architecture/adr/0006-subtitle-graphics-layer.md)、[ADR-0003 多视频项目与样式来源](../../20-architecture/adr/0003-multi-video-projects.md) 与 [ADR-0004 崩溃恢复副本](../../20-architecture/adr/0004-client-recovery-copies.md)；本需求不新增跨边界契约，不另建 ADR。

## 自行决定的事项

- **5 个平台未取得真机实测截图时的默认校准标注**：本工作树无真机平台客户端环境，将 5 个平台默认安全区统一标为 `verified: false`（「参考，未验证 / Reference, unverified」，参考日期 `2026-11-13`），不伪造实测状态（影响 AC-4）。
- **安全区绘制方式**：采用播放器内同尺寸 `pointer-events-none` DOM/SVG 叠加层绘制辅助线，彻底隔离于 `SubtitleGraphicScene` 与导出链路（影响 AC-2）。
- **预设默认逐字/关键词策略**：5 个平台预设均基于现有 `wordHighlightMode: 'word'` 与 `keywordColorEnabled: true` 配置平台差异化配色与底框，当缺少可靠字词时间戳时由已有图形层与提示条明确降级为整句高亮（影响 AC-3）。
- **画幅切换控件位置**：在「位置大小」内开放 `aspectPreset`（16:9 / 9:16 / 1:1）选择，方便用户在任意视频上切换验证三画幅与微调（影响 AC-1、AC-3）。

## 风险与回退

- **风险 1**：向 `defaultSubtitleStyle` 写入 `undefined` 属性可能改变 `JSON.stringify` 键集合并影响既有恢复副本测试。**缓解**：新增字段为可选字段且不写入 `defaultSubtitleStyle` 初始字面量，仅在启用平台预设或安全区时写入。
- **风险 2**：新增「重试 / Retry」按钮可能与 `F-0024` / `F-0028` 字体失败测试中的 `getByRole('button', { name: '重试' })` 冲突。**缓解**：字体加载失败时仅保留 `SubtitleOverlay` 内的「重试」按钮；预设区仅在 Host 保存失败时展示「重试 / Retry」与「返回 / Back」。
- **回退**：若需要回退本需求，可整体移除 `platformPresets` 模块、`PlatformPresetsSection` 与 `SafeZoneOverlay`，`SubtitleStyle` 的新增可选字段在旧代码读取时会被安全忽略。

## 实现清单

- [x] 1. 共用平台预设目录与安全区模型：新增 `shared/subtitle-graphics/platformPresets.ts`、扩展 `src/subtitle/subtitleStyle.ts` / `src/subtitle/platformPresets.ts`（5 平台预设、安全区参考参数、字体覆盖边界、匹配与几何校验），完善 `shared/subtitle-graphics/projectExport.ts` 关键词样式透传，并补充单元测试/架构测试。
- [ ] 2. Host 持久化恢复与冲突回退辅助：在 `src/services/projectService.ts` 中补充 `revertUnsavedStyle()`、完善 `verifyCurrentEditsSaved()` 对 `style` 的校验与 `recheckStyleConflict()` 支持，验证多客户端/重开读取一致性与并发冲突处理。
- [ ] 3. 播放器安全区叠层与辅助线：实现 `src/components/VideoPlayer/SafeZoneOverlay.tsx` 并接入 `SubtitleOverlay.tsx`，支持开关、参考平台标注（含「参考，未验证 / Reference, unverified」及参考日期/画幅）、底部进入遮挡区视觉提醒，且确保绝不进入导出场景。
- [ ] 4. 平台预设库、画幅切换、安全区微调与生命周期 UI：实现 `src/components/SubtitleSettings/PlatformPresetsSection.tsx`、中英文文案 `src/locales/platformPresets.ts`，接入 `SubtitleSettings.tsx`（含 AC-5 空态/缺失提示、AC-6 加载/处理中/取消、AC-7 已完成、AC-8 失败查询重试/返回/冲突重新检查）。
- [ ] 5. E2E 端到端与真实 Host 导出回归：编写 `tests/e2e/features/F-0026.spec.ts`（覆盖 AC-1~AC-9、light/dark × zh/en、加载/空态/成功重开/失败重试/冲突重新检查）与 `tests/architecture/platform-presets-f0026.test.ts`（含三画幅真实 Host Skia + FFmpeg 导出一致性、无辅助线泄漏及 Red check），生成截图与录屏证据。

## 验证计划

- **静态与架构检查**（每项提交及最终验收）：`pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`、`CARGO_TARGET_DIR=/private/tmp/f0026-cargo-check cargo check --manifest-path src-tauri/Cargo.toml`、`pnpm test`、`pnpm test:architecture`。
- **真实 Host 导出验证**（AC-2、AC-3、AC-4、AC-9）：使用本地真实 `bili-BV1Rex26dEWF.mp4`（或 FFmpeg 衍生的 16:9 / 9:16 / 1:1 真实样本）+ 真实 `bili-BV1Rex26dEWF.transcript.json` 词元，启动真实 `createHost` + Skia + FFmpeg，分别按平台预设在三画幅下导出硬字幕视频，断言：
  - 关键词与逐字高亮像素位置与预览 `drawFrame` 一致；
  - 导出成片不含安全区辅助线像素；
  - 无词时间戳的片段明确降级为整句高亮；
  - 双客户端连接同一 Host 保存与重开读取结果一致。
- **Web 端到端与视觉证据**（AC-1 ~ AC-9）：`PW_PORT=5303 pnpm e2e:evidence F-0026` 覆盖 `light / dark × zh / en`，生成截图至 `docs/features/F-0026-platform-subtitle-presets/screenshots/`。
- **Red check**：至少覆盖安全区辅助线与导出场景隔离、冲突/保存失败不伪造「已完成」、无词元时降级整句高亮。
- **环境限制预声明（Not run）**：真实抖音/视频号/小红书/B 站/YouTube Shorts 移动端实机界面校准截图与 Tauri 打包实机需本机或实机条件；若当前无对应移动客户端与打包环境，5 个平台保持「参考，未验证 / Reference, unverified」并在报告如实记为 `⏸ Not run`。

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | `PlatformPresetsSection` 展示平台、画幅、缩略图；应用预设只改样式字段不改正文/时间戳/EDL；字体语言覆盖提示；支持微调与画幅切换 |
| AC-2 | `SafeZoneOverlay` 在播放器叠层展示 5 平台安全区参考线、参考日期与画幅；支持开关与边距微调；安全区数据不进入 `SubtitleGraphicScene` 导出 |
| AC-3 | 5 平台预设全部复用 `shared/subtitle-graphics` 逐字高亮与关键词样式字段；`buildPreviewSubtitleScene` / `buildExportSubtitleScene` 三画幅一致，无可靠词元走 `word-highlight-fallback` |
| AC-4 | 元数据含 `verified` / `referenceDate` / 平台版本字段；未实测平台在列表卡片、安全区叠层与元数据栏明确标「参考，未验证 / Reference, unverified」 |
| AC-5 | 复用编辑器「样式」Tab 入口；无字幕/筛选无结果展示「暂无内容 / Nothing here yet」，媒体缺失提示定位入口，无假成功，原有编辑可用 |
| AC-6 | 字体/项目加载显示「正在加载… / Loading…」；保存提交显示「正在处理… / Processing…」，禁用重复提交，提供「取消 / Cancel」；按 `projectId + videoId` 隔离迟到响应 |
| AC-7 | 仅在 Host 保存返回 `saved` 后显示「已完成 / Completed」；样式与安全区存 `projectStyle` / `edits`，重开及第二客户端连接同 Host 读取一致 |
| AC-8 | 保存失败展示原因与「重试 / Retry」「返回 / Back」（重试先查 `verifyCurrentEditsSaved`），保留当前输入；版本冲突提示「内容已更新，请重新检查 / Content changed. Review again.」 |
| AC-9 | `tests/e2e/features/F-0026.spec.ts` 覆盖中英文、明暗主题与截图录屏；`tests/architecture/platform-presets-f0026.test.ts` 跑真实 Host Skia+FFmpeg 三画幅导出；缺真机平台/打包环境如实记 Not run |

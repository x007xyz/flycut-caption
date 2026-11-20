---
id: F-0033
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-16
---

# F-0033 多语言字幕与软字幕轨导出：设计

## UI / UX

沿用现有导出对话框（`ExportDialog`），新增 MKV 输出、软字幕轨多选、字幕文件语言轨选择；不新建页面。

| 状态 / 入口 | 用户看到什么、能做什么 | 验收构造 |
|---|---|---|
| 视频导出 · 输出格式 | MP4 / WebM / MKV 三选一；MKV 说明「多软字幕轨」 | 打开发出对话框 |
| 软字幕轨选择 | 列出原字幕和每个语言轨，显示语言代码、完成数/总数；缺译或过期轨默认禁用并显示「N 条缺译/过期」；勾选「导出已完成部分」后允许显式选择，缺译/过期条目会省略 | mock 项目带完整/过期两条语言轨 |
| WebM 多轨 | 选择 WebM 且多轨时提示「WebM 只支持一条软字幕轨」；Host 也拒绝多轨 WebM | 选 WebM + 两条轨 |
| 硬烧录语言限制 | 当前生效语言没有随包字体时禁用硬烧录并显示「此语言暂不支持烧录 / Burn-in is not available for this language」 | 语言轨语言为 `ja` |
| 字幕文件导出 | 选择「双字幕 / 仅副字幕」时出现语言轨选择，列出原字幕与所有语言轨；选中的轨道用于生成 SRT/VTT/ASS/JSON | 导出字幕 → 双字幕 |
| 空态 / 加载 | 没有语言轨时只显示原字幕；导出按钮沿用现有 Host 检查、进度和取消 | 不带 languageTracks 的项目 |
| 失败 / 过期 | Host 导出失败显示具体 FFmpeg 原因；缺译/过期不会用原文补译，用户只能显式导出已完成部分 | 手工构造过期条目 |

## 技术方案

### 涉及的子系统

已读 [frontend.md](../../subsystems/frontend.md)、[cordis-host.md](../../subsystems/cordis-host.md)、[providers.md](../../subsystems/providers.md)、[code-standards.md](../../code-standards.md)、[acceptance-testing.md](../../30-engineering/acceptance-testing.md)、[decisions.md](../../decisions.md)，并核对 `shared/protocol.ts`、`shared/editing/edl`、`shared/languageTracks.ts`、`server/plugins/export.ts`、`src/components/ExportPanel/ExportDialog.tsx`、`src/hooks/useVideoExport.ts`、`src/services/videoEngines/HostExportEngine.ts`、`src/subtitle/softSubtitles.ts`、`src/subtitle/exportFormats.ts`、`src/FlyCutCaption.tsx`。

### 方案

**1. 导出协议**

`exportInputSchema.options`：

- `format` 增加 `mkv`；
- 新增 `subtitleTracks?: Array<{ id, name, languageCode, content, default? }>`，最多 20 条；`content` 是已经投影到成片时间轴的 WebVTT；
- 保留 `subtitleTextContent` 作为单轨兼容字段，Host 优先使用 `subtitleTracks`。

**2. Host 导出**

`server/plugins/export.ts` 的软字幕分支改为逐轨写入临时 VTT，逐条 `-i`、`-map`，并按容器设置编码：

- MP4：`mov_text`；MKV：`srt`；WebM：`webvtt`；
- 每条写 `language=`（BCP-47 映射到 ISO 639-2，如 `en→eng`、`zh→zho`、`ja→jpn`）和 `title=`；
- `default` 轨写 `-disposition:s:N default`；
- WebM 多轨直接抛错「WebM 只支持一条软字幕轨，请选择 MP4 或 MKV」；
- 输出 MIME：`video/x-matroska`（MKV）。
- 旧的单轨 `subtitleTextContent` 仍生成一条 `und` 轨，行为不变。

**3. 客户端轨道构建（`src/subtitle/softSubtitles.ts`）**

`listSoftSubtitleTracks` 统计每条轨的缺失和过期：缺失=当前有效字幕没有译文；过期=`entry.sourceText !== chunk.text`。`buildSoftSubtitleTracks` 只导出完整条目，缺失/过期条目省略，不用原文补译；原字幕轨始终可导出。时间统一走 `projectFromKept(cues, keptSegments)`，与视频裁剪使用同一组 segments。

**4. 导出对话框与调用链**

- `ExportDialog` 增加 MKV 按钮、软轨多选、部分导出开关、硬烧录语言限制、字幕文件语言轨选择；
- `FlyCutCaption` 读取 `languageTracks` / `activeLanguageTrackId` / `language`，生成 candidates 传给对话框；视频导出时按选择构建 `subtitleTracks`，字幕文件导出时按 `languageTrackId` 把该轨译文投影到 `secondText`；
- `VideoProcessingOptions` 增加 `subtitleTracks`，`HostExportEngine` 原样发给 `export.start`；
- 保存路径支持 `.mkv`（Tauri 对话框和 Web File System Access）。

### 接口与数据

| 位置 | 接口 / 约束 |
|---|---|
| `shared/protocol.ts` | `format: 'mp4' \| 'webm' \| 'mkv'`、`subtitleTracks` schema |
| `server/plugins/export.ts` | 多轨 VTT 输入、编码、语言/标题/默认轨、WebM 限制 |
| `src/subtitle/softSubtitles.ts` | `listSoftSubtitleTracks`、`buildSoftSubtitleTracks`、统一 EDL 投影 |
| `src/components/ExportPanel/ExportDialog.tsx` | 多轨选择、部分导出、字体限制、字幕文件轨道选择 |
| `src/FlyCutCaption.tsx` | 候选生成、视频/字幕导出接线 |
| 项目格式 | 无变化；语言轨已由 F-0030 存在 `edits.languageTracks` |

### 备选方案与取舍

| 选定 | 备选 | 理由 |
|---|---|---|
| 客户端构建每条 VTT，Host 只封装 | Host 读取 languageTracks 自己生成 | Host 不理解语言轨与字幕编辑状态；客户端已有统一的 EDL 投影 |
| 缺译/过期默认禁用，显式允许 `allowPartial` | 自动用原文补译 | 原文补译会把译文轨变成原文轨，违反 AC-2 |
| 语言码映射到 ISO 639-2 | 直接写 BCP-47 | MP4/MKV 容器期望 3 字母语言码；直接写 `en`/`ja` 会丢标签 |
| MKV 用 `srt` 字幕编码 | `ass` / `webvtt` | `srt` 兼容性最好，播放器可切换；样式由硬烧录负责 |
| 保留单轨兼容字段 | 直接删除 | 旧客户端/旧调用仍可用 |

## 架构决策

不新增 ADR。沿用 [ADR-0001](../../20-architecture/adr/0001-project-storage-format.md) 和 [ADR-0003](../../20-architecture/adr/0003-multi-video-projects.md)；语言轨仍是 `edits.languageTracks`。

## 自行决定的事项

- 原字幕轨名称固定 `Original`，语言取当前 transcript 语言；其他轨用语言轨名称。
- 缺译/过期一律省略，不补原文；面板显示省略数量（AC-2）。
- WebM 只允许一条软字幕轨，多轨请用 MP4/MKV（AC-3）。
- 硬烧录语言限制按当前激活语言检查随包字体；没有字体时禁用，不自动换语言（AC-4）。
- 字幕文件导出选择任意一条语言轨与原文组成双字幕；这就是「任意两轨双语」的首版实现，暂不支持两条非原文轨组合。

## 风险与回退

- MKV 编码兼容性：用 `srt` 字幕 + H.264/AAC，真实 ffprobe/播放器验证；不支持时回退 MP4。
- 语言码映射不全：未知语言写 `und`，不伪造标签；后续按需补齐。
- 旧单轨调用继续可用；多轨字段缺失时行为与之前一致。

## 实现清单

- [x] 1. **协议与 Host 多轨导出**：`format` 增加 MKV、`subtitleTracks` schema、逐轨 VTT/映射/编码/语言标签/默认轨、WebM 限制、MIME；架构测试覆盖构建规则（AC-1、AC-3）。
- [x] 2. **客户端轨道构建**：`listSoftSubtitleTracks` / `buildSoftSubtitleTracks`、缺译/过期统计与省略、统一 EDL 投影；单测覆盖（AC-1、AC-2、AC-3）。
- [x] 3. **导出界面**：MKV、软轨多选、部分导出、字体限制、字幕文件语言轨选择；中英文文案沿用现有导出对话框（AC-1、AC-2、AC-4、AC-5、AC-6）。
- [x] 4. **调用链接线**：`FlyCutCaption`、`useVideoExport`、`HostExportEngine`、保存路径支持 MKV（AC-3）。
- [x] 5. **验收**：E2E 中英文 × 明暗主题；真实 Host 导出 MP4/MKV，ffprobe 验证 3 条轨、语言标签、默认轨、EDL 时间；WebM 多轨拒绝（AC-3、AC-4、AC-9）。

## 验证计划

- 架构/单测：`tests/architecture/multilingual-export-f0033.test.ts` 覆盖缺失/过期统计、默认阻止部分导出、显式允许后只省略问题条目、EDL 时间映射、语言标签。
- E2E：`tests/e2e/features/F-0033.spec.ts` 覆盖软轨列表、缺译禁用与部分导出开关、硬烧录语言限制、字幕文件语言轨选择；中英文 × 明暗主题，`pnpm e2e:evidence F-0033`。
- 真实使用：`pnpm acceptance:f0033` 用真实 Host 导出 MP4/MKV，ffprobe 断言 3 条字幕轨、`zho/eng/jpn` 标签、默认轨、裁剪后时间；WebM 多轨返回错误。
- Red check：撤掉过期条目省略或 EDL 投影后单测必须失败；撤掉语言码映射后真实验收标签断言失败（本轮用单测/代码审查覆盖映射）。
- 回归：`pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`、`pnpm test`、`pnpm test:architecture`、`cargo check`。

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | 多轨列表、语言/名称/完成数、任意一条语言轨与原文双字幕、MKV/MP4 多轨，清单 1–3 |
| AC-2 | 缺译/过期默认禁用、显式部分导出、省略不补原文，清单 2、3 |
| AC-3 | 统一 EDL 投影、ISO 639-2 标签、默认轨、旧格式回归，清单 1、2、5 |
| AC-4 | 字体覆盖检查与硬烧录禁用，清单 3、4 |
| AC-5 | 沿用导出入口、无语言轨只显示原字幕、Host 不可用提示，清单 3 |
| AC-6 | 现有 Host 导出进度/取消、禁止重复提交，清单 3、4 |
| AC-7 | Host 导出成功才完成、重开读取同一语言轨版本，清单 1、4、5 |
| AC-8 | Host 失败原因、缺译/过期不静默覆盖、显式重试，清单 1、3、5 |
| AC-9 | 中英文 × 明暗主题 E2E、截图/录屏、真实 ffprobe 验收，清单 5 |

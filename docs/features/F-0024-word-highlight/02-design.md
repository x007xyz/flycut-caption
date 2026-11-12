---
id: F-0024
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-12
---

# F-0024 逐字高亮字幕：设计

## UI / UX

沿用现有项目、播放器、字幕样式面板和 Host 导出入口，不新增独立任务或页面。字幕样式面板增加「逐字高亮」预设；启用后在当前主/副字幕样式下显示普通色与高亮色。普通色继续使用现有 `color`，高亮色使用 `wordHighlightColor`。控件和按钮都使用可访问名称，新增文案进入中英文 locale。

| 状态 / 入口 | 用户看到什么、能做什么 | 验收构造 |
|---|---|---|
| 预设入口 | 样式预设中出现「逐字高亮 / Word highlight」；点击后立即生效，随后可改普通色和高亮色 | 打开真实项目编辑器，选择预设并改色，断言画布颜色和样式持久化 |
| 正常逐字 | 主字幕当前通过校验范围内的词元使用高亮色，词元结束后恢复普通色；暂停、拖动、倍速和剪辑预览都读取视频媒体时间 | 固定词元时间，停在词元中间、边界和间隙；播放倍速并拖动；带 EDL 裁剪后核对映射 |
| 无可靠词元 | 显示「使用整句高亮 / Using sentence highlighting」，当前整句使用高亮色；任何缺失、错序、越界或文本无法映射的词元都不按字数猜时间 | transcript 无 `wordChunks`、未通过 `hasWordTimestamps`、缺句词关联、文本不一致、时间越界各构造一次 |
| 副字幕 | 原文字词时间不套给译文；副字幕启用逐字预设时按整句高亮，双语模式只高亮主字幕当前词 | 三种显示模式分别检查主、副、双语画面 |
| 字体载入 / 失败 | 沿用 F-0028 的「正在加载字幕字体…」「字幕渲染不可用」、原因与重试；加载完成前不画替代字体 | 延迟或拒绝字体请求，中英文和明暗主题各跑一次 |
| 空态 / 未连接 / 处理中 / 导出完成或失败 | 沿用现有项目空态、Host 连接、任务进度、取消、结果校验和重试；逐字高亮不从这些入口伪造内容或成功状态 | 复用现有 F-0002、F-0003、F-0028 用例，并增加本需求导出异常与正常状态证据 |

预览和 Host 都消费同一条 `SubtitleGraphicScene`；预览使用原始媒体时间，导出使用 EDL 投影后的成片时间。高亮绘制保留原字幕的字体、描边、背景和阴影，只替换当前词的文字填充色。

## 技术方案

### 涉及的子系统

已读 [frontend.md](../../subsystems/frontend.md)、[cordis-host.md](../../subsystems/cordis-host.md)、[architecture-current.md](../../architecture-current.md)、[decisions.md](../../decisions.md)、[ADR-0006](../../20-architecture/adr/0006-subtitle-graphics-layer.md)、[F-0028 验收](../../F-0028-shared-subtitle-graphics/04-test-report.md) 与 [F-0001 调研](../../archive/F-0001-zh-talking-head-asr-benchmark/02-research.md)。核对过 `shared/subtitle-graphics/**`、`src/subtitle/graphicsScene.ts`、`src/components/VideoPlayer/SubtitleOverlay.tsx`、`src/components/SubtitleSettings/SubtitleSettings.tsx`、`src/hooks/useVideoExport.ts`、`src/services/videoEngines/HostExportEngine.ts`、`server/subtitle-render.ts`、`server/plugins/export.ts`、项目样式持久化和 F-0028 的预览 / Host 测试。

本需求只改前端图形场景、字幕样式和既有 Host 导出输入；不新增 RPC、不改项目格式版本、不改 EDL、不让 Tauri 执行业务。F-0028 的 Skia 条带、字体注册、rawvideo 背压和 `overlay=format=yuv420` 是唯一成片路径。

### 方案

1. **场景契约**：继续使用 `SubtitleGraphicScene` v1 和已有的可选 `cues[].words`。给 `SubtitleGraphicStyle` 增加向后兼容的 `wordHighlightMode: 'none' | 'word'` 与 `wordHighlightColor`。旧项目/恢复副本没有字段时补 `none`，不需要迁移；新客户端总是发送完整字段。`wordHighlightColor` 只控制文字填充，轮廓、背景和阴影继续取当前样式。
2. **可靠词元映射**：`src/subtitle/graphicsScene.ts` 只在 `hasWordTimestamps === true` 且有当前句完整 `wordIds` 时生成 `words`。每个词必须属于当前句、时间单调且位于句段内，去显示标点后的词文本拼接必须与当前句一致。预览直接使用原时间；导出先用同一个 `projectFromKept` 投影句子与词，并按“原句 id + 同一保留区间”重新关联，跨剪切点的词允许被切成多段。任一步无法证明映射时不生成词元，交给整句降级。
3. **共用绘制语义**：`shared/subtitle-graphics/layout.ts` 将可靠词元映射到排版行的字符范围，`draw.ts` 用该范围找出 `t ∈ [word.start, word.end)` 的当前词。逐字模式只在主字幕有可靠词元时逐词换色；无词元或副字幕译文时整句换色。只使用 Canvas 2D 的 `measureText`、路径裁剪与 `fillText`，保持原字距和换行。
4. **帧缓存**：`frameKey(scene, t)` 纳入当前词索引；同一词期间键稳定，进入下一个词、词间空隙或整句降级状态时变化。这样播放器只在词色变化时重画，Host 也可复用相同词状态的 RGBA 条带。
5. **样式与界面**：`SubtitleStyle` 增加高亮模式/颜色及默认值，新预设写入这两项；切换普通静态预设会关闭逐字模式。中英文 locale 增加预设、高亮色和整句降级文案。样式仍作为 Host 不透明数据保存，重新打开项目后由默认值合并旧字段。
6. **导出接线**：冻结导出时的 `chunks`、`wordChunks`、`hasWordTimestamps`，把词元传入 `buildExportSubtitleScene`，再经现有 `export.start.options.subtitleScene` 交给 Host。Host 不读取原始 transcript，因此 CLI/MCP 走同一 RPC 时使用完全相同场景语义。

### 接口与数据

| 层 | 接口 / 约束 |
|---|---|
| `SubtitleStyle` | 新增 `wordHighlightMode`、`wordHighlightColor`；旧样式由 `defaultSubtitleStyle` / `fromProjectStyle` 补默认值，保持项目格式 3 |
| `SubtitleGraphicStyle` | 新增同名可选渲染字段；缺失按 `none`，保持 F-0028 v1 场景兼容 |
| `SubtitleGraphicCue.words` | 继续使用现有 v1 可选结构 `{ text, start, end }`；只传已校验并按目标时间轴投影的数据 |
| `drawFrame` / `frameKey` | 不新增外部渲染入口；增加词状态计算与词感知缓存键，两端调用同一实现 |
| `export.start` | 不改 RPC 与 schema；`options.subtitleScene` 内携带新字段和词元 |
| 项目持久化 | 样式仍是 Host 不透明的 `primary` / `secondary` 记录；不新增存储字段或迁移 |

场景示例：

```ts
primary: { ...style, wordHighlightMode: 'word', wordHighlightColor: '#FFE100' }
cues: [{
  id: 's1', start: 0.5, end: 2,
  text: '大家好',
  words: [
    { text: '大', start: 0.5, end: 0.8 },
    { text: '家', start: 0.8, end: 1.1 },
    { text: '好', start: 1.1, end: 1.4 },
  ],
}]
```

### 备选方案与取舍

| 选定 | 备选 | 理由 |
|---|---|---|
| 高亮配置放在各自 `SubtitleGraphicStyle` | 放在场景级全局开关 | 现有预设、主副样式、项目样式持久化都按单一样式工作；场景级开关会重复现有数据路径并让主副样式无法独立调整 |
| 按字符范围裁剪并重填原排版行 | 把行拆成多个 `fillText` 或均分字数 | 裁剪重填保留原换行、字距和字偶距，也避免把不可靠词元伪装成按字数估算 |
| 词映射失败时整句降级 | 用句子起止时间均分到字 | 会制造伪精确高亮，违反 AC-2 和 F-0001 对真实时间戳的约束 |
| 继续使用 F-0028 Skia 条带 | ASS 硬烧或浏览器导出 | ADR-0006 已拍板共用 Canvas 2D 与 Host 唯一导出；新增第二种渲染会再次产生一致性问题 |

## 架构决策

沿用已接受的 [ADR-0006](../../20-architecture/adr/0006-subtitle-graphics-layer.md)，本需求不新增架构决策。逐字高亮属于该 ADR 明确留给 E-03/2 的场景数据与动画能力，不另起渲染架构。

## 自行决定的事项

- 逐字模式是高亮样式的属性，因此主、副字幕可以分别启用。主字幕有可靠词元时逐字；副字幕译文没有对齐数据时按整句高亮。影响 AC-1、AC-3。
- 高亮颜色为不透明文字填充，轮廓/背景/阴影沿用样式；首版不增加高亮透明度、渐变或动画曲线。影响 AC-1。
- 词元文本映射失败时该句整句降级；界面仅在当前样式启用逐字模式且没有可证明的词元映射时显示降级提示。影响 AC-2、AC-5。
- 场景版本仍为 1：F-0028 已预留可选 `words`，本需求新增字段均非必填且旧场景可继续渲染，因此不改变已确认的共用契约或制造迁移。

## 风险与回退

- 浏览器与 Skia 的字形光栅化存在抗锯齿差异；换行、词范围和包围盒由同一场景与绘制代码固定，按 AC-3 在 1080p 断言包围盒偏移不超过 2px，边缘差异单独记录。
- 词元很短时帧采样可能跨过整词；这是媒体帧率限制，按 `requestVideoFrameCallback` 与 Host 帧率如实记录，不延长词时间来伪造命中。
- 字体加载失败继续由 F-0028 的不可用状态阻断，不退回系统字体或 ASS。
- 回退方式：关闭新预设只影响样式数据，文字、EDL、时间戳不变；代码回退到 F-0028 绘制层时未知高亮字段会被忽略。

## 实现清单

- [x] 1. **共用场景与词元渲染**：扩展样式与场景校验，可靠词元映射、当前词、整句降级、词感知 `frameKey` 都落在 `shared/subtitle-graphics`；架构测试覆盖词边界、文本/时间异常、三画幅和主副显示模式（AC-1、AC-2、AC-3）。
- [x] 2. **预览与样式 UI**：接 `wordChunks` / `hasWordTimestamps`，新增逐字预设、普通色/高亮色和中英文降级提示；暂停、拖动、倍速、剪辑预览及字体状态由真实编辑器验证；Playwright 测试名带 AC（AC-1、AC-2、AC-5、AC-6、AC-9）。
- [x] 3. **Host 导出与 EDL 投影**：冻结并按保留段投影词元，通过既有 `subtitleScene` 路径导出；Graphic 输出与预览同场景，覆盖跨剪切点、主副双语、空词元降级和任务失败（AC-3、AC-4、AC-6、AC-8）。
- [ ] 4. **持久化、重开与生命周期证据**：样式保存和重开保持高亮字段，补齐空态、加载、错误、重试、完成后端到端状态、中英文和明暗主题截图；记录通用项目/Host 生命周期未新增分支的原因（AC-4、AC-5、AC-7、AC-8、AC-9）。
- [ ] 5. **真实媒体验收与文档**：用至少一条真实字词时间戳素材完成预览、Host 成片和播放器打开，核对三种画幅、主副双语及 1080p 包围盒；更新子系统和需求实现/验收文档，列出桌面、Web、CLI/MCP 与环境缺项（AC-3、AC-4、AC-9）。

## 验证计划

- 每项提交前跑与文件范围对应的 `pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`；全部完成后跑 `pnpm test`、`pnpm test:architecture`、`pnpm build`。改动不涉及 Rust 源码时不重复 `cargo check`，并在最终提交的 Verification 中列为 Not run 及原因。
- 新增 `tests/architecture/word-highlight-f0024.test.ts`：固定 1080p 场景，断言有效词、句间空隙、无词/坏文本/越界时降级、`frameKey` 按词变化、三种画幅 × 主/副/双语可见，以及完整画布与 Skia 条带的颜色包围盒偏移 ≤ 2px。
- 新增 `tests/e2e/features/F-0024.spec.ts`：真实编辑器选择预设、改色、暂停拖动、倍速、无词降级；用 F-0028 的字体延迟/失败构造加载与错误状态；中英文和明暗主题截图，状态文案和可操作控件都有断言。
- 导出测试复用真实 Host 和固定视频：检查当前词帧高亮色、下一词帧颜色变化、无词帧整句颜色、EDL 剪辑后时间、输出时长和播放器可打开；跨剪切点词元另做纯投影断言。
- 持久化测试保存含高亮字段的项目样式，重新打开后核对预设仍匹配且画布颜色一致；确认不改正文、EDL、词时间戳。
- Red check：分别临时禁用 `frameKey` 当前词索引、让词映射失败时仍返回词元、让 Host 忽略 `subtitleScene.words`；对应测试必须失败并指出当前词不刷新、坏数据被伪装成逐字或成片未逐词高亮。
- `pnpm e2e:evidence F-0024` 生成截图和本地录屏；真实桌面、Web、CLI/MCP 能执行则执行，缺环境明确写 `Not run`。

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | 样式字段、逐字预设、可靠词元判定、共用 `drawFrame`、词感知 `frameKey`；预览 E2E 与真实 Host 导出测试 |
| AC-2 | 词元映射失败关闭、整句填充回退、中英文降级提示；缺字段/坏顺序/坏文本/越界测试 |
| AC-3 | 同一场景分别渲染完整画布和 Skia 条带；三种画幅、主副双语、1080p 颜色包围盒 ≤ 2px，抗锯齿差异单列 |
| AC-4 | 冻结词元、EDL 投影、既有 `export.start` 场景、CLI/MCP 共用接口；真实素材预览/导出/重开 |
| AC-5 | 沿用项目与样式入口；空态、未连接、缺词提示和字体加载状态 E2E |
| AC-6 | 字体加载、导出处理中/取消沿用 F-0028 与 Host；迟到任务不串项目沿用现有代次校验 |
| AC-7 | 样式由 Host 不透明保存，重开合并默认字段；成功只在任务结果校验后出现 |
| AC-8 | 字体/Host 失败沿用具体错误与重试；坏词元整句降级；导出失败无半成品 |
| AC-9 | 中英文 × 明暗主题 E2E、截图/录屏、真实媒体以及桌面/Web/CLI 平台结果与 Not run |

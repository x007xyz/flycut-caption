---
id: F-0028
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-09
---

# F-0028 共用字幕图形层落地：设计

## UI / UX

沿用现有播放器、字幕样式面板和导出入口，不新增「共用字幕图形层」这类技术入口。界面只改变字幕覆盖层的渲染来源和三种状态；组件、文案与验收构造如下。

| 状态 / 入口 | 用户看到什么、能做什么 | 验收构造 |
|---|---|---|
| 字体载入中 | 视频照常播放；字幕位置显示「正在加载字幕字体… / Loading subtitle fonts…」，不先用系统替代字体画最终字幕 | 让字体请求挂起或延迟；检查加载完成前后的画布像素 |
| 空字幕 / 无字幕区间 | 不绘制字幕层，画布完全透明；不显示载入或错误提示 | 空 transcript、所有 chunk 删除、当前时间落在字幕间隙 |
| 正常预览 | 字体就绪后按视频帧时间绘制；暂停拖动到新位置后补画；样式、主副字幕和三画幅与成片一致 | 真实视频播放、暂停、拖动进度条；1080p 截图比较 |
| 渲染失败 | 字幕区域显示「字幕渲染不可用 / Subtitle rendering is unavailable」、失败原因和「重试 / Retry」；不静默换成系统字体或 ASS 硬烧 | 注入字体加载失败、原生模块缺失 |
| 导出中 / 取消 / 失败 / 完成 | 沿用现有 Host 任务进度、取消和结果校验；失败显示具体原因，半成品不标完成 | Host 导出正常、取消、字体缺失、输出失败 |

预览画布按视频显示尺寸乘设备像素比（上限 2）绘制，静止字幕按 `frameKey` 缓存，只在字幕条或样式变化时重画。加载、失败和重试文案进入 `src/locales`，明暗主题沿用现有 CSS 变量。界面证据由 `tests/e2e/features/F-0028.spec.ts` 生成，测试名带 AC 编号。

## 技术方案

### 涉及的子系统

已读 [frontend.md](../../subsystems/frontend.md)、[cordis-host.md](../../subsystems/cordis-host.md)、[funasr-tauri.md](../../subsystems/funasr-tauri.md)、[architecture-current.md](../../architecture-current.md)、[decisions.md](../../decisions.md)、[ADR-0006](../../20-architecture/adr/0006-subtitle-graphics-layer.md) 与 [F-0016 调研报告](../../features/archive/F-0016-subtitle-render-research/02-research.md)。核对过 `src/subtitle/subtitleRenderer.ts`、`subtitleLayout.ts`、`subtitleMetrics.ts`、`subtitleFonts.ts`、`subtitlePresets.ts`、`burnAss.ts`、`exportFormats.ts`、`src/components/VideoPlayer/SubtitleOverlay.tsx`、`src/services/videoEngines/{HostExportEngine,WebAVEngine,FFmpegEngine}.ts`、`server/plugins/export.ts`、`shared/protocol.ts`、`scripts/fetch-subtitle-fonts.sh`、`scripts/package-host.mjs` 和 Tauri 资源配置。

本次只替换硬烧和预览；SRT / VTT / ASS 文件导出和 `mov_text` / WebVTT 软字幕轨保持现状。桌面端导出仍只走 Host，Tauri 不增加媒体处理命令。

### 方案

**1. shared 中唯一的 Canvas 2D 图形层**

新增 `shared/subtitle-graphics/`，不反向依赖 `src`：

- `scene.ts`：`SubtitleGraphicScene` v1 与 zod schema。场景是纯数据，包含画布宽高、fps、时长、字体族 / 字体 id、主副样式、显示模式和已经投影到目标时间轴的字幕条。
- `layout.ts`：复用现有 Pretext + 中文标点禁则算法，按 `measureText` 输出每行、每个字词的 x 与宽度；排版结果可缓存为数据。主副字幕各自排版，底边距和最大行宽共享主样式。
- `draw.ts`：`drawFrame(ctx, scene, t, opts)` 在透明画布上绘制一帧，支持 `layer` 局部条带、整体缩放、主副字幕、背景框、描边、下划线、字间距、左中右对齐和手绘阴影。只用 `measureText`、`fillText`、`strokeText`、`createLinearGradient`、`drawImage`、路径等两端都有的 API，不使用 `shadowBlur`。
- `frameKey(scene, t)`：场景与时间点相同则键相同。v1 只有静态样式，键由字幕条 id、文本、样式版本和主副样式版本组成；同一字幕条内不重画。
- `subtitleBand(scene, layouts)`：按所有字幕条的最大行数、字号、行高、描边和阴影余量计算字幕条带，输出偶数对齐的 `{ y, height }`，供 Host 只渲染条带。
- `fonts.ts`：字体 id 到固定字体族的映射和字体文件清单；两端用同一个字体族名注册同一份完整字体文件。

`src/subtitle/graphicsScene.ts` 负责把现有 `SubtitleStylePair`、`SubtitleChunk[]`、画幅和显示模式适配成场景：预览使用原始媒体时间轴，导出先用现有 `projectFromKept` 投影到成片时间轴，并按现有规则去掉画面标点、过滤删除项。样式字段和预设不改，旧项目和恢复副本直接兼容；场景带 `version` 与 `fontId`，导出输入可追踪。

**2. 字体资源与加载**

字体文件改为前后端同一份完整文件：Noto Sans SC Regular / Bold（OFL）和 Inter Regular / Bold。`scripts/fetch-subtitle-fonts.sh` 下载到 `public/fonts/subtitle/`（页面通过 `/fonts/subtitle/...` 读取）和 `src-tauri/shared_assets/subtitle-fonts/`（Host 和安装包读取），两处文件名、字节一致。`build:tauri` 前已有 `fetch:subtitle-fonts`，普通 Web 构建使用 `public/` 下的文件。

预览用 `FontFace` 加载完整文件并 `await document.fonts.load(...)`，不再用 `@fontsource` 分片 woff2 画最终字幕。Host 用 `@napi-rs/canvas` 的 `GlobalFonts.registerFromPath` 注册同一份文件，注册失败或运行时字体不可用都抛出可读错误，不静默改用 ASS 或系统替代字体。Arial / Georgia 仍是现有系统字体选项；Host 在注册后检查 `GlobalFonts.has`，缺失即报错。

**3. 预览**

`SubtitleOverlay` 接收 `<video>` 引用，播放时用 `requestVideoFrameCallback` 的 `mediaTime` 驱动绘制；暂停拖动后监听 `seeked` 补画一帧（WKWebView 暂停时不触发 `requestVideoFrameCallback`），并保留 `timeupdate` 作为兜底。画布尺寸为显示尺寸乘 `devicePixelRatio`（上限 2），绘制坐标仍按视频场景尺寸缩放。

每次绘制前比较 `frameKey`；静态样式在同一字幕条内直接跳过重画。字体加载、失败和重试状态由 overlay 自己维护；旧视频或旧字幕条的异步任务用 generation / cue key 校验，完成后不得画到新视频。拖拽调整底边距仍写现有 store，不产生额外的项目编辑记录。

**4. Host 导出**

`export.start` 的 options 新增可选 `subtitleScene`（版本化场景）和 `subtitleTransport: 'skia-band'`。新客户端硬字幕只发场景，不再发 `assContent`；`assContent` 保留为旧客户端兼容字段，新路径失败时直接报错，不退回 ASS。软字幕仍发 `subtitleTextContent`。

Host 动态加载 `@napi-rs/canvas`，按场景预排版并计算字幕条带，创建一个条带大小的 Skia 画布。导出时把主视频链路统一到探测到的源帧率和 0 起点，并在视频 filter 末尾加：

```text
[1:v]format=rgba[sub];[vout][sub]overlay=x=0:y=<bandY>:format=yuv420:eof_action=pass[vsub]
```

字幕层通过 `-f rawvideo -pix_fmt rgba -s <bandW>x<bandH> -r <fps> -i pipe:0` 输入；逐帧用 `frameKey` 复用上一帧缓冲区，`stdin.write` 遵守背压，取消时停止写并终止 FFmpeg。输出帧率、宽高和时长由 Host 从同一份 FFmpeg 探测信息校验，场景与媒体尺寸不一致就拒绝导出。默认 `overlay` 必须显式 `format=yuv420`，避免把整帧转成 RGBA。

**5. 浏览器回退**

WebAV：新增基于 `IClip` 的 `SubtitleGraphicsClip`，`tick(timeUs)` 用共用图形层把当前条带画到 `OffscreenCanvas`，返回 `ImageBitmap`；`OffscreenSprite.rect` 定位到条带，`zIndex` 保持在视频上方。Bilingual、主副样式和画幅与预览共用同一场景。

ffmpeg.wasm：每个字幕条渲染一张透明条带 PNG（间隙用透明图），写入 `concat` 清单（`file` + `duration`），先在 wasm 内编码成带 alpha 的 VP9 字幕层，再用同一 `overlay format=yuv420` 叠加。这样不需要为每个字幕条增加一个 overlay 输入；长素材的 wasm 编码会明显慢于 Host，但不改变导出语义。若当前 wasm core 不支持 VP9 alpha，导出显示「字幕渲染不可用」及原因，不退回 libass。

**6. 打包与验证**

`@napi-rs/canvas` 加入 Host 依赖，`pnpm package:host` 已按生产依赖布局复制原生包；Tauri `shared_assets/**/*` 继续包含字体。macOS 安装包需要验证 `.node` 能被 Host 加载、字体从资源目录读取、离线导出完整成功。Windows / Linux 的预编译包和 WebView2 一致性留给 F-0029，不在本需求宣称三端一致。

### 接口与数据

| 层 | 接口 / 约束 |
|---|---|
| shared/subtitle-graphics | `drawFrame(ctx, scene, t, opts)`、`frameKey(scene, t)`、`layoutCue` / `layoutScene`、`subtitleBand`、`subtitleSceneSchema`；纯数据和 Canvas 调用，不读写全局状态 |
| src/subtitle/graphicsScene.ts | `buildPreviewSubtitleScene`、`buildExportSubtitleScene`；样式字段、标点清理、主副字幕和 EDL 投影沿用现有函数 |
| src/subtitle/subtitleFonts.ts | `ensureSubtitleFonts()`、字体状态与订阅、重试；失败带原因，不降级到替代字体 |
| export.start | `options.subtitleScene?: SubtitleGraphicScene`、`subtitleTransport?: 'skia-band'`；旧 `assContent` / `subtitleTextContent` 语义保留；场景 schema 校验尺寸、fps、cue 时间和样式范围 |
| Host 渲染插件 | `createSubtitleBandRenderer(scene, resourceRoot)` 负责加载原生模块、注册字体、排版和条带；`renderFrame(t)` 返回 RGBA 缓冲区；导出插件只负责管道和进程生命周期 |
| 导出引擎 | 只注册 Host；本地 WebAV / ffmpeg.wasm 回退已按维护者 2026-11-09 决定移除 |

场景 v1 结构（节选）：

```ts
interface SubtitleGraphicScene {
  version: 1;
  width: number; height: number; fps: number; duration: number;
  fontId: string; fontFamily: string;
  displayMode: 'Bilingual' | 'Main' | 'Second';
  primary: SubtitleGraphicStyle;
  secondary?: SubtitleGraphicStyle;
  cues: Array<{ id: string; start: number; end: number; text: string; secondText?: string }>;
}
```

### 备选方案与取舍

| 选定 | 备选 | 理由 |
|---|---|---|
| Host 用 Skia 条带 + rawvideo 管道 | 继续 ASS 硬烧 | ADR-0006 已拍板；ASS 的字号、底边距和缩放语义与 Canvas 不同，新增特效无法两端一致 |
| 预览按字幕条缓存，只在 cue 变化时重画 | 每帧重画整层 | 静态样式下每帧重画是 WKWebView 掉帧的主要原因；缓存后预览成本接近基线 |
| 场景数据由客户端构建、Host 只渲染 | Host 重新解析字幕和样式 | 两端使用同一投影和标点规则，Host 不需要理解编辑器状态；场景 schema 可校验 |
| 移除本地 WebAV / ffmpeg.wasm 回退 | 保留浏览器本地合成 | 维护者 2026-11-09 决定 Web 端不做本地回退，统一连接 Host；少一套引擎和一套字幕合成路径 |
| 原生模块失败显式报错 | 自动改用 ASS | AC-8 要求不静默降级；两套渲染会重新引入不一致 |

## 架构决策

沿用 [ADR-0006](../../20-architecture/adr/0006-subtitle-graphics-layer.md)，本需求不新增架构决定。实现中新增的具体接口、场景版本和回退编码方式记录在本设计与测试报告；若验证发现必须改变分层，回到本设计并请维护者确认。

## 自行决定的事项

- 场景 v1 只覆盖现有静态样式；动画字段留到 F-0024 / F-0025，不提前写死在绘制代码里（AC-1、AC-2）。
- 预览画布按 DPR（上限 2）绘制，并用 `frameKey` 跳过同一字幕条的重画；如果真实 Tauri 仍掉帧，再评估 Worker / OffscreenCanvas（AC-2）。
- 字体文件使用完整 Noto Sans SC / Inter；Arial、Georgia 保留为系统字体选项，Host 缺字时显式报错（AC-2、AC-8）。
- ffmpeg.wasm 对长素材优先保证语义正确，编码速度不作为本需求门槛；Host 和 WebAV 是主要路径（AC-4）。
- 旧客户端仍可发送 `assContent`，但新客户端和新场景路径不自动回退；兼容字段只用于版本过渡（AC-3、AC-8）。

## 风险与回退

- `@napi-rs/canvas` 原生模块在 macOS 签名 / 打包后可能加载失败；实现必须在真实安装包里验证，失败时保留预览可用并给出可读错误。
- WKWebView 的 Canvas 性能波动大；先用 `frameKey` 缓存和 DPR 上限，仍不达标再考虑 Worker，不能用测试窗口的数据代替真实 Tauri 窗口。
- ffmpeg.wasm 的 VP9 alpha 支持需要实测；若不支持，报错并提示使用桌面 Host 或 WebAV，不退回 libass。
- 场景通过 RPC 传输可能较大；长素材先测 60 分钟项目的消息大小和导出耗时，必要时只传投影后的 cue 数据，不传原始 transcript。
- 字体文件增大安装包和 Web 首次加载；记录实际体积，字体加载失败不能让视频无法播放。

## 实现清单

- [x] 1. **共用图形层核心**：`shared/subtitle-graphics/` 的场景 schema、排版、绘制、`frameKey`、字幕条带和字体族；单元 / 架构测试覆盖主副字幕、三种画幅、全部现有样式字段和 1080p 换行 / 包围盒（AC-1、AC-2、AC-7）。
- [x] 2. **字体资源与前端加载**：完整字体下载到页面和 Host 资源目录，`FontFace` 加载、状态、失败原因和重试，`fetch:subtitle-fonts` 与打包资源对齐（AC-2、AC-5、AC-8）。
- [x] 3. **预览接入**：`SubtitleOverlay` 用 `requestVideoFrameCallback` + `seeked`、`frameKey` 缓存、DPR、旧任务隔离，空字幕 / 加载 / 失败 / 重试状态和明暗主题 E2E（AC-2、AC-5、AC-6、AC-8、AC-9）。
- [x] 4. **Host 导出**：协议场景字段、Skia 条带渲染、rawvideo 背压、`overlay format=yuv420`、尺寸 / 帧率校验、取消和错误；20 / 60 分钟导出与 ASS 基线比较（AC-3、AC-7、AC-8）。
- [x] 5. **移除 WebAV 回退**：删除 WebAVEngine、SubtitleGraphicsClip 和 `@webav/*` 依赖；Host 是唯一导出引擎（AC-4）。
- [x] 6. **移除 ffmpeg.wasm 回退**：删除 FFmpegEngine、subtitleOverlayVideo 和注册；不再维护 wasm 字幕合成（AC-4、AC-8）。
- [x] 7. **打包与真实验收**：macOS 安装包中的原生模块和字体加载、离线完整导出、真实 Tauri 窗口 1080p30 掉帧 / 拖动 100ms 测量，截图与录屏进入测试报告；更新子系统和运维文档（AC-2、AC-3、AC-4、AC-9）。
- [x] 8. **移除 ASS 硬烧兼容**：删除 `assContent`、Host 的 ASS 硬烧分支和 `buildBurnAssContent`；保留 `chunksToAss` 仅用于 ASS 字幕文件导出（AC-4、AC-8）。

## 验证计划

- 每个清单项提交前跑 `pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`、`cargo check --manifest-path src-tauri/Cargo.toml`；全量再跑 `pnpm test`、`pnpm test:architecture`、`pnpm build`。涉及 Host 打包时跑 `pnpm package:host`。
- 图形层测试用 `@napi-rs/canvas` 在 Node 中渲染固定场景，断言换行、每个字词的 x、字幕条带范围和 `frameKey` 稳定性；用 Playwright 在 Chromium 中渲染同一场景，按 1080p 像素比较包围盒偏移 ≤ 2 px、换行完全相同，抗锯齿差异单独记录。
- 预览性能在真实 `pnpm tauri:dev` 窗口测 1080p30 素材至少 30 秒，记录 `requestVideoFrameCallback` 的跳帧数（要求 < 1%）和 20 次拖动到正确帧的耗时（要求 100 ms 内）；暂停拖动单独验 `seeked` 补画。字体载入中、失败和重试各构造一次。
- Host 导出用 20 分钟和 60 分钟 1080p 口播素材，记录总耗时、实时倍数、Node / FFmpeg CPU 和峰值内存；静态样式与同机 ASS 基线比较，慢不超过 1.2 倍，动画测试场景不超过 1.5 倍（本需求只实现静态样式，动画场景作为架构余量记录）。取消和失败各跑一次，确认无半成品或临时文件。
- WebAV 与 ffmpeg.wasm 在 Chrome 真实导出 30–60 秒短片，抽取首、中、尾帧与预览比较换行和包围盒；记录 ffmpeg.wasm 的实际编码方式和耗时，未支持项列 Not run。
- macOS 打包：`pnpm tauri:build` 后安装，断网打开项目，确认 `.node` 从资源目录加载、字体可用、Host 导出完整成功；Windows / Linux、WebView2 与 Cloud 未验证的明确写 Not run。
- `tests/e2e/features/F-0028.spec.ts` 按 AC 命名，覆盖字体载入中、空字幕、正常预览、渲染失败、导出中 / 取消 / 失败 / 完成，中英文和明暗主题，截图用 `shot()`；`pnpm e2e:evidence F-0028` 生成截图和本地录屏。
- 行为改动做 Red check：临时让新预览退回旧 `renderSubtitleFrame` 或让 Host 退回 ASS，新增的换行 / 字体 / 叠加断言必须失败，且失败信息指出对应行为。

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | shared 图形层、样式适配、三画幅 / 主副字幕、1080p 一致性测试，清单 1 |
| AC-2 | 完整字体、预览 rVFC + seeked、frameKey 缓存、真实 Tauri 测量，清单 1–3、7 |
| AC-3 | Host Skia 条带、rawvideo 管道、`format=yuv420`、性能对照，清单 4 |
| AC-4 | Host 唯一导出、ASS 文件导出保留、macOS 离线包，清单 5–7 |
| AC-5 | 入口不变、空字幕不绘制、字体载入中提示，清单 2–3 |
| AC-6 | 字体就绪后首帧、导出进度 / 取消、旧任务隔离，清单 3–4 |
| AC-7 | 样式字段兼容、场景版本与字体 id、导出校验，清单 1、4 |
| AC-8 | 字体 / 原生模块失败错误与重试、不回退 ASS、无半成品，清单 2–4、6 |
| AC-9 | 中英文 / 明暗主题 E2E、真实 Mac 安装包，清单 3、7 |

## 2026-11-09 维护者调整：移除本地回退

维护者本轮明确「先不用考虑本地回退的问题，WebAV 也删除掉」。本设计前面关于 WebAV / ffmpeg.wasm 的接口、备选方案和自行决定事项由本节覆盖：

- 删除 WebAVEngine、FFmpegEngine、SubtitleGraphicsClip、subtitleOverlayVideo、`@webav/av-cliper` / `@webav/av-recorder`，前端只注册 Host 引擎。
- Web 端没有 Host 时导出入口显示「Host 导出不可用」，不再在浏览器内合成视频。
- 删除 `assContent`、Host 的 ASS 硬烧分支和 `buildBurnAssContent`；ASS 只用于字幕文件导出，`chunksToAss` 与导出对话框的 ASS 入口保留。
- AC-4 的验收改为「Host 导出 + ASS 文件导出 + macOS 包」，不再要求 WebAV / ffmpeg.wasm 成片对比；01-spec 的原始 AC 作为历史保留。


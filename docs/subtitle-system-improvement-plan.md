# 字幕系统改进方案

> 2026-11-09 变更：本地 WebAV / ffmpeg.wasm 导出回退已移除，Host 是唯一视频导出路径。本文中的 WebAV 渲染、`subtitleUtils` 等描述属于历史方案。

> 版本：v1.0  
> 日期：2026-07-02  
> 状态：Phase 0–4 + 剩余问题修复（2026-07-02）已实施
> 关联代码：`SubtitleOverlay`、`SubtitleSettings`、`subtitleUtils`、`WebAVEngine`

---

## 1. 背景与目标

FlyCut Caption 的核心价值是「识别 → 编辑 → 预览 → 导出」字幕。当前字幕渲染基于 Canvas 2D + WebAV `EmbedSubtitlesClip`，功能可用，但在**字体、排版、分辨率适配、导出格式、预览一致性**等方面存在明显缺口。

### 1.1 改进目标

| 目标 | 说明 | 优先级 |
|------|------|--------|
| 跨平台字体一致 | 摆脱系统字体依赖，支持开源字体（含 Google Fonts 自托管） | P0 |
| 分辨率无关字号 | 720p / 1080p / 4K / 竖屏视频字幕视觉比例一致 | P0 |
| 预览 = 导出 | 预览画面与烧录导出像素级一致（WYSIWYG） | P0 |
| 排版质量提升 | 统一换行、标点禁则、安全区 | P1 |
| 导出格式完善 | VTT / ASS，双语 `secondText` | P1 |
| 代码清理 | 移除 debug 埋点、合并重复 UI | P0 |

### 1.2 非目标（仍不做）

- 逐字/逐词时间戳（依赖 ASR 升级，见 `models.json` `token_timestamp_verified`）
- 竖排、注音、复杂阿拉伯语塑形（需 HarfBuzz，投入过大）
- ~~FFmpeg 内置打包进 app bundle~~（已实现：`pnpm fetch:ffmpeg` + `src-tauri/binaries/ffmpeg`）

---

## 2. 现状分析

### 2.1 数据流

```text
ASR (Whisper / FunASR)
  → SubtitleChunk { text, timestamp, secondText?, deleted? }
  → historyStore (chunks)
  → SubtitleOverlay (Canvas 预览)
  → SubtitleSettings (样式 state)
  → WebAVEngine.addSoftSubtitles (EmbedSubtitlesClip 烧录)
  → SRT / JSON 导出（无样式）
```

### 2.2 关键文件

| 文件 | 职责 |
|------|------|
| `src/components/VideoPlayer/SubtitleOverlay.tsx` | 预览 Canvas 渲染、拖拽定位、手写换行 |
| `src/components/SubtitleSettings/SubtitleSettings.tsx` | 样式 UI，`SubtitleStyle` 类型定义 |
| `src/utils/subtitleUtils.ts` | WebAV 字幕图像工具、`formatSubtitleText` |
| `src/services/videoEngines/WebAVEngine.ts` | `EmbedSubtitlesClip` 软烧录 |
| `src/FlyCutCaption.tsx` | 样式 state、SRT 导出、视频导出传参 |
| `src/types/subtitle.ts` | `SubtitleChunk`、`secondText` 字段 |

### 2.3 已识别问题清单

#### P0 — 阻塞体验

1. **字体仅 4 个系统字体**，Linux / Windows / macOS 显示不一致  
2. **`FlyCutCaption.tsx` 有独立 `font` state**，未绑定 `subtitleStyle.fontFamily`（双控件）  
3. **字号用绝对 px**（默认 24），4K 视频上仅占画面高度 ~1.1%  
4. **默认值不一致**：UI 默认 24，WebAV 兜底 48，硬烧录路径写死 28  
5. **`SubtitleOverlay.tsx` 含 debug fetch / console.log**（`debug-subtitle-overlap.md`）  
6. **无 `document.fonts.load()`**，自定义字体可能 fallback 或闪烁  

#### P1 — 功能缺口

7. **预览与导出换行逻辑分裂**（Overlay 自写 ~100 行，WebAV 内置策略不同）  
8. **`secondText` 双语字段未渲染、未导出**  
9. **仅 SRT / JSON**，无 VTT / ASS  
10. **竖屏 9:16 无安全区预设**，`bottomOffset` 固定 px  
11. **中文无标点禁则**（行首可出现 `，。！？`）  

#### P2 — 架构债务

12. `subtitleUtils.ts` 与 `SubtitleSettings.tsx` 各有一套 `SubtitleStyle` 类型  
13. `src/types.ts` 还有第三套 `SubtitleStyle`  
14. FunASR 时间戳为 VAD segment 级，限制口癖精剪精度  

---

## 3. 目标架构

### 3.1 分层设计

```text
┌─────────────────────────────────────────────────────────┐
│  UI 层                                                   │
│  SubtitleSettings / 字体选择器 / 预设模板 / 安全区切换      │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│  样式 & 布局层（新增 src/subtitle/）                      │
│  ├─ subtitleStyle.ts      统一样式类型 + 默认值           │
│  ├─ subtitleMetrics.ts    视频空间 px 换算（比例→px）     │
│  ├─ subtitleLayout.ts     Pretext 换行 + 标点禁则         │
│  ├─ subtitleFonts.ts      字体注册 / load / 清单          │
│  └─ subtitleRenderer.ts   Canvas 绘制（预览+导出共用）    │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│  消费层                                                    │
│  SubtitleOverlay（预览）                                   │
│  WebAVEngine（烧录，调用同一 renderer 或共享 layout 结果）    │
│  exportSrt / exportVtt / exportAss（导出）                 │
└───────────────────────────────────────────────────────────┘
```

### 3.2 字号模型（核心决策）

**存储**：相对视频高度的比例 + 1080p 参考值（便于 UI 展示）

```typescript
interface SubtitleStyleV2 {
  // 主存储：占视频高度的比例，默认 0.045（4.5%，接近 broadcast 惯例）
  fontSizeRatio: number;

  // UI 展示用：等价 1080p 像素字号（只读计算，不单独存储）
  // displayFontSizeAt1080p = Math.round(1080 * fontSizeRatio)
}
```

**渲染换算**：

```typescript
function resolveVideoFontSize(style: SubtitleStyleV2, videoHeight: number): number {
  return Math.round(videoHeight * style.fontSizeRatio);
}

function resolveOffset(style: SubtitleStyleV2, videoHeight: number, key: 'bottom'): number {
  // bottomOffsetRatio 同样改为比例，默认 0.055（1080p 约 60px）
  return Math.round(videoHeight * style.bottomOffsetRatio);
}
```

**预览缩放**（保持现有逻辑，叠加一层）：

```typescript
const previewFontSize = resolveVideoFontSize(style, videoHeight) * (displayHeight / videoHeight);
// 化简后 = videoHeight * ratio * displayHeight / videoHeight = displayHeight * ratio
```

**迁移**：旧 `fontSize: 24` → `fontSizeRatio: 24 / 1080 ≈ 0.0222`；新用户默认 `0.045`。

### 3.3 字体方案

**原则**：Google Fonts 可用，但必须**自托管 woff2**，不依赖运行时 CDN。

#### 字体清单（Phase 1）

| ID | 显示名 | 文件 | 协议 | 场景 |
|----|--------|------|------|------|
| `noto-sans-sc` | Noto Sans SC | `NotoSansSC-Regular.woff2` + `Bold.woff2` | OFL | 中文默认 |
| `noto-sans` | Noto Sans | `NotoSans-Regular.woff2` | OFL | 多语种兜底 |
| `inter` | Inter | `Inter-Regular.woff2` + `Bold.woff2` | OFL | 英文 |
| `source-han-sans-sc` | 思源黑体 SC | `SourceHanSansSC-Regular.woff2` | OFL | 中文备选 |

目录结构：

```text
public/fonts/
  noto-sans-sc/
    NotoSansSC-Regular.woff2
    NotoSansSC-Bold.woff2
  inter/
    Inter-Regular.woff2
    Inter-Bold.woff2
  manifest.json          # id → family名、文件路径、字重映射
```

`src/config/subtitleFonts.ts`：

```typescript
export const SUBTITLE_FONTS = [
  {
    id: 'noto-sans-sc',
    label: 'Noto Sans SC',
    family: '"Noto Sans SC"',
    files: [
      { weight: 400, path: '/fonts/noto-sans-sc/NotoSansSC-Regular.woff2' },
      { weight: 700, path: '/fonts/noto-sans-sc/NotoSansSC-Bold.woff2' },
    ],
    recommended: true,
    languages: ['zh', 'en'],
  },
  // ...
] as const;
```

加载时机：

```typescript
export async function ensureSubtitleFont(
  fontId: string,
  weight: 400 | 700,
  fontSizePx: number,
): Promise<void> {
  const font = SUBTITLE_FONTS.find(f => f.id === fontId);
  if (!font) return;
  const file = font.files.find(f => f.weight === weight);
  const desc = `${weight} ${fontSizePx}px ${font.family}`;
  if (!document.fonts.check(desc)) {
    const face = new FontFace(font.family.replace(/"/g, ''), `url(${file.path})`);
    await face.load();
    document.fonts.add(face);
  }
  await document.fonts.load(desc);
}
```

Tauri 注意：`public/fonts` 会随前端资源打包，离线可用。

---

## 4. Pretext 集成方案

### 4.1 是否引入

| 维度 | 评估 |
|------|------|
| 解决的问题 | 统一换行、Unicode 分词、resize 性能 |
| 不解决的问题 | 渲染、描边阴影、OpenType 特性 |
| 包体积 | ~15KB gzipped，0 依赖 |
| 与 Canvas 关系 | `prepare()` 内部仍用 `measureText`，结果给 `layoutWithLines()` |

**结论**：Phase 2 引入，替换 `SubtitleOverlay` 手写换行。

### 4.2 集成方式

```bash
pnpm add @chenglou/pretext
```

`src/subtitle/subtitleLayout.ts`：

```typescript
import { prepare, layoutWithLines } from '@chenglou/pretext';
import { applyCjkLineBreakRules } from './cjkPunctuation';

export function layoutSubtitleText(
  text: string,
  font: string,           // 完整 ctx.font 字符串
  maxWidth: number,
  lineHeight: number,
): { lines: string[]; totalHeight: number } {
  const normalized = applyCjkLineBreakRules(text); // 标点禁则预处理
  const prepared = prepare(normalized, font);
  const { lines } = layoutWithLines(prepared, maxWidth, lineHeight);
  return {
    lines: lines.map(l => l.text),
    totalHeight: lines.length * lineHeight,
  };
}
```

标点禁则（`cjkPunctuation.ts`）在 `prepare` 前插入零宽断行提示，或在 `layoutWithLines` 后对行首标点做回退调整。

### 4.3 共用策略

```text
subtitleLayout.layoutSubtitleText()
    ├─→ SubtitleOverlay（预览绘制）
    └─→ WebAVEngine（烧录前预分行，传给 EmbedSubtitlesClip 时带 \n）
```

若 WebAV `EmbedSubtitlesClip` 不接受预分行，则在烧录路径改用 `subtitleRenderer` 逐帧/逐段绘制为 `ImgClip`（与 `subtitleUtils.createSubtitleClip` 统一）。

---

## 5. 分阶段任务与实施方案

---

### Phase 0：清理与类型统一（0.5 周）

> 先还债，避免后续改动扩散。

#### 任务 0.1 — 移除 debug 代码

| 项 | 内容 |
|----|------|
| 文件 | `src/components/VideoPlayer/SubtitleOverlay.tsx` |
| 操作 | 删除 `#region debug-point` fetch 埋点、换行 `console.log` |
| 文件 | `debug-subtitle-overlap.md` | 移至 `.dbg/` 或删除 |
| 验收 | `pnpm lint` 通过；预览无网络请求到 `127.0.0.1:7777` |

#### 任务 0.2 — 合并 SubtitleStyle 类型

| 项 | 内容 |
|----|------|
| 新建 | `src/subtitle/subtitleStyle.ts`（唯一来源） |
| 迁移 | `SubtitleSettings.tsx`、`subtitleUtils.ts`、`types.ts` 改为 re-export |
| 验收 | `pnpm tsc -b --noEmit` 无类型冲突 |

#### 任务 0.3 — 合并重复字体选择器

| 项 | 内容 |
|----|------|
| 文件 | `src/FlyCutCaption.tsx` ~L1430 独立 `font` / `setFont` |
| 操作 | 删除独立 Select，仅保留 `SubtitleSettings` 内字体选择 |
| 验收 | 改字体后预览立即生效；state 只有一份 |

**Phase 0 完成标准**：无 debug 代码；单一 `SubtitleStyle`；单一字体控件。

---

### Phase 1：字体 + 分辨率字号（1 周）— P0

#### 任务 1.1 — 自托管字体资源

| 项 | 内容 |
|----|------|
| 脚本 | 新增 `scripts/fetch-subtitle-fonts.sh` |
| 来源 | [Google Fonts GitHub](https://github.com/google/fonts) 或 [fontsource](https://fontsource.org/) |
| 输出 | `public/fonts/**` |
| 体积预算 | Phase 1 .subset 子集化中文常用字 ~2–4MB/字体 |
| 验收 | 断网状态下字体正常显示 |

脚本示例：

```bash
#!/usr/bin/env bash
set -euo pipefail
DEST="public/fonts/noto-sans-sc"
mkdir -p "$DEST"
# 从 fontsource npm 包复制，或 curl 下载 woff2
curl -L -o "$DEST/NotoSansSC-Regular.woff2" \
  "https://cdn.jsdelivr.net/fontsource/fonts/noto-sans-sc@5.0.0/chinese-simplified-400-normal.woff2"
```

#### 任务 1.2 — 字体注册模块

| 项 | 内容 |
|----|------|
| 新建 | `src/subtitle/subtitleFonts.ts` |
| 新建 | `src/config/subtitleFonts.ts`（字体清单） |
| 修改 | `src/index.css` 添加 `@font-face`（可选，与 FontFace API 二选一） |
| 验收 | `ensureSubtitleFont('noto-sans-sc', 700, 48)` 后 Canvas 测量宽度稳定 |

#### 任务 1.3 — 字号比例模型

| 项 | 内容 |
|----|------|
| 新建 | `src/subtitle/subtitleMetrics.ts` |
| 修改 | `SubtitleStyle` 增加 `fontSizeRatio`、`bottomOffsetRatio` |
| 兼容 | `migrateSubtitleStyle(legacy)` 把旧 `fontSize` 转为 ratio |
| 修改 | `SubtitleSettings` 滑块改为「1080p 等价字号」显示，内部写 ratio |
| 默认值 | `fontSizeRatio: 0.045`，`bottomOffsetRatio: 0.056` |

滑块 UI 逻辑：

```typescript
// 用户拖动「48」时
const ratio = value / 1080;
updateStyle({ fontSizeRatio: ratio });
```

#### 任务 1.4 — 预览渲染接入

| 项 | 内容 |
|----|------|
| 修改 | `SubtitleOverlay.tsx` 用 `resolveVideoFontSize` + `ensureSubtitleFont` |
| 修改 | 所有 `scaleSize(style.fontSize)` → `scaleSize(resolve...(style, videoHeight))` |
| 验收 | 同一字号比例下，720p / 1080p / 4K 视频字幕**占画面高度比例一致** |

#### 任务 1.5 — 导出渲染接入

| 项 | 内容 |
|----|------|
| 修改 | `WebAVEngine.addSoftSubtitles` 传入换算后的 `fontSize` |
| 修改 | 删除硬编码 `fontSize: 48` / `28` 兜底 |
| 验收 | 1080p 视频：预览截图与导出帧字幕大小一致（误差 ≤ 2px） |

**Phase 1 完成标准**：

- [ ] 至少 4 款自托管开源字体可选  
- [ ] 720p 与 4K 字幕视觉比例一致  
- [ ] 预览与导出 WYSIWYG（1080p 基准）  
- [ ] Tauri 离线字体可用  

---

### Phase 2：统一排版引擎（1 周）— P1

#### 任务 2.1 — 抽取共享 Renderer

| 项 | 内容 |
|----|------|
| 新建 | `src/subtitle/subtitleRenderer.ts` |
| 职责 | 接收 `{ lines, style, videoSize, displaySize? }`，输出 Canvas 绘制 |
| 从 | `SubtitleOverlay.renderSubtitleToCanvas` 抽取 |
| 验收 | Overlay 代码量减少 50%+ |

#### 任务 2.2 — 引入 Pretext 换行

| 项 | 内容 |
|----|------|
| 依赖 | `pnpm add @chenglou/pretext` |
| 新建 | `src/subtitle/subtitleLayout.ts` |
| 替换 | Overlay 内中文逐字 / 英文按词逻辑 |
| 验收 | 中英混排、日文无回归；resize 不卡顿 |

#### 任务 2.3 — 中文标点禁则

| 项 | 内容 |
|----|------|
| 新建 | `src/subtitle/cjkPunctuation.ts` |
| 规则 | 行首禁 `，。！？；：、」』）】》`；行尾禁 `「『（【《` |
| 实现 | 换行后调整：若行首为禁则标点，将该标点移至上一行 |
| 验收 | 含标点长句换行后无孤立标点行首 |

#### 任务 2.4 — 竖屏安全区预设

| 项 | 内容 |
|----|------|
| 新建 | `src/subtitle/subtitlePresets.ts` |
| 预设 | `landscape`（默认）、`portrait_9_16`、`square_1_1` |
| 逻辑 | 竖屏 `bottomOffsetRatio` 提高到 0.12，最大行宽 85% |
| UI | `SubtitleSettings` 增加「画面比例」下拉 |
| 验收 | 9:16 视频字幕不遮挡底部平台 UI 常见区域 |

**Phase 2 完成标准**：

- [ ] 预览 / 导出共用 layout + renderer  
- [ ] Pretext 换行上线  
- [ ] 标点禁则生效  
- [ ] 竖屏预设可用  

---

### Phase 3：导出格式与双语（1.5 周）— P1

#### 任务 3.1 — VTT 导出

| 项 | 内容 |
|----|------|
| 新建 | `src/subtitle/exportVtt.ts` |
| 修改 | `ExportDialog.tsx` 增加 VTT 按钮 |
| 修改 | `FlyCutCaption.handleExportSubtitles` 支持 `'vtt'` |
| 格式 | WEBVTT 标准，时间戳 `HH:MM:SS.mmm` |
| 验收 | VLC / Chrome 可加载播放 |

```typescript
export function chunksToVtt(chunks: SubtitleChunk[]): string {
  const lines = ['WEBVTT', ''];
  chunks.filter(c => !c.deleted).forEach((c, i) => {
    lines.push(String(i + 1));
    lines.push(`${toVttTime(c.timestamp[0])} --> ${toVttTime(c.timestamp[1])}`);
    lines.push(c.text);
    if (c.secondText) lines.push(c.secondText);
    lines.push('');
  });
  return lines.join('\n');
}
```

#### 任务 3.2 — ASS 导出（带样式）

| 项 | 内容 |
|----|------|
| 新建 | `src/subtitle/exportAss.ts` |
| 关键字段 | `PlayResX` / `PlayResY` = 视频分辨率；`Style: Default,...` |
| 字号 | `Fontsize = resolveVideoFontSize(style, playResY)` |
| 位置 | `MarginV = resolveOffset(...)` |
| 验收 | Aegisub 打开样式正确；FFmpeg `ass` 滤镜可烧录 |

ASS 样式行示例：

```text
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, ...
Style: Default,Noto Sans SC,48,&H00FFFFFF,&H000000FF,...
```

#### 任务 3.3 — 双语 secondText

| 项 | 内容 |
|----|------|
| 修改 | `subtitleRenderer.ts` 支持主/副两行，副字号 = 主 × 0.75 |
| 修改 | `SubtitleOverlay` 读取 `currentSubtitle.secondText` |
| 修改 | SRT / VTT / ASS 导出包含副字幕 |
| UI | 字幕编辑器增加「副字幕」列（可 Phase 3b） |
| 验收 | 预览双行显示；ASS 导出双行 |

#### 任务 3.4 — 样式预设模板

| 项 | 内容 |
|----|------|
| 新建 | `src/subtitle/subtitlePresets.ts` 扩展 |
| 预设 | `classic`（白字黑边）、`boxed`（黑底白字）、`minimal`（无描边） |
| UI | 一键应用预设 |
| 验收 | 三种预设预览与导出一致 |

**Phase 3 完成标准**：

- [ ] SRT / VTT / JSON / ASS 四种导出  
- [ ] ASS 含 PlayRes + 样式  
- [ ] 双语渲染 + 导出  

---

### Phase 4：高级能力（按需，2 周）— P2

#### 任务 4.1 — Tauri FFmpeg ASS 烧录

- Rust 侧 `ffmpeg -vf "ass=subtitles.ass"`  
- 导出前在前端生成 ASS 临时文件，Tauri 写本地路径  
- 适合硬烧录高质量字幕  

#### 任务 4.2 — 自动分句

- 长 segment（> N 秒或 > M 字）按标点拆分为多条  
- 仅编辑层拆分，不重新 ASR  

#### 任务 4.3 — 逐词时间戳（依赖 ASR）

- 待 `models.json` 中模型 `token_timestamp_verified: true`  
- UI 字级高亮、口癖精剪  

---

## 6. 文件变更总览

### 6.1 新增文件

```text
docs/subtitle-system-improvement-plan.md     # 本文档
scripts/fetch-subtitle-fonts.sh
public/fonts/**                              # 字体资源
src/subtitle/
  subtitleStyle.ts
  subtitleMetrics.ts
  subtitleFonts.ts
  subtitleLayout.ts
  subtitleRenderer.ts
  cjkPunctuation.ts
  subtitlePresets.ts
  exportVtt.ts
  exportAss.ts
  index.ts
src/config/subtitleFonts.ts
```

### 6.2 修改文件

```text
src/components/VideoPlayer/SubtitleOverlay.tsx   # 精简，调用 subtitle/*
src/components/SubtitleSettings/SubtitleSettings.tsx
src/services/videoEngines/WebAVEngine.ts
src/utils/subtitleUtils.ts                       # 委托给 subtitle/*
src/FlyCutCaption.tsx                            # 导出、移除重复 font state
src/components/ExportPanel/ExportDialog.tsx
src/index.css                                    # @font-face（可选）
package.json                                     # @chenglou/pretext
docs/README.md                                   # 文档索引
```

### 6.3 删除 / 归档

```text
debug-subtitle-overlap.md → .dbg/ 或删除
src/types.ts 中重复 SubtitleStyle（改为 re-export）
```

---

## 7. 测试计划

### 7.1 单元测试（建议 vitest）

| 模块 | 用例 |
|------|------|
| `subtitleMetrics` | 1080p/720p/4K 换算；迁移旧 fontSize |
| `subtitleLayout` | 纯中文、纯英文、中英混排换行 |
| `cjkPunctuation` | 行首无禁则标点 |
| `exportVtt` / `exportAss` | 时间格式、样式字段 |

### 7.2 视觉回归（手工 + 截图）

| 场景 | 检查点 |
|------|--------|
| 1080p 横屏 | 字号比例 4.5%，预览=导出 |
| 4K 横屏 | 字幕占画面比例与 1080p 一致 |
| 9:16 竖屏 | 安全区底边距 |
| 长句换行 | 无 overflow，标点正确 |
| 字体切换 | Noto / Inter 加载成功 |

### 7.3 验证命令

```bash
pnpm lint
pnpm tsc -b --noEmit
pnpm build
# Tauri 改动时
cargo check --manifest-path src-tauri/Cargo.toml
```

---

## 8. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 中文字体子集不全 | 缺字方块 | fontsource 子集 + 全量包可选下载 |
| WebAV EmbedSubtitlesClip 换行不可控 | 预览≠导出 | Phase 2 统一走 subtitleRenderer |
| 字体文件增大安装包 | Tauri 包体积 +5–15MB | 默认仅打包 Noto Sans SC + Inter |
| Canvas letterSpacing CJK 兼容性 | 间距异常 | 中文默认 letterSpacing=0 |
| ASS 颜色格式 &HAABBGGRR | 导出颜色错误 | 写转换工具 + 测试 |

---

## 9. 里程碑与时间线

```text
Week 1   Phase 0 + Phase 1（字体、字号比例、WYSIWYG）
Week 2   Phase 2（Pretext、标点、竖屏预设）
Week 3   Phase 3（VTT/ASS、双语）
Week 4+  Phase 4（按需）
```

### 任务看板（可拆 Issue）

| ID | 任务 | Phase | 估时 | 依赖 |
|----|------|-------|------|------|
| SUB-001 | 移除 debug 埋点 | 0 | 2h | — |
| SUB-002 | 统一 SubtitleStyle 类型 | 0 | 4h | — |
| SUB-003 | 合并重复字体选择器 | 0 | 2h | SUB-002 |
| SUB-004 | fetch-subtitle-fonts 脚本 | 1 | 4h | — |
| SUB-005 | subtitleFonts 模块 | 1 | 4h | SUB-004 |
| SUB-006 | fontSizeRatio 模型 + UI | 1 | 6h | SUB-002 |
| SUB-007 | Overlay 接入 metrics + fonts | 1 | 6h | SUB-005, SUB-006 |
| SUB-008 | WebAV 导出 WYSIWYG | 1 | 4h | SUB-007 |
| SUB-009 | subtitleRenderer 抽取 | 2 | 8h | SUB-007 |
| SUB-010 | Pretext 换行 | 2 | 6h | SUB-009 |
| SUB-011 | 标点禁则 | 2 | 4h | SUB-010 |
| SUB-012 | 竖屏安全区预设 | 2 | 4h | SUB-006 |
| SUB-013 | VTT 导出 | 3 | 4h | — |
| SUB-014 | ASS 导出 | 3 | 8h | SUB-006 |
| SUB-015 | 双语 secondText | 3 | 8h | SUB-009 |
| SUB-016 | 样式预设模板 | 3 | 4h | SUB-006 |

---

## 10. 附录

### A. 字号参考表（fontSizeRatio = 0.045）

| 视频高度 | 渲染字号 (px) | 占画面高度 |
|----------|---------------|------------|
| 720 | 32 | 4.5% |
| 1080 | 49 | 4.5% |
| 1440 | 65 | 4.5% |
| 2160 (4K) | 97 | 4.5% |

### B. Google Fonts 与许可证

所有推荐字体均为 **SIL Open Font License (OFL)**，可自由嵌入、分发、用于商业项目。自托管不违反 ToS。

### C. Pretext vs HarfBuzz 选型

| 能力 | Pretext | HarfBuzz + FreeType |
|------|---------|---------------------|
| 换行测量 | ✅ | ✅ |
| Canvas 渲染 | 需配合 | 需配合 |
| 连字/复杂脚本 | ❌ | ✅ |
| Web 集成成本 | 低 | 高（WASM ~1MB+） |
| 字幕场景推荐 | ✅ 默认 | 仅特殊语言需求 |

### D. 相关文档

- [FunASR 接入方案](./funasr-integration.md) — ASR 时间戳策略  
- [技术架构](./architecture.md) — 视频引擎分层  
- `models.json` — `timestamp.level: segment` 说明  

---

## 11. 审批与下一步

1. 确认 Phase 1 字体清单（是否包含思源黑体 / 仅 Noto）  
2. 确认默认 `fontSizeRatio`（建议 0.045）  
3. 按 SUB-001 → SUB-008 顺序开工  

**建议首个 PR 范围**：Phase 0 全部 + Phase 1 任务 1.1–1.3（字体资源 + 类型 + 比例模型），第二个 PR 做预览/导出 WYSIWYG。

---

## 12. 剩余问题修复计划（2026-07-02 已完成）

| ID | 问题 | 修复 |
|----|------|------|
| FIX-001 | 预览模式字幕时间轴错位 | `SubtitleOverlay` 始终用 `localCurrentTime`；删除片段区间 `visible=false` |
| FIX-002 | Debug 埋点 | 移除 `EnhancedVideoPlayer` 127.0.0.1:7777 fetch |
| FIX-003 | Web 硬烧录 / 软烧录混淆 | Web 仅硬烧录（`addBurnedSubtitles`）；软烧录禁用并提示桌面版 |
| FIX-004 | FFmpeg 烧录字体 | `fontsdir` 指向 `shared_assets/subtitle-fonts`；`fetch:subtitle-fonts` 下载 TTF |
| FIX-005 | shadow N/S/M/L 无效 | `applyShadowSize` 联动 `subtitleStyle` |
| FIX-006 | 导出前无 FFmpeg 检测 | `ExportDialog` 打开时 `check_ffmpeg_environment` |
| FIX-007 | 软字幕 mux | 显式 `-map 0:v:0 -map 0:a:0? -map 1:s:0` |
| FIX-008 | 缓存堆积 | 24h 过期清理 + 完成后删除 ASS |
| FIX-009 | 类型三套 | `src/types.ts` re-export canonical 类型 |
| FIX-010 | WebAVEngine 死代码 | 删除 `calculateSubtitleTimeMapping` / `addSubtitlesToCombinator` |
| FIX-011 | FFmpeg 依赖系统 PATH | `pnpm fetch:ffmpeg` + `ffmpeg_bin.rs` 内置解析；FunASR 经 `FFMPEG_PATH` |

**仍待后续**：ASR 逐词时间戳、自动分句声学边界。

# 前端（React / UI）

适用范围：`src/**`（`src/runtime/**` 另见 [cordis-host.md](cordis-host.md)）。

## 技术栈

- React 19 + TypeScript（strict，project references：`tsconfig.app.json` / `tsconfig.node.json`）+ Vite
- Tailwind CSS 4：CSS-first 配置，`src/index.css` 中 `@import "tailwindcss"` 与 `@theme` 块，`@tailwindcss/vite` 插件；没有 `tailwind.config.js` / `postcss.config.js`
- Shadcn/ui（`components.json`，new-york 风格、neutral 基色），基于 Radix UI；图标用 Lucide React
- 主题：CSS 变量 + `oklch()` 颜色，内置明暗模式
- ES modules（`"type": "module"`），路径别名 `@/*` → `./src/*`
- 包管理器 pnpm

## 目录

- `src/components/`：UI 组件（文件上传、视频播放器、字幕编辑器、ASR 设置、导出等）
- `src/hooks/`：自定义 Hooks（ASR、字幕管理等）
- `src/services/`：前端服务层（ASR/AI/视频引擎适配，推理在 Host 执行）
- `src/stores/`：按 Context 隔离的业务 store（用法见 cordis-host.md）
- `src/runtime/`：前端 Cordis 组装与 Host 连接
- `src/types/`、`src/utils/`、`src/locales/`、`src/contexts/`（仅 `LocaleProvider`）

## 规则

- **项目模式**（`src/components/Project/ProjectsApp.tsx`、`src/services/projectService.ts`）：路由 `#/projects`（首页）、`#/trash`、`#/projects/<id>`（详情）、`#/projects/<id>/videos/<videoId>`（编辑器）。编辑器一次只装一个视频；切换视频走 `ctx.projects.switchVideo`：先保存当前视频，再整体载入目标视频并清空撤销栈，转写进行中不能切换。字幕样式分两部分保存：跟随项目的视频改样式写项目样式，单独设置的视频和所有视频的画幅按视频保存；比较样式时不看画幅。
- **崩溃恢复**（F-0004、ADR-0004）：`src/recovery/` 是唯一允许前端在本地存业务内容的地方，而且只是临时恢复副本：IndexedDB 库 `flycut-recovery`，每个编辑会话一份完整快照（字幕、删除标记、译文、样式来源、样式、画幅），按 Host 身份 + 项目 + 视频 + 会话隔离；Host 保存成功或用户放弃后删除。不要在别处写业务数据到 localStorage / IndexedDB。记录器由 `ctx.projects` 在 `onEdit` 里驱动（停止编辑 250ms、连续编辑最多 1 秒记录一次），打开项目时 `checkRecovery` 检查副本；还开着的会话用 Web Lock 标记，其他窗口跳过。恢复流程的状态在 `stores.project.recovery`，`phase` 不是 `idle` 时编辑器被对话框挡住、不自动保存。副本是否已经写进 Host 按内容比较（`src/recovery/copy.ts`），不比较时间。
- 业务状态放 `src/stores`，通过 `useXStore(selector)` 读取；不要新建全局 React Context 承载业务状态。
- 服务通过 `useClientRuntime()` 获取 `ctx.asr` / `ctx.ai`，不要写模块级单例。
- 新的 Shadcn 组件用 `pnpm dlx shadcn@latest add <component-name>` 添加，不要手抄。
- 用户可见文案走 `src/locales`，见根目录 `INTERNATIONALIZATION.md`。
- 改动交互细节前先查 [decisions.md](../decisions.md)，已拍板的行为不要在 PR 里顺手改。
- **端到端测试**：按 [自动化验收方案](../30-engineering/acceptance-testing.md) 选择目标平台，测试名带 AC 编号，覆盖 PRD 列出的状态和明暗主题。Web 用例写在 `tests/e2e/features/<F-编号>.spec.ts`，截图用 `tests/e2e/lib/evidence.ts` 的 `shot()`；`pnpm e2e:evidence F-NNNN` 把截图写进需求目录的 `screenshots/`、录屏写进 `recordings/`。Web 异常状态可用 `page.route` 构造；需要真实 Host 时用 `pnpm dev`，在证据中注明。桌面专属行为在真实 Tauri 中验收。

## F-0006 / F-0007 / F-0012 实施

EditingSuggestionsPanel（去口癖）和 SilenceCutPanel（去静音）共用 PendingSuggestionsList；pendingSuggestions.kind 决定哪个面板显示列表。选择、预览、剪前/剪后 audition 只改临时层，确认后一次提交。historyStore.pendingCuts 只作为 F-0005 兼容派生视图，不要在新组件里直接写它。

FindReplaceBar + useFindReplace 只查当前视频未删除原文；命中用只读 mark 片段呈现，不替换 textarea。全部替换先预览，确认时一次 batchUpdateText，撤销一次恢复整批。

## 命令与验证

```bash
pnpm dev:web          # 只起前端
pnpm lint
pnpm tsc -b --noEmit
pnpm build
```

涉及字幕分句、智能剪空白等纯逻辑的，跑对应 `pnpm test:sentence-grouping` / `pnpm test:smart-cut`。

## F-0005 实施

`history.edl` 是剪辑真源，字幕 deleted 只作显示投影；播放器/导出/字幕映射读 shared/editing/edl。`pendingCuts` 和 `historyPreview` 只用于预览，不进入项目、恢复副本或导出。`editingOf` 生成正式持久快照；CutHistoryPanel 先保存再读历史，回退失败保留当前编辑，回执丢失先读回核对。

## F-0028 实施

字幕画面统一走 `shared/subtitle-graphics/`：`drawFrame`、`frameKey`、`layoutScene`、`subtitleBand` 只依赖 Canvas 2D，预览和 Host 共用。`src/subtitle/graphicsScene.ts` 把现有 `SubtitleStylePair` 和 chunks 适配成场景，预览用原始时间轴，导出用 EDL 投影后的时间轴。

`SubtitleOverlay` 用 `requestVideoFrameCallback` 的 `mediaTime` 绘制，暂停拖动在 `seeked` 补画，同一字幕条按 `frameKey` 跳过重画；画布按显示尺寸 × DPR（上限 2）。字体改为 `FontFace` 加载 `public/fonts/subtitle/` 下的完整文件，状态分 loading / ready / error，失败显示「字幕渲染不可用」和重试，不静默用系统字体或 ASS。空字幕不绘制、不显示加载提示。本地 WebAV / ffmpeg.wasm 回退已移除；没有 Host 时导出入口显示 Host 不可用，不再在浏览器内合成视频。

## F-0024 实施

字幕样式新增「逐字高亮」预设与 `wordHighlightMode` / `wordHighlightColor`。`src/subtitle/graphicsScene.ts` 只把 `hasWordTimestamps` 且逐句 `wordIds` 完整、文本可映射、时间在句内的词元写入场景；预览使用原始时间，导出使用 EDL 投影时间。任一词元无法证明可靠时该句不传 `words`，界面显示「使用整句高亮」并由共用图形层给整句换色；原文词时间不会套给译文。

`shared/subtitle-graphics` 的 `frameKey` 现在把当前词索引计入缓存键，同一词内稳定，词边界、词间空隙和整句降级时更新。绘制仍只用一份 `drawFrame`：前端 Canvas 与 Host Skia 条带共用词色范围，F-0028 的字体、DPR、seeked 补画和失败处理保持不变。嵌入式 WKWebView 若在 React 订阅前已加载视频元数据，播放器会主动读取一次尺寸；若 `ResizeObserver` 没给初始值，则用容器 DOM 尺寸回退。

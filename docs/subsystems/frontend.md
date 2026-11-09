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
- **端到端测试**：涉及界面的 AC 写在 `tests/e2e/features/<F-编号>.spec.ts`，测试名带 AC 编号，覆盖 PRD 列出的每个状态和明暗主题；截图用 `tests/e2e/lib/evidence.ts` 的 `shot()`；`pnpm test:e2e` 只跑测试，`pnpm e2e:evidence F-NNNN` 跑测试并把截图写进需求目录的 `screenshots/`、录屏写进 `recordings/`。需要 Host 的状态，用 `page.route` 拦截 Host 请求构造，或者在 `pnpm dev` 下运行并在测试里注明。

## 命令与验证

```bash
pnpm dev:web          # 只起前端
pnpm lint
pnpm tsc -b --noEmit
pnpm build
```

涉及字幕分句、智能剪空白等纯逻辑的，跑对应 `pnpm test:sentence-grouping` / `pnpm test:smart-cut`。

## F-0005 实施（待验收）

`history.edl` 是剪辑真源，字幕 deleted 只作显示投影；播放器/导出/字幕映射读 shared/editing/edl。`pendingCuts` 和 `historyPreview` 只用于预览，不进入项目、恢复副本或导出。`editingOf` 生成正式持久快照；CutHistoryPanel 先保存再读历史，回退失败保留当前编辑，回执丢失先读回核对。

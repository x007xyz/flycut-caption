---
id: F-0002
stage: 03-design
status: approved
approved_by: auto
approved_at: 2026-11-05
---

# F-0002 项目数据保存到 Host：技术设计

## UI / UX

界面状态和文案以 PRD 的 AC-11 到 AC-27 为准（2026-11-05 从原型记录 [03-ux.md](03-ux.md) 整理进 PRD）。`src/components/Project/` 的展示组件保留，本节写它们怎么接到真实数据：

| 原型组件 | 数据来源 | 动作 |
|---|---|---|
| `ProjectsShell` + `ProjectsHome` | `projects.list` → 前端 `projectStore.projects`；`status` 由请求状态决定；搜索和网格 / 列表视图是页面本地状态，视图选择存 `localStorage`（只是界面偏好） | `onOpen` → 打开项目流程；`onFilesDropped` / `onChooseFile` / `onUseSample` → 新建项目流程；`onRetry` → 重新请求 |
| `ProjectCard` 的缩略图 | `projects.thumbnail`（按需请求，返回 data URL，前端按 `projectId + revision` 缓存） | — |
| `ProjectBreadcrumb` + `SaveStatusIndicator` | `projectStore.save`（`status`、`savedAt`） | `onBack` → 回首页（有未写入的修改时先保存，失败弹 `UnsavedChangesDialog`）；`onSaveNow` / `onRetry` → 立即保存；`onResolveConflict` → 打开冲突对话框 |
| `SaveConflictDialog` | 保存返回 `conflict` 时打开 | 覆盖 → 带 `force` 重存；另存为新项目 → `projects.duplicate`；取消 → 保持暂停 |
| `UnsavedChangesDialog` | 返回首页 / 关闭窗口 / 打开别的项目时，`save.status` 是 `failed` 或 `conflict` | 重试 / 放弃修改 / 取消 |
| `ProjectOpenErrorDialog` | `projects.open` 返回 `newer-version` | 关闭 |
| `MediaMissingBanner` | `projects.open` 返回的 `media.status === 'missing'` | 重新选择文件 → `projects.relinkMedia` |

「已保存」在保存成功后显示约 3 秒再淡出（维护者 2026-11-05 选定）；`SaveStatusIndicator` 增加 `fadeAfterMs` 参数实现，其他状态一直显示。

## 技术方案

### 涉及的子系统

- [cordis-host.md](../../subsystems/cordis-host.md)、[architecture-current.md](../../architecture-current.md)：新 Host 插件、RPC、Profile 开关。
- [frontend.md](../../subsystems/frontend.md)：新页面、store、自动保存。
- [funasr-tauri.md](../../subsystems/funasr-tauri.md)：桌面端媒体登记（ADR-0002）。

### 方案

**1. Host：`projects` 插件（`server/plugins/projects.ts`）**

- 存储格式见 [ADR-0001](../../20-architecture/adr/0001-project-storage-format.md)：`<home>/projects/<projectId>/`，`project.json` + 每个视频的 `transcript.json` / `edits.json` / `thumbnail.jpg`，媒体按 [ADR-0002](../../20-architecture/adr/0002-desktop-project-media.md)。
- 在 `server/profile.ts` 的 `BUILTINS` 登记，`provides: ['projects']`，注入 `hostConfig`、`rpc`、`assets`、`jobs`。
- 同一项目的写入用一个 Promise 链串行；写文件一律「写 `.tmp` → `rename`」。
- 封面帧：新建项目时用内置 FFmpeg 截第 3 秒（不足 3 秒取第 1 帧），缩放到 320 宽 JPEG；时长用 ffprobe。截图失败不影响建项目，卡片显示占位图。
- 资产转项目媒体：给 `AssetService` 加 `claim(id, target)`，把上传完成的资产移出 `assets/`，从此不受 24 小时清理（Web 端和「复制」方案用）。
- 版本迁移：`server/projects/migrations.ts`，`formatVersion` 当前为 1；读到更新的版本返回 `newer-version`，不写任何文件。

**2. 前端**

- **服务**：`src/services/projectService.ts` 作为前端 Cordis 插件提供 `ctx.projects`，封装下面的 RPC；组件通过 `useClientRuntime()` 获取（遵守「不写模块级单例」）。
- **store**：新增 `projectStore`（每个 Context 一份），保存当前项目、当前视频、`revision`、`save: { status, savedAt, error }`、`dirty`。
- **页面结构**：新增 `ProjectsApp`，在同一个 `ClientRuntime` 里按路由渲染 `ProjectsShell + ProjectsHome`（首页）或现有的工作台（编辑器，通过 `headerSlot` 放 `ProjectBreadcrumb`）。路由只有两种，用 URL hash（`#/projects`、`#/projects/<id>/videos/<videoId>`）实现，不引入路由库；Tauri 和 Web 一致。`App.tsx` 改为渲染 `ProjectsApp`；`FlyCutCaption` 组件保持可单独使用（不传项目相关参数时行为不变）。
- **样式进 store**：`subtitleStylePair` 现在是 `FlyCutCaption.tsx` 的组件状态，自动保存要能订阅它，移到 store（不持久化到 `localStorage`）；画幅随样式对一起保存。
- **打开项目**：`projects.open` → 拿到转写、修改、样式、媒体信息 → 写入 `historyStore`（清空撤销栈）、样式 store、`appStore.videoFile`、`stage = 'edit'`；不触发 ASR。媒体地址：桌面 `linked` 用 `convertFileSrc(path)`，`stored` 和 Web 用 Host 的媒体地址（见 3）。
- **新建项目**：沿用 `useMediaLoader` 选文件 / 拖入 / 示例视频 → Web 端上传媒体，桌面端经 Tauri 外壳登记本地文件（ADR-0002）→ `projects.create` → 进入编辑器并照常开始转写；转写完成后自动 `projects.saveTranscript`（AC-2）。
- **自动保存**（`useProjectAutosave`）：
  - 订阅 `historyStore.chunks / wordChunks`、样式 store；变化后标 `pending`，停止操作 1.5 秒后保存（`Cmd/Ctrl+S` 立即保存），满足 AC-3 的「3 秒内」。
  - 同一时间最多一个保存请求；请求期间又有修改，结束后再存一次。
  - 失败标 `failed`，按 2、4、8、16、30 秒退避重试；成功后清零。
  - 返回 `conflict` 时标 `conflict`、停止自动保存，打开冲突对话框。
  - 保存内容只有 `edits.json` 的数据（约几百 KB），不重发转写。
- **离开前**：回首页、打开别的项目时先等当前保存完成；仍失败则弹 `UnsavedChangesDialog`。桌面端用 Tauri 窗口的 `onCloseRequested` 拦截关闭；Web 端只能用 `beforeunload` 触发浏览器自带的确认框（无法显示自定义对话框，PRD AC-4 在 Web 端按此满足）。

**3. Web 端播放项目媒体**

Web 端重新打开项目时，视频要从 Host 流式播放，需要支持 HTTP Range（拖动进度条）。现在的 `/assets/<id>` 不支持 Range。做法：由 `projects` 插件在打开项目时为媒体签发一个只读的媒体地址（`/projects/<id>/media/<videoId>`，同样走 Gateway 的鉴权），并支持 `Range`。路由由插件注册，不在 `gateway.ts` 里加分支；Gateway 目前没有 HTTP 路由注册机制的话，实现时先补这个机制（只做 GET 和鉴权）。

### 接口与数据

在 `shared/protocol.ts` 的 `RpcMethods` 声明，类型放 `shared/projects.ts`（前后端共用）：

| 方法 | 输入 | 输出 |
|---|---|---|
| `projects.list` | — | `ProjectSummary[]`（与原型组件的类型一致；`transcribing` 由当前任务推出） |
| `projects.create` | `{ name, media: { assetId } \| { mediaRef } }` | `{ projectId, videoId, revision }` |
| `projects.open` | `{ projectId, videoId? }` | `{ status: 'ok', project, video, transcript?, edits?, media: { status: 'ok' \| 'missing', playback } }` 或 `{ status: 'newer-version', name }` |
| `projects.saveTranscript` | `{ projectId, videoId, transcript, model, baseRevision }` | `SaveResult` |
| `projects.saveEdits` | `{ projectId, videoId, edits, baseRevision, force? }` | `SaveResult` |
| `projects.duplicate` | `{ projectId, edits? }` | `{ projectId }`（另存为新项目：复制项目目录，`linked` 媒体只复制引用） |
| `projects.relinkMedia` | `{ projectId, videoId, media }` | `{ revision }` |
| `projects.thumbnail` | `{ projectId, videoId }` | `{ dataUrl }` |

`SaveResult = { status: 'saved', revision, updatedAt } | { status: 'conflict', revision, updatedAt }`：冲突是正常的返回值，不是异常，前端据此打开对话框。

桌面端另加（ADR-0002）：Tauri command `link_project_media(path)`（只接受本次运行里用户选择过的路径）→ Host 的外壳登记接口（只认外壳密钥，`server` Profile 下关闭）→ 返回 `mediaRef`。

数据迁移：目前没有任何已保存的项目数据，不需要迁移现有数据；`localStorage` 里的设置保持原样。

### 备选方案与取舍

| 问题 | 选定 | 备选 | 取舍 |
|---|---|---|---|
| 存储 | 目录 + 拆分 JSON（ADR-0001） | 单个 JSON；SQLite | 见 ADR-0001 |
| 桌面媒体 | 记录原文件位置，Tauri 外壳登记（ADR-0002，维护者 2026-11-05 选定） | 复制进项目 | 见 ADR-0002 |
| 自动保存粒度 | 整份 `edits.json` 覆盖写 | 只发变化的字幕条（补丁） | 几百 KB 的整份写入足够快，实现和冲突处理都简单；以后数据变大再改补丁 |
| 冲突检测 | 项目级修订号 | 每个视频单独的修订号 | 项目级最简单；F-0002 只有单视频，两者等价。E-02/6 多视频时如果误报冲突多，再细化到视频级 |
| 页面路由 | URL hash，两种路由 | react-router | 只有两三个页面，不值得加依赖；以后页面变多再换 |
| 缩略图传输 | RPC 返回 data URL（约 20 KB） | 走 HTTP 图片地址 | 不依赖新的 HTTP 路由；Web 端的媒体地址做好后可以改走 HTTP |

## 架构决策

- [ADR-0001 项目数据的存储格式与版本迁移](../../20-architecture/adr/0001-project-storage-format.md)（accepted）
- [ADR-0002 桌面端项目媒体的保存方式](../../20-architecture/adr/0002-desktop-project-media.md)（accepted）

## 风险与回退

- **写坏项目文件**：所有写入「临时文件 + 改名」，并在 Host 测试里模拟写入中断（`.tmp` 留存时打开项目不受影响）。
- **自动保存太频繁**：1.5 秒停顿合并 + 单请求在途；60 分钟视频压测一次连续编辑，记录写入次数和耗时。
- **桌面媒体登记通道的安全**：必须有三项测试——非允许列表路径被 Tauri 拒绝、前端 token 调外壳接口被拒绝、`server` Profile 下接口不存在。
- **把样式移进 store** 会影响预览和导出：现有导出、预览的回归测试要跑；手动检查样式预设切换和导出成片。
- **回退**：`App.tsx` 切回直接渲染 `FlyCutCaption` 即可回到无项目的旧行为；Host 的 `projects` 插件可以在 Profile 里 `disable`。

## 实现清单

> 2026-11-05 补充：需求流程取消了任务拆解（04-tasks），开发按这份清单推进。上面的方案（维护者 2026-11-05 确认）没有改动；技术设计阶段现在自动确认，清单由维护者在测试与验收时一并审阅。

按顺序做，每项从 Host 到界面打通、带测试，做完提交一次并勾选。第 1 项定下共用契约（`shared/projects.ts`、`RpcMethods`、ADR-0001 的存储格式），E-02/6、E-02/7、E-02/8 只能在此基础上扩展。

- [ ] 1. **新建、转写、重新打开（桌面端）**：`shared/projects.ts` 和 `RpcMethods` 声明；`projects` 插件的 `create` / `open` / `list` / `saveTranscript`（串行写、`.tmp` → `rename`、`revision`）和 `AssetService.claim`；ADR-0002 的 `link_project_media` 与外壳登记接口，含三项安全测试；前端 `projectService`、`projectStore`、`ProjectsApp` 与 hash 路由；首页接真实数据，打开项目写入 stores、不触发 ASR。（AC-1、AC-2、AC-5、AC-6、AC-11–AC-18、AC-19 的面包屑和返回）
- [ ] 2. **自动保存**：样式对和画幅移进 store；`projects.saveEdits`；`useProjectAutosave`（1.5 秒停顿、`Cmd/Ctrl+S`、单请求在途）；编辑器顶栏 `ProjectBreadcrumb` + `SaveStatusIndicator`（「已保存」3 秒后淡出）。（AC-3、AC-19–AC-21）
- [ ] 3. **保存失败与离开保护**：退避重试；回首页 / 打开别的项目前等待保存，失败弹 `UnsavedChangesDialog`；桌面 `onCloseRequested`，Web `beforeunload`。（AC-4、AC-22、AC-24）
- [ ] 4. **版本冲突**：`baseRevision` 校验与 `SaveResult.conflict`；暂停自动保存 + `SaveConflictDialog`；`force` 覆盖和 `projects.duplicate`。（AC-9、AC-23、AC-25）
- [ ] 5. **媒体丢失与格式版本**：打开时校验媒体，`MediaMissingBanner` + `projects.relinkMedia`；`server/projects/migrations.ts`，更新的版本返回 `newer-version` 并显示 `ProjectOpenErrorDialog`。（AC-7、AC-8、AC-26、AC-27）
- [ ] 6. **项目封面**：新建时 FFmpeg 截封面帧、ffprobe 取时长；`projects.thumbnail` 与前端按 `projectId + revision` 缓存；截图失败显示占位图。（AC-5、AC-14）
- [ ] 7. **Web 端**：Gateway 的插件 HTTP 路由机制（带鉴权的 GET）；`/projects/<id>/media/<videoId>` 支持 Range；Web 端新建、打开、自动保存走同一套 RPC。（AC-10）
- [ ] 8. **回归与压测**：60 分钟视频连续编辑的写入次数和耗时；预览、导出、样式预设的回归；补齐端到端测试的截图。

## 验证计划

- **每一项**：`pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`、`pnpm test`、`pnpm test:architecture`；Host 侧的新逻辑配 Host 测试（含写入中断时 `.tmp` 不影响打开）。
- **端到端测试**：`tests/e2e/features/F-0002.spec.ts`，随对应清单项一起提交。AC-11 到 AC-27 每条至少一个测试，测试名带 AC 编号；明暗主题各一遍，断言 PRD 写明的文案和可操作的控件，并用 `shot()` 截图。Host 请求用 `page.route` 构造（加载中：挂起 `projects.list`；出错：返回错误；冲突：`saveEdits` 返回 `conflict`；版本过新：`open` 返回 `newer-version`；媒体丢失：`open` 返回 `media.status: 'missing'`）；AC-24 的桌面端关闭窗口在 Tauri 下手动验证。
- **真实使用验证**（`pnpm tauri:dev`）：AC-2 用内置 sherpa-onnx 和一个 HTTP Provider 各跑一遍；AC-6 调小 `assetTtlHours` 并重启 Host；AC-7 移走原文件；AC-9 两个窗口同时打开一个项目；AC-10 用 `pnpm dev` 在浏览器里走一遍新建、编辑、重新打开。

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | 新建项目流程；`projects.create` 只收 `assetId` 或 `mediaRef`，不收路径；ADR-0002 |
| AC-2 | 转写完成后 `projects.saveTranscript`，写 `transcript.json` |
| AC-3 | `useProjectAutosave`：1.5 秒停顿保存、`Cmd/Ctrl+S`、单请求在途；`edits.json` 含文本、删除、译文、样式、画幅 |
| AC-4 | 失败退避重试；离开前等待保存，失败弹 `UnsavedChangesDialog`；桌面 `onCloseRequested`，Web `beforeunload` |
| AC-5 | `projects.list` + `ProjectsHome`；`projects.open` 写入 stores，不触发 ASR；hash 路由回首页 |
| AC-6 | 项目在 `projects/` 下不受资产清理；`claim` 把上传资产移出 `assets/`；验收时调小 `assetTtlHours` 并重启 Host |
| AC-7 | `projects.open` 校验媒体（大小、指纹），返回 `missing` → `MediaMissingBanner` → `projects.relinkMedia` |
| AC-8 | `formatVersion` 逐级迁移；更新的版本返回 `newer-version` 且不写文件 |
| AC-9 | 项目级 `revision` + `baseRevision`；`SaveResult.conflict` → 暂停自动保存 + `SaveConflictDialog`；`force` / `duplicate` |
| AC-10 | Web 端同一套 RPC；媒体走支持 Range 的项目媒体地址；`pnpm dev` 连本机 Host 验证 |
| AC-11–AC-18 | `ProjectsHome` / `ProjectCard` 接 `projectStore` 的 `status`、`projects`、`openingId`、`creating`；拖入遮罩、搜索、视图切换是页面本地状态；创建成功的提示用现有 toast |
| AC-19–AC-23 | `ProjectBreadcrumb` + `SaveStatusIndicator` 接 `projectStore.save`；「已保存」用 `fadeAfterMs` 淡出；快捷键文字按平台取 ⌘S / Ctrl+S |
| AC-24 | `UnsavedChangesDialog`；桌面 `onCloseRequested`，Web 关标签页用 `beforeunload`，应用内离开与桌面一致 |
| AC-25 | `SaveConflictDialog`：`force` 重存 / `projects.duplicate` / 取消保持暂停 |
| AC-26 | `ProjectOpenErrorDialog`，`projects.open` 返回 `newer-version` 时显示，停留在首页 |
| AC-27 | 播放器区域内的 `MediaMissingBanner` + `projects.relinkMedia`；媒体丢失时禁用导出视频 |

## 未决问题

- [x] 1. **「已保存」的显示**：维护者 2026-11-05 选择「几秒后淡出」。保存成功后显示「已保存 · 时间」约 3 秒再淡出；有未保存修改、保存中、失败、冲突时一直显示。
- [x] 2. **桌面端媒体**（ADR-0002）：维护者 2026-11-05 选择「记录原文件位置」，由 Tauri 外壳登记。
- [x] 3. **Web 端的媒体地址**：放在实现清单第 7 项，给 Gateway 补「插件注册 HTTP 路由」的机制（只做带鉴权的 GET + Range）。2026-11-05 按建议处理，维护者未提异议。

---
id: F-0019
stage: 04-test-report
status: approved
approved_by: zhangxiang.chen
approved_at: 2026-11-13
---

# F-0019 热词与专有名词识别：测试与验收

验收在代码与测试提交 `2fe3fd4`（代码测试 `94dc50a`）上进行；本报告随后作为文档提交，不改变代码与测试。

> 技术设计和开发阶段由 agent 连续推进、自动确认；维护者在这里一并审阅。

## 设计与实现摘要

在项目层建立共享术语词表实体，并在模型能力层按声明过滤与发送 ASR 识别热词：

- **共享项目术语实体**（`shared/terminology.ts`、`shared/projects.ts`）：在 `ProjectFile` 增加可选 `terminology` 与 `terminologyRevision`，词条支持 `term`、`asHotword`、可选正有限权重 `weight`（`0 < weight <= 100`）与预留给 E-04/3（`F-0032`）的 `translations` 语言译名映射。大小写不敏感去重、空白词和非法权重就地校验，保存时自动保留已有 `translations` 字段。
- **模型热词能力声明与网关校验**（`shared/providers.ts`、`server/plugins/providers.ts`、`server/plugins/asr.ts`、`server/providers/httpProvider.ts`、`server/plugins/endpoints.ts`、`docs/provider-http-protocol.md`）：`ModelInfo` 新增 `hotwords?: { supported, weights?, maxTerms?, format? }`；内置 `sherpa-onnx` 如实声明 `hotwords: { supported: false }`；FlyCut HTTP Provider 兼容自动识别 `options.hotword` 并通过 `X-Flycut-Hotwords` / `X-Flycut-Options` 透传；OpenAI 兼容服务支持将词表编入 `prompt`；`ProviderRegistry.transcribe` 拒绝向不支持热词的模型发送非空热词并自动剥离不支持模型的权重字段。
- **Host 持久化与前端集成**（`server/plugins/projects.ts`、`server/plugins/projectOps.ts`、`src/services/projectService.ts`、`src/hooks/useASR.ts`、`src/components/AgentPanel.tsx`、`src/components/Project/HotwordsDialog.tsx`、`src/components/ProcessingPanel/ASRSettingsPanel.tsx`、`src/components/Project/ProjectDetail.tsx`）：提供 `projects.getTerminology` / `projects.saveTerminology`（并发 `baseRevision` 冲突检测、`operationId` 幂等去重、重开与双客户端读取一致）；前端在识别选项区展示转写前词表或「此模型不支持热词 / This model does not support hotwords」及换模型/继续普通识别入口。
- 新增 [ADR-0015 项目级术语词表与 ASR 热词能力契约](../../20-architecture/adr/0015-project-terminology-and-asr-hotwords.md)（当前 `status: proposed`，维护者确认本报告时一并改为 `accepted`）。
- **与设计的偏差**：无重大偏差；OpenAI 兼容端点的 `models` 配置项同步补充了可选 `hotwords?: boolean` 开关。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| 与 `F-0032` 共享同一词表实体（请确认） | `ProjectTermEntry` 放在 `ProjectFile.terminology` 并预留 `translations` 字段，保存时保留既有译名 | 遵守 Epic 约定，不建第二份平行词库，避免未来迁移冲突 | AC-1 |
| 内置 `sherpa-onnx` 诚实声明不支持（请确认） | 将当前 `sherpa-onnx` 模型（SenseVoice/Paraformer/Whisper/Moonshine/FireRedASR）均标为 `hotwords: { supported: false }` | 当前 Rust sidecar 全部使用 `greedy_search`，不伪造热词生效 | AC-2、AC-3 |
| 幂等键纳入生效热词 | `useASR` 的 `taskOperationKey` 纳入实际生效的 `hotwords` 列表 | 修改项目热词后重跑识别不会误命中旧任务定位 | AC-2、AC-4 |

## 验收标准逐条结果

| AC | 目标平台 / 环境 | 验证方式、用例与命令 | 证据或未跑原因 | 结果 |
|---|---|---|---|---|
| AC-1 | Node + Host + Web Chrome | `tests/architecture/terminology-f0019.test.ts`、`tests/architecture/hotwords-f0019.test.ts`、E2E `F-0019.spec.ts` | 空白词、非法权重与大小写重复就地报错；保存后跨 Host 重启与重开一致且保留 `translations` | ✅ 通过 |
| AC-2 | Node + Host + Web Chrome | `terminology-f0019.test.ts`、`hotwords-f0019.test.ts`、`F-0019.spec.ts`（`panel-supported-active`） | 转写前展示词表数量与目标模型；仅向声明支持热词的模型发送其允许的格式，剥离不支持的权重，不按 Provider ID 硬编码 | ✅ 通过 |
| AC-3 | Node + Host + Web Chrome | `hotwords-f0019.test.ts`、`F-0019.spec.ts`（`panel-unsupported`） | 显示「此模型不支持热词 / This model does not support hotwords」，提供「更换模型」并可继续普通识别；不支持模型收到的热词请求数为 0；Red check 撤掉校验后用例立即失败 | ✅ 通过 |
| AC-4 | 本地隔离 Host + 测试 HTTP ASR | `hotwords-f0019.test.ts` 开启/关闭热词对比用例 | 同一音频在关闭热词时识别为音译误词，开启后命中 `DeepMind` 与 `FlyCut`；取消/失败保护既有转写 | ✅ 通过（测试 HTTP 服务） |
| AC-4 | 真实外部支持热词的口播服务实测 | 使用真实支持热词的远程 FunASR / OpenAI 兼容 API 对含人名与英文术语的真实长口播对比命中率与误替换率 | 本环境无真实带热词后端的远程 FunASR 服务或商用 API Key | ⏸ Not run |
| AC-5 | Web Chrome | E2E `F-0019.spec.ts`（`dialog-empty`）与 `ASRSettingsPanel` / `ProjectDetail` 入口 | 复用选项与项目详情入口；空词表显示「暂无内容 / Nothing here yet」；无项目提示指引 | ✅ 通过 |
| AC-6 | Web Chrome | E2E `F-0019.spec.ts`（`dialog-loading`）与 `ProjectService` 请求序号守卫 | 加载显示「正在加载… / Loading…」，保存显示「正在处理… / Processing…」，禁重复提交并防迟到响应串项目 | ✅ 通过 |
| AC-7 | Host + Web Chrome | `hotwords-f0019.test.ts` 跨进程重开与 `F-0019.spec.ts`（`dialog-completed`） | 仅 Host 确认持久化后提示「已完成 / Completed」，重开读取一致 | ✅ 通过 |
| AC-8 | Host + Web Chrome | `hotwords-f0019.test.ts`（`baseRevision` 冲突与 `operationId` 幂等）+ `F-0019.spec.ts`（`dialog-stale` 与错误重试） | 冲突显示「内容已更新，请重新检查 / Content changed. Review again.」；失败显示「重试 / Retry」「返回 / Back」并先查 Host | ✅ 通过 |
| AC-9 | Web Chrome（`light/dark × zh/en`） | `PW_PORT=5301 pnpm e2e:evidence F-0019` | 4/4 通过，24 张截图已入库，4 段录屏留本地 | ✅ 通过（Web） |
| AC-9 | 真实 Tauri 桌面应用端实机界面验证 | 在真实打包桌面端中进入项目选项面板管理热词并切换模型 | 本 worktree 未构建完整桌面安装包；内置 `sherpa-onnx` 与后端测试已运行 | ⏸ Not run |

## 界面证据

由 `PW_PORT=5301 pnpm e2e:evidence F-0019` 生成，覆盖 `light/dark × zh/en` 全部 4 个组合；`screenshots/` 已入库，`recordings/` 仅留本地。

| 界面 | 状态 | AC | 截图 | 录屏 |
|---|---|---|---|---|
| ASR 选项面板 | 模型不支持热词提示与换模型入口 | AC-3 | `panel-unsupported-{light,dark}-{zh,en}.png` | 本地 |
| 热词管理弹窗 | 加载中（「正在加载… / Loading…」） | AC-6 | `dialog-loading-{light,dark}-{zh,en}.png` | 本地 |
| 热词管理弹窗 | 空态（「暂无内容 / Nothing here yet」） | AC-5 | `dialog-empty-{light,dark}-{zh,en}.png` | 本地 |
| 热词管理弹窗 | 版本过期冲突（「内容已更新，请重新检查」） | AC-8 | `dialog-stale-{light,dark}-{zh,en}.png` | 本地 |
| 热词管理弹窗 | 保存完成（「已完成 / Completed」） | AC-1、AC-7 | `dialog-completed-{light,dark}-{zh,en}.png` | 本地 |
| ASR 选项面板 | 支持热词模型与转写前词表摘要 | AC-2 | `panel-supported-active-{light,dark}-{zh,en}.png` | 本地 |

## 回归检查

均在提交 `2fe3fd4` 上运行：

- `pnpm lint` ✅（0 errors）
- `pnpm tsc -b --noEmit` ✅
- `pnpm check:host` ✅
- `cargo check --manifest-path src-tauri/Cargo.toml` ✅
- `pnpm test` ✅（130 passed, 0 failed, 6 skipped — 既有未下载模型跳过项；内置 SenseVoice 与 FSMN-VAD 真实模型测试均通过）
- `pnpm test:architecture` ✅（163 passed, 0 failed, 0 skipped，含 `terminology-f0019.test.ts` 2/2 与 `hotwords-f0019.test.ts` 2/2）
- `PW_PORT=5301 pnpm e2e:evidence F-0019` ✅（4/4 passed，24 张截图）
- Red check ✅：临时绕过 `shared/providers.ts` `checkAsrRequest` 的 `!caps.supported` 检查后，`hotwords-f0019.test.ts` 立即失败于 `'complete' !== 'error'`（`hotwords-f0019.test.ts:244`），恢复后 2/2 通过。

## 发现的问题

- 暂无阻塞缺陷；并发工作树本地生成 `ADR-0015`，合入基线时如与并发特性（`F-0023`/`F-0035`）编号重叠需顺延重命名编号。

## 结论

**可以发布**（Web 与 Host 全链路自动化验收全绿，真实外部热词后端实测与桌面打包 UI 补验按 `⏸ Not run` 披露，请维护者审阅确认）。

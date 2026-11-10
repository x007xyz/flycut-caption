---
id: F-0056
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-09
---

# F-0056 AI模型配置与密钥保存到Host：设计

## UI / UX

AI 设置继续放在现有播放器下方 `api` 标签和既有设置入口，不新增顶层页面。
`AISettingsPanel` 从 Host 读取快照；列表显示名称、模型、Base URL、是否已配置 Key，永不回显
Key。新增/编辑优先复用 Dialog，加入必填校验、保存中禁用、连接测试、删除确认、错误/冲突
提示；冲突时保留表单并显示「内容已更新，请重新检查」，刷新后由用户重新编辑。

面板顶部增加迁移卡片：仅当检测到旧 `app-settings` 中带 Key 的配置时显示，列出配置名称和
数量，并明确展示当前目标 Host identity。用户点击迁移后弹出确认，确认前不发网络请求。
上传中禁止重复提交，失败保留旧浏览器副本和同一 migrationId 可重试；成功且 Host identity
匹配后才删除旧 Key。切 Host 时立即清空 AI 快照并重新加载，旧请求通过 effect 序号和 hostId
双重检查后丢弃。

根编辑器在连接 ready 后加载 `aiSettings.list`，写入 app store 的非持久化快照；字幕模型选择、
AI 设置列表和 Agent 共用该快照。空态显示现有「暂无模型 / No model」和添加入口；加载中、
保存中、测试中、保存失败、revision 冲突、迁移失败都保留当前可编辑业务数据。明暗主题和中英文
由 Playwright 覆盖。

## 技术方案

### 涉及的子系统

- `docs/subsystems/providers.md`：不改变 Provider/ModelRef；AI 文本配置不是识别 Provider。
- `docs/subsystems/cordis-host.md`、`docs/architecture-current.md`：新增 Host 插件、RPC 和
  Context 服务，前端只经连接层调用。
- `docs/subsystems/frontend.md`：设置面板、Host 快照和主题/i18n/E2E 规则。
- `docs/decisions.md`：Host 是业务数据来源；格式版本化、并发不静默覆盖；Tauri 只做外壳。

### 方案

1. `shared/aiSettings.ts` 定义版本化的公开配置视图、revision、保存/删除/选择/测试/导入及
   冲突结果。公开视图只有 `hasApiKey`，没有 Key 字段。
2. `server/plugins/aiSettings.ts` 是 `<home>/ai-settings.json` 唯一入口。文件保存 Host home、
   formatVersion、revision、selectedId、配置元数据和 migration 去重记录；用进程内 mutex 和
   temp + rename 原子提交。Host identity 来自既有 `projects.identity` 文件。
3. secret backend 接口按不可变 `secretRef` 提供 get/set/delete。桌面 `auto` 走系统凭据库；
   `server` Profile 使用 `FLYCUT_AI_SECRET_KEY` 的 AES-256-GCM 文件；memory 仅测试。缺安全
   后端时 Key 写操作失败。保存顺序为新 secretRef → 原子元数据切换引用 → 清旧引用；失败只
   删新引用，旧正式配置继续指向旧 Key。
4. `ctx.aiSettings.resolve(configId)` 只在 Host 进程返回完整运行时配置。`text.start` 和
   `agent.start` 优先按 configId 解析；旧 `model` 形状保留为兼容读取。上游失败消息不再拼接
   response body，job/progress 不含 Key。
5. 前端把 `aiModels` 改为 Host 快照投影，不再进入 Zustand persist；旧 v1 localStorage 在
   migration 中提取到单独待迁移记录并移除原 app-settings 中的 AI 字段。新 Key 只存在于表单
   内存和 Host secret backend。
6. 根编辑器按连接状态加载 Host 快照；每轮请求有递增 token，响应必须同时匹配 token 和
   snapshot.hostId，断开/切换时先清空快照。迁移 intent 固定绑定 `{hostId,migrationId}`，
   只有匹配成功响应才清本地副本。

所有保存、测试和 `resolve` 都调用与 endpoints 共用的 URL 策略。`server` Profile 的
`ai-settings.privateNetwork=false` 拒绝 loopback、私网和 link-local；桌面默认可连接本机
OpenAI 兼容服务。

### 接口与数据

- 新 RPC：`aiSettings.list/save/remove/select/test/import`。所有写/测试输入带当前 `hostId`；
  save/remove/select/import 带 `expectedRevision`。冲突返回 `{status:'conflict', snapshot}`，
  其余变更返回新 snapshot。
- `AIConfigView = { id,name,baseUrl,model,temperature?,hasApiKey }`；
  `AISettingsSnapshot = { hostId,revision,selectedId,configs }`。任何响应和错误都不含 Key。
- `aiSettings.save` 的 `apiKey` 省略或空字符串表示保留；`clearApiKey` 显式删除。新配置要求
  输入 Key，编辑时空输入不覆盖。
- `aiSettings.import` 接收用户确认后的配置列表、来源配置 ID、Host identity 与持久化
  migrationId；Host 先查 migration 记录，再按来源 ID 去重，返回相同 configIds。
- `textInputSchema`/`agentInputSchema` 增加 `configId`，并保留旧 `model` 作为兼容分支。
  OpenAI 兼容 profile 与 ModelRef 契约不变。
- 元数据格式 v1：`{formatVersion:1,hostId,revision,selectedId,configs,migrations}`；配置中的
  `secretRef` 是不可变代次引用。读到未知
  版本或损坏文件直接报错，不静默重建。secret backend 独立版本化，元数据备份可单独恢复。

<!-- RPC 方法（shared/protocol.ts）、事件、数据结构变化、兼容迁移 -->

### 备选方案与取舍

- 同文件保存 Key：简单但默认明文，被 ADR-0007 否决。
- 每次调用继续由前端传 Key：无需 Host secret backend，但不能满足跨客户端共用和 RPC 脱敏，
  且会让旧兼容路径成为新 UI 的默认，故仅保留旧请求兼容。
- 自动迁移：操作少，但无法确认目标 Host，响应丢失还可能误清本地 Key；采用显式确认 +
  Host/migrationId 绑定。
- 只做内存密钥：避免磁盘风险，但重启即丢失，不能满足 Host 持久配置；仅作为测试 backend。

## 架构决策

[ADR-0007：Host AI settings and secret storage](../../20-architecture/adr/0007-host-ai-settings-and-secrets.md)，
状态 `proposed`；由维护者验收时再决定是否 accepted。

## 自行决定的事项

- Key 编辑：空输入表示保留；显式“清除 Key”按钮映射 `clearApiKey`。避免用户编辑名称时误删 Key。
- 测试连接使用 OpenAI 兼容 `GET /models`，只返回成功/HTTP 状态，不返回上游正文。
- 旧的 `model` 请求分支保留，使 CLI/旧版客户端不会立刻断开；新前端和文档只使用 configId。
- 远程 secret 文件以 `FLYCUT_AI_SECRET_KEY` 解密；密钥轮换需要运维先保留旧环境并迁移，
  不属于本需求自动完成。

## 风险与回退

- 系统凭据库在某平台不可用时，保存 Key 明确失败，配置元数据和其他功能仍可用；不降级明文。
- 元数据提交失败会删除新 secretRef；进程在两次写入之间崩溃可能留下孤儿 secret，但旧元数据
  仍指向旧 Key，下一次成功切换或删除时可清理旧引用。
- 旧浏览器配置在成功迁移前仍需短暂保留；UI 明确来源和目标 hostId，成功后清除。
- 回退代码可恢复旧版本，但已迁移到 Host 的配置不会自动倒灌回浏览器，避免重新形成明文副本。

## 实现清单

<!--
开发阶段按这份清单推进，不再拆任务。每一项是一段能单独验证的功能（从存储到界面打通），做完提交一次并勾选。
项数不限，一般 3–8 项；按依赖顺序排列。进入「测试与验收」前必须全部勾选（脚本检查）。
一个需求做不完、需要拆成几个 PR 分别发布时，说明需求太大，回到 Epic 拆成多个需求。
-->

- [x] 1. 定义 shared 配置/revision/migration 契约，完成 Host 元数据存储、Host identity 校验、冲突和幂等导入。
- [x] 2. 接通桌面系统凭据与远程 AES secret backend，完成遮罩、保留/清除 Key、元数据失败回滚和 jobs/error 脱敏。
- [x] 3. 将文本纠错/翻译和 Agent 改为 Host 按 configId 解析，保留旧形状兼容并用本地真实 HTTP fixture 验证请求只带 configId。
- [x] 4. 重做 AI 设置面板与根快照同步，覆盖 CRUD、测试连接、加载/失败/冲突、切 Host 清缓存和迟到响应隔离。
- [x] 5. 完成浏览器旧配置的显式 Host 迁移、Host identity/migrationId 幂等重试和成功后才清理本地 Key。
- [x] 6. 补齐中英文/明暗主题 E2E、失败重试与快速回归，跑架构测试、red check 和真实本地 Host 使用证据。

## 验证计划

- 每项：`pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`；Host/协议项加
  `pnpm test:architecture`。仓库 IPC/端口测试按协调要求使用 `require_escalated`。
- 项 1-3：新增 `tests/architecture/ai-settings-f0056.test.ts`，覆盖持久化重启、两客户端读取、
  revision 冲突、迁移重试/去重、Host identity 不匹配、元数据写失败时旧 secretRef 不变、删除、
  server 私网地址拒绝、日志/jobs/RPC 无明文 Key；文本与 Agent 使用真实本机 OpenAI 兼容 HTTP fixture。
- 项 4-5：`tests/e2e/features/F-0056.spec.ts` 覆盖空态、加载、正常、失败重试、冲突、迁移
  确认/失败/成功、迟到响应不串 Host、中英文与明暗主题；截图经 `e2e:evidence F-0056` 写入
  `screenshots/`。E2E 端口用 5175，临时 Playwright 配置放 `/tmp`。
- 项 6：`pnpm test`、`pnpm test:architecture`、`pnpm build`、`pnpm build:lib`、`cargo check`；
  用真实本地 Host 保存/重启/第二客户端读取并实际触发一次兼容接口。真实外部付费 API 仅在
  本产品已有授权配置存在时运行，否则 `Not run`，不使用代理或 Codex 凭据。
- Red check：实现完成后分别临时撤掉“revision 冲突返回”或“secret 遮罩/回滚”行为，确认对应
  测试失败于该行为；恢复后全绿。截图、日志和最终 commit 记录到 04。

<!-- 每一项完成时要跑的检查（对照 docs/code-standards.md）；涉及界面的 AC 写哪些端到端测试；哪些 AC 需要真实使用验证 -->

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | Host 元数据 + secret backend；text/Agent 按 configId；公开 view 仅 hasApiKey；CLI/MCP 复用同一 RPC。 |
| AC-2 | 显式迁移卡片 + 目标 hostId 确认；migrationId/来源 ID 幂等；成功后清本地副本，失败保留重试。 |
| AC-3 | 新增/修改/删除/测试；空 Key 保留、显式清除；revision 冲突返回当前快照并要求刷新重编。 |
| AC-4 | ADR-0007；本机/远程 secret 边界；上游请求仅 Host 解析 Key；RPC/job/error/备份扫描与真实本地接口验证。 |
| AC-5 | Host 快照空态、无 Host/无模型提示、已有字幕编辑保持可用；中英文文案。 |
| AC-6 | list/save/test/import 的 loading/progress 状态，按钮禁用；连接切换 token 隔离取消旧 UI 写入。 |
| AC-7 | 成功响应使用 Host snapshot；重启和第二个连接同 Home 读取一致；只有 Host 成功才显示完成。 |
| AC-8 | 错误/冲突卡片保留表单与正式数据；冲突刷新、失败重试、partial save 先读回。 |
| AC-9 | Playwright 状态矩阵 + 截图/录屏；真实本地 Host/接口使用；外部授权配置缺失时写 Not run。 |

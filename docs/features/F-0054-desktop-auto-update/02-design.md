---
id: F-0054
stage: 02-design
status: draft
approved_by:
approved_at:
ai_review: fail
ai_reviewed_by: deepseek-v4.1-flash-reviewer
ai_reviewed_at: 2026-11-19
ai_review_note: 两轮未通过：第2轮遗留（AI 密钥真实存储、fail-closed 读取、门禁数据源、Web 标注、英文文案、安装失败恢复、HTTPS spike）已由主会话修正并经第3次核对，剩余为维护者项，见 B-01
---

# F-0054 桌面端自动更新：设计

本设计只覆盖桌面端（macOS arm64、Windows x86_64）。更新的是整个应用包：Tauri 外壳、随包 Host（`flycut-node` + `host/`）、`funasr-asr`、`ffmpeg`、字幕字体都在同一个 `bundle.resources` 里，一起替换，没有单独的 Host 或 FFmpeg 更新通道。Web 端不提供应用内更新，只显示当前版本。

## UI / UX

设置弹窗（`src/components/ProcessingPanel/SettingsDialog.tsx`，由工作台顶部栏的设置按钮打开）现有四个分区（models / tts / plugins / connection）。新增第五个分区「应用与更新」（`section: 'about'`，导航按钮 `data-testid="settings-tab-about"`，沿用 `SectionButton`），组件 `src/components/ProcessingPanel/AppUpdatePanel.tsx`。文案走 `src/locales/`（中英两份）。

分区内容：

- 当前版本：读 `src/index.ts` 导出的 `version`（由 `package.json` 注入，发版闸门保证与 `tauri.conf.json`、`Cargo.toml` 一致）。
- 检查更新按钮：仅在桌面端渲染。Web 端只显示版本和「网页版由部署方更新 / The web version is updated by whoever deploys it.」，不渲染检查按钮，也不显示任何更新结果。

界面状态（状态机见「方案」，文案以 01-spec.md 的 AC 为准）：

| 状态 | 显示 | 对应 AC |
|---|---|---|
| `idle` | 版本号 + 「检查更新 / Check for updates」 | AC-1 |
| `checking` | 「正在加载… / Loading…」，按钮禁用，不能重复提交 | AC-6 |
| `up-to-date` | 「已是最新版本 / You are up to date」 | AC-1 |
| `available` | 新版本号、版本说明（`update.body`）、体积（清单扩展字段 `size`，见「接口与数据」）、「安装前请保存；安装完成后会重启应用 / Save your work first. The app will restart after installing.」，按钮「下载并安装 / Download and install」。不自动下载、不自动重启 | AC-1、AC-2 |
| `downloading` | 「正在处理… / Processing…」+ 百分比（插件进度事件）+「取消 / Cancel」 | AC-2、AC-6 |
| `ready-to-install` | 门禁通过；按钮「安装并重启 / Install and restart」 | AC-3 |
| `blocked` | 列出阻塞项：进行中的 Host 任务 / Running Host tasks（导出 / Export、识别 / Transcription、配音 / Dubbing 等）、未上传完成的上传会话 / Unfinished uploads、未写入 Host 的编辑 / Unsaved edits（恢复副本与 Host 内容不一致）、正在保存的请求 / Saves in progress、备份导出或导入 / Backup export or import。按钮「等待完成 / Wait」「保存后继续 / Save and continue」「放弃并安装 / Discard and install」「返回 / Back」。默认焦点在「返回」；「放弃并安装」需二次确认，并说明会中断正在进行的任务 | AC-3 |
| `host-unavailable` | 门禁数据源不可读（Host 未连接、`jobs.list` 失败、本地读取抛错）：「无法确认是否有进行中的任务，安装已禁用 / Cannot confirm running tasks. Install is disabled.」，按钮「重新连接 / Reconnect」（进入既有连接设置 `ConnectionDetails`）与「重试 / Retry」。该状态 fail-closed，不提供「放弃并安装」 | AC-3、AC-5 |
| `installing` | 「正在安装… / Installing…」，安装过程不可取消，文案明确说明 | AC-6 |
| `completed` | 「已完成 / Completed」，仅在重启后读到的版本号等于目标版本时显示 | AC-7 |
| `error` | 具体原因：网络失败 / Network error；签名不合法 / Invalid signature；安装失败 / Installation failed；磁盘空间不足 / Not enough disk space；本构建未配置更新源 / Updates are not configured for this build+「重试 / Retry」「返回 / Back」。签名不合法时只提供「重新检查 / Recheck」，不提供安装 | AC-2、AC-8 |
| `expired` | 「内容已更新，请重新检查 / Content changed. Review again.」，必须重新检查并重新展示版本说明后才能提交 | AC-8 |
| `interrupted` | 应用启动时若本机记录的「待完成更新目标版本」高于当前版本：「上次更新未完成，当前仍是 X.Y.Z / The last update did not finish. Still on X.Y.Z.」+「重新检查 / Check again」「关闭 / Dismiss」。仅当当前版本等于目标版本时清除记录并显示 `completed` | AC-8 |

AC-5 的入口与前置不足处理：

- 入口复用：更新入口只放在既有设置弹窗中，不新增工作台按钮，不改变项目、字幕、模型的任何入口。
- 前置不足说明：检查更新本身不依赖项目、模型或资源；需要的前置是网络和 Host。Host 不可用时门禁进入 `host-unavailable` 并给出「重新连接」入口；网络不可用时进入 `error` 并给出「重试」。两者都不显示「已是最新版本」。
- 「暂无内容 / Nothing here yet」不适用：更新没有列表记录（**请确认**：这一条收窄了 AC-5 的字面要求，理由是本需求只有单个更新对象；建议答案是接受不适用）。
- 编辑保持可用：检查、下载在后台 store 中进行，关闭设置弹窗后编辑器可用。安装会重启应用，因此安装前由门禁保证无未保存编辑。设置弹窗本身是模态的，与既有分区一致，不额外设计非模态面板。

Store：新增 `src/stores/updateStore.ts`，沿用 `src/stores/appStore.ts` 的写法，组件用 `useUpdateStore(selector)` 读取。store 只保存当前请求编号、状态、更新元数据与进度；「待完成更新目标版本」只保存在 `localStorage`（键 `flycut.update.pending`），这是每个浏览器的提示用途，读写都包在 try/catch 中；它不是可靠状态，真正判断依据是当前版本号与目标版本号的比较。

## 技术方案

### 涉及的子系统

- [FunASR / Tauri](../../subsystems/funasr-tauri.md)：`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/src/lib.rs`、`src-tauri/src/host.rs`、`src-tauri/capabilities/default.json`。Rust 侧允许的新增责任只有三项：注册 `tauri-plugin-updater` 与 `tauri-plugin-process`，以及一个生命周期命令 `update_stop_host`（调用 `host::stop_host()`）。不新增执行业务的 command。实现清单第 1、2 项随改动同步更新该子系统文档。
- [Cordis / Host](../../subsystems/cordis-host.md)：只读使用既有 `jobs.list`（`shared/protocol.ts` 的 `RpcMethods`）。不新增 RPC，不改 Host 插件。
- [前端](../../subsystems/frontend.md)：设置弹窗分区、`src/stores/`、`src/locales/`、新增 `src/update/` 目录（状态机与门禁纯逻辑）、`src/services/desktopUpdate.ts` 适配器、端到端测试与截图证据。实现清单第 2 项随改动同步更新该文档的目录与规则。
- [代码与验收标准](../../code-standards.md) 第 6 条与 [自动化验收方案](../../30-engineering/acceptance-testing.md)：`scripts/release.mjs`、`scripts/release-signing.mjs`、`.github/workflows/release.yml`。`src-tauri/tauri.conf.json` 与 `src-tauri/capabilities/**` 属于安全相关改动，按 code-standards 不自动合并，需维护者放行。
- 依赖 [F-0057](../F-0057-desktop-signing-notarization/02-design.md) 的签名、公证与装订（`scripts/signing/macos.mjs`、`macos-notarize.mjs`、`windows.mjs`，以及 `.github/workflows/release.yml` 的 build 矩阵）和 [ADR-0014](../../20-architecture/adr/0014-desktop-signing-notarization.md)。
- 已拍板决定：[decisions.md](../../decisions.md) 中「Tauri 只做桌面外壳」「RPC 不接收任意本地路径」「FFmpeg 随安装包内置」。

### 方案

**1. 官方 updater 插件 + 静态清单。**

- Rust：`Cargo.toml` 增加 `tauri-plugin-updater = "2"`、`tauri-plugin-process = "2"`；`lib.rs` 的 `Builder` 注册两者。
- JS：`package.json` 增加 `@tauri-apps/plugin-updater`、`@tauri-apps/plugin-process`。
- `tauri.conf.json` 增加 `plugins.updater`：`pubkey`（公钥，可入库）、`endpoints`（HTTPS，只列一个稳定通道地址，建议 `https://github.com/<owner>/<repo>/releases/latest/download/latest.json`，owner/repo 见「请确认」）。
- `capabilities/default.json` 增加 `updater:default` 与 `process:allow-restart`，其余不放宽。
- 不设置 `bundle.createUpdaterArtifacts`。原因：macOS 构建是 `tauri build --no-sign`，之后由 F-0057 签名、公证、装订。若 Tauri 在 `--no-sign` 阶段生成更新归档，归档会早于代码签名，签名失效。更新归档与 `.sig` 由发版流程在装订之后生成（见第 5 条）。

**2. 前端只通过适配器接触 Tauri 插件。**

- `src/services/desktopUpdate.ts`：端口 `UpdateClient`，方法 `check()`、`download(onEvent)`、`install()`、`relaunch()`、`currentVersion()`、`stopHostForInstall()`。实现里才 `import()` 插件与 `@tauri-apps/api/core`。没有 `__TAURI_INTERNALS__` 时适配器不可用，设置页按 Web 分支渲染（判断方式与 `src/utils/nativeDialogs.ts` 一致）。
- `src/update/updateMachine.ts`：纯 TypeScript 状态机，只依赖 `UpdateClient` 端口与门禁函数。负责：请求编号（每次 check、download、install 递增，迟到的旧响应丢弃）；下载前重新 `check()` 并比较 `version` 与该平台的 `signature` 字符串，不一致进入 `expired`；错误分类；`interrupted` 判断。
- `src/update/installGate.ts`：纯函数，输入为各数据源的读取结果（见第 4 条），输出 `ok` / `blocked`（带阻塞项列表）/ `unavailable`（数据源读取失败）。

**3. 下载与取消（AC-2、AC-6）。**

- 用插件 `download(onEvent)` 的事件（`Started` 的 `contentLength`，`Progress` 的 `chunkLength`）驱动进度。插件在完整下载并验签后才允许安装，中途失败或包损坏时旧版不变。
- 取消：插件能否中止 `download()` 未核实（实现清单第 1 项的 spike 第一件事）。能中止则直接中止；不能中止则采用备选 B（见「备选方案与取舍」），并单独确认。两种方式下取消都回到 `available`，当前版本不变。

**4. 安装门禁（AC-3）。**

门禁读取的真实数据源（逐项列出，全部在前端或 Host 中可查到）：

- Host 任务：`jobs.list`（`shared/protocol.ts`），`status` 为 `queued` 或 `running` 的任务。导出、识别、配音、剪辑分析等通过 `ctx.jobs` 创建，都会出现在这里。
- 上传会话：客户端 `localStorage` 中以 `flycut.upload.sessions.<hostId>` 为键的记录（`src/upload/locator.ts`）。`UploadLocator` 没有状态字段，因此**定义「活动」为：本地存在定位记录**（上传完成或放弃时定位会被删除）。Host 侧的会话在 `<home>/uploads/<id>/session.json`（`server/plugins/uploads.ts`），目前没有列出会话的 RPC；localStorage 被清空或会话由其他客户端创建时，客户端看不到。v1 处理：这类会话只可能来自其他客户端或已丢失的本地状态，门禁不覆盖，列为已知风险（「风险与回退」），并在「请确认」第 8 条（不新增 Host 排空接口）一并请维护者确认；若不接受，需新增只读 `uploads.list`（共用契约改动）。
- 任务定位：`src/services/taskOperation.ts` 的 `TaskOperationStore`，键 `flycut.task.operations.<hostId>`，覆盖全部 `TaskOperationKind`：`asr`、`export`、`backup-export`、`backup-import`。定位仍存在的算进行中。
- 未写入 Host 的编辑：`src/recovery/` 中 IndexedDB 库 `flycut-recovery` 的副本。对每个有副本的项目，用 `projects.open`（入参 `{projectId, videoId}`，与 `projectService.ts` 的恢复流程相同，只读 store、不打开编辑器）读取 Host 当前内容，按 `src/recovery/copy.ts` 的 `diffWithHost` 比较，不一致即阻塞；恢复副本按 `hostId|projectId|videoId` 存储，逐个副本按该三元组读取。`projects.open` 返回 `trashed` 或 `newer-version` 时视为无法确认，门禁结果为 `unavailable`。projectStore 中保存请求未返回的也阻塞。

**读取方式：** `UploadLocatorStore.read()` 与 `TaskOperationStore.read()` 现在用 try/catch 吞掉异常并返回 `[]`，直接复用会把读取失败当成「没有任务」。门禁改用不吞异常的原始读取（新增 `readStrict()`，`JSON.parse` 或 `localStorage` 抛错时向上抛出），现有 `read()` 行为不变。

**fail-closed 规则：** 任一数据源读取失败（`jobs.list` 报错或超时、Host 未连接、`localStorage` 或 IndexedDB 读取抛错）时，门禁结果为 `unavailable`，进入 `host-unavailable`，不允许安装。门禁没有「读不到就当作没有任务」的分支。

门禁通过后的安装顺序：

1. 再次读取全部数据源（防止门禁与安装之间有新任务），仍为空才继续。
2. 调用 `update_stop_host`（实现为 `host::stop_host()`，复用它已有的 `host.shutdown` 优雅关闭与超时结束逻辑）。只在门禁通过后调用。Windows 下必须先停 Host，否则安装程序无法覆盖被占用的 `host/` 与 `binaries/`。
3. 写入「待完成更新目标版本」到 localStorage，然后调用插件 `install()`。签名在安装前由插件校验，失败不会进入安装。
   `install()` 失败（签名、磁盘、安装程序错误）时：Host 已停，界面立即显示 `error`（安装失败），并调用既有 `ensure_host` 重新拉起旧版 Host；拉起期间显示「正在恢复… / Restoring…」，成功后回到 `available`。重新拉起也失败时显示「请重新打开应用 / Please reopen the app」。残留风险：安装程序若已部分替换 `host/` 或 `binaries/`，`ensure_host` 拉起的可能是不完整的 Host；拉起后用 `host.info` 的版本与包内版本比较，不一致时直接提示重新安装，不继续使用。安装失败后的「重试」先重新读取当前应用版本（`currentVersion()`）与待完成标记：若版本已等于目标版本（安装其实已生效），进入 `completed` 路径，不再次安装；否则重新走门禁与安装（AC-8，不盲目重复副作用）。
4. 安装成功后调用 `relaunch()`。relaunch 失败时显示「更新已安装，请手动重新打开应用 / Update installed. Please reopen the app.」，「已完成」只在重启后版本号确认后显示。

「放弃并安装」只在本次操作内、经二次确认后允许，不写入持久设置。

**5. 发版侧产物、密钥注入与清单（`.github/workflows/release.yml`）。**

- 现状：`build` 矩阵按平台执行 `tauri build --bundles app --no-sign`，再由 `scripts/release-signing.mjs macos|windows` 签名、公证、装订（macOS 另生成 dmg），并上传签名产物。
- 改动一：`build` 矩阵在 macOS 上，于 F-0057 装订之后生成 `FlyCut Caption.app.tar.gz`（`tar -czf`，保留符号链接），只在 `mode == release` 时上传为 artifact。build 矩阵不接触 updater 私钥。
- 改动二：新增作业 `updater-sign`：`needs: [preflight, build]`，条件 `startsWith(github.ref, 'refs/tags/v') && needs.preflight.outputs.mode == 'release'`，`environment: release`。它下载 macOS 归档与 Windows `-setup.exe`，用 `scripts/signing/updater.mjs` 生成 `.sig`（Tauri CLI `signer sign`，私钥经环境变量注入，变量名待核实，不进命令行参数），生成 `latest.json`（字段见「接口与数据」），并运行 `scripts/release-signing.mjs updater-manifest` 校验：每个 `.sig` 能用 `pubkey` 验证，`version` 等于 `package.json`，`url` 指向本次 Release 资产。
- 改动三：`release` 作业 `needs` 增加 `updater-sign`，上传 `*.app.tar.gz`、`*.sig`、`latest.json`；`verify-release-artifacts` 增加对这些文件的检查。
- 私钥注入位置：只在 `updater-sign` 作业的环境变量中出现，且该作业 `environment: release`。`candidate-signed`、`candidate-unsigned`（`workflow_dispatch`）模式下作业条件为假，既不运行，也拿不到私钥。候选构建不生成 `latest.json`，不会被 `releases/latest` 指向。
- **GitHub Environment `release` 目前不存在，必须由维护者创建**：在仓库 Settings → Environments 新建 `release`，设置 required reviewers，部署分支与标签规则限制为 `v*`，并把 `TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 放进该环境（不放仓库级 secrets）。Apple 与 Windows 签名 secrets 不迁移。本设计不创建 Environment，仓库设置变更属于维护者操作。
- `scripts/release.mjs` 的 `validateReleasePipelineConfig` 增加检查：`tauri.conf.json` 存在 `plugins.updater.pubkey` 与 `endpoints`，`release.yml` 含 `updater-sign` 作业与 `updater-manifest` 步骤。

**6. 随包 Host、模型与 FFmpeg 的一致性。**

- 所有随包资源在同一个 `.app` 或安装目录里，更新替换整包，Host、`flycut-node`、`funasr-asr`、`ffmpeg`、字体与前端 bundle 同版本。旧 Host 在安装前已停止（第 4 条第 2 步），新应用启动时 `ensure_host` 从新包启动新 Host。
- Host 数据位置（`src-tauri/src/host.rs` 与 `server/main.ts`）：Host home 为 `<app_data>/host`（`FLYCUT_HOST_HOME`），内含 `projects/`、`host-id.json`、`ai-settings.json`、上传会话（`ai-secrets.enc` 只在 encrypted-file 后端或设置了 `FLYCUT_AI_SECRET_KEY` 时存在）。桌面端默认的 AI 密钥不在 Host home：`server/plugins/aiSettings.ts` 的 `auto` 后端落到 `OsAISecretStore`（`server/aiSettings/secrets.ts`），macOS 存钥匙串（service `com.flycut.caption.ai-settings`），Windows 存 `%LOCALAPPDATA%\FlyCut\ai-settings\<ref>.dpapi`；Host 的 `appData` 为 `<app_data>`（`FLYCUT_APP_DATA`），内含 `models/<modelId>/`（下载的模型与校验记录）与 `host/assets`。更新只替换应用包，不触碰 `<app_data>`（AC-4 实测确认）。

**7. 与 F-0058 的关系。** AC-4、AC-9 的桌面打包冒烟依赖 F-0058 的 `pnpm acceptance:bundle` 入口（见「自行决定的事项」中的 depends_on 请确认）。

### 接口与数据

- **Host RPC：无变化。** 不新增方法，不改 `shared/protocol.ts`。门禁只读取既有 `jobs.list`。
- **Tauri 命令：新增 1 个。** `update_stop_host`（无参数，返回 `Result<(), String>`），在 `lib.rs` 的 `generate_handler!` 中登记。它只调用 `host::stop_host()`。
- **事件：无新增。** 进度来自插件回调。
- **清单 `latest.json`**（Tauri 静态格式 + 扩展字段 `size`）：

```json
{
  "version": "2.1.0",
  "notes": "版本说明",
  "pub_date": "2026-12-01T00:00:00Z",
  "platforms": {
    "darwin-aarch64": { "signature": "<.sig 内容>", "url": "<Release 资产>", "size": 123456789 },
    "windows-x86_64": { "signature": "<.sig 内容>", "url": "<Release 资产>", "size": 98765432 }
  }
}
```

  `size` 是扩展字段，插件是否忽略未知字段必须在实现清单第 1 项 spike 中实测，结论冻结前不生成正式清单。若插件不忽略，备选是在 `available` 前对 `url` 发 HEAD 请求读取 `Content-Length`（多一次网络请求，且 Web 不适用）。
- **本机存储：** 只新增 localStorage 键 `flycut.update.pending`（目标版本字符串），用于 `interrupted` 提示；不保存清单内容、签名或凭据。
- **数据格式：无变化。** 不改项目格式、不做迁移。
- **兼容：** 2.0.2 及更早版本没有 updater 插件，无法应用内升级到本需求版本，需要一次手动安装（见「请确认」）。

### 备选方案与取舍

| 方案 | 优点 | 缺点 | 取舍 |
|---|---|---|---|
| A. Tauri 官方 updater 插件 + GitHub Release 静态 `latest.json`（采用） | 官方签名校验、进度事件、安装流程；跨平台一致；清单由发版流程生成 | 取消下载与 `size` 字段需要 spike 核实；需要单独的 minisign 密钥 | 采用；未核实项是第一步，结论前不冻结契约 |
| B. 取消用的备选：Rust 侧 `reqwest` 流式下载，支持取消令牌，验签沿用插件同一公钥与算法，安装仍调插件 `install()` | 取消语义可控 | 验签逻辑要与插件对齐，安全面变大，需要安全复核 | 仅在 A 不能中止时启用，并单独请维护者确认 |
| C. 由 Host 检查、下载、安装更新 | 更新逻辑集中在 Host | 远程 Host（Cloud 托管或用户自部署）更新的是服务器而非用户机器上的客户端；Host 要替换自己的文件；违背「Tauri 只做外壳」与远程部署边界 | 不采用 |
| D. 第三方框架（Sparkle、WinSparkle） | 各平台成熟 | 两套清单与签名，与 Tauri 打包脱节 | 不采用 |
| E. 只提供下载页，手动安装 | 实现最少 | 不满足 AC-2、AC-3、AC-4 | 不采用 |

## 架构决策

本设计不新增 ADR。以下两条是否需要长期记录，留给维护者决定（见「自行决定的事项」）：

- 更新签名密钥与 Apple、Windows 代码签名是两套独立密钥，分别保管、分别轮换。
- 更新只替换应用包，数据目录不随更新变动，因此数据格式的前向兼容要求写进发版规则。

若维护者确认，再用 `pnpm feature adr` 另起 ADR，本文件只放链接。

## 自行决定的事项

- **更新只走稳定通道，不做灰度、不做后台静默安装或自动重启。** 与需求说明一致。
- **门禁的数据源与 fail-closed 规则如「方案」第 4 条。** 数据源读取失败即禁止安装。影响 AC-3、AC-5。
- **AC-5「暂无内容」不适用，编辑保持可用按非模态后台检查理解，设置弹窗本身模态。** 收窄了 AC-5 字面要求。**请确认**：建议答案是接受。
- **AC-8「上次更新未完成」** 以 localStorage 的目标版本记录加版本比较判断，只是提示用途。**请确认**：建议答案是接受 localStorage 作为提示用途，判断依据始终是版本号比较。
- **安装前不做自动数据备份。** 确认对话框提示「建议先导出项目备份」，链接既有的项目备份导出。影响 AC-3、AC-8。
- **「放弃并安装」只在本次操作内有效，默认焦点在「返回」。** 影响 AC-3。
- **同一时间只允许一个更新请求。** 请求编号机制保证迟到响应被丢弃。影响 AC-6。
- **过期依据是 `version` 与该平台 `signature` 字符串。** 影响 AC-8。
- **请求只访问清单与 Release 资产固定地址，不携带用户标识；日志不记录私钥、token 或清单以外的内容。** 影响 AC-2。
- **安装过程不可取消。** 插件 `install()` 能否中止未核实，界面明确写出。影响 AC-6。
- **AC-7「第二个连接同 Host 的客户端读取结果一致」按下面解释。** 更新结果是本机应用包的版本，不写入 Host。验证改为「重启后版本号等于目标版本，且安装前后 Host 数据哈希一致（见验证计划 AC-4）」。若要求第二客户端也能看到版本，需要给 `HostInfo` 增加只读 `appVersion`，属于共用契约改动。影响 AC-7。
- **Windows 更新格式使用 NSIS `-setup.exe`，`installMode` 取 passive。** 这是设计建议，**请确认**：建议答案是 NSIS 与 passive，msi 不作为更新格式。影响 AC-1、AC-4。
- **更新私钥与测试密钥分开。** 真实签名的 AC-4 测试包使用一把专用测试 updater 密钥（公钥只写进测试构建），生产私钥不在本地使用。**请确认**：建议答案是接受。影响 AC-4、AC-6。
- **不新增 Host 排空接口。** 门禁用客户端检查加安装前复查完成；CLI / MCP 若连接同一桌面 Host 并在安装窗口内创建任务，会有竞态，记为已知风险。**请确认**：建议答案是 v1 不做排空。影响 AC-3。

以下事项需要维护者决定，每条给出建议答案，未确认前按建议答案实现：

1. **「请确认」更新清单托管地址**：使用 GitHub Release 的 `releases/latest/download/latest.json`，并告知仓库 owner 与名称。建议答案：是，只用稳定通道，候选构建不发布 Release。
2. **「请确认」更新签名密钥**：独立生成 Tauri updater 密钥（与 Apple、Windows 签名分开），私钥存于 GitHub Environment `release` 并设 required reviewers，维护者保留离线备份。建议答案：是。
3. **「请确认」旧版过渡**：2.0.2 及更早版本没有 updater，需要接受一次手动安装过渡，并写入版本说明。建议答案：是。
4. **「请确认」Windows 更新格式**：NSIS `-setup.exe`，`installMode: "passive"`（配置位置为 `tauri.conf.json` 的 `plugins.updater.windows.installMode`，实现第 1 项 spike 时以插件文档核实），不用 msi。建议答案：是。
5. **「请确认」取消下载的实现方式**：若 spike 发现插件不能中止 `download()`，是否接受备选 B。建议答案：先按插件实现，spike 结论不满足时再单独确认备选 B。
6. **「请确认」更新前自动备份**：v1 不做，只提示并链接既有备份导出。建议答案：是。
7. **「请确认」AC-7 第二客户端条款**：按「自行决定的事项」解释，不新增 `HostInfo.appVersion`。建议答案：是。
8. **「请确认」Host 排空接口与 Host 侧上传会话**：v1 不做排空接口，竞态作为已知风险；客户端看不到的 Host 侧上传会话（其他客户端创建或本地记录已清空）同样作为已知风险，不新增只读 `uploads.list`。建议答案：是。若不接受，新增只读 `uploads.list`（共用契约改动，约 +1 天）。
9. **「请确认」真实凭据时机**：AC-4、AC-6 的真实验证依赖 F-0057 的真实签名与公证凭据（当前 `⏸ Not run`）。建议答案：凭据就绪后再做实现清单第 7 项的真实验证，在此之前记为 `⏸ Not run`。
10. **「请确认」F-0058 是否加入 depends_on**：AC-4、AC-9 的桌面打包冒烟依赖 F-0058 的 `pnpm acceptance:bundle`，当前 `depends_on` 只有 F-0057。建议答案：是，把 F-0058 加入依赖（由维护者修改需求编号与依赖，本设计不改 frontmatter）。
11. **「请确认」GitHub Environment `release` 的创建**：由维护者在仓库设置中创建并放入更新私钥（见「方案」第 5 条）。建议答案：是。

## 风险与回退

- **门禁看不到的 Host 上传会话。** 由其他客户端创建、或本地 localStorage 已清空的上传会话只存在于 Host 的 `<home>/uploads/<id>/session.json`，客户端门禁读不到。停 Host 会中断它们；F-0015 的断点续传可在新版本中恢复。是否接受、或新增只读 `uploads.list`，见「请确认」第 8 条。

**签名密钥保管（最高风险）。**

- 私钥丢失：已安装用户无法通过应用内更新拿到新版本，只能手动重装。泄露：攻击者可签名恶意更新并被已安装应用接受。
- 措施：私钥只在 GitHub Environment `release` 中，required reviewers，只在 `updater-sign` 作业注入，且该作业只在 `v*` 标签的 `mode == release` 下运行；维护者另在密码管理器保留离线备份；私钥与口令都不入库、不进日志，`scripts/signing/common.mjs` 的 `redactSecrets` 增加对 minisign 私钥特征的识别。
- 仓库检查：新增 `tests/update-config.test.mjs`，断言 tracked 文件中不存在 minisign 私钥头（`untrusted comment: minisign encrypted secret key`），并断言 `pubkey` 存在。
- 轮换：公钥写在已安装应用里，换公钥不能靠更新下发。轮换需要一个由旧私钥签名的过渡版本，并附带手动重装说明，写进运维手册（实现清单第 7 项）。

**失败的更新不破坏旧版。**

- 网络中断、损坏包、签名不合法：插件在安装前完成完整下载与验签，失败即停，旧版不动。验证见验证计划 AC-2 的脚本化负向用例。
- 安装中途失败（磁盘满、文件占用）：可能留下不完整安装。措施：停 Host 后再安装；失败后下次启动比较当前版本与 `flycut.update.pending`，进入 `interrupted`，允许重新检查，不盲目重试安装（AC-8）。残留风险：macOS 在替换应用包的极端中断情况下只能靠重装 DMG 恢复，需写进运维手册。
- 数据目录不被更新触碰，安装失败不影响项目与模型；验证见 AC-4 的数据对比。

**新版本有问题。**

- 更新器只安装更高版本，不自动降级。回退是发布修复版本（前滚），或用户从旧版 DMG / 安装包手动安装。
- 发版前必须通过 `pnpm acceptance:bundle` 打包冒烟。本需求不做灰度。

**数据格式前向兼容。** 新版本若升级项目格式（参考 ADR-0001、ADR-0003 与既有迁移），旧版无法读取。这类发版须在版本说明中写明，并在确认对话框提示备份。

**竞态与 CLI / MCP。** 安装门禁与安装之间，CLI 或 MCP 若连着同一个桌面 Host 创建新任务，可能被中断。v1 只做客户端复查，不做 Host 排空。

**回退。** 功能可整体关闭：移除设置分区入口与 `update_stop_host` 注册；`tauri.conf.json` 的 `plugins.updater` 与 `capabilities` 改动可单独还原。无数据迁移。

## 实现清单

每项是一段可单独验证的纵向切片，按依赖顺序排列。第 1 项包含插件 spike，spike 结论出来之前不冻结 `latest.json` 与 `.sig` 契约。

- [ ] 1. 插件 spike 与发版契约：在 debug 构建中实测 (a) `tauri-plugin-updater` 忽略 `latest.json` 的 `size` 字段；(b) `download()` 能否中止；(c) `tauri signer sign` 的私钥环境变量名；(d) 测试构建能否连本地 `http://localhost` 端点——Tauri updater 默认要求 HTTPS，需核实是否只能通过仅测试构建启用的不安全传输开关（如 `dangerousInsecureTransportProtocol`）连接，或改用本地自签 HTTPS。正式配置不得启用该开关，`release.mjs` 增加检查。结论写入 `03-implementation.md`，再冻结契约。然后生成 updater 密钥对，公钥写入 `tauri.conf.json`；新增 `scripts/signing/updater.mjs`；`release.yml` 增加 `updater-sign` 作业与 macOS 归档 artifact；`release-signing.mjs` 增加 `updater-manifest`；`release.mjs` 增加配置检查；同一项内同步 `docs/subsystems/funasr-tauri.md` 的发版与签名部分。验证：`pnpm test`（`tests/update-config.test.mjs`、`tests/update-manifest.test.mjs`）、`node scripts/release.mjs --dry-run`，以及在一份真实测试包上运行 `updater.mjs`，产出的 `latest.json` 能被 `pubkey` 验证。
- [ ] 2. 设置页「应用与更新」最小可见切片：`lib.rs` 与 `Cargo.toml` 注册插件，`capabilities/default.json` 增加最小权限，同一项内同步 `docs/subsystems/funasr-tauri.md`（Rust 侧允许的 updater、process 插件与 `update_stop_host`）与 `docs/subsystems/frontend.md`（`src/update/`、`updateStore`、Web 分支规则），`src/services/desktopUpdate.ts`，`AppUpdatePanel.tsx`，中英文文案，SettingsDialog 新分区，版本显示与「检查更新」调用真实 `check()`。用户可见的检查：`pnpm tauri:dev` 指向测试端点（`src-tauri/tauri.update-test.conf.json`），设置页显示「已是最新版本」或新版本信息，截图存入 `screenshots/`。补充检查：`cargo check --manifest-path src-tauri/Cargo.toml`、`pnpm tsc -b --noEmit`。
- [ ] 3. 更新状态机：`src/update/updateMachine.ts`、`src/stores/updateStore.ts`，覆盖请求编号、迟到丢弃、过期检测、错误分类、`interrupted` 判断。验证：`pnpm test`，并做 Red check（撤掉请求编号判断后迟到响应用例失败）。
- [ ] 4. 安装门禁：`src/update/installGate.ts`，读取 `jobs.list`、上传会话 localStorage、`TaskOperationRunner` 定位、恢复副本与保存状态，实现 fail-closed 的 `unavailable`。验证：`pnpm test`（门禁纯函数，逐个数据源注入失败用例）；`pnpm check:host`、`pnpm lint`。
- [ ] 5. 下载、安装、重启与完成态：进度与取消、门禁后调用 `update_stop_host`、`install()`、`relaunch()`、`completed` 与 `interrupted`。真实验证在 macOS 测试构建中完成，见验证计划 AC-2、AC-3。
- [ ] 6. 界面全状态与证据：覆盖「方案」中表格的全部状态，中英文 × 明暗主题，`tests/e2e/features/F-0054.spec.ts`，`pnpm e2e:evidence F-0054`。
- [ ] 7. 真实升级验证、运维与文档：`scripts/update-verify/` 与 `tests/acceptance/app-update.ts`（见验证计划），运维手册 `docs/40-ops/runbooks/desktop-auto-update.md`，复核子系统文档与实现一致。依赖 F-0057 真实凭据，缺失时记为 `⏸ Not run`。

### 规模估算与结论

- 代码与测试：第 1 项约 2 天（含 spike 与 CI 作业），第 2 项约 1.5 天，第 3 项约 1 天，第 4 项约 1.5 天，第 5 项约 2 天（含 macOS 真机调试），第 6 项约 2 天，第 7 项约 1.5 天（脚本与文档），合计约 11 天。
- 不计入的外部阻塞：F-0057 真实签名与公证凭据、GitHub Environment 创建、Windows 环境。
- 结论：开发量在两周以内，可以作为一个需求交付，但余量很小。若 spike 发现插件不能中止下载、需要采用备选 B，则增加约 3–4 天，合计超过两周。此时建议拆分：F-0054a 为发版契约与设置页检查（第 1、2 项），F-0054b 为门禁、下载安装与界面状态（第 3–7 项）。拆分需回到 Epic E-08 由维护者确认。

## 验证计划

所有项完成后必须通过：`pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`、`cargo check --manifest-path src-tauri/Cargo.toml`、`pnpm test`、`pnpm test:architecture`。桌面专属行为必须在真实 Tauri 构建中验证，不用 Web 结果代替。

**测试构建与密钥。** 测试构建使用 `src-tauri/tauri.update-test.conf.json`（仿照 `tauri.acceptance.conf.json`，只覆盖 `plugins.updater.endpoints` 与 `pubkey`），指向测试端点。测试端点为 GitHub 预发布资产（若可用），否则为本地发布服务 `scripts/update-verify/serve-release.mjs`。本地服务只做故障注入的载体，提供的仍是真实签名的产物，不替代插件行为。测试版本用两个预发布版本号（如 `2.1.0-f0054.1` 与 `2.1.0-f0054.2`），通过 `scripts/update-verify/set-version.mjs` 在独立 git worktree 中改三处版本号。签名使用测试密钥（见「自行决定的事项」）。

**`scripts/update-verify/serve-release.mjs`（新增）**：参数 `--dir <release-dir> --port <p> [--cut-after <bytes>] [--tamper-sig] [--tamper-artifact]`，按真实文件提供 `latest.json` 与资产，记录每个请求到日志（方法、路径、时间）。`--cut-after` 在发送指定字节后断开连接；两个 tamper 参数分别翻转 `.sig` 中一个字符或产物中一个字节。

**`tests/acceptance/app-update.ts`（新增）**：通过 `pnpm acceptance:update` 运行，参数 `--case <name> --old <old.app> --new <new.app> [--out <dir>]`，使用 WebDriver 驱动（复用 `acceptance-webdriver` 构建，见 `docs/30-engineering/acceptance-testing.md`）。它输出 `screenshots/update-verification-<platform>.json`，结构为：`{ platform, oldVersion, newVersion, commit, artifactSha256, endpoint, cases: [{ name, result, before, after, log }] }`。`before`/`after` 为下述数据对比结果。

**数据对比（AC-4、AC-7、AC-8）。** 脚本 `scripts/update-verify/tree-digest.mjs`（新增）对以下位置计算摘要，升级前后比较：

- Host home `<app_data>/host/`：`projects/` 整棵树（相对路径、大小、sha256），`host-id.json`、`ai-settings.json`（sha256），`ai-secrets.enc` 存在时一并比较。
- AI 密钥（桌面默认后端）：macOS 从 `ai-settings.json` 取每个模型的密钥 ref，逐个用 `security find-generic-password -s com.flycut.caption.ai-settings -a com.flycut.caption.ai-settings:<ref>` 只检查条目存在（不加 `-w`，不读出密钥值）；Windows 比较 `%LOCALAPPDATA%\FlyCut\ai-settings\*.dpapi` 的文件名与 sha256。
- `<app_data>/models/`：整棵树的文件清单（相对路径、大小、sha256 对小于 1 MB 的文件）与各模型的校验记录；大文件只比较大小与记录中的 sha256。
- 额外用 Host RPC `providers.list` 读取模型就绪状态，升级前后应相同。

**AC-2 真实网络失败（`--case network-cut`）**：先用 `serve-release.mjs --cut-after 1048576` 启动服务，断开发生在下载中途，断言：下载报错、界面显示「网络失败 / 重试」、当前版本与数据摘要不变。第二个用例 `--case endpoint-down`：停止服务后再点检查，断言 `error` 且不显示「已是最新版本」。第三个用例 `--case tamper-sig` / `--tamper-artifact`：断言「签名不合法」、无安装按钮、版本不变。

**AC-2 取消与进度（`--case cancel-download`）**：下载中途点击取消，断言回到 `available`，版本不变，服务日志中该请求已结束。

**AC-3 真实门禁（`--case gate-export`，macOS）**：启动一个真实导出（固定素材，`export.start`），在导出运行中触发安装，断言：界面显示 `blocked` 且列出「导出」；`update_stop_host` 未被调用（日志）；Host 进程号不变。点「放弃并安装」前取消，断言版本不变。另一个用例 `--case gate-unavailable` 停止 Host 后触发检查安装，断言 `host-unavailable`、安装按钮不可用。导出完成后用 `ffprobe` 检查输出时长与音轨，并抽检字幕像素。

**AC-4 真实升级（`--case upgrade`，macOS arm64，Windows 同脚本若环境可用）**：步骤为：用旧测试版创建固定项目与设置（AI 设置、一个已下载或已校验的模型）；记录数据摘要；发布新版本到测试端点；在旧版触发检查、下载、安装、重启；断言版本号为新版、`providers.list` 与数据摘要一致、`host.info` 返回成功、随包 `ffmpeg` 与 `funasr-asr` 可执行。负向用例见 AC-2。

**AC-6 真实请求次数（`--case check-request`，macOS）**：在 1 秒内连续点击两次「检查更新」，断言服务日志中只有一次 `latest.json` GET，且界面仅一次 `checking`。

**AC-1、AC-5、AC-8、AC-9 的 UI 状态（Web）**：Playwright 在 Web 中运行，桌面分支通过注入 Tauri IPC 响应（`window.__TAURI_INTERNALS__.invoke` 的 addInitScript 替身，覆盖 `plugin:updater|check` 等命令的返回）触发，前端代码路径不变。该注入只用于 UI 状态覆盖，不代表插件行为，插件行为由上面的桌面真实用例验证。Web 分支的断言是「不渲染检查按钮，只显示版本」，在未注入的 Web 页面中验证。

| AC | 目标平台 | 自动化命令 | 断言 | 真实环境 / 缺口 |
|---|---|---|---|---|
| AC-1 | 桌面（真实 check，`--case check-request` 同环境）；桌面分支 UI（Web e2e 注入 IPC，非真实桌面：UI 状态与 Web 分支） | `pnpm test`（`updateMachine`）；`pnpm test:e2e tests/e2e/features/F-0054.spec.ts`（注入 IPC 覆盖 `up-to-date`、`available`；未注入页面断言无检查按钮） | 设置页显示版本；`up-to-date` 显示「已是最新版本 / You are up to date」；`available` 显示版本号、说明、体积与安装提示；检查过程中没有 `install` 或 `relaunch` 调用 | 真实端点需要第 1 项产物；未配置则 `⏸ Not run` |
| AC-2 | 桌面 macOS 真实包（`--case network-cut`、`endpoint-down`、`tamper-sig`、`tamper-artifact`、`cancel-download`）；桌面分支 UI（Web e2e 注入 IPC，非真实桌面：UI） | `pnpm acceptance:update --case <name> --old <old.app> --new <new.app>`；`pnpm test`（签名失败映射为 `error` 且不调用 `install`）；`node --test tests/update-config.test.mjs`（私钥不入库） | 下载显示进度；取消回到 `available` 且版本不变；网络失败显示「重试」；签名不合法无安装按钮；版本与数据摘要不变 | 真实端点与测试密钥；生产签名产物需要 F-0057 凭据 |
| AC-3 | 桌面 macOS 真实应用（`--case gate-export`、`gate-unavailable`）；桌面分支 UI（Web e2e 注入 Tauri IPC 与 `jobs.list` 结果，非真实桌面）：`blocked`、`host-unavailable` | 同上；`pnpm test`（`installGate` 纯函数，逐数据源注入失败）；`pnpm test:e2e tests/e2e/features/F-0054.spec.ts`（`blocked` 默认焦点在「返回」） | 有运行中任务时不调用 `update_stop_host`；「放弃并安装」需二次确认；Host 不可用时无安装按钮；导出完成后视频有效；取消后版本不变 | Windows 门禁行为待 Windows 环境 `⏸ Not run` |
| AC-4 | 桌面 macOS arm64 真实包（必须）；Windows x86_64（环境可用时同脚本） | `pnpm acceptance:update --case upgrade --old <old.app> --new <new.app>` 产出 `screenshots/update-verification-<platform>.json`；数据对比由 `scripts/update-verify/tree-digest.mjs` 完成 | 旧版升级到新版；升级前后 `projects/`、`host-id.json`、`ai-settings.json`、`models/` 摘要一致，AI 密钥条目（钥匙串 / DPAPI 文件）一致，且升级后 `aiSettings.list` 中每个模型的 `hasApiKey` 与升级前一致；`providers.list` 模型就绪状态一致；新版 `host.info` 成功；随包 `ffmpeg`、`funasr-asr` 可执行；负向用例后旧版可启动且摘要不变 | 需要 F-0057 真实签名与公证凭据、真实端点；缺失则 `⏸ Not run` 并列阻塞项，不以 mock 代替通过结论 |
| AC-5 | 桌面分支 UI（注入 IPC，非真实桌面：`host-unavailable`、无网络 `error`）；Web 真实可见：版本号、无检查按钮；桌面（Host 未就绪） | `pnpm test:e2e tests/e2e/features/F-0054.spec.ts`（注入 IPC 错误） | 无网络时显示网络错误与「重试」，不显示「已是最新版本」；Host 不可用时显示「重新连接」；Web 不渲染检查按钮；编辑器在检查进行中可输入（设置弹窗关闭后）；「暂无内容」不适用，见「自行决定的事项」 | 无 |
| AC-6 | 桌面 macOS 真实请求（`--case check-request`）；桌面分支 UI（Web e2e 注入 IPC，非真实桌面：`checking` UI） | `pnpm acceptance:update --case check-request ...`；`pnpm test`（请求编号、迟到丢弃）；`pnpm test:e2e tests/e2e/features/F-0054.spec.ts` | 检查中按钮禁用且只发一次请求；下载可取消；安装中无取消按钮且文案说明；快速两次检查时旧响应不覆盖新结果 | 无额外缺口 |
| AC-7 | 桌面 macOS 真实升级（`--case upgrade`）；桌面分支 UI（Web e2e 注入 IPC，非真实桌面：`completed` UI） | `pnpm acceptance:update --case upgrade ...`；`pnpm test:e2e tests/e2e/features/F-0054.spec.ts`（完成提示只在版本号匹配时出现） | 重启后版本号等于目标版本才显示「已完成 / Completed」；安装前后数据摘要一致；第二客户端条款按「自行决定的事项」解释 | 同 AC-4 |
| AC-8 | 桌面 macOS 真实失败（`network-cut`、`tamper-sig`，之后的重启）；桌面分支 UI（Web e2e 注入 IPC，非真实桌面：`error`、`expired`、`interrupted` UI） | `pnpm acceptance:update --case interrupted --old <old.app> --new <new.app>`（安装中途强制结束，之后重启断言 `interrupted`）；`pnpm test`（过期检测、错误分类、`interrupted` 判断）；`pnpm test:e2e tests/e2e/features/F-0054.spec.ts` | 网络、签名、安装失败各有具体原因与「重试 / 返回」；过期显示「内容已更新，请重新检查 / Content changed. Review again.」且不能直接安装；`interrupted` 显示「上次更新未完成」；失败前后用户输入与数据摘要不变 | 真实中断需要 macOS 测试包；缺环境记为 `⏸ Not run` |
| AC-9 | 桌面分支 UI（Web e2e 注入 IPC，非真实桌面，全部状态，中英文 × 明暗）；Web 真实可见：版本号、无检查按钮；桌面打包冒烟 | `pnpm e2e:evidence F-0054`；`pnpm test:e2e`（既有设置相关用例回归）；`pnpm acceptance:bundle <已打包的 FlyCut Caption.app>`（依赖 F-0058） | 每个状态有截图与录屏，保存到 `docs/features/F-0054-desktop-auto-update/screenshots/`；打包冒烟在新包上启动 Host 并导出一段字幕视频 | `acceptance:bundle` 依赖 F-0058，见「请确认」第 10 条；缺环境记为 `⏸ Not run` |

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | 「UI / UX」设置分区与 `idle`、`up-to-date`、`available`；`src/services/desktopUpdate.ts`、`src/update/updateMachine.ts`；清单 `version`、`notes`、`size`；不自动安装或重启 |
| AC-2 | 「方案」第 3 条（插件进度、验签失败不安装、取消回到 `available`）；「方案」第 5 条（`.sig` 与 `pubkey`）；「风险与回退」签名密钥保管；「验证计划」的 `--case network-cut` 等脚本化用例 |
| AC-3 | 「方案」第 4 条（门禁数据源、fail-closed、安装顺序）；`blocked` 与 `host-unavailable` 状态；「验证计划」`--case gate-export`、`gate-unavailable` |
| AC-4 | 「方案」第 1、5、6 条（插件、产物与清单、Host 与模型同包一致与数据位置）；「接口与数据」兼容说明；「验证计划」`--case upgrade` 与数据对比 |
| AC-5 | 「UI / UX」入口复用、前置不足说明、`host-unavailable` 与无网络 `error`、不适用项的收窄说明；「验证计划」AC-5 行 |
| AC-6 | 「UI / UX」`checking`、`downloading`、`installing`；「方案」第 2、3 条（请求编号、迟到丢弃、安装不可取消）；「验证计划」`--case check-request` |
| AC-7 | 「UI / UX」`completed` 仅在版本号匹配时显示；「方案」第 4 条步骤 4；「自行决定的事项」第二客户端条款；`--case upgrade` 的数据对比 |
| AC-8 | 「UI / UX」`error`、`expired`、`interrupted`；「方案」第 2 条过期检测；「风险与回退」安装中途失败；「验证计划」`--case interrupted` |
| AC-9 | 「UI / UX」端到端覆盖约定；「验证计划」截图与录屏、打包冒烟；实现清单第 6 项；「请确认」第 10 条 |

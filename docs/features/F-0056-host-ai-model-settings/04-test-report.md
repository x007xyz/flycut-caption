---
id: F-0056
stage: 04-test-report
status: review
approved_by:
approved_at:
---

# F-0056 AI模型配置与密钥保存到Host：测试与验收

原验收基线为 commit `83059bd`；Tauri Host Node 打包修复在 `a853ecd`，完整 Tauri 窗口与
桌面包字体修复在 `2ed0755`。

> 技术设计和开发阶段由 agent 连续推进、自动确认；维护者在这里一并审阅。

## 设计与实现摘要

AI 配置元数据保存在 Host home 的版本化 JSON，API Key 由独立 secret backend 保存；RPC 只暴露
`hasApiKey`，文本纠错、翻译和 Agent 都按 `configId` 由 Host 解析 Key。桌面使用 macOS Keychain，
远程 Profile 使用 `FLYCUT_AI_SECRET_KEY` 加密文件；测试用 memory backend 只用于隔离场景。

浏览器旧配置在用户确认目标 Host 后按 `hostId + migrationId` 导入，失败保留本地副本并用同一请求
ID 重试，成功后才清理。所有面板写操作和根快照加载都绑定请求 generation；列表响应还核对
`hostId`，同地址 identity 变化时旧配置不会串入新 Host。编辑时可留空保留 Key，或显式清除。

架构决定见 [ADR-0007](../../20-architecture/adr/0007-host-ai-settings-and-secrets.md)，当前仍为
`proposed`，应在维护者确认本报告时一并决定是否转为 `accepted`。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| 清除 Key | 编辑表单增加显式清除按钮；空输入仍表示保留 | 避免只改名称时误删 Key，同时让用户能主动撤销已存 Key | AC-3、AC-4 |
| 迟到响应 | 所有操作绑定 request generation；列表还核对 response `hostId` | 切 Host 或 identity 变化时旧响应不能改写当前 store | AC-6、AC-7、AC-8 |
| 证据配置 | `e2e-evidence` 支持 `FLYCUT_E2E_CONFIG`，并改用 Playwright 1.64 的 JSON 输出变量 | 让验收固定走 localhost:5175，并实际产出录屏摘要 | AC-9 |
| 本机测试资源 | 全量架构测试从原仓库只读软链媒体、FFmpeg、FunASR 和 VAD 资源 | 目标 worktree 只有被 git 忽略的占位文件；未改写源文件 | 验证环境 |

## 验收标准逐条结果

| AC | 验证方式 | 证据 | 结果 |
|---|---|---|---|
| AC-1 | 架构测试、第二个 HTTP 客户端、真实本地 OpenAI 兼容 fixture | `F-0056/AC-1 AC-3 AC-7 AC-8 config IDs...`：第二客户端读到同一 revision，并用同一 `configId` 完成纠错；RPC/job 中不含明文 Key | ✅ |
| AC-2 | Playwright、失败重试 | `F-0056/AC-2 AC-6 AC-8 explicit Host-bound migration...`：失败后本地 Key 仍在，第二次请求复用同一 `migrationId`，成功后才清本地副本 | ✅ |
| AC-3 | Playwright、Red check | CRUD、测试连接、空 Key 保留、显式清除、遮罩和 revision 冲突覆盖 4 个主题/语言组合；撤掉冲突保护后测试以 `saved !== conflict` 失败 | ✅ |
| AC-4 | 架构测试、真实 macOS Keychain、DeepSeek 官方 API、本地严格回归 | 加密文件 0600/原子写/串行；元数据失败保留旧 ref；`OsAISecretStore` 唯一临时引用写入、读回、删除成功；DeepSeek 官方 API 真实翻译/纠错成功，RPC、元数据和任务结果不含明文 Key | ✅ |
| AC-5 | Playwright | 空配置显示添加入口，已有编辑界面可用；中英文与明暗主题全覆盖 | ✅ |
| AC-6 | Playwright | 加载显示处理中，刷新/添加/编辑/删除在忙碌期间禁用；错误 Host 响应和 identity 切换不写回旧数据 | ✅ |
| AC-7 | Playwright、Host 重启、第二个客户端 | 只有 Host 返回新 snapshot 才显示完成；重启与第二客户端读回同一 Host 配置 | ✅ |
| AC-8 | Playwright、架构 Red check | 迁移失败保留来源；revision 冲突保留表单并提示重新检查；错误 Host 响应保留当前列表 | ✅ |
| AC-9 | 40 张截图、8 段录屏、真实 Host/DeepSeek 官方 API、真实 Tauri | localhost:5175 UI 8/8；真实本地 Host 和 macOS 凭据后端通过；DeepSeek 官方 `deepseek-flash` 连接、翻译、纠错通过。完整 Tauri 窗口已完成原生导入、转写、字幕编辑/删除/撤销、AI 配置 CRUD、Keychain、重启读回、保存重开、导出和原生关闭，见下方实机记录 | ✅ |

## 界面证据

| 界面 | 状态 | AC | 截图 | 录屏 |
|---|---|---|---|---|
| AI 设置 | 空态、已保存、清除 Key、冲突已重编 | AC-3、AC-5、AC-8 | `screenshots/settings-{empty,saved,key-cleared,conflict-resolved}-{light,dark}-{zh,en}.png` | 2 段/主题语言组合 |
| AI 设置 | 加载、错误 Host 响应、identity 切换 | AC-6、AC-8 | `screenshots/settings-{loading,host-mismatch,host-switched}-{light,dark}-{zh,en}.png` | 同组录屏 |
| 旧配置迁移 | 核对、失败保留、成功清理 | AC-2、AC-6、AC-8 | `screenshots/migration-{review,failed,complete}-{light,dark}-{zh,en}.png` | 同组录屏 |
| 真实 Tauri 桌面 | 导入、转写、AI 配置、翻译/纠错、保存重开、导出 | AC-1、AC-3、AC-4、AC-7、AC-9 | `screenshots/tauri-*.{jpg,png}` | 无 |

`docs/features/F-0056-host-ai-model-settings/screenshots/` 共 40 张 PNG；
`recordings/summary.json` 记录 commit `83059bd`、8 passed / 0 failed；8 段 WebM 仅保存在本地，已被 git 忽略。

## 回归检查

- `pnpm lint` ✅
- `pnpm tsc -b --noEmit` ✅
- `pnpm check:host` ✅
- `pnpm test`：103 项，100 passed、3 skipped；跳过项是未下载的可选 ASR 模型 moonshine、nemo_transducer、whisper，不计为通过
- `pnpm test:architecture`：97/97 ✅（只读复用本机媒体、FFmpeg、FunASR 和 VAD 资源）
- `pnpm exec playwright test tests/e2e/features/F-0056.spec.ts --config /private/tmp/f0056-playwright.config.ts`：8/8 ✅，localhost:5175
- `pnpm build` ✅；`pnpm build:lib` ✅；`pnpm package:host` ✅；`cargo check --manifest-path src-tauri/Cargo.toml` ✅
- Red check 1：撤掉 save 的 revision 检查，专项测试失败于 `saved !== conflict`
- Red check 2：让公开 snapshot 拼接 secret，专项测试失败于 `true !== false`（RPC 明文 Key 检查）
- 恢复后：F-0056 架构专项 5/5 ✅

## 发现的问题

- 无产品代码失败。首次全量架构测试缺媒体/二进制/VAD 资源，按授权从原仓库只读复用后 96/96 通过。
- `cargo check` 首次因 `src-tauri/host/**/*` 未生成而失败；运行 `pnpm package:host` 后通过。
- 未发现明文 Key 出现在 RPC、job、普通元数据或加密文件的可读内容中。

## 完整 Tauri 补测准备（2026-11-10）

按协调要求，F-0017 正在占用前台完成 Tauri 五次基准；本需求没有并行启动 Tauri 窗口，也没有把
构建中断前的阶段计入通过。补测以 `a9b3ba2`（本报告更新前 HEAD）的代码为准。

本地前置检查：

- `127.0.0.1:5179` 为当前 worktree 的 Vite 服务，`/__flycut/connection` 返回 HTTP 200。
- `127.0.0.1:5191` 为当前 worktree 的 Host；无凭据访问根路由返回预期的 HTTP 401，发现文件与
  RPC 使用 Host 生成的 token，报告和日志不记录 token。
- 原桌面 WebKit 数据的三个 origin 中，旧 `app-settings.aiModels` 均为空；Tauri 应用数据中也没有
  旧 AI 配置元数据，因此首次进入应验证真实空态，而不伪造迁移卡片。
- `pnpm tauri:dev` 已完成 `package:host`（31 个 Host 依赖及当前平台 Node）、
  `build:funasr-sidecar` release 构建和 FFmpeg/shared assets 前置检查；开发 Vite 已启动，Cargo
  在窗口启动前按前台协调中止。此项只记为 `⏸ Not run`，不是构建通过。
- 已准备仅监听 `127.0.0.1:5207` 的 OpenAI 兼容 fixture，使用独立本地测试 Key；fixture 位于
  `/private/tmp/f0056-ai-fixture.mjs`，不进入仓库，也不读取 Codex/OpenCode 或其他产品凭据。

前台释放后的完整桌面步骤：

1. 重新运行 `pnpm tauri:dev` 并确认构建完成、桌面窗口实际打开。
2. 记录 AI 设置的真实空态与当前 Host identity；确认页面、已有项目入口和字幕编辑仍可用。
3. 通过窗口新增本地 fixture 配置，保存后确认列表只显示“已配置 Key”，RPC 和页面均不回显 Key。
4. 点击测试连接，确认本地 fixture 的 `/v1/models` 返回 200；随后只检查 macOS Keychain 条目
   的元信息，不读取或输出密钥。
5. 关闭并重新打开 Tauri，确认同一配置、模型和遮罩状态仍由 Host 读取；再删除测试配置并确认
   列表恢复空态。
6. 截图写入本需求 `screenshots/`，命令、窗口结果和失败项追加到本报告；外部真实 AI API 仍按
   `⏸ Not run` 记录，除非另有明确授权的产品配置。

### 执行结果（2026-11-10）

- F-0017 清理前台后，从无监听端口的状态重新运行 `pnpm tauri:dev`。Host 打包（31 个依赖及
  当前平台 Node）、FunASR sidecar release 构建、FFmpeg/shared assets 检查和 Vite 启动均通过；
  Cargo 415/415 在 18.38 秒完成，进程进入 `Running target/debug/flycut-caption`。
- 桌面 Host 启动失败：本次 dyld 进程 `22507`、`22508` 先后报告
  `target/debug/binaries/flycut-node` 加载
  `@rpath/libnode.147.dylib` 失败，dyld 报 `Library not loaded`；已尝试的 bundle 相对路径
  `target/debug/binaries/libnode.147.dylib` 与 `target/debug/binaries/../lib/libnode.147.dylib`
  均不存在。Host 因此无法启动，AI 设置无法从真实桌面 Host 读取、保存、测试或重启复验。
- UI 自动化随后遇到 `ScreenCaptureKit` 错误 `SCStreamErrorDomain Code=-3811`
  （`Failed to start stream due to audio/video capture failure`）。按 bundle id 选择窗口时，
  系统同时存在 debug 与旧安装包两个 `com.flycut.caption` 进程；无法证明绑定的是本次新启动的
  debug 窗口。期间只打开并关闭了设置面板，没有保存、删除或修改任何配置，也不将该窗口计入通过。
- 按“运行时因打包 Node/libnode 或自动驱动阻塞时保留错误并标注 Not run”的约束，没有继续修改
  dyld 搜索路径、替换 Node/打包资源或绕过自动驱动。完整 Tauri 桌面流程仍为 `⏸ Not run`。
- 复测结束后已停止本轮启动的 Tauri 与 Vite，5173、5179、5191、5207 均无监听；未触碰其他
  worktree 或旧安装包进程。

### Host Node 打包修复与真实窗口启动（2026-11-10 续测）

修复提交：`a853ecd`。

- `scripts/package-host.mjs` 支持显式 `FLYCUT_NODE_BINARY`；未设置时仍使用当前
  `process.execPath`，保持现有 CI 的默认行为。
- macOS 打包前用 `otool -L` 校验 Node 依赖。依赖 `@rpath`、`@loader_path`、Homebrew 路径，
  或绝对路径文件缺失时，在替换 Host 资源前明确失败并列出原因；官方自包含 Node 仅依赖系统库时
  通过。
- 安装 `flycut-node` 前先移除目标路径再复制，避免旧目标为软链时把二进制写穿到其他 checkout。

失败路径与 Red check：

- 默认 Homebrew Node 26（`/opt/homebrew/bin/node`）被拒绝，错误明确列出
  `@rpath/libnode.147.dylib` 和 21 个 `/opt/homebrew/opt/**` dylib。
- 临时禁用 macOS 依赖检查后，`tests/package-host-node.test.mjs` 的
  “refuses a macOS Node binary...” 用例失败于 `Missing expected exception`；恢复后 5/5 通过。
- 另一个用例验证旧目标为软链时只替换软链本身，软链原目标内容保持不变。

成功路径：

- 使用
  `FLYCUT_NODE_BINARY=/Users/zhangxiangchen/.nvm/versions/node/v24.6.0/bin/node pnpm package:host`
  完成最终打包，输出 `Packaged 31 Host dependencies and Node v24.6.0`。
- 打包出的 `src-tauri/binaries/flycut-node` 是 116,945,120 字节的普通文件，SHA-256 与 nvm Node
  完全一致；`otool -L` 只剩 CoreFoundation、Security、libc++ 和 libSystem 系统库。
- 执行前，旧软链指向的原 checkout 文件 SHA-256 为
  `08dad0581f00a0cabf4d49ec92ca1f25fdfd01c2c18fa8e92b35f04d4c24c164`；修复打包后未变化。

真实 Tauri：

- 清除本 worktree 的 `target/debug/binaries/flycut-node` 和 `target/debug/host` 后，Tauri
  重新复制资源；debug 资源中的 Node 哈希与 nvm Node 一致，依赖校验通过。
- 首次使用原 HOME 启动时，Tauri 窗口和新的 Host 进程都进入运行，但同一 bundle id 的旧安装版
  已占用真实应用数据目录，Host 以 `A Host already owns this home directory` 退出。这是环境中的
  多实例冲突，不是 Node/dyld 问题；旧安装版进程未被终止，原数据未被修改。
- 使用隔离 HOME `/private/tmp/f0056-tauri-home-20261110` 启动后，CUA 识别应用为
  `FlyCut Caption` / `com.flycut.caption`，debug 可执行文件为
  `src-tauri/target/debug/flycut-caption`。窗口 PID `66908`、Host PID `66984` 均保持运行。
- Host 监听 `http://127.0.0.1:65440`；shell token 只经环境变量传入，连接发现使用的
  `connection.json` 和 `auth.token` 保存在隔离 HOME 的
  `Library/Application Support/com.flycut.caption/host/`，权限均为 `0600`。本报告和命令输出
  未记录 token 值。
- 旧安装版与 debug 版拥有相同 bundle id。CUA 操作时需按 debug 可执行路径/窗口确认，不能只按
  bundle id 选择。

补充回归：

- `pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`、`cargo check`、`pnpm build` ✅
- `pnpm test`：103 项，100 passed、3 skipped（未下载的 moonshine、nemo_transducer、whisper 可选模型）✅
- `pnpm test:architecture`：97/97 ✅。目标 worktree 缺少被 git 忽略的 `tests/media` 时首轮有 3 项
  文件缺失；只读链接现有测试媒体后串行复跑全绿。并行高负载时另有 1 项 WebSocket ready 断言失败，
  同一资源齐全后串行复跑通过，未改产品代码。
- 窗口内的文件导入、AI 配置读取/测试、清除 Key、失败状态和完整编辑/导出流程现已在真实 Tauri
  窗口中完成；本报告仍不自行 approve。

### 完整 Tauri 窗口与视频导出（2026-11-10 最终验收）

本轮使用 `pnpm exec tauri build --debug --bundles app` 生成独立 debug `.app`，通过完整路径绑定窗口，
避免了同 bundle id 的旧安装版。运行环境为隔离 HOME `/private/tmp/f0056-tauri-final`，Host ID
`b5da5cba-9ca8-4d17-920f-4a334fb0539d`；真实 Keychain 通过只读软链使用，未记录 token 或 Key。

- 原生文件选择器成功导入 `/private/tmp/f0056-tauri-input.mp4`；SenseVoice Small INT8 完成
  201.153 秒转写，共 101 句，时间轴与字幕列表可操作。
- 窗口内完成 DeepSeek 配置读取、HTTP 200 连接测试、改名时留空 Key 保留、显式清除 Key、
  不可达 endpoint 失败状态和恢复官方地址/名称。关闭重开后 Host 读回同一配置与 Key 状态。
- 完成真实字幕编辑：首句改为「测试字幕已修改」，删除第二句后撤销，内容自动保存；关闭重开后
  首句修改仍在。窗口内 DeepSeek 翻译写回「Test subtitle updated.」和
  「What are pre-made dishes?」；纠错预览成功生成 40 条建议，检查后取消，未写回正式字幕。
- 原生保存对话框导出 MP4：3:21.17、H.264 902 kb/s + AAC 130 kb/s；抽取 0.5 秒画面确认底部
  烧录「测试字幕已修改」。另删除一句后导出无字幕版本，时长 3:19.96，说明 cut 已生效，随后撤销。
- 通过 File → Close Window 关闭应用，进程和 Host 均退出；重新打开后项目与修改可读回。测试中的
  重复 AI 配置已清理，只保留一条带 Key 的 DeepSeek Official 配置。
- 截图：`screenshots/tauri-deepseek-test-http-200.jpg`、`tauri-deepseek-rename-key-retained.jpg`、
  `tauri-deepseek-failure.jpg`、`tauri-deepseek-cleaned.jpg`、`tauri-deepseek-translation.jpg`、
  `tauri-deepseek-correction.jpg`、`tauri-export-hard-subtitle.png`。

本轮还修复了一个真实桌面包资源错位：Tauri 将 `models.json` 放在 `Resources/_up_`，将字体放在
`Resources/shared_assets`，Host 以 `_up_` 为资源根时找不到 Skia 字体，导致硬字幕导出失败。
`server/subtitle-render.ts` 现在同时查找资源根本身、其父目录和开发目录；新增
`tests/architecture/subtitle-resource-root.test.ts`。撤掉父目录候选后测试失败于 `actual undefined`，
恢复后通过；重建 `.app` 后真实硬字幕导出成功。

### DeepSeek 官方 API 实测（2026-11-10）

- 按维护者指示从本机 DSH 配置读取 `DEEPSEEK_API_KEY`；只读入临时 Host 内存，未输出、未写入报告，也未复制到项目文件或长期 Host 配置。
- `GET https://api.deepseek.com/models` 返回 HTTP 200，模型列表包含 `deepseek-flash` 和 `deepseek-v4-pro`。
- 用 `deepseek-flash` 保存临时 memory secret backend 配置，`aiSettings.test` 返回 `连接成功 (HTTP 200)`；公开配置只有 `hasApiKey:true`，元数据文件不包含 Key。
- 真实字幕翻译返回 `Hey everyone, welcome to this episode.` / `Today we're starting from scratch.`；真实中文纠错把「这个功能可以使用把」修正为「这个功能可以使用吧。」，两个任务均 `complete`。
- 临时 Host 与临时 home 在测试后清理。此项补上此前的“真实付费外部 AI 接口 Not run”；随后完整 Tauri 窗口也已通过。

## 结论

本地实现、Host 架构、UI 矩阵、macOS 凭据后端、真实 Tauri 完整客户端流程和真实 DeepSeek 官方
AI 均已通过。此前阻断桌面启动的 Homebrew Node / `libnode` 问题已在 `a853ecd` 修复；本轮还修复
了桌面包字体资源根错位，并用真实硬字幕导出验证。请维护者审阅这些证据并决定是否批准；本报告
不自行批准。

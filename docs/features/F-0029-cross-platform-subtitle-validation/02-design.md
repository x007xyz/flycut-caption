---
id: F-0029
stage: 02-design
status: draft
approved_by:
approved_at:
ai_review: fail
ai_reviewed_by: deepseek-v4.1-flash-reviewer
ai_reviewed_at: 2026-11-19
ai_review_note: 两轮未通过：第2轮遗留（Cargo target 表、debug 测试构建、F-0058 依赖、批次冲突、AC-5 状态锚点）已由主会话修正并经第3次核对，剩余 AC 语义与拆分问题交维护者，见 B-01
---

# F-0029 Windows与Cloud字幕渲染补测：设计

## UI / UX

无界面改动。本需求不新增页面、组件、文案、stores 或 RPC。

- 播放器、字体载入提示、空字幕沿用 F-0028 的预览组件。导出的运行中、完成、失败**不在导出对话框里显示**：`ExportDialog.tsx` 的 `handleVideoExport`（第 153–158 行）调用 `onExportVideo` 后立即关闭对话框，`HostExportEngine.ts` 只调用 `export.start`；这三个状态由 `src/hooks/useVideoExport.ts` 驱动：运行中与完成显示在 `src/components/Timeline/TimelineWaveform.tsx`（由 `videoProgress`、`isVideoProcessing` 驱动的进度条，文案回退为「导出进度」）以及消息中心的处理条目（`messages.fileUpload.processingFile`「正在处理文件...」）；Host 侧导出失败（例如字体缺失）在 `processVideo` 内抛出，走 `errorVideoProcessing` 写入消息中心，而 `setError(messages.export.exportFailed)` 只覆盖 `processVideo` 开始前的错误。AC-5 的截图对象：运行中、完成截 `TimelineWaveform` 进度条与消息中心条目；失败截消息中心的错误条目。`ExportDialog.tsx` 第 551 行的「取消」只关闭对话框，不取消运行中的导出任务。
- AC-5 要求复测「现有界面状态」。按代码核对，现有界面中**没有**导出「排队」状态，也**没有**导出「取消」控件（`HostExportEngine.ts` 未使用 `jobs.cancel`；Host 的 `server/` 中也没有导出并发上限）。因此本设计把这两个状态列为「请确认」事项（见「自行决定的事项」第 2 条），不在本需求里默认补齐。
- 按现有状态计，AC-5 的截图矩阵为 7 个状态：播放中、暂停、字体载入中、空字幕、导出运行中、导出完成、导出失败。每个状态 × 中英文 × 明暗主题 = 28 张截图。若维护者确认补齐排队和取消（见第 2 条），则为 9 个状态、36 张截图。
- 补测中若发现缺陷，只在对应现有组件里修复，修复不引入新状态；修复记入测试报告的「自行决定的事项」。

## 技术方案

### 涉及的子系统

本设计读过的文档与代码（与 `AGENTS.md` 路由表对照）：

- [funasr-tauri.md](../../subsystems/funasr-tauri.md)：Tauri 只做外壳；`binaries/*`、`shared_assets/**/*`、`host/**/*` 随包；`pnpm package:host` 把 `@napi-rs/canvas` 与当前平台 `.node` 放进 `src-tauri/host/node_modules/`；FFmpeg 随包。
- [cordis-host.md](../../subsystems/cordis-host.md)：导出由 Host 插件完成（`server/plugins/export.ts`），字幕条带在 `server/subtitle-render.ts`；Host 可远程部署，`server/main.ts` 读取 `FLYCUT_RESOURCE_ROOT`、`FLYCUT_HOST_HOME`、`FLYCUT_HOST_PORT`、`--profile`。
- [frontend.md](../../subsystems/frontend.md)：端到端测试命名与证据规则（测试名带 AC 编号，证据进需求目录）。
- [ADR-0006](../../20-architecture/adr/0006-subtitle-graphics-layer.md)：Canvas 2D 图形层加 Host Skia 条带；其「只在 macOS 上验证过」一句是本需求要补的缺口。备选表中 A（采用）、B、C、D（libass，不采用）、「A + D 混合」（维护者提出，单独一行，记录为备选）、E。
- [F-0028 设计](../F-0028-shared-subtitle-graphics/02-design.md)、[实现记录](../F-0028-shared-subtitle-graphics/03-implementation.md)、[测试报告](../F-0028-shared-subtitle-graphics/04-test-report.md)：本需求的基线。F-0028 的真实 Tauri 前台性能、Windows、Linux 均为「Not run」，由本需求承接。
- [acceptance-testing.md](../../30-engineering/acceptance-testing.md)、[code-standards.md](../../code-standards.md)、[decisions.md](../../decisions.md)。

已核对的代码锚点：

- `shared/subtitle-graphics/fonts.ts`：`noto-sans-sc` 与 `inter` 为随包字体（`FlyCutNotoSansSC`、`FlyCutInter`）；`arial`、`georgia` 为**可选的系统字体**（第 27–28 行，`bundled: false`）。
- `shared/subtitle-graphics/platformPresets.ts`：`PlatformAspectPreset = 'landscape' | 'portrait_9_16' | 'square_1_1'`（第 10 行）。三画幅统一用这个类型。
- `server/subtitle-render.ts`：`loadCanvasModule`、`findFontDir`（候选目录含 macOS 专用的 `_up_` 分支）、`registerSceneFonts`（随包字体用 `GlobalFonts.registerFromPath` 注册；系统字体只做 `GlobalFonts.has` 检查，缺失即报错）、`createSubtitleBandRenderer`。
- `server/plugins/export.ts`：`runFromFile` 中 `const id = randomUUID()`（第 96 行），输出为 `exportRoot/<uuid>.<扩展名>`，**与 Job id 无关**；失败或取消时删除输出与临时文件；`resolveFfmpeg` 按 `FFMPEG_PATH`、随包副本、开发目录副本的顺序解析，末位回退到 PATH 中的 `ffmpeg`。
- `shared/protocol.ts`：`export.start` 的 `subtitleProcessing`、`subtitleScene`、`subtitleTransport: 'skia-band'`；`JobStatus` 为 `queued | running | complete | error | cancelled`；`jobs.get`、`jobs.cancel` 已在协议中声明。
- `src-tauri/src/lib.rs`：`Builder` 上的 WebDriver 插件注册只在 `#[cfg(all(target_os = "macos", debug_assertions, feature = "acceptance-webdriver"))]` 下生效，插件为 `tauri-plugin-wdio-webdriver`（`src-tauri/Cargo.toml` 第 17、20 行，`=1.0.0`，可选依赖）。**Windows 上目前没有任何 WebDriver 入口。**
- `tests/acceptance/bundle-smoke.ts`：只接受 `.app` 路径（第 11 行的用法提示与第 31 行的 `Candidate.app`）；没有 Windows 分支。
- `scripts/package-host.mjs`：从本机已安装的生产依赖复制 Host，复制当前平台 Node 为 `binaries/flycut-node(.exe)`；只能在目标平台上打包。
- `scripts/fetch-subtitle-fonts.sh`：下载四个字体并复制到 `public/fonts/subtitle/` 与 `src-tauri/shared_assets/subtitle-fonts/`；**不校验哈希，仓库中也没有哈希清单**。
- `scripts/fetch-ffmpeg.sh`：已覆盖 Windows x64、Linux x86_64 与 arm64、macOS。
- `src-tauri/tauri.conf.json`：`resources` 为 `../models.json`、`binaries/*`、`shared_assets/**/*`、`host/**/*`。
- `.github/workflows/ci.yml` 与 `release.yml` 的矩阵包含 `windows-latest`；`acceptance-macos.yml` 只跑 macOS。

### 方案

本需求是补测，不重选渲染架构，也不改共用的场景数据。代码改动只针对补测中被证实的缺陷，每个缺陷修复都要带回归测试，并能证明测试会失败（Red check）。

**1. 参考输出、比较口径与字体哈希清单（所有平台共用）**

- 固定素材：用 ffmpeg `lavfi` 生成的 1080p30 测试视频，内容为纯色与网格，不含第三方内容。另生成一段 10–60 分钟口播风格的中英混排字幕 JSON 作为场景输入。素材与场景 JSON 入库到 `docs/features/F-0029-cross-platform-subtitle-validation/evidence/fixtures/`。
- 参考：同一场景 JSON 在 macOS 上由 F-0028 已验证的 Host 渲染出的字幕条带（RGBA 帧序列）与换行数据。这是已有产品路径的输出。
- 比较分三层：换行（`layoutScene` 行数据逐行逐字比较，完全相同）；包围盒（每个采样时间点的 alpha 包围盒换算到视频像素坐标，偏移 ≤ 2 px，与 F-0028 AC-1 口径一致）；像素（阈值见「自行决定的事项」第 3 条）。
- 比较脚本为纯函数，放在 `tests/architecture/`，输入两份条带帧与场景，输出结构化结果，三个平台共用。
- **字体哈希清单（新增）**：仓库中目前没有字体哈希。本需求让 `scripts/fetch-subtitle-fonts.sh` 在首次下载后计算四个文件的 SHA-256，写入 `scripts/subtitle-fonts.sha256`（入库），之后每次下载都校验；复制到 `src-tauri/shared_assets/subtitle-fonts/` 时同时生成 `SHA256SUMS`。AC-2 的包内断言以入库的哈希为准。这会改变下载脚本的行为（之前不校验），属于补测前提，列入「自行决定的事项」第 12 条。

**2. Linux 无界面 Host（AC-3、AC-6、AC-7、AC-8 的 Linux 部分）**

- 环境：Linux x86_64 容器或虚拟机，满足并记录三个条件：无 `DISPLAY`/`WAYLAND_DISPLAY`，无 `/dev/dri`，`fc-list :lang=zh` 为空。推荐最小基础镜像，不装 CJK 字体。环境选择见「备选方案与取舍」。
- 打包：在该 Linux 上执行 `pnpm fetch:subtitle-fonts`、`pnpm fetch:ffmpeg`、`pnpm package:host`，运行打包目录，不需要 Tauri 壳。`FFMPEG_PATH` 指向随包的 `binaries/ffmpeg`，并在报告中断言解析结果（避免回退到 PATH）。
- 启动：`FLYCUT_RESOURCE_ROOT` 指向打包目录，`FLYCUT_HOST_HOME`、`FLYCUT_HOST_PORT`、`FLYCUT_HOST_TOKEN` 由测试设置，不带 `--web-root`（没有页面）。
- 任务：只通过既有 RPC（`export.start`、`jobs.get`、`jobs.cancel`）执行，轮询 `JobSnapshot` 直到 `complete` 或 `error`。
- 导出：静态样式的单帧与 cue 随时间切换的导出（逐帧 rawvideo 管道）与参考对比。「动画」口径见「自行决定的事项」第 1 条。
- 失败与重试（AC-6、AC-8）：
  - 字体缺失：删除测试副本中的随包字体目录，任务进入 `error`，错误包含「字幕渲染不可用」及原因，不生成成片。
  - 系统字体未注册：选择 Arial 或 Georgia（可选项，`bundled: false`）。Linux 上没有这两个字体，Host 的 `GlobalFonts.has` 检查失败，任务进入 `error`。这是预期结果，不能用替代字体成片。
  - 取消：`jobs.cancel` 后任务进入 `cancelled`。
  - 清理断言：输出文件名是 `randomUUID()` 生成的，测试无法预知，因此断言方式为：导出前记录 `exportRoot` 目录清单，任务结束后目录中**新增的文件**为零，且没有 `*.ass` 与临时 rawvideo 文件。
  - 重试：新的 `export.start` 得到新的 uuid 与新文件；失败任务不被复用；成功的再次导出是新文件，不覆盖旧文件。
  - 原字幕与 EDL 不变：导出前后对项目文件计算 SHA-256，必须相同。
- 记录：发行版与版本（`/etc/os-release`）、`uname -m`、libc、Node 版本、`@napi-rs/canvas` 的 Linux 包版本、`ffmpeg -version`。
- 本需求以 Linux 无界面 Host 作为 Cloud 形态的可验证替身。Cloud 服务端、账号、计费不在本仓库（见 `decisions.md`）。

**3. Windows WebDriver 入口与安装包检查（AC-1 的驱动前提，AC-2 的包内断言）**

- 现状：WebDriver 插件只在 macOS debug + feature 下注册（`lib.rs`）。Windows 需要新增一个**同样只在测试构建生效**的注册分支，不进入正式安装包。
- 做法（主方案）：把 `lib.rs` 的 `cfg` 扩展到 `target_os = "windows"`，同时把 `src-tauri/Cargo.toml` 中 `tauri-plugin-wdio-webdriver` 的声明从 `[target.'cfg(target_os = "macos")'.dependencies]`（第 19–20 行）扩展到 Windows（改为 `cfg(any(target_os = "macos", target_os = "windows"))`，仍为 optional，仅由 `acceptance-webdriver` feature 引入）。因为注册条件含 `debug_assertions`，测试版必须是 **debug 构建**（`pnpm tauri build --debug --features acceptance-webdriver --config src-tauri/tauri.acceptance.conf.json`），复用 F-0058 已有的 `src-tauri/tauri.acceptance.conf.json`；`pnpm tauri:build` 是 release 构建，插件不会注册。前提是 `tauri-plugin-wdio-webdriver = 1.0.0` 在 WebView2 上可用，这一点待核实（见「备选方案与取舍」）。
- 安装包检查：`tests/acceptance/bundle-smoke.ts` 目前只接受 `.app`。新增 `tests/acceptance/f0029-windows-bundle.ts`，接受安装目录（或安装器解包后的目录），断言包内资源与哈希（第 1 条的 `SHA256SUMS`），不依赖 `.app` 结构。
- 运行时断言：从安装目录启动正式安装包，清空 `FFMPEG_PATH` 等开发变量，独立数据目录；断言 `GlobalFonts.has('FlyCutNotoSansSC')` 为真，ffmpeg 解析到随包副本。
- 路径用例：安装目录放在含空格和非 ASCII 字符的路径下，验证 `registerFromPath` 与 `findFontDir` 仍能工作。
- 导出端到端：实机导入一段视频（原生对话框，实机步骤），预览，导出硬字幕成片，`ffprobe` 断言视频轨、时长、字幕像素非零，并用播放器打开截图。
- Arial 与 Georgia：Windows 上这两个系统字体存在，但 Host 能否通过 `GlobalFonts.has` 看到它们未核实。若看不到而预览能画，属于缺陷，见「自行决定的事项」第 8 条。AC-2 的成片断言只用默认的 `noto-sans-sc` 场景，不把 Arial 写成「只用随包字体」。

**4. Windows WebView2 预览（AC-1）**

- 测试对象：第 3 条的测试构建（与安装包同一提交、同一前端产物，只多了 WebDriver 注册）。安装包对应的实机验证见第 3 条。是否接受这一分工，见「自行决定的事项」第 5 条（维护者确认项）。
- 三画幅：`PlatformAspectPreset` 的 `landscape`（1920×1080）、`portrait_9_16`（1080×1920）、`square_1_1`（1080×1080）。
- 帧比较：暂停在固定时间点，用 WebDriver `executeScript` 只读调用字幕 canvas（`canvas[data-subtitle-scene-version]`）的 `toDataURL()` 取像素，与第 1 条的参考比较。不新增生产端钩子。
- 流畅度（前台、窗口可见）：
  - 掉帧率：播放 60 秒 1080p30 样片，`requestVideoFrameCallback` 的 `metadata.presentedFrames` 增量与期望帧数之差，除以期望帧数。
  - 拖动：程序化 seek 后，从 `seeked` 到字幕 canvas 完成首次绘制的耗时。
  - 口径与次数见「自行决定的事项」第 2 条。
- F-0028 中 WKWebView 的数据（窗口不可见）只用于估计阈值是否合理，不作为证据。

**5. Windows 界面状态（AC-5）**

- 状态与截图矩阵：见 UI / UX，7 个已存在状态 × 中英文 × 明暗 = 28 张；排队与取消两个状态是否补齐待确认（第 2 条）。
- 触发方式：字体载入中用测试构建的字体请求延迟（不改产品代码，待核实在 WebView2 上可行）；空字幕用删除全部 cue 的项目副本；导出失败用第 2 条中字体删除的同一方法；导出运行中与完成用正常导出。
- 截图进入 `evidence/windows/screenshots/`。

**6. 支持矩阵与证据（AC-4、AC-7、AC-9）**

- 矩阵行：操作系统、架构、WebView2 版本（WebDriver 中读取 `navigator.userAgent`）、Node、FFmpeg、`@napi-rs/canvas` 版本，以及真实输入与输出（素材哈希、输出 `ffprobe`）。
- 每个平台三种状态：已测（附证据）、失败（附复现命令和日志）、未测（附阻塞原因）。未测不写成支持。
- 证据目录 `evidence/`：`linux/`、`windows/`、`macos/`，各含命令日志、JSON 结果、截图和帧比较输出；矩阵写入 `04-test-report.md`。

## 接口与数据

- RPC：不新增，不修改。`export.start` 的 options（`subtitleScene`、`subtitleTransport: 'skia-band'`）与 `JobSnapshot` 保持现状。
- 场景 schema v1、字体 id 与族名不变（不改共用契约）。
- 构建配置：`src-tauri/src/lib.rs` 的 WebDriver 注册 `cfg` 增加 Windows 分支，仅在 `acceptance-webdriver` feature 下生效；正式安装包不包含该插件。`src-tauri/Cargo.toml` 需要把 `tauri-plugin-wdio-webdriver` 的 target 表从仅 macOS 扩展到 Windows（仍为 optional 依赖、仅 `acceptance-webdriver` feature 引入，正式包不含）；若插件在 WebView2 上不可用改走备选 A2，则改为不动 Cargo.toml、另装 `tauri-driver`。
- 新增数据文件：`scripts/subtitle-fonts.sha256`（字体哈希，入库）；安装目录中的 `shared_assets/subtitle-fonts/SHA256SUMS`（打包时生成）。
- 新增测试入口：`tests/acceptance/f0029-host-render.ts`、`tests/acceptance/f0029-webview2.ts`、`tests/acceptance/f0029-windows-bundle.ts`；`package.json` 中对应新增 `acceptance:f0029:linux-host`、`acceptance:f0029:windows-webview2`、`acceptance:f0029:windows-bundle`（计划，未实现）。
- 兼容迁移：无。项目数据格式不变。

## 备选方案与取舍

**A. Windows WebDriver 工具（AC-1、AC-5 的驱动）**

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| A1. 扩展现有 `tauri-plugin-wdio-webdriver` 到 Windows（`lib.rs` 的 `cfg` 加 Windows 分支，测试构建） | 与 F-0058 的 macOS 路径同一套插件与测试脚本；不新增工具链 | 插件在 WebView2 上是否可用未核实（待核实）；F-0058 仅支持 macOS | **首选**，前提是 WebView2 可用，需先做一次可行性验证（实现清单第 3 项） |
| A2. `tauri-driver` + `msedgedriver`（WebDriver 标准做法） | 社区标准；WebView2 由 Edge 驱动 | 仓库尚未使用；需新增 `tauri-driver` 与 `msedgedriver` 版本匹配；与 F-0058 的 macOS 路径分叉，维护两套 | 作为 A1 不可用时的回退 |
| A3. 无自动化驱动，人工操作加录屏，像素取自截图 | 不改构建 | 无法做可复现的帧比较与拖动计时；截图含视频帧，污染 canvas 像素；不满足 code-standards 的自动化要求 | 不采用，只用于原生对话框等无法自动化的步骤 |
| A4. Playwright 连接 Chromium | 工具成熟 | 不是 WebView2，不算证据（AC-4、AC-9 明确禁止） | 不采用 |

**B. Linux 无界面环境**

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| B1. 最小化容器（不装 CJK 字体）在 Linux 主机或 Docker 中运行 | 可复现；镜像内容可版本化记录；容易证明无字体、无显示 | 需要本机支持容器；镜像层需记录 | **首选** |
| B2. 虚拟机（无显示适配器，无 GPU 直通） | 与物理机最接近 | 构建慢；需要额外准备镜像 | 容器不可用时的回退 |
| B3. 物理 Linux 机器 | 最真实 | 不易保证「无 CJK 字体」「无 GPU」；难以复现 | 作为补充，不作为主证据 |
| B4. GitHub `ubuntu-latest` 运行器 | 免准备环境 | 预装字体与显示服务状态不可控，无法证明「无系统中文字体」（待核实） | 只用于功能冒烟，不作为 AC-3 的证据 |

**C. 字幕渲染架构**：不重选，沿用 ADR-0006 方案 A。备选表中的「A + D 混合」与 D（libass）已在 ADR-0006 否决或记录为备选，本需求不重新评估。

## 架构决策

本设计不新增 ADR。ADR-0006 的决定保持不变，补测只验证它在 Windows 与 Linux 上是否成立。

- 验收通过后，ADR-0006 的「只在 macOS 上验证过」一段需要更新验证范围。建议由维护者确认后，在测试报告中一并更新该 ADR 的后续变更段落。
- 提议（非决定）：若 Windows 上 `@napi-rs/canvas` 预编译包无法稳定加载，或 Linux 在无 CJK 字体下得不到一致的字幕条带，应停止补测，提出新的 ADR 讨论替代方案。本设计不预先决定替代方案，且不允许以 ASS 硬烧或替代字体通过验收（与 F-0028 一致）。

## 自行决定的事项

1. 「请确认」AC-3 的「动画导出」口径。当前 v1 场景只有静态样式（`frameKey` 对同一 cue 不重画），没有逐字高亮或关键词动画（属于 E-03/2、E-03/3，不在本需求）。建议：「动画」理解为 cue 随时间切换的多条幕导出，覆盖进入、离开时的逐帧输出。影响 AC-3。
2. 「请确认」AC-5 的状态范围与 AC-1 的计量口径，分两部分：
   - 排队与取消：现有界面没有这两个状态，也没有取消控件；Host 也没有并发上限。建议：本需求不补齐，AC-5 按现有 7 个状态验收，排队与取消记为「现有产品未实现，不在本需求」，另立需求。若维护者要求补齐，则属于新增界面，需要回到需求确认，并增加实现清单项。
   - 计量：建议掉帧按 `presentedFrames` 口径，每个画幅 ≥3 次、每次 60 秒，取最大值 < 1%；拖动按 `seeked` 到首次绘制完成，每个画幅 ≥30 次，取 p95 ≤ 100 ms。
3. 「请确认」像素阈值。需求没有给出像素阈值。建议：换行完全相同；包围盒偏移 ≤ 2 px；alpha 掩码 IoU ≥ 0.98；alpha > 0 的像素上 RGBA 平均绝对误差 ≤ 2/255。阈值是设计选择，实测不达标即为失败，不得调整阈值来通过。影响 AC-1、AC-3。
4. 「请确认」真实环境来源。建议：Linux 用无桌面、无 GPU、无 CJK 字体的容器（B1）；Windows 功能类可用 `windows-latest`；Windows 性能类（AC-1 的掉帧与拖动）需要有前台桌面的 Windows x64 实机。没有实机则 AC-1 性能记为阻塞，不以 CI 数据代替。
5. 「请确认」测试构建与安装包的分工。AC-1 的 WebDriver 测量只能在带 `acceptance-webdriver` 的测试构建上做，正式安装包不注册测试命令。建议：功能与帧比较在测试构建上做；AC-2 的安装包运行、导入与导出用正式安装包，原生对话框步骤实机完成。若维护者要求 AC-1 也在正式安装包上测，则需要另行设计（当前无可行方案）。
6. 「请确认」签名。Windows 正式签名属于 F-0057，不在本需求。建议用本地未签名构建，测试报告写明 SmartScreen 等系统提示，不以签名作为通过条件。
7. 「请确认」Cloud 的替身。spec 中的「Cloud」在本仓库由 Linux 无界面 Host 代表，远程 Cloud 不在本仓库。建议以 Linux 无界面 Host 作为验收对象，并在测试报告中说明。
8. 「请确认」Windows 上 Arial 与 Georgia（`shared/subtitle-graphics/fonts.ts` 第 27–28 行的可选系统字体）。`registerSceneFonts` 对它们只做 `GlobalFonts.has` 检查。若 Windows 上 Host 看不到它们而 WebView2 能画出来，预览与成片不一致，属于缺陷。建议修复为让 Host 注册 Windows 字体目录中对应的字体文件，不改变字体选项，不回退到替代字体；若修复需要改动字体清单契约，则回到需求确认。影响 AC-1、AC-2、AC-3。
9. 支持范围：Linux 只验证 x86_64 glibc；arm64、musl、Windows arm64 不在本需求范围，在矩阵中记为「未测」。与需求说明的建议（Windows x64 与 Linux x64）一致。
10. 生产代码不新增测试钩子：帧读取用 WebDriver 只读调用 `toDataURL()`；字体请求延迟与 WebDriver 注册只在测试构建中生效。
11. 同批次冲突（据审查意见，同批次含 F-0054 与 F-0040）：
   - F-0006、F-0024、F-0033 已合并，按当前代码判断，不再作为待解决冲突。
   - F-0054（桌面自动更新）与本需求重叠的文件：`src-tauri/Cargo.toml`（F-0054 增加 `tauri-plugin-updater`、`tauri-plugin-process`；本需求扩展 `tauri-plugin-wdio-webdriver` 的 target 表）、`src-tauri/src/lib.rs`（两者都改 `Builder` 的插件注册，本需求只加 Windows 的 WebDriver `cfg` 分支）、`src-tauri/tauri.conf.json`（F-0054 增加 `plugins.updater`，本需求不改）、`.github/workflows/release.yml`（F-0054 改，本需求不改）。
   - F-0040（授权口型同步）：F-0040 计划把 `probeStderr`/`probeVideo` 从 `server/plugins/export.ts` 抽到 `server/lib/ffmpegProbe.ts`。本需求第 6 项若需修复 Windows 文件句柄清理，可能同样落在 `export.ts`。建议：谁先合并谁定版，后合并的一方在当前代码上重基；本需求不改 probe 相关函数。
   - 顺序建议：F-0029 先在**当前代码**上验证 Windows 安装包（实现清单第 3–5 项）；F-0054 合并后，由 F-0054 重新运行 `f0029-windows-bundle` 检查，确认更新器插件没有破坏包内资源与启动；两者都改 `lib.rs` 时，F-0029 的 WebDriver 分支应在 F-0054 之前或之后合并，由批次执行图决定。
12. 「请确认」字体哈希的来源。仓库中没有字体哈希，下载脚本也不校验。建议：首次下载后计算 SHA-256，入库到 `scripts/subtitle-fonts.sha256`，后续下载校验；这会改变下载脚本的行为，但它是 AC-2 证据的前提。
13. 「请确认」依赖 F-0058。本设计的 WebDriver 路径复用 F-0058 的驱动基础设施（`acceptance-webdriver` feature、`src-tauri/tauri.acceptance.conf.json`、`tests/acceptance/mac-app.ts`、`pnpm acceptance:tauri`）；F-0058 已验收，但其 CI 相关 AC 为 Not run。spec 的 `depends_on` 只有 F-0028。建议把 F-0058 补进 `depends_on`（它已验收，不阻塞排期）。

## 风险与回退

- **WebDriver 插件在 WebView2 上不可用。** 缺口：`tauri-plugin-wdio-webdriver` 1.0.0 的 Windows 支持未核实。回退：改用 A2（`tauri-driver` + `msedgedriver`）；若两者都不可行，AC-1 的帧比较与拖动计时记为阻塞，不以 Playwright 替代。
- **无实机环境。** 没有 Windows 前台桌面时，AC-1 性能、AC-2 实机导入导出、AC-5 的 Windows 截图无法完成，按 AC-4、AC-9 记为阻塞，写出复现命令与缺口。
- **Skia 预编译包不可用。** `loadCanvasModule` 抛出「字幕渲染不可用」，导出失败。回退：不加 ASS 硬烧兜底，停止补测，提出 ADR，回到需求确认（AC-8）。
- **Windows 路径与进程问题。** `findFontDir` 依赖资源布局，`_up_` 分支是 macOS 的注释，Windows 的布局待核实。含空格或非 ASCII 的安装路径可能影响 `registerFromPath`。取消 ffmpeg 时，Windows 上文件句柄未释放可能导致输出删除失败，此时 AC-8 的「新增文件为零」断言会失败，需要修复清理逻辑并回归。
- **WebView2 与 WKWebView 差异。** WebView2 为 Chromium 内核，预期支持 `requestVideoFrameCallback`；`SubtitleOverlay` 保留 `timeupdate` 作为兜底，兜底路径的流畅度可能不达标。回退：修复 overlay 的驱动方式并回归；仍不达标则如实记为失败。
- **Linux 字形。** 无 CJK 系统字体时只有随包字体生效；若随包字体缺字，条带与参考不一致，属于 AC-6 失败场景，明确报错，不以替代字体成片。
- **性能不达标。** 不改渲染架构。记为失败，提出改进或由维护者决定备选，不在本需求私自切换。
- **同批次代码冲突。** 见第 11 条。回退：按批次执行图合并，测试在最终基线上重跑。

## 规模估计与结论

估计（人日，按有实机环境的前提，不含等待时间）：

| 工作块 | 估计 |
|---|---|
| 1. 参考输出、比较纯函数、字体哈希清单 | 2–3 |
| 2. Linux 无界面 Host（环境、打包、静态与切换导出、失败与重试） | 3–4 |
| 3. Windows WebDriver 入口可行性验证、测试构建、安装包检查与导出实机 | 3–5 |
| 4. WebView2 三画幅帧比较与流畅度测量 | 3–5 |
| 5. Windows 界面状态（28 张截图，含触发方式） | 1–2 |
| 6. 缺陷修复与回归（数量未知，按预留估计） | 1–3 |
| 7. 支持矩阵与报告 | 1 |
| 合计 | 约 14–23 人日 |

结论：按日历时间约 3–4 周，**超过 spec 规模检查的约两周上限**。主要不确定性是第 3 条（WebView2 的 WebDriver 可行性）与实机可用性。建议回到 E-03 拆分为两个需求：

- F-0029a（Linux 无界面 Host）：AC-3、AC-6、AC-7 的 Linux 部分、AC-8 的 Linux 部分；只需要 Linux 环境。
- F-0029b（Windows）：AC-1、AC-2、AC-5、AC-7 与 AC-9 的 Windows 部分；需要 Windows 实机，依赖第 1 项的比较函数。

「请确认」是否拆分。本设计按单需求写完，拆分后按实现清单的对应子集执行。

## 实现清单

依赖关系：第 1 项是后续比较的基础；第 3、4、5 项依赖第 1 项；第 6 项依赖第 2–5 项；第 7 项依赖第 6 项。

- [ ] 1. 基线与比较：生成 1080p30 测试素材与场景 JSON；记录 macOS Host 参考条带与换行数据；实现三层比较纯函数与单元测试；新增字体哈希清单并让 `fetch-subtitle-fonts.sh` 校验；Mac 回归（F-0028 套件）通过。
- [ ] 2. Linux 无界面 Host：新增 `tests/acceptance/f0029-host-render.ts` 与 `acceptance:f0029:linux-host`；在无桌面、无 GPU、无 CJK 字体的 Linux x86_64 环境完成 `package:host`，启动无页面 Host，完成静态与切换导出的参考对比，以及字体缺失、Arial/Georgia 未注册、取消、重试与清理断言（AC-3、AC-6、AC-7、AC-8 的 Linux 部分）。
- [ ] 3. Windows 入口与安装包：可行性验证 `tauri-plugin-wdio-webdriver` 在 WebView2 上是否可用（不可用则切换 A2 并更新设计）；`Cargo.toml` 把该插件的 target 表扩展到 Windows、`lib.rs` 增加 Windows 测试分支，debug + `acceptance-webdriver` + `tauri.acceptance.conf.json` 构建测试版；新增 `tests/acceptance/f0029-windows-bundle.ts` 与 `acceptance:f0029:windows-bundle`，断言包内资源哈希、启动后随包字体与 ffmpeg 路径、含空格与非 ASCII 路径；实机导入、预览、导出并用播放器打开（AC-2）。
- [ ] 4. Windows WebView2 预览：新增 `tests/acceptance/f0029-webview2.ts` 与 `acceptance:f0029:windows-webview2`；三画幅帧比较、掉帧与拖动测量，记录 WebView2 版本（AC-1）。
- [ ] 5. Windows 界面状态：同一个 WebDriver 文件中的界面模式，7 个状态（或确认后 9 个）× 中英文 × 明暗的截图与文案断言（AC-5）。
- [ ] 6. 缺陷修复与重跑：修复补测中发现的缺陷并补回归测试；修复后**重新运行 Linux 验证（第 2 项全部）**，并重新运行 Windows 检查（第 3–5 项）。
- [ ] 7. 支持矩阵与报告：汇总各平台结果写入 `04-test-report.md`，列明已测、失败、未测及阻塞原因；提议更新 ADR-0006 的验证范围（AC-4、AC-7、AC-9）。

本需求不改共用契约（`shared/protocol.ts`、场景 schema v1），没有需要先行的契约项。

## 验证计划

每次代码改动（包括缺陷修复）后，按 `docs/code-standards.md` 第 1、2 条运行：

```bash
pnpm lint
pnpm tsc -b --noEmit
pnpm check:host
cargo check --manifest-path src-tauri/Cargo.toml
pnpm test
pnpm test:architecture
```

Windows 上的 `cargo check` 由 CI 的 `windows-latest` 矩阵覆盖。Windows 本地运行额外执行 `pnpm fetch:ffmpeg`、`pnpm fetch:subtitle-fonts`、`pnpm package:host`，以及 WebDriver 测试版构建（必须是 debug 构建：`pnpm tauri build --debug --features acceptance-webdriver --config src-tauri/tauri.acceptance.conf.json`；release 构建因 `debug_assertions` 条件不注册插件）。脚本与 `package.json` 条目为计划，尚未实现。

- **AC-1**：Windows x64 WebView2，测试构建。命令（计划）：`pnpm acceptance:f0029:windows-webview2 preview`。断言：三画幅换行与参考完全相同；包围盒偏移 ≤ 2 px；前台掉帧率每次 < 1%；拖动 p95 ≤ 100 ms；记录 WebView2 版本。需要前台实机（第 4 条）；安装包对应的实机验证见 AC-2。
- **AC-2**：Windows x64 正式安装包。命令（计划）：`pnpm acceptance:f0029:windows-bundle "<安装目录>"`。断言：包内 `.node`、`flycut-node.exe`、`ffmpeg.exe` 与四个字体的 SHA-256 与入库清单一致；启动后 `GlobalFonts.has('FlyCutNotoSansSC')` 为真；ffmpeg 解析到随包副本；默认场景导出的 `ffprobe` 显示视频轨与正确时长，字幕像素非零；含空格与非 ASCII 路径用例通过。原生对话框导入为实机步骤，播放器打开需截图。
- **AC-3**：Linux x86_64 无界面（容器）。命令（计划）：`pnpm acceptance:f0029:linux-host`。断言：静态与切换导出的换行相同；包围盒偏移 ≤ 2 px；像素阈值按第 3 条；随包字体生效；输出时长误差 ≤ 1 帧；环境记录完整；`FFMPEG_PATH` 解析到随包副本。
- **AC-4**：全平台。命令（计划）：矩阵由脚本从 `evidence/` 汇总。断言：每个平台为已测、失败、未测之一；未测有阻塞原因与复现命令。Mac 回归：`pnpm test:e2e tests/e2e/features/F-0028.spec.ts` 通过。
- **AC-5**：Windows WebView2，测试构建。命令（计划）：`pnpm acceptance:f0029:windows-webview2 ui`。断言：7 个（或确认后 9 个）状态 × 中英文 × 明暗的截图存在且非空；文案与 F-0028 的验收断言一致。需要 Windows 实机或前台会话。
- **AC-6**：Linux x86_64 无界面。命令：`pnpm acceptance:f0029:linux-host`（失败子集）。断言：字体缺失或 Arial/Georgia 未注册时进入 `error`，错误包含「字幕渲染不可用」及原因；取消进入 `cancelled`；进度随 `jobs.get` 返回；无 `DISPLAY`、无页面。
- **AC-7**：全平台。命令（计划）：矩阵由 `evidence/*/environment.json` 生成。断言：每行含 OS、架构、WebView、Node、FFmpeg、Skia 版本，与真实输入输出哈希；复现命令可直接运行。
- **AC-8**：Linux 与 Windows，同一套断言。命令：`linux-host` 的失败子集与重试用例，Windows 部分在 `windows-bundle` 的导出用例中执行。断言：导出前后 `exportRoot` 目录中新增文件数为零（输出名为 uuid，不预先断言）；没有 `*.ass` 与临时 rawvideo；重试得到新文件；导出前后项目文件 SHA-256 相同；Windows 的取消用例覆盖文件句柄问题。
- **AC-9**：Windows 安装包与 Linux 无界面。命令：AC-2、AC-3、AC-5、AC-6 的组合；Mac 回归见 AC-4。断言：每个真实环境的专用 AC 都有结果；无环境的项记阻塞；没有以 Chromium 或模拟浏览器替代。

涉及界面的 AC（AC-1、AC-5）的截图与录屏写入 `evidence/windows/`，不以 Chromium 的 Playwright 结果代替。

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | 技术方案「方案」第 4 节（WebView2 预览、三画幅、帧比较、计量）；第 3 节（WebDriver 入口前提）；备选方案 A；实现清单第 3、4 项；自行决定的事项第 2、4、5 条 |
| AC-2 | 技术方案「方案」第 1 节（字体哈希清单）与第 3 节（安装包检查、运行时断言、路径用例、导出）；接口与数据（新增数据文件）；实现清单第 1、3 项；自行决定的事项第 5、6、8、12 条 |
| AC-3 | 技术方案「方案」第 1、2 节（参考输出、Linux 无界面 Host、静态与切换导出）；备选方案 B；实现清单第 2 项；自行决定的事项第 1、3、7、9 条 |
| AC-4 | 技术方案「方案」第 6 节（支持矩阵与证据目录）；架构决策；实现清单第 7 项；验证计划 |
| AC-5 | UI / UX（状态与截图矩阵）；技术方案「方案」第 5 节（触发方式）；实现清单第 5 项；自行决定的事项第 2、10 条 |
| AC-6 | 技术方案「方案」第 2 节（只用既有 RPC、字体缺失与 Arial/Georgia 的明确失败、取消）；实现清单第 2 项；风险与回退（Linux 字形） |
| AC-7 | 技术方案「方案」第 6 节（矩阵行）；备选方案 B；实现清单第 7 项；自行决定的事项第 9 条 |
| AC-8 | 技术方案「方案」第 2 节（清理断言改用 `exportRoot` 目录清单、重试新文件、项目 SHA-256 不变）；风险与回退（Windows 句柄）；实现清单第 2、6 项；自行决定的事项第 11 条 |
| AC-9 | 验证计划（真实环境门禁，不用模拟浏览器）；风险与回退（无实机环境）；规模估计与结论；自行决定的事项第 4、6 条 |

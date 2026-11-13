---
id: F-0057
stage: 04-test-report
status: approved
approved_by: zhangxiang.chen
approved_at: 2026-11-13
---

# F-0057 桌面安装包签名与公证：测试与验收

验收在最终代码/测试实现提交 `b15009a` 上进行；本报告随后作为文档提交（不改变代码与测试）。

> 技术设计和开发阶段由 agent 连续推进、自动确认；维护者在这里一并审阅。

## 设计与实现摘要

本次实现为桌面安装包构建与发版流程补齐了 macOS 开发者签名/Hardened Runtime/公证装订、Windows Authenticode 代码签名/RFC 3161 时间戳验证，以及缺凭据或验签失败时的 fail-closed 发布门禁：

- **Tauri 配置与最小权限清单**：在 `src-tauri/entitlements/app.plist` 与 `src-tauri/entitlements/host-node.plist` 中区分隔离权限——仅随包 `binaries/flycut-node` 获得 V8 JIT 所需的 `allow-jit` 与 `allow-unsigned-executable-memory`，主程序 `flycut-caption` 与 `funasr-asr`、`ffmpeg`、`*.node` 保持最小 Hardened Runtime 约束；`src-tauri/tauri.conf.json` 显式启用 `hardenedRuntime: true` 与 Windows `sha256` + `tsp: true`。
- **由内向外签名与依赖自包含校验（`scripts/signing/macos.mjs`）**：扫描 `Contents/` 下全部 Mach-O 文件与 `.node`/`.dylib`/`.so`（覆盖 `flycut-node`、`funasr-asr`、`ffmpeg` 与 `@napi-rs/canvas` 原生模块），通过 `otool -L` + `otool -D`（排除库自身 `LC_ID_DYLIB`）阻断 Homebrew/未随包 `@rpath` 依赖；通过临时钥匙串导入 `.p12`，按深度由内向外签名、验证每件嵌套签名与一致 `TeamIdentifier`，再组装并签名 `.dmg`，并在 `finally` 中无条件清理临时钥匙串与 `.p12`。
- **幂等公证状态机（`scripts/signing/macos-notarize.mjs`）**：支持 App Store Connect API Key（`.p8` 临时 `0600` 写入）或 Apple ID。已有 `submissionId`（`FLYCUT_NOTARY_SUBMISSION_ID` 或状态文件）时先调 `xcrun notarytool info` 查询；新提交使用 `--no-wait` 立即落盘 `submissionId`；超时保留 `submissionId` 并阻断发布；拒绝拉取脱敏日志留证并阻断；通过后对 `.dmg` 与 `.app` 执行 `stapler staple`、`stapler validate` 与 `spctl` 评估。
- **Windows 签名与验签（`scripts/signing/windows.mjs`）**：通过 PowerShell `Import-PfxCertificate` 将证书导入临时 `Cert:\CurrentUser\My`（密码经环境变量 `SecureString` 传入，不进命令行），先签 `binaries/*.exe` 与 `host/**/*.{node,dll}`，再通过临时 Tauri 配置覆写签主程序及 `.msi`/`-setup.exe`，并用 `signtool verify /pa /v` 与 `Get-AuthenticodeSignature` 核验 `Status == Valid`、RFC 3161 时间戳和发布者主题，最后在 `finally` 清除证书。
- **发版流水线、本地闸门与运维手册**：`scripts/release-signing.mjs` 统一承接 `preflight`、`macos`、`windows` 与 `verify-release-artifacts`；`.github/workflows/release.yml` 补齐 `pnpm build:core` 与 `pnpm package:host`，并在 `release` 作业发布前校验双平台证据与 `SHA256SUMS`；`scripts/release.mjs` 打 tag 前先校验发版配置完整性；`docs/40-ops/runbooks/desktop-signing-notarization.md` 记录 Secrets 配置、超时续接及禁止绕过系统安全检查的运维边界。
- **新增 ADR**：[ADR-0014 桌面安装包签名、公证与发版门禁边界](../../20-architecture/adr/0014-desktop-signing-notarization.md)（`status: accepted`，维护者 2026-11-13 确认）。
- **与设计的偏差**：无重大偏差。本机无签发证书与 Windows 环境，因此在真实构建的 `FlyCut Caption.app` 上实测了 Mach-O/原生模块扫描、本地自包含检查与 `preflight` 阻断，并把真实签发、公证装订及干净系统安装验证如实记为 `⏸ Not run`。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| macOS 公证鉴权模式（请确认） | 同时支持 App Store Connect API Key（`.p8`，推荐）与 Apple ID + App-Specific Password | 兼容维护者不同的 Apple Developer 凭据形态 | AC-1、AC-5、AC-6 |
| `flycut-node` 权限范围（请确认） | 仅开启 `allow-jit` 与 `allow-unsigned-executable-memory`，不开启 `disable-library-validation` | 由内向外将 `@napi-rs/canvas` 等 `.node` 模块用同一 Team ID 签名后即可满足库校验，避免扩大权限面 | AC-1、AC-3 |
| DMG 组装方式（请确认） | `tauri build --bundles app --no-sign` 后由脚本以 `hdiutil create` 组装带 `Applications` 软链的 DMG 并签名公证 | 避免在无头 macOS CI Runner 上依赖 Finder AppleScript 偶发超时，且确保所有嵌套 Mach-O 先签完再封包 | AC-1、AC-7 |
| 手动调度门禁（请确认） | `workflow_dispatch` 默认 `allow_unsigned_candidate: false`；仅显式勾选 `true` 时产出 `unsigned-candidate` 产物且跳过 Release 发布 | 防止手动构建在缺凭据时静默产生未签名正式包，同时保留前置测试打包通道 | AC-2、AC-4、AC-5、AC-8 |
| `.node` 库 `LC_ID_DYLIB` 排除 | `checkSingleMacBinaryContainment` 通过 `otool -D` 排除动态库自身安装名后再做 `otool -L` 检查 | 避免 `skia.darwin-arm64.node` 自带的构建机 `libcanvas.dylib` 路径触发误报，同时仍严格拦截外部 Homebrew/`@rpath` 依赖 | AC-1 |
| Windows PFX 导入方式 | 使用 `Import-PfxCertificate` 导入 `Cert:\CurrentUser\My` 并以 `/sha1 <thumbprint>` 签名 | 避免 PFX 密码出现在 `signtool.exe` 命令行参数中，降低进程列表与错误日志泄露风险 | AC-2、AC-3、AC-8 |
| AC-9 界面回归构造 | 新增 `tests/e2e/features/F-0057.spec.ts` 复用既有首页导入、识别字幕与导出视频对话框，检查浅色/深色与中/英文状态并断言无签名页面 | 遵守 AC-5（不新增签名页面）与 AC-9（不为 CI 日志增加无意义界面测试） | AC-5、AC-9 |

## 验收标准逐条结果

| AC | 目标平台 / 环境 | 验证方式、用例与命令 | 证据或未跑原因 | 结果 |
|---|---|---|---|---|
| AC-1 | macOS 脚本与本机真实资源 | `pnpm test`：`F-0057/AC-1 macOS entitlements...`、`discoverMacSignTargets...`、`checkMacSelfContainment...`、`verifyMacSignatureOutput...`；本机实测 `tauri build --bundles app --no-sign` 产出 `FlyCut Caption.app` 并执行 `discoverMacSignTargets` + `checkMacSelfContainment` | 确认扫描到全部 6 个目标（`skia.darwin-arm64.node`、`ffmpeg`、`flycut-node`、`funasr-asr`、`flycut-caption`、`.`），`flycut-node` 绑定 `host-node.plist`，本机 `funasr-asr` 与 `skia.darwin-arm64.node` 无外部动态库依赖，且能检出本机 Homebrew `ffmpeg` 的 55 个外部 dylib | ✅ 通过（配置与本机资源检查） |
| AC-1 | 真实 Developer ID 签名与公证环境 | `scripts/release-signing.mjs macos` 真实执行 `codesign`、Hardened Runtime、`notarytool` 与 `stapler` | 本机无 Apple Developer ID Application 证书与公证凭据，无法执行真实签名与苹果公证服务交互 | ⏸ Not run |
| AC-2 | Windows 签名脚本与发版门禁逻辑 | `pnpm test`：`F-0057/AC-2 AC-7 AC-8 discoverWindowsSignTargets and verifyWindowsSignatureResult...` 与 `F-0057/AC-3 AC-5 AC-8 preflightSigning...` | 确认发现 `binaries/*.exe`、`host/**/*.node`、`flycut-caption.exe`、`.msi` 与 `-setup.exe`，缺凭据/缺时间戳/状态非 `Valid`/发布者不匹配均失败阻断 | ✅ 通过（脚本与门禁单测） |
| AC-2 | 真实 Windows 构建机与代码签名证书 | `scripts/release-signing.mjs windows` 真实执行 `Import-PfxCertificate`、`signtool` 与 `Get-AuthenticodeSignature` | 本机为 macOS，无 Windows Runner 与真实代码签名 `.pfx` 证书 | ⏸ Not run |
| AC-3 | 密钥脱敏、临时凭据生命周期与安全文案 | `pnpm test`：`F-0057/AC-3 AC-5 AC-8 preflightSigning...`、`temporary keychain and Windows cert store always clean up after failure`、`release pipeline config and runbook prohibit OS security bypass...` | 断言 `redactSecrets` 脱敏密码/PEM/Bearer/Base64；异常时临时目录、临时钥匙串与临时 Windows 证书均在 `finally` 清理；手册与工作流不含关闭 Gatekeeper 或虚假 SmartScreen 承诺 | ✅ 通过 |
| AC-4 | 发版脚本与流水线分支隔离 | `pnpm test` 与 `scripts/release.mjs` 检查；`release.yml` 审查 | 正式 Release 仅由 `refs/tags/v*` + `mode == 'release'` 触发；手动候选打包不会发布正式版本 | ✅ 通过（门禁与隔离配置） |
| AC-4 | 无开发环境的真实干净 Mac / Windows 实机 | 在干净 Mac / Windows 安装候选包并从选择视频、转写到导出走通 | 当前无签名发行包、无 Apple 公证凭据、无干净 Windows 测试机 | ⏸ Not run |
| AC-5 | CI 预检脚本 + Web Chrome (`tests/e2e/features/F-0057.spec.ts`) | 本机运行 `node scripts/release-signing.mjs preflight --platform all --mode release`（无凭据）；`PW_PORT=5195 pnpm e2e:evidence F-0057` | preflight 退出码 1 并脱敏列出缺失的 `APPLE_*` 与 `WINDOWS_*` 变量；Playwright 确认应用内无任何签名配置或 CI 日志页面 | ✅ 通过 |
| AC-6 | macOS 公证状态机（注入 mock `xcrun`） | `pnpm test`：`F-0057/AC-6 notarizeMacArtifact preserves submissionId on timeout and queries info before submit on retry` + Red check | 断言超时保留 `submissionId` 并写 `notary-submission.json`；重试先查 `info`（`Accepted` 时跳过 `submit` 直奔 `staple`）；`Invalid` 拉取日志并阻断。Red check 撤销 `if (currentId)` 先查分支后该用例立即失败于意外调用 `notarytool submit` | ✅ 通过（状态机与 Red check） |
| AC-6 | 真实 Apple `notarytool` 服务端提交与轮询 | 在 GitHub Actions `macos-14` 或本机真实调用 Apple 公证服务 | 本机无 Apple Developer 公证账号 / API Key | ⏸ Not run |
| AC-7 | 证据与哈希核验脚本 | `pnpm test`：`F-0057/AC-7 AC-8 verifyReleaseArtifacts checks evidence, hashes, and blocks unsigned/error artifacts` | 校验 `signing-evidence-*.json`（含发布者信息与 `releaseAuthorized: false`）及 `SHA256SUMS-*.txt`；文件篡改或缺时间戳时立即报错 | ✅ 通过（脚本单测） |
| AC-7 | 真实 CI 签发产物与发布会附件 | `release.yml` 产出真实签发包的 `signing-evidence-*.json`、`SHA256SUMS` 与发布者信息比对 | 尚未在维护者仓库配置 Secrets 并运行 `release.yml` | ⏸ Not run |
| AC-8 | 失败门禁与清理（macOS/Windows/Release） | `pnpm test`：`verifyMacSignatureOutput...`、`notarizeMacArtifact`（`Invalid`）、`verifyWindowsSignatureResult`（`NotSigned`/缺时间戳）、`temporary keychain and Windows cert store always clean up after failure`、`verifyReleaseArtifacts`（错误文件阻断） | 所有失败场景均抛出阻断并生成脱敏 `signing-error-*.json`，临时钥匙串与证书均在 `finally` 清理 | ✅ 通过 |
| AC-9 | Web Chrome (`PW_PORT=5195`) | `PW_PORT=5195 pnpm e2e:evidence F-0057` | 3/3 通过：覆盖浅色/深色主题与中/英文下既有首页导入、识别进入编辑器及导出视频对话框（8 张截图、3 段录屏） | ✅ 通过（既有界面明暗主题回归） |
| AC-9 | 真实干净 Mac / Windows 桌面实机 | 安装真实签名候选包，记录系统安全提示并完成导入→识别→导出全流程 | 本机无 Apple 公证与 Windows 代码签名证书及干净双平台实机 | ⏸ Not run |

## 界面证据

由 `PW_PORT=5195 pnpm e2e:evidence F-0057` 在 Chrome 下生成，覆盖 `light`/`dark` 主题与中/英文（`recordings/` 仅留本地，`screenshots/` 已入库）：

| 界面 | 状态 | AC | 截图 | 录屏（本地） |
|---|---|---|---|---|
| 首页导入区（浅色中文） | 正常、无签名/CI 日志页面 | AC-5、AC-9 | [home-import-light-zh.png](screenshots/home-import-light-zh.png) | `recordings/light_F-0057_AC-5_AC-9_无产品内签名页面_既有导入_识别_导出对话框在中文_light_下正常-default.webm` |
| 编辑器已识别字幕（浅色中文） | 导入并打开已转写项目 | AC-9 | [editor-transcribed-light-zh.png](screenshots/editor-transcribed-light-zh.png) | 同上 |
| 导出视频对话框（浅色中文） | Host 导出就绪、开始导出可用 | AC-9 | [export-dialog-light-zh.png](screenshots/export-dialog-light-zh.png) | 同上 |
| 首页导入区（深色中文） | 正常、无签名/CI 日志页面 | AC-5、AC-9 | [home-import-dark-zh.png](screenshots/home-import-dark-zh.png) | `recordings/dark_F-0057_AC-5_AC-9_无产品内签名页面_既有导入_识别_导出对话框在中文_dark_下正常-default.webm` |
| 编辑器已识别字幕（深色中文） | 导入并打开已转写项目 | AC-9 | [editor-transcribed-dark-zh.png](screenshots/editor-transcribed-dark-zh.png) | 同上 |
| 导出视频对话框（深色中文） | Host 导出就绪、开始导出可用 | AC-9 | [export-dialog-dark-zh.png](screenshots/export-dialog-dark-zh.png) | 同上 |
| 编辑器已识别字幕（浅色英文） | 英文语言切换、无签名页面 | AC-5、AC-9 | [editor-transcribed-light-en.png](screenshots/editor-transcribed-light-en.png) | `recordings/F-0057_AC-5_AC-9_英文界面下既有导入与导出流程可用且无签名页面-default.webm` |
| 首页导入区（浅色英文） | 返回项目列表、导入按钮可用 | AC-5、AC-9 | [home-import-light-en.png](screenshots/home-import-light-en.png) | 同上 |

## 回归检查

全部运行于最终代码/测试提交 `b15009a`（除 `pnpm test` 中 5 个需额外本地 ASR 模型的族烟雾用例跳过，以及无真实签名证书/Windows 环境的实机步骤外）：

- `pnpm lint` ✅（0 errors, 0 warnings）
- `pnpm tsc -b --noEmit` ✅
- `pnpm check:host` ✅
- `cargo check --manifest-path src-tauri/Cargo.toml` ✅（在已执行 `pnpm package:host` 的工作区通过）
- `pnpm test` ✅：122 tests, 117 passed, 0 failed, 5 skipped（未下载 fire_red_asr / moonshine / nemo_transducer / paraformer / whisper 额外模型）；其中 `tests/release-signing.test.mjs` 10/10 全部通过
- `pnpm test:architecture` ✅：145/145 passed
- `PW_PORT=5195 pnpm e2e:evidence F-0057` ✅：3/3 passed，生成 8 张截图与 3 段录屏
- `plutil -lint src-tauri/entitlements/app.plist src-tauri/entitlements/host-node.plist` ✅
- `pnpm exec tauri build --debug --bundles app --no-sign` + 本机 `discoverMacSignTargets` / `checkMacSelfContainment` / `release-signing.mjs preflight` 实测 ✅
- Red check ✅：临时关闭 `scripts/signing/macos-notarize.mjs` 的 `if (currentId)` 先查分支后，`tests/release-signing.test.mjs` 中 `F-0057/AC-6` 用例立即失败于意外调用 `xcrun notarytool submit`；恢复后重新全绿。

## 发现的问题

- **原有 `release.yml` 缺失 `pnpm package:host` 与 `pnpm build:core`**：旧发版工作流直接执行 `tauri build` 而不先打包 `src-tauri/host` 与 `flycut-node`，且不签 `Contents/Resources/` 内的 `flycut-node`、`funasr-asr`、`ffmpeg` 与 `skia.*.node`。已在本次改造的 `.github/workflows/release.yml` 与 `scripts/signing/macos.mjs`、`windows.mjs` 中一并修复。
- **本机开发环境 FFmpeg 为 Homebrew 动态库**：本机工作区 `src-tauri/binaries/ffmpeg` 链接了 `/opt/homebrew/Cellar/ffmpeg/...` 等 55 个动态库，严格的 `checkMacSelfContainment` 已正确拦截该情况；CI 构建阶段会由 `pnpm fetch:ffmpeg` 拉取静态构建并在签名前自动执行同一自包含门禁。

## 结论

脚本配置、门禁逻辑、权限清单、单元测试、架构测试、真实 `.app` 打包资源扫描及既有界面回归均已通过验证（对应 AC-3、AC-5、AC-8 及 AC-1/2/4/6/7/9 的本地与脚本验证部分）；受当前环境缺少 Apple Developer 证书/公证凭据及 Windows 签名证书/干净双平台实机限制，真实签名公证与干净系统安装体验项记为 `⏸ Not run`，待维护者配置 CI Secrets 并完成一次候选发布及干净 Mac/Windows 实机验证后确认是否放行。

本报告等待维护者审阅与确认（未自行执行 `pnpm feature approve`，未执行 `pnpm release` 对外发版）。

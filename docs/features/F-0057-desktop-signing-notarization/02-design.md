---
id: F-0057
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-13
---

# F-0057 桌面安装包签名与公证：设计

## UI / UX

无新增界面改动（遵守 AC-5「不新增产品内签名页面」与 AC-9「不为CI日志增加无意义的界面测试」）。

为满足 AC-9 对既有流程与明暗主题/多语言的界面验证要求，新增 `tests/e2e/features/F-0057.spec.ts`，沿用项目既有首页导入、转写进入编辑器与导出视频对话框（`src/components/ExportPanel/ExportDialog.tsx`），在浅色/深色主题及中/英文下通过 `mockHost` 拦截 Host RPC、以本地 `ffmpeg` 生成的短视频构造导入-转写-导出状态并生成截图证据，同时断言产品内不存在任何签名配置或 CI 日志页面。

## 技术方案

### 涉及的子系统

- [FunASR / Tauri](../../subsystems/funasr-tauri.md)：`src-tauri/tauri.conf.json`、`src-tauri/entitlements/*.plist`、随包二进制与 `src-tauri/host` 资源结构。
- [代码与验收标准](../../code-standards.md) 第 6 条及 [自动化验收方案](../../30-engineering/acceptance-testing.md)：`scripts/release.mjs`、`.github/workflows/release.yml`。

### 方案

1. **权限清单与 Tauri 打包配置**
   - 新增 `src-tauri/entitlements/app.plist`（最小 Hardened Runtime，不放宽代码签名/JIT 限制）与 `src-tauri/entitlements/host-node.plist`（仅针对 `binaries/flycut-node` 启用 `com.apple.security.cs.allow-jit` 与 `com.apple.security.cs.allow-unsigned-executable-memory`）。
   - 更新 `src-tauri/tauri.conf.json`：显式配置 `bundle.macOS.hardenedRuntime: true`、`bundle.macOS.entitlements: "entitlements/app.plist"`，以及 `bundle.windows.digestAlgorithm: "sha256"`、`bundle.windows.tsp: true`；不在仓库内写入任何证书指纹或密钥。

2. **共享安全、脱敏、预检与证据模块（`scripts/signing/common.mjs`）**
   - `redactSecrets(text, extraSecrets)`：统一脱敏环境密钥值、PEM 私钥块、Base64 证书内容、Bearer/Basic 凭据与命令行密钥参数。
   - `preflightSigning({ platform, mode, env })`：校验当前平台与发版模式所需 CI 秘密；正式发版（`release`）或未允许无签名候选的调度运行（`candidate-signed`）缺任何必需凭据时，输出脱敏后的缺失变量清单并以非零退出码 fail-closed，绝不降级成未签名产物，也不自动购买证书或创建账户（AC-2、AC-3、AC-5）。
   - `writeSigningEvidence` / `writeSigningErrorEvidence`：生成包含产物 SHA-256 哈希、平台验签输出、发布者信息与 `releaseAuthorized: false` 声明的 JSON 证据及 `SHA256SUMS-<platform>.txt`（AC-7、AC-8）。

3. **macOS 签名、嵌套检查、公证与装订（`scripts/signing/macos.mjs`、`scripts/signing/macos-notarize.mjs`）**
   - **打包与自包含校验**：构建流水线先执行 `pnpm build:core`、`pnpm package:host`、`build funasr sidecar`、`fetch:ffmpeg`、`fetch:shared-assets`、`fetch:subtitle-fonts`，再以 `tauri build --bundles app --no-sign` 产出干净 `.app`，避免 Tauri 提前对未签嵌套资源的外层签名造成冲突。随后递归扫描 `Contents/MacOS`、`Contents/Frameworks`、`Contents/Resources/binaries` 与 `Contents/Resources/host` 内全部 Mach-O 文件与 `.node`/`.dylib`/`.so`（含 `flycut-node`、`funasr-asr`、`ffmpeg` 与 `@napi-rs/canvas` 的 `skia.*.node`）。通过 `otool -L` + `otool -D`（排除 dylib 自身 `LC_ID_DYLIB`）阻断 Homebrew/未随包 `@rpath` 依赖（正式发版严格阻断，本地无证书候选冒烟可显式传入 `--allow-dev-dylibs` 仅用于非分发测试）。
   - **临时钥匙串与由内向外签名**：仅在 `withTemporaryKeychain` 作用域内创建随机临时钥匙串、导入 `.p12` 并设置 `codesign` 分区列表；按嵌套深度倒序签名，`flycut-node` 绑定 `host-node.plist`，其余随包二进制/扩展绑定 `--options runtime --timestamp`，最后签主二进制与 `.app`，并在 `finally` 中还原钥匙串搜索列表且销毁临时钥匙串与 `.p12`（AC-1、AC-3、AC-8）。
   - **嵌套签名验证与 DMG 打包**：逐件校验 `codesign --verify --strict` 与 `codesign -dv`（断言非 `adhoc`、带 `runtime` 标志、含时间戳、`TeamIdentifier` 一致），再用 `hdiutil create` 生成带 `Applications` 软链的 `.dmg` 并签名。
   - **幂等公证状态机**：支持 App Store Connect API Key（`.p8` 临时写入 `0600` 并在 `finally` 删除）或 Apple ID + App-Specific Password。若传入 `FLYCUT_NOTARY_SUBMISSION_ID` 或存在同哈希状态文件，先调用 `xcrun notarytool info <id>` 查验：`Accepted` 直接进入 `staple`；`In Progress` 继续等待；`Invalid`/`Rejected` 拉取 `notarytool log` 并阻断，绝不重复提交掩盖失败。新提交使用 `submit --no-wait --output-format json` 立即落盘 `submissionId`，轮询直到完成或超时（超时保留 `submissionId` 以便安全重试并阻断发布，AC-6）。通过后对 `.dmg` 与 `.app` 执行 `xcrun stapler staple`、`xcrun stapler validate` 与 `spctl -a -vv`（AC-1、AC-7）。

4. **Windows 代码签名与时间戳验证（`scripts/signing/windows.mjs`）**
   - 构建前准备完 `binaries/*.exe` 与 `host` 后，使用 PowerShell `Import-PfxCertificate`（通过环境变量传入 `SecureString`，密码不进入任何进程参数）将 `.pfx` 导入临时证书存储 `Cert:\CurrentUser\My`，并在 `finally` 中无条件移除证书与临时 `.pfx`（AC-3、AC-8）。
   - 先签名预置 `binaries/*.exe`（`flycut-node.exe`、`funasr-asr.exe`、`ffmpeg.exe`）及 `host/**/*.{node,dll}`，再通过临时 Tauri 配置覆写（`bundle.windows.certificateThumbprint`、`digestAlgorithm: "sha256"`、`timestampUrl`、`tsp: true`）运行 `tauri build` 签名主程序与 `.msi`/`-setup.exe`。
   - 使用 `signtool.exe verify /pa /v` 与 PowerShell `Get-AuthenticodeSignature` 逐件核验 `Status == Valid`、存在 RFC 3161 时间戳证书、且 `SignerCertificate.Subject` 与 `WINDOWS_EXPECTED_PUBLISHER` 一致（AC-2、AC-7、AC-8）。

5. **CLI 入口、CI 发版流水线、本地发版闸门与运维手册**
   - 新增统一入口 `scripts/release-signing.mjs`（子命令：`preflight`、`macos`、`windows`、`verify-release-artifacts`）。
   - 改造 `.github/workflows/release.yml`：
     - 新增 `preflight` 作业：`refs/tags/v*` 强制校验两平台签名/公证凭据齐全；`workflow_dispatch` 默认 `allow_unsigned_candidate: false`（同样严格 fail-closed），仅当手动显式勾选 `allow_unsigned_candidate: true` 时标记产物为 `unsigned-candidate` 并跳过 `release` 发布作业。
     - `build` 矩阵补齐 `pnpm build:core` 与 `pnpm package:host`，分别调用 `scripts/release-signing.mjs macos|windows`；失败时由 `if: always()` 上传脱敏错误证据与日志，临时凭据仍在脚本 `finally` 与兜底清理步骤中清除。
     - `release` 作业下载双平台产物后，先运行 `verify-release-artifacts` 校验 `signing-evidence-*.json` 均为 `signed: true` & `verified: true` 且 `SHA256SUMS` 完整校验通过，才执行 `softprops/action-gh-release@v2`，并随 Release 附带校验和与验签证据。
   - 更新 `scripts/release.mjs`：在打 tag 前静态校验 `tauri.conf.json`、`src-tauri/entitlements/*.plist` 与 `.github/workflows/release.yml` 发版门禁配置完整性。
   - 新增运维手册 `docs/40-ops/runbooks/desktop-signing-notarization.md`：说明必需 Secrets、公证超时后使用 `FLYCUT_NOTARY_SUBMISSION_ID` 安全续接方式、双平台本地/干净环境验收流程，并明确遵守 AC-3（不提供关闭 Gatekeeper 的安装指引，不承诺 Windows SmartScreen 信誉提示立即消失）。

### 接口与数据

- 无 Host RPC、项目格式或前端 store 接口变更；保持既有 `ensure_host`、`ModelRef` 与导出路径契约不变。
- 新增发版证据契约 `signing-evidence-<platform>.json` 与 `notary-submission.json`（只含非敏感元数据、SHA-256 与脱敏验证输出）。
- 环境变量接口（CI Secrets）：
  - macOS：`APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_API_KEY` + `APPLE_API_ISSUER` + `APPLE_API_KEY_ID`（或 `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID`）、可选 `APPLE_SIGNING_IDENTITY`、可选 `APPLE_EXPECTED_TEAM_ID`、重试用 `FLYCUT_NOTARY_SUBMISSION_ID`。
  - Windows：`WINDOWS_CERTIFICATE`、`WINDOWS_CERTIFICATE_PASSWORD`、可选 `WINDOWS_TIMESTAMP_URL`（默认 `http://timestamp.digicert.com`）、可选 `WINDOWS_EXPECTED_PUBLISHER`。

### 备选方案与取舍

| 方案 | 优点 | 缺点 | 取舍 |
|---|---|---|---|
| 由内向外显式签名脚本 + 临时钥匙串/证书存储（采用） | 覆盖 `bundle.resources` 全部可执行与 `.node` 资源；JIT 权限仅给 `flycut-node`；公证可查询重试；核心逻辑可单测 | 需维护跨平台脚本 | 满足 AC-1/2/3/5/6/7/8 全量要求 |
| 仅配置 Tauri 内置 `APPLE_CERTIFICATE` / `signCommand` | 配置较少 | 漏签 `Contents/Resources` 下的 `flycut-node`、`ffmpeg`、`funasr-asr` 与 `skia.*.node`；公证超时缺幂等查询 | 不采用 |
| 禁用 Hardened Runtime 或要求用户 `xattr -cr` | 绕过系统检查 | 无法公证且违反系统安全策略（违反 AC-1/AC-3/AC-8） | 明确禁止 |

## 架构决策

- [ADR-0012 桌面安装包签名、公证与发版门禁边界](../../20-architecture/adr/0012-desktop-signing-notarization.md)（status: `proposed`，待维护者验收时确认）

## 自行决定的事项

- macOS 公证鉴权同时支持 App Store Connect API Key（`.p8`，CI 推荐）与 Apple ID + App-Specific Password，便于维护者按既有 Apple 账户形态配置。
- macOS `flycut-node` 仅授予 `allow-jit` 与 `allow-unsigned-executable-memory`，不开启 `disable-library-validation`，前提是由内向外将 `@napi-rs/canvas` 等全部 `.node` 模块用同一 Team ID 签名，使权限面保持最小。
- macOS `.dmg` 在签完 `.app` 后由脚本以 `hdiutil create` 组装并再次签名公证，避免在无头 CI Runner 上依赖 Finder AppleScript 导致偶发超时。
- `workflow_dispatch` 默认要求签名凭据齐全，仅当显式传入 `allow_unsigned_candidate: true` 时允许产出一份明确标注为 `unsigned-candidate` 的测试包并跳过 Release 发布作业。
- 本地无签名证书时，AC-9 的界面核验复用既有导入/识别/导出对话框，通过 `tests/e2e/features/F-0057.spec.ts` 在浅色/深色与中/英文下核验并留存截图。

## 风险与回退

- 真实签发证书、公证服务、Windows 代码签名环境在本工作机均不可用；配置错误或第三方时间戳/公证服务器抖动将在首次配置 Secrets 后通过 `workflow_dispatch` 暴露，回退只需修复对应脚本或暂不打正式 `v*` tag。
- 所有脚本新增与修改仅作用于发版与打包路径，不改动编辑器、Host 业务与项目存储格式，回退无数据迁移风险。

## 实现清单

- [x] 1. 签名基础契约与配置：新增 entitlements plist、更新 `tauri.conf.json`，实现 `scripts/signing/common.mjs`（脱敏、预检 fail-closed、哈希与证据输出）。
- [x] 2. macOS 签名与自包含检查：实现 `scripts/signing/macos.mjs`（Mach-O/`.node` 递归发现、`otool -L`/`-D` 校验、临时钥匙串隔离与 `finally` 清理、由内向外签名与嵌套校验、DMG 打包与签名）。
- [x] 3. macOS 幂等公证、装订与验证：实现 `scripts/signing/macos-notarize.mjs`（API Key / Apple ID 支持、`info` 先行查验、超时保留 `submissionId`、拒绝留证阻断、`stapler` + `spctl` 验证）。
- [x] 4. Windows 代码签名与验证：实现 `scripts/signing/windows.mjs`（临时证书存储导入与 `finally` 清理、预置二进制与安装包签名、`signtool verify` + `Get-AuthenticodeSignature` + 时间戳/发布者校验）。
- [x] 5. 发版流水线、本地闸门与运维文档：实现 `scripts/release-signing.mjs`、改造 `.github/workflows/release.yml` 与 `scripts/release.mjs`、编写 `docs/40-ops/runbooks/desktop-signing-notarization.md`。
- [x] 6. 自动化测试与界面证据：编写 `tests/release-signing.test.mjs` 与 `tests/e2e/features/F-0057.spec.ts`，运行全量静态检查、单测、架构测试与 `PW_PORT=5195 pnpm e2e:evidence F-0057`。

## 验证计划

| AC | 目标平台与入口 | 检查命令与断言 | 真实环境/缺口说明 |
|---|---|---|---|
| AC-1 | macOS 脚本 + 本地资源（`tests/release-signing.test.mjs`） | `pnpm test`：断言 entitlements、嵌套 Mach-O/`.node` 发现与顺序、`otool` 校验、签名验证解析；本机运行 `otool -L` 检查 `funasr-asr` 与 `skia.darwin-arm64.node` | 本机无 Developer ID 证书，真实 `codesign`/公证/装订在测试报告记为 `⏸ Not run` |
| AC-2 | Windows 脚本（`tests/release-signing.test.mjs`） | `pnpm test`：断言 PE/installer 发现、缺凭据/时间戳/发布者不匹配时 fail-closed 阻断 | 本机无 Windows 环境与代码签名证书，真实 `signtool` 签名与验证记为 `⏸ Not run` |
| AC-3 | 共享脱敏与临时凭据管理（`tests/release-signing.test.mjs`） | `pnpm test`：断言密钥脱敏、命令行不含密码、成功/异常后临时钥匙串与证书均清理、runbook 与脚本不含关闭系统安全检查或承诺信誉消失的文案 | 无 |
| AC-4 | 发版脚本与门禁（`tests/release-signing.test.mjs`、`scripts/release.mjs`） | `pnpm test`：断言测试候选与正式发版路径隔离、`release.yml` 正式发布仅由 `v*` tag 触发 | 无开发环境的干净 Mac/Windows 安装导入-转写-导出实机验证记为 `⏸ Not run` |
| AC-5 | 预检与界面（`tests/release-signing.test.mjs`、`tests/e2e/features/F-0057.spec.ts`） | `pnpm test` 验证缺凭据时输出脱敏缺失项并阻断；Playwright 验证应用无签名/CI日志页面 | 无 |
| AC-6 | macOS 公证状态机（`tests/release-signing.test.mjs`） | `pnpm test`（注入 mock `xcrun`）：断言日志状态脱敏、超时保留 `submissionId`、重试先调 `info` 再决定等待/装订而非重复 `submit` | 真实 Apple 公证服务联调记为 `⏸ Not run` |
| AC-7 | 成功证据与校验和（`tests/release-signing.test.mjs`） | `pnpm test`：断言生成 `SHA256SUMS` 与验签证据 JSON（含发布者信息、`releaseAuthorized: false`） | 真实签发产物证据记为 `⏸ Not run` |
| AC-8 | 失败门禁与清理（`tests/release-signing.test.mjs`） | `pnpm test`：断言嵌套签名无效、公证拒绝、Windows 签名/时间戳失败均抛出阻塞并产出脱敏错误证据，且清理临时钥匙串/证书文件 | 无 |
| AC-9 | Web E2E（`tests/e2e/features/F-0057.spec.ts`） | `PW_PORT=5195 pnpm e2e:evidence F-0057`：在浅色/深色与中/英文下覆盖既有导入、识别进入编辑与导出对话框状态并生成截图 | 真实干净 Mac/Windows 安装运行记为 `⏸ Not run` |

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | `src-tauri/entitlements/*.plist`、`src-tauri/tauri.conf.json`、`scripts/signing/macos.mjs`、`scripts/signing/macos-notarize.mjs` |
| AC-2 | `src-tauri/tauri.conf.json`、`scripts/signing/windows.mjs`、`.github/workflows/release.yml` |
| AC-3 | `scripts/signing/common.mjs`（脱敏）、`macos.mjs`/`windows.mjs`（临时凭据与 `finally` 清理）、`docs/40-ops/runbooks/desktop-signing-notarization.md` |
| AC-4 | `.github/workflows/release.yml`（候选 vs `v*` tag）、`scripts/release.mjs`、`docs/40-ops/runbooks/desktop-signing-notarization.md` |
| AC-5 | `scripts/signing/common.mjs`（`preflightSigning`）、无产品内签名页面（`tests/e2e/features/F-0057.spec.ts` 验证） |
| AC-6 | `scripts/signing/macos-notarize.mjs`（提交/轮询状态日志、超时保留 `submissionId`、重试先查 `info`） |
| AC-7 | `scripts/signing/common.mjs` & `scripts/release-signing.mjs`（`SHA256SUMS`、平台验签证据、`releaseAuthorized: false`） |
| AC-8 | `scripts/signing/*` 与 `.github/workflows/release.yml`（失败门禁、错误证据留存、`finally` 与 `if: always()` 清理） |
| AC-9 | `tests/e2e/features/F-0057.spec.ts`（既有导入/识别/导出明暗主题与中英文状态截图）、真实机安装项按实际环境记录 |

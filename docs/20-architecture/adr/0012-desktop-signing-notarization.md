---
id: ADR-0012
status: proposed     # proposed → accepted → superseded / deprecated
date: 2026-11-13
deciders:
feature: F-0057
superseded_by:
---

# ADR-0012 桌面安装包签名、公证与发版门禁边界

## 背景

FlyCut Caption 桌面端除了主进程 `flycut-caption`（Tauri/Rust）外，还在 `Contents/Resources`（macOS）与安装目录（Windows）随包分发多个可执行文件与原生模块：`binaries/flycut-node`、`binaries/funasr-asr`、`binaries/ffmpeg`，以及 `host/node_modules/@napi-rs/canvas-*` 下的 `.node` 原生扩展。

Tauri 默认打包不会为 `bundle.resources` 下的嵌套二进制和 `.node` 模块逐个施加 macOS Hardened Runtime 与按二进制区分的 entitlements；若把未签名或 adhoc 签名的嵌套二进制送交 Apple 公证会被拒绝，若给所有二进制统一开启 JIT 权限又会无谓扩大攻击面。同时，签发密钥与公证凭据属于发布期敏感资产，不能进入仓库、构建日志、错误证据或进程命令行参数。

## 决策

桌面安装包签名与公证采用**资源自包含检查 + 由内向外隔离签名 + 幂等公证状态机 + 缺凭据 fail-closed 发版门禁**：

1. **随包二进制由内向外签名与最小权限 entitlements**：
   - macOS 构建先产出未签 `.app`，由 `scripts/release-signing.mjs` 检查所有 Mach-O 二进制与 `.node`/`.dylib` 的依赖自包含性（禁止引用 `/opt/homebrew/`、`/usr/local/` 或未随包 `@rpath`），随后由内向外逐一用 `--force --options runtime --timestamp` 签名，最后签名 `Contents/MacOS/flycut-caption`、`.app` 与 `.dmg`。
   - 仅 `binaries/flycut-node` 使用 `src-tauri/entitlements/host-node.plist`（授予 V8 JIT 所需的 `allow-jit` 与 `allow-unsigned-executable-memory`）；主应用使用最小化 `src-tauri/entitlements/app.plist`，`funasr-asr`、`ffmpeg` 与 `.node` 不授予 JIT 权限。
   - Windows 构建先签名预置 `binaries/*.exe` 与 `host/**/*.{node,dll}`，再通过 Tauri 配置覆写（证书指纹 + SHA-256 + RFC 3161 时间戳）签名主程序与 `.msi`/`-setup.exe` 安装包，最后用 `signtool verify /pa` 与 `Get-AuthenticodeSignature` 逐件核验发布者与时间戳。
2. **临时凭据生命周期与零命令行密钥**：
   - macOS 使用每次运行的临时钥匙串，Windows 使用 `PowerShell Import-PfxCertificate` 将证书导入 `Cert:\CurrentUser\My` 后按指纹签名，避免密码出现在 `signtool` 命令行参数中；`try ... finally` 保证无论成功或失败都删除临时钥匙串、证书与密钥文件，并对所有日志与错误证据执行脱敏。
3. **幂等公证状态机**：
   - 存在已有 `submissionId`（环境变量或状态文件）时，先执行 `xcrun notarytool info` 查验状态，仅在未提交过时才调用 `submit --no-wait`；超时保留 `submissionId` 并阻断发布，拒绝不重新提交掩盖结果。
4. **Fail-closed 发版门禁与边界**：
   - 正式发版（`refs/tags/v*`）缺少任一签名/公证凭据或任一嵌套二进制/时间戳/装订验证失败时立即阻断；`workflow_dispatch` 仅在显式勾选 `allow_unsigned_candidate` 时才允许产出带 `unsigned-candidate` 标记的测试包，且绝不进入正式 Release 发布作业。
   - 不在应用内增加签名页面，不提供绕过 Gatekeeper/SmartScreen 的指引。

## 备选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| 由内向外显式签名脚本 + fail-closed 门禁（采用） | 完全覆盖 `bundle.resources` 内的 Node/sidecar/FFmpeg/Skia `.node`，权限最小化，公证可查询重试，单测可覆盖状态机与脱敏 | 需维护跨平台签名脚本与单元测试 |
| 仅依赖 Tauri `APPLE_CERTIFICATE` 自动签名 | 配置最少 | 不覆盖 `bundle.resources` 中的 `flycut-node`、`ffmpeg`、`funasr-asr` 与 `skia.*.node`，容易导致公证拒绝或 Hardened Runtime 加载失败 |
| 关闭 Hardened Runtime 或引导用户 `xattr -cr` | 无需处理签名与权限 | 无法通过 Apple 公证，违反系统安全策略与 F-0057 AC-1/AC-3/AC-8 |

## 后果

- 正式版本发版前必须配置 Apple Developer 签名/公证凭据与 Windows 代码签名凭据，否则 `release.yml` 会在前置阶段阻断发布。
- `scripts/release.mjs` 在本地打 tag 前校验发版流水线与 entitlements 配置完整性，CI 侧则负责持密签名、公证、验签与生成校验和/证据清单。
- 本 ADR 在维护者完成 F-0057 验收前保持 `proposed`。

# 桌面安装包签名、公证与发版运维手册

本手册用于配置、排查和验收 FlyCut Caption 的 macOS / Windows 安装包签名、Apple 公证与发版门禁（对应 F-0057 与 [ADR-0012](../../20-architecture/adr/0012-desktop-signing-notarization.md)）。

## 1. 受控 CI Secrets 清单

所有证书与私钥只存放在受控 GitHub Actions Secrets 中，禁止写入仓库或任何构建日志。

### macOS（Apple Developer）

- `APPLE_CERTIFICATE`：Developer ID Application `.p12` 证书的 Base64 编码。
- `APPLE_CERTIFICATE_PASSWORD`：导出 `.p12` 的密码。
- 公证鉴权（二选一，推荐 App Store Connect API Key）：
  - **API Key 模式**：`APPLE_API_KEY`（`.p8` 原文或 Base64）、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`。
  - **Apple ID 模式**：`APPLE_ID`、`APPLE_PASSWORD`（App 专用密码）、`APPLE_TEAM_ID`。
- 可选校验项：
  - `APPLE_SIGNING_IDENTITY`：证书存在多个签名身份时显式指定名称。
  - `APPLE_EXPECTED_TEAM_ID`：校验签名产出与维护者证书的 Team ID 一致。
  - `FLYCUT_NOTARY_SUBMISSION_ID`：公证等待超时后，重跑前填入上一次保留的 Submission ID，脚本会先查询状态而不会重复提交。

### Windows（Authenticode）

- `WINDOWS_CERTIFICATE`：代码签名 `.pfx` 证书的 Base64 编码。
- `WINDOWS_CERTIFICATE_PASSWORD`：`.pfx` 密码（通过临时 `Cert:\CurrentUser\My` 导入与环境变量传递，不进入命令行参数）。
- 可选校验项：
  - `WINDOWS_TIMESTAMP_URL`：RFC 3161 时间戳服务器，默认 `http://timestamp.digicert.com`。
  - `WINDOWS_EXPECTED_PUBLISHER`：期望的证书 Subject 子串，用于验签阶段核对发布者身份。

## 2. 发版门禁与候选构建

- **正式发版**：必须先在维护者确认后运行 `pnpm release`（由本地校验一致性、CI 绿灯后推送 `v*` tag）。`release.yml` 在 `refs/tags/v*` 下强制执行 `release` 签名模式，缺少任何必需 Secrets、嵌套二进制检查失败、公证拒绝/超时或 Windows 时间戳失败都会立即阻断发布。
- **手动候选包**：在 GitHub Actions 手动运行 `release` workflow 时，默认要求签名凭据齐全（`candidate-signed`）。仅在明确勾选 `allow_unsigned_candidate: true` 时才会产出带 `unsigned-candidate` 名称的测试包，且绝不会触发 Release 发布作业。

## 3. macOS 公证超时与安全重试

1. 每次提交公证都会在日志输出脱敏后的 `submissionId`，并在失败产物 `flycut-caption-signing-errors-macos-arm64` 中保存 `notary-submission.json` 与 `signing-error-macos-arm64.json`。
2. 若发生超时（`NOTARIZATION_TIMEOUT`），先从日志或错误证据中取得 `submissionId`，可通过 `xcrun notarytool info <submissionId>` 确认处理进度，或在重跑时设置 `FLYCUT_NOTARY_SUBMISSION_ID=<submissionId>`：脚本会先查 `info`，若已 `Accepted` 直接执行 `stapler staple` 与验签，不重复提交；若为 `Invalid`/`Rejected`，会拉取脱敏日志并保持阻断。

## 4. 真实干净系统安装与安全提示说明

- **macOS**：安装签名并装订票据的 `.dmg` / `.app` 时，系统应直接通过 Gatekeeper 校验并正常启动完成导入、识别与导出。禁止在用户文档或故障指引中添加关闭 Gatekeeper（如 `spctl --master-disable` 或引导用户执行 `xattr -cr`）的绕过操作。
- **Windows**：使用有效代码签名证书与 RFC 3161 时间戳签名的安装包可验证发布者信息；但普通 OV/新签发证书在累计下载信誉前仍可能触发 Windows Defender SmartScreen 提示，本手册与发布说明不承诺安装后 SmartScreen 提示立即消失，也不引导用户关闭系统安全策略。

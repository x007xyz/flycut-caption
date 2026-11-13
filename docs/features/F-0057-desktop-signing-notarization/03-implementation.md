---
id: F-0057
stage: 03-implementation
status: approved
approved_by: auto
approved_at: 2026-11-13
---

# F-0057 桌面安装包签名与公证：开发记录

## 分支与 PR

- 分支：codex/f0057-desktop-signing
- PR：

## 进度

<!-- 每完成实现清单的一项，在 02-design.md 勾选，并在这里追加一行：日期、清单项、提交 sha、跑过的检查。
换会话接着做时，先读 02-design.md 和这里。 -->

| 日期 | 清单项 | 提交 | 检查 |
|---|---|---|---|
| 2026-11-13 | 1. 签名基础契约与配置 | cc0f8ba | plutil -lint, node --check, cargo check |
| 2026-11-13 | 2. macOS 签名与自包含检查 | 1a55734 | node --check scripts/signing/macos.mjs |
| 2026-11-13 | 3. macOS 幂等公证、装订与验证 | 04842ac | node --check scripts/signing/macos-notarize.mjs |
| 2026-11-13 | 4. Windows 代码签名与验证 | 8d53d8d | node --check scripts/signing/windows.mjs |
| 2026-11-13 | 5. 发版流水线、本地闸门与运维文档 | 2699979 | node --check scripts/release-signing.mjs && release.yml YAML |
| 2026-11-13 | 6. 自动化测试与界面证据 | pending | lint, tsc, check:host, cargo check, pnpm test (117/122), test:architecture (145/145), e2e:evidence F-0057 (3/3) |

## 自行决定的事项

- 继承设计阶段决定：macOS 公证同时支持 App Store Connect API Key 与 Apple ID 鉴权；`flycut-node` 仅开 `allow-jit` + `allow-unsigned-executable-memory`；`.dmg` 用 `hdiutil create` 组装后再签名公证；`workflow_dispatch` 默认 `allow_unsigned_candidate: false`；`F-0057.spec.ts` 复用既有导入/识别/导出对话框检查明暗主题与中英文。
- 新增实现决定：在 `scripts/signing/macos.mjs` 的依赖自包含校验中通过 `otool -D` 排除 `.node`/`.dylib` 自身的 `LC_ID_DYLIB` 安装名（如 `skia.darwin-arm64.node` 携带的构建机路径 `libcanvas.dylib`），避免误报同时仍严格拦截外部 `/opt/homebrew`、`@rpath` 或缺失路径依赖（影响 AC-1）。
- 新增实现决定：在 `scripts/signing/windows.mjs` 中采用 PowerShell `Import-PfxCertificate` 导入临时证书存储 `Cert:\CurrentUser\My` 并按指纹调用 `signtool /sha1`，避免 PFX 密码出现在任何命令行参数中（影响 AC-2、AC-3、AC-8）。

## 与设计的偏差

无重大偏差。本地无签名证书时，在真实打包产物 `FlyCut Caption.app` 上执行了 `discoverMacSignTargets`、`checkMacSelfContainment` 与 `release-signing.mjs preflight` 实机验证；真实签发、公证装订与干净双平台安装将在测试报告如实标注为 `⏸ Not run`。

## 遗留问题

- 待维护者在 GitHub Actions 配置 Apple Developer 与 Windows 代码签名 Secrets 后，首次通过 `workflow_dispatch` 验证真实签名与公证/装订产物，并在真实干净 Mac/Windows 设备完成 AC-4 / AC-9 实机安装导入-识别-导出闭环。

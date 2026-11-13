---
id: F-0057
stage: 03-implementation
status: draft
approved_by:
approved_at:
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
| 2026-11-13 | 5. 发版流水线、本地闸门与运维文档 | pending | node --check scripts/release-signing.mjs && release.yml YAML |

## 自行决定的事项

<!-- 开发中自己决定的事：决定了什么、为什么、影响哪条 AC。验收时汇总进测试报告 -->

## 与设计的偏差

<!-- 实现时改变了设计的地方及原因；重大偏差回到 02-design.md 修改，并记进测试报告 -->

## 遗留问题

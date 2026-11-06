---
name: fc-release
description: FlyCut 按版本发布：把已验收、还没发布的需求和其他提交一起整理成版本发布文档 docs/40-ops/releases/vX.Y.Z.md，运行发版闸门，维护者同意后打 tag，发布后归档需求。用户说「发布」「发版」「出个版本」时使用。
---

# 版本发布

发布按版本做：一个版本带上这段时间验收通过的所有需求，不再给每个需求单独写发布文档。

1. `pnpm feature status` 看「待发布（已验收）」列表；`git log <上一个 tag>..HEAD --oneline` 看其他修复和小改动。
2. 确定版本号（和维护者对一下：新功能升 minor，只有修复升 patch），运行 `pnpm feature release-notes v<版本>`，脚本创建 `docs/40-ops/releases/v<版本>.md` 并填好需求列表。
3. 填写：其他修复和小改动、面向用户的发布说明（中英文）、平台和回滚方案。
4. 版本号要同步改 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 三处，改完跑一次 `cargo check`（见 `LESSONS.md`）。
5. 运行 `pnpm release --dry-run`，把输出贴进「发版闸门」。有未通过的检查就停下来报告，不要绕过。
6. **停下来请维护者同意发版。** 真正打 tag（`pnpm release`）会触发对外发布，必须等维护者在对话里明确同意。
7. 发布完成后：在文档 frontmatter 写上 `tag`，`status` 改为 `released`；运行 `pnpm feature archive <编号...> --release v<版本>` 归档这次带上的需求。
8. 发布后的观察和复盘用 `fc-retro`，写在同一份版本文档里。

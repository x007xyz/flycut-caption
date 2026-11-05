---
name: fc-release
description: FlyCut 需求流程阶段 7：为验收通过的需求准备发布，写 07-release.md 并运行发版闸门。用户说「发布」「发版」时使用。
---

# 阶段 7：发布

1. 确认 `06-test-report` 已 `approved`。
2. 填写 `07-release.md`：版本号、面向用户的发布说明、发布平台（macOS / Windows / Web / npm 组件库）、回滚方案。
3. 先运行 `pnpm release --dry-run`，把输出贴进「版本」一节。有未通过的检查就停下来报告，不要绕过。
4. 真正打 tag（`pnpm release`）会触发对外发布，**必须等维护者在对话里明确同意后才执行**。
5. 发布完成后在文档里记录 tag 和 release 链接。

## 通用规则

- 先读 `docs/00-process/README.md`（阶段、编号、闸门）和 `AGENTS.md`。
- 用 `pnpm feature status <F-编号>` 确认当前阶段就是本阶段且状态是 `draft`；不是就停下，告诉维护者当前状态和下一步。
- 只编辑本阶段的文件。发现前面阶段的文档有错，停下来告诉维护者，由维护者决定是否退回修改。
- 写完后运行 `pnpm feature review <F-编号>`，然后**停下来请维护者确认**，用几句话总结本阶段的要点和待决问题。
- **不要自己运行 `approve` 或 `skip`。** 只有维护者在对话里明确确认（例如「确认」「通过」「可以进入下一步」）后，才运行 `pnpm feature approve <F-编号> --by <维护者>`，再运行 `pnpm feature next <F-编号>`。维护者说本阶段不需要时，才用 `skip`，并写明原因。

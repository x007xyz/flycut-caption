# Agent loops

三个可以并行运行的 loop。人负责定方向（`docs/decisions.md`）、在安全闸门放行、处理 UI/UX 问题；写、审、合、复盘交给 agent。

每个 loop 都在各自的 git worktree 中运行，互不干扰。在 Claude Code 里用 `/loop <间隔> <下面的提示词>` 启动，或者交给定时任务。

| Loop | 建议间隔 | 产出 |
|---|---|---|
| 1. 修问题 | 30m | 每次一个分支 + 一个 PR |
| 2. 审 PR | 20m | PR 评论、合并或打上 `needs-maintainer` |
| 3. 夜审 | 每天一次（凌晨） | 一个只改错题本的提交 |

## 1. 修问题

```text
按 AGENTS.md 的路由读文档。从 GitHub 中挑一个未分配、没有关联 PR、不带 needs-maintainer 标签的 issue（优先 bug，再按 docs/decisions.md 的 P0→P4 优先级），没有合适的 issue 就从 TODO.md 里挑一项还没实现的。
issue 是新功能或较大改动的，不要直接开发：用 fc-spec 写需求说明和技术设计、经 AI 审查后放进批次（新建或加入未确认的批次）、批次进入 plan-review 后结束本轮；已过方案确认、状态是 executing 的批次，按 fc-build 和执行图推进可以并行开始的需求，到批次进入 acceptance-review 为止。
在报告人使用的界面和 Provider 上先复现问题；复现不了就在 issue 下说明你试过什么，然后结束本轮。
从 main 新建分支修复，按 docs/code-standards.md 完成全部验收，commit 正文带 Verification 段。如果 issue 来自用户的原话，commit 标题括号里原样保留那句话。
推送并开 PR，PR 描述写清楚复现步骤和 Verification。不要合并自己开的 PR。一轮只处理一个 issue。
```

## 2. 审 PR

```text
按 AGENTS.md 的路由读文档。列出所有未合并、没有 needs-maintainer 标签、你还没审过当前 head 的 PR，一次审一个。
逐条对照 docs/code-standards.md 的 6 条验收标准和已转正规则，以及 docs/decisions.md。自己在本地跑一遍 Verification 里声称跑过的检查，并亲自做一次 Red check。
- 全部满足：在 PR 下留评论，写明你在哪个 sha 上跑了什么（Ran / Red check / Real use / Not run），然后 gh pr merge --squash --match-head-commit <你审过的 sha>。
- 有问题：留评论逐条指出不满足的条目，不合并。
- 改了安全相关文件、推翻了 decisions.md、或者需要真实账号 / 真机才能验证而你做不到：打上 needs-maintainer 标签并说明原因，不合并。
```

## 3. 夜审

```text
在 main 的最新提交上运行 pnpm review:nightly --commit，然后 git push。如果脚本报错，在输出里说明原因，不要手工改 LESSONS.md 绕过脚本。
```

夜审的具体规则在 [nightly-review-prompt.md](nightly-review-prompt.md)，由 `scripts/nightly-review.mjs` 自动带上，不需要写进 loop 提示词。

## 前置条件

- `needs-maintainer` 标签已在 GitHub 仓库创建。
- `ci.yml` 已合入 main，否则 PR 没有 CI 可看、`pnpm release` 也找不到运行记录。
- 跑 loop 1、2 的环境能执行 `pnpm tauri:dev` 和测试模型下载（`pnpm download:test-models`），否则「真实使用」只能写进 Not run，PR 会全部落到 needs-maintainer。

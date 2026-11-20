---
id: F-0032
stage: 03-implementation
status: approved
approved_by: auto
approved_at: 2026-11-17
---

# F-0032 项目术语表与译名一致性：开发记录

## 分支与 PR

- 分支：`codex/baseline-20261113`（工作区直接实现；本会话未获提交授权，没有创建 commit 或 PR）
- PR：无

## 进度

| 日期 | 清单项 | 提交 | 检查 |
|---|---|---|---|
| 2026-11-16 | 1. 共享契约与不一致判断 | 未提交 | `tests/architecture/terminology-translation-f0032.test.ts` ✅（2 项） |
| 2026-11-16 | 2. 翻译链路与面板版本/徽标 | 未提交 | `pnpm tsc -b --noEmit` ✅；E2E 版本断言 ✅ |
| 2026-11-16 | 3. 术语表译名编辑 | 未提交 | `PW_PORT=5213 pnpm e2e:evidence F-0032` ✅ 4/4 |
| 2026-11-16 | 4. 真实 API 与 E2E | 未提交 | `pnpm acceptance:f0032` ✅ 英文 5/5、日文 2/2；截图 12 张 |

## 自行决定的事项

- 译名用「每行 语言=译名」文本格式，支持多语言一次编辑。
- 英文不一致判断忽略大小写并接受简单复数（`subtitle`/`subtitles`、`glossary`/`glossaries`）。
- 术语版本在每次翻译运行开始时捕获；运行中改词表进入 stale，不自动合并旧响应。
- 不做自动替换或自动重译，只在面板标记，由用户核对。

## 与设计的偏差

- 设计中的「逐条徽标」在草稿行实现；不一致汇总列出 id 和缺失源词。
- 真实 API 用 opencode go `deepseek-v4.1-flash`，需要 `x-opencode-session` 请求头；AI 设置已增加自定义请求头字段。

## 遗留问题

- 未跑 Tauri 桌面与 Windows/Cloud；真实 API 在 Node Host 环境验证，E2E 在 Chrome 完成。
- 未提交 commit：本会话未获得 git 提交授权。

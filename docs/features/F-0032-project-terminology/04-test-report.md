---
id: F-0032
stage: 04-test-report
status: approved
approved_by: zhangxiang.chen
approved_at: 2026-11-17
---

# F-0032 项目术语表与译名一致性：测试与验收

验收在 **工作区（HEAD `bf58f93` + 未提交改动）** 上进行；本会话未获提交授权，提交后需按新 commit 重跑回归。

## 设计与实现摘要

- 复用 F-0019 的项目术语表 `ProjectTermEntry.translations`，热词弹窗新增「每行 语言=译名」编辑、校验和 chip 展示。
- 翻译请求新增 `terms`，system prompt 要求模型使用指定译名；翻译面板显示「术语表 vN · M 条」。
- 新增 `findTerminologyIssues`：源文含源词但译文缺少对应译名时标记，不自动替换；术语版本在运行开始时捕获，运行中变更进入 stale。
- 真实 API 使用 opencode go `deepseek-v4.1-flash`（自定义 `x-opencode-session` 请求头）。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| 译名输入格式 | `en=Subtitle` 每行一条 | 一次编辑多语言，不新增复杂表格 | AC-1 |
| 英文不一致判断 | 忽略大小写 + 简单复数 | 避免把 `glossaries` 误报 | AC-3 |
| 版本变化 | stale，阻止应用 | 旧响应基于旧词表 | AC-4 |
| 不自动替换 | 只标记 | 避免破坏语境 | AC-3 |

## 验收标准逐条结果

| AC | 环境 | 验证方式 | 证据 | 结果 |
|---|---|---|---|---|
| AC-1 | Web | E2E 译名 chip、编辑回填、保存；架构测试不一致标记 | E2E 4/4；截图 `glossary-*` | ✅ |
| AC-2 | Host | 复用 F-0019 Host 术语存储与版本；E2E `getTerminology` revision 3 | 架构/E2E 通过 | ✅ |
| AC-3 | Host + 真实 API | 架构测试断言 prompt 含「字幕」→「Subtitle」；`findTerminologyIssues` 覆盖命中/缺失/大小写/复数；E2E 版本显示 | 架构 2 项；E2E 版本 `v4 · 1 条` | ✅ |
| AC-4 | 真实 API | `pnpm acceptance:f0032` 两批（英/日）记录遵循率；版本捕获与 stale 由 hook 实现 | 英文 5/5、日文 2/2 | ✅ |
| AC-5 | Web | 沿用热词弹窗入口与空态；无术语时显示 vN · 0 条 | E2E/面板 | ✅ |
| AC-6 | Web | 沿用 F-0019 加载/保存/禁用重复提交 | 既有 E2E + 代码 | ✅ |
| AC-7 | Host | 只有 `saveTerminology` 成功才显示「已完成」 | E2E 保存完成 | ✅ |
| AC-8 | Web/Host | 沿用冲突、失败、重试；术语版本 stale 复用翻译 stale | 代码/E2E 版本 | ✅ |
| AC-9 | Web + 真实 API | E2E 中英文 × 明暗主题 4/4；真实 API 两批 | 截图 12 张、录屏 4 段；`acceptance:f0032` 通过 | ✅（桌面/Windows/Cloud Not run） |

### Red check

- 撤掉 system prompt 的术语映射后，架构测试在 `「字幕」→「Subtitle」` 断言失败。
- 把英文比较改回大小写敏感后，不一致测试失败（把 `Subtitle` 误报为缺失）。

### 真实 API

- `pnpm acceptance:f0032`：opencode go `deepseek-v4.1-flash`，英文 5/5、日文 2/2 术语遵循；输出保留了真实译文。
- 未跑：Tauri 桌面、Windows/Cloud（无构建环境）。

## 界面证据

`PW_PORT=5213 pnpm e2e:evidence F-0032`：4/4，截图 12 张、录屏 4 段。

| 界面 | 状态 | AC | 截图 |
|---|---|---|---|
| 热词/术语弹窗 | 译名 chip、编辑回填、保存完成 | AC-1、AC-7 | `glossary-chip-*`、`glossary-saved-*` |
| 翻译面板 | 术语版本显示 | AC-3 | `translation-version-*` |

## 回归检查

| 命令 | 结果 |
|---|---|
| `pnpm lint` | ✅ 0 error，1 条既有 warning |
| `pnpm tsc -b --noEmit` | ✅ |
| `pnpm check:host` | ✅ |
| `pnpm test` | ✅ 135 pass / 5 skip |
| `pnpm test:architecture` | ✅ 198 pass / 1 skip |
| `cargo check` | ✅ |
| `PW_PORT=5213 pnpm e2e:evidence F-0032` | ✅ 4/4 |
| `pnpm acceptance:f0032` | ✅ 真实 API 英文 5/5、日文 2/2 |

## 发现的问题

- opencode go 需要 `x-opencode-session` 请求头；已在 AI 设置加入自定义请求头字段并通过测试。
- MP4/桌面等平台未跑；本需求不涉及导出。

## 结论

可以发布（工作区验证通过）。建议提交后按新 commit 重跑回归；桌面端与 Windows/Cloud 记 Not run。

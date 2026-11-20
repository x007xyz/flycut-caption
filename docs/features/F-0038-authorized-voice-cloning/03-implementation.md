---
id: F-0038
stage: 03-implementation
status: draft
approved_by:
approved_at:
---

# F-0038 项目说话人声音克隆：开发记录

## 进度

| 日期 | 清单项 | 检查 |
|---|---|---|
| 2026-11-17 | 1. 共享 schema + 项目字段 | `pnpm tsc -b --noEmit` ✅ |
| 2026-11-17 | 2. Host voices.create/list/delete + 样本提取 + 音频路由 | `tests/architecture/voices-f0038.test.ts` ✅ |
| 2026-11-17 | 3. 302.ai IndexTTS Provider | `pnpm acceptance:f0038` ✅ `cloned=true duration=4.748s bytes=209486 magic=RIFF` |
| 2026-11-17 | 4. 声音克隆面板 | E2E 4/4（中英文 × 明暗主题，截图 8 张） |
| 2026-11-17 | 5. 接入单条/整段配音音色选择、原片段试听、取消 | 架构测试 + E2E ✅ |

## 自行决定的事项

- 302 的 2.5 版本对提供样本返回 `Synthesis failed`，Provider 固定用 2.0，并在模型说明中写清。
- 302 无远端样本删除接口；删除只清本地并在界面披露远端留存，AC-4 的远端核实记 Not run。
- 样本起止时间由用户输入，限制 1–15 秒；从项目媒体提取，不提供任意录音上传。

## 遗留问题

- 302.ai 无远端样本删除接口，删除只清本地并披露远端留存；AC-4 的远端核实记 Not run。
- 未提交 commit。

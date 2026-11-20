---
id: F-0027
stage: 03-implementation
status: approved
approved_by: auto
approved_at: 2026-11-16
---

# F-0027 自定义字幕样式保存与复用：开发记录

## 分支与 PR

- 分支：`codex/baseline-20261113`（工作区直接实现；本会话未获提交授权，没有创建 commit 或 PR）
- PR：无

## 进度

| 日期 | 清单项 | 提交 | 检查 |
|---|---|---|---|
| 2026-11-16 | 1. 共享契约 `shared/stylePresets.ts` + 项目增量字段 + 协议 | 未提交 | `pnpm check:host` ✅、`pnpm tsc -b --noEmit` ✅ |
| 2026-11-16 | 2. Host `projects.getStylePresets` / `saveStylePresets` | 未提交 | `pnpm exec tsx --tsconfig server/tsconfig.json --test tests/architecture/style-presets-f0027.test.ts` ✅（4 项） |
| 2026-11-16 | 3. 客户端 `useCustomStylePresets` + `applyCustomStylePreset` | 未提交 | 架构测试覆盖画幅保留/字体回退/冲突/重启 ✅ |
| 2026-11-16 | 4. 界面 `CustomPresetsSection` + 中英文文案 | 未提交 | `pnpm exec eslint <改动文件>` ✅ |
| 2026-11-16 | 5. E2E + 真实验收 | 未提交 | `PW_PORT=5211 pnpm e2e:evidence F-0027` ✅ 8/8，截图 32 张；`pnpm acceptance:f0027` ✅ 双视频真实验收 |

## 自行决定的事项

- 预设存主/副样式和名称，不存画幅/底边距/显示模式；应用时保留当前视频的画幅与底边距（AC-3）。
- 同名判断忽略大小写与多余空格，覆盖必须二次确认（AC-1）。
- `stylePresetsRevision` 独立于 `styleRevision`，保存预设不触发视频/样式保存冲突（AC-8）。
- 网络不确定时下一次保存先读最新列表核对修订号，再决定是否重发（AC-8）。
- 未知字体回退当前字体并显示提示，不写未知字体（AC-4）。
- 删除预设只改列表，已应用样式快照保持不变（AC-4）。

## 与设计的偏差

- 无重大偏差。实现中把预览样张放在保存表单内（Aa 样张），没有另做弹窗；界面状态与 AC 一致。
- 应用预设只改变本地 `stylePair`，持久化继续走现有项目样式/视频编辑自动保存；「已完成」只用于预设列表的 Host 写入，应用提示为「已应用到当前样式」，避免把本地操作说成 Host 已完成（AC-7）。

## 遗留问题

- 真实桌面 Tauri 未单独跑；真实验收在 Chrome + 真实 Host + 真实媒体上完成，桌面复用同一 Host/前端代码，测试报告记 `Not run`。
- 未提交 commit：本会话未获得 git 提交授权。

---
id: F-0033
stage: 03-implementation
status: approved
approved_by: auto
approved_at: 2026-11-16
---

# F-0033 多语言字幕与软字幕轨导出：开发记录

## 分支与 PR

- 分支：`codex/baseline-20261113`（工作区直接实现；本会话未获提交授权，没有创建 commit 或 PR）
- PR：无

## 进度

| 日期 | 清单项 | 提交 | 检查 |
|---|---|---|---|
| 2026-11-16 | 1. 协议与 Host 多轨导出（MKV、逐轨 VTT、语言标签、默认轨、WebM 限制） | 未提交 | `pnpm check:host` ✅；真实验收 MP4/MKV 3 轨 ✅ |
| 2026-11-16 | 2. 客户端轨道构建与缺译/过期统计 | 未提交 | `tests/architecture/multilingual-export-f0033.test.ts` ✅（2 项） |
| 2026-11-16 | 3. 导出界面（MKV、多轨选择、部分导出、字体限制、字幕文件语言轨） | 未提交 | `pnpm tsc -b --noEmit` ✅、`pnpm exec eslint` ✅ |
| 2026-11-16 | 4. `FlyCutCaption` / `useVideoExport` / `HostExportEngine` / 保存路径接线 | 未提交 | `pnpm tsc -b --noEmit` ✅ |
| 2026-11-16 | 5. E2E 与真实验收 | 未提交 | `PW_PORT=5212 pnpm e2e:evidence F-0033` ✅ 8/8，截图 16 张；`pnpm acceptance:f0033` ✅ MP4/MKV 3 轨、zho/eng/jpn、默认轨、EDL 时间 |

## 自行决定的事项

- 「任意两轨双语」首版实现为：任意一条语言轨 + 原文轨组成双字幕，暂不支持两条非原文轨组合（AC-1）。
- 缺译/过期条目默认阻止对应轨导出；用户显式允许后只导出完整条目并省略问题条目，不补原文（AC-2）。
- WebM 只允许一条软字幕轨，多轨时要求选择 MP4/MKV（AC-3）。
- 语言码按 ISO 639-2 写入容器（`en→eng`、`zh→zho`、`ja→jpn`），未知语言写 `und`（AC-3）。
- 硬烧录按当前激活语言检查随包字体；没有字体时禁用硬烧录（AC-4）。

## 与设计的偏差

- 设计中的「语言码映射后失败由真实验收断言」改为真实验收直接断言 `zho/eng/jpn`；Red check 用单测覆盖过期/EDL 逻辑。
- 真实素材的 MP4 字幕时间有约 23ms 的容器取整（1.023/1.523），验收断言用 ±50ms 容差，不要求毫秒完全一致。

## 遗留问题

- 未跑 Tauri 桌面与 Windows/Linux/Cloud；真实验收在 Chrome + 真实 Host + 真实 FFmpeg/ffprobe 上完成，测试报告记 `Not run`。
- 未提交 commit：本会话未获得 git 提交授权。

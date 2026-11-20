---
id: F-0033
stage: 04-test-report
status: approved
approved_by: zhangxiang.chen
approved_at: 2026-11-16
---

# F-0033 多语言字幕与软字幕轨导出：测试与验收

验收在 **工作区（HEAD `bf58f93` + 未提交改动）** 上进行。本会话未获 git 提交授权，因此没有固定 commit；维护者提交后应按新 commit 重跑文末回归命令。

> 技术设计和开发阶段由 agent 连续推进、自动确认；维护者在这里一并审阅。

## 设计与实现摘要

- 导出协议新增 MKV 和 `subtitleTracks`（最多 20 条，内容为已投影到成片的 VTT）；Host 逐轨写入临时 VTT，按容器用 `mov_text`/`srt`/`webvtt` 封装，写 ISO 639-2 语言标签、标题和默认轨；WebM 多轨直接拒绝。
- 客户端新增 `listSoftSubtitleTracks` / `buildSoftSubtitleTracks`：按语言轨统计缺失/过期，默认禁用问题轨，显式允许部分导出时只导出完整条目，不用原文补译；所有轨统一走 `projectFromKept` 的 EDL 投影。
- 导出对话框新增 MKV、多轨多选、部分导出开关、硬烧录语言限制和字幕文件语言轨选择；视频与字幕导出调用链接入 `languageTracks`。
- 无项目格式变化、无新 ADR；沿用 F-0030 的 `edits.languageTracks`。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| 双轨组合 | 任意一条语言轨 + 原文组成双字幕 | 首版覆盖主要场景；两条非原文轨组合留后续 | AC-1 |
| 缺译/过期 | 默认禁用；显式允许后省略问题条目 | 不伪造译文、不静默改变导出 | AC-2 |
| WebM 多轨 | 只允许一条；多轨要求 MP4/MKV | WebM 播放器不支持多字幕轨 | AC-3 |
| 语言码 | BCP-47 映射到 ISO 639-2 | 容器要求 3 字母语言码，否则标签丢失 | AC-3 |
| 烧录限制 | 按当前激活语言检查随包字体 | 缺字体不能保证渲染 | AC-4 |
| **请确认**：首版不组合两条非原文轨 | 只支持「原文 + 任一语言轨」 | 避免 UI 复杂度和本轮范围膨胀 | AC-1 |

## 验收标准逐条结果

| AC | 目标平台 / 环境 | 验证方式、用例与命令 | 证据或未跑原因 | 结果 |
|---|---|---|---|---|
| AC-1 | Web + 真实 Host | E2E 软轨列表显示语言、名称、完成数；MKV 按钮；字幕文件语言轨选择；真实导出 MP4/MKV 3 条软轨 | E2E 8/8；`pnpm acceptance:f0033` 输出 `mp4: 3 tracks, zho, eng, jpn`、`mkv: 3 tracks …` | ✅（双轨组合限原文+任一轨） |
| AC-2 | Web + 架构测试 | 单测统计缺失/过期；默认不导出问题轨；显式部分导出只含完整条目；E2E 缺译轨默认禁用、勾选后启用 | 架构测试 2 项；E2E 截图 `soft-tracks-*`、`partial-enabled-*` | ✅ |
| AC-3 | Host + 真实 ffprobe | 所有轨统一 EDL 投影；真实导出后 ffprobe 校验 `zho/eng/jpn`、默认轨、裁剪后时间；WebM 多轨拒绝 | `acceptance:f0033` 输出 `EDL timing ok`、`default=1`、`webm multi-track rejected` | ✅ |
| AC-4 | Web（Chrome） | E2E 激活语言 `ja` 时硬烧录禁用并显示「此语言暂不支持烧录」 | 截图 `burn-in-blocked-*`；按钮 `toBeDisabled()` | ✅ |
| AC-5 | Web（Chrome） | 沿用现有导出入口；无语言轨时只显示原字幕；Host 不可用沿用现有提示 | E2E 覆盖；无语言轨时 `softTracks.length<=1` 不渲染多轨选择 | ✅ |
| AC-6 | Web（Chrome） | 沿用现有 Host 导出进度、取消和重复提交保护；新增选择不改变提交流程 | 未新增 E2E 进度用例；现有 F-0028/F-0026 导出流程覆盖 | ✅（沿用既有覆盖） |
| AC-7 | Host + 真实导出 | Host 导出成功才完成；语言轨来自已保存的 `edits.languageTracks`，重开读取同一版本 | 真实验收从保存后的项目读取语言轨并导出成功 | ✅ |
| AC-8 | Host + 架构测试 | WeekM 多轨返回明确错误；缺译/过期不静默补原文；问题轨默认禁用 | 真实验收错误信息；单测省略断言；E2E 禁用状态 | ✅ |
| AC-9 | Web（Chrome）+ 真实 Host | `PW_PORT=5212 pnpm e2e:evidence F-0033` 中英文 × 明暗主题 8/8；真实 FFmpeg/ffprobe 验收；截图 16 张、录屏 8 段 | 全部通过；桌面 Tauri / Windows / Cloud 记 `⏸ Not run`（无构建环境） | ✅（桌面待补测） |

### Red check

- 撤掉过期条目省略（`entry.sourceText !== chunk.text` 判断）后，`F-0033/AC-1 AC-2 …` 在「outdated cue is omitted」断言失败；恢复后通过。
- 撤掉 `projectFromKept` 的 EDL 投影后，`F-0033/AC-3 …` 在裁剪后时间断言失败（`00:00:01.000 --> 00:00:02.000` vs 期望 1.0–1.5）；恢复后通过。

### 真实验证与未测项

- Ran：`pnpm acceptance:f0033`（真实 Host + 真实 FFmpeg + 3 秒视频 + 中文/英/日三条轨道 + 1–1.5 秒裁剪）。输出：`mp4: 3 tracks, zho, eng, jpn, default=1, EDL timing ok`、`mkv: 3 tracks, zho, eng, jpn, default=1, EDL timing ok`、`webm multi-track rejected`、`F-0033 real acceptance passed`。
- Not run：Tauri 桌面、Windows/Linux/Cloud、真实播放器手动切换轨道。原因：本会话没有桌面构建/签名环境；容器层已用 ffprobe 验证，播放器切换留桌面补测。
- Not run：真实 AI 翻译/模型。本需求只导出已有语言轨，不依赖模型。

## 界面证据

`pnpm e2e:evidence F-0033`：8/8 通过，截图 16 张（`docs/features/F-0033-multilingual-subtitle-export/screenshots/`），录屏 8 段（`recordings/`，只在本地）。

| 界面 | 状态 | AC | 截图 | 录屏 |
|---|---|---|---|---|
| 视频导出 / 软字幕轨 | 多轨列表、缺译禁用 | AC-1、AC-2 | `soft-tracks-*.png` | `F-0033_AC-1_…webm` |
| 视频导出 / 软字幕轨 | 部分导出开关启用问题轨 | AC-2 | `partial-enabled-*.png` | 同上 |
| 视频导出 / 硬烧录 | 语言无字体时禁用 | AC-4 | `burn-in-blocked-*.png` | 同上 |
| 字幕文件导出 | 语言轨选择 | AC-1、AC-3 | `subtitle-track-*.png` | `F-0033_AC-1_AC-3_…webm` |

## 回归检查

| 命令 | 结果 |
|---|---|
| `pnpm lint` | ✅ 0 error，1 条既有 warning（`PlatformPresetsSection.tsx`） |
| `pnpm tsc -b --noEmit` | ✅ |
| `pnpm check:host` | ✅ |
| `pnpm test` | ✅ 140 项：135 pass，5 skip，0 fail |
| `pnpm test:architecture` | ✅ 197 项：196 pass，1 skip，0 fail |
| `cargo check --manifest-path src-tauri/Cargo.toml` | ✅ |
| `PW_PORT=5212 pnpm e2e:evidence F-0033` | ✅ 8/8 |
| `pnpm acceptance:f0033` | ✅ MP4/MKV 三轨、语言标签、默认轨、EDL 时间、WebM 拒绝 |

## 发现的问题

- MP4 `mov_text` 的字幕时间在容器层有约 23ms 取整（1.023/1.523），验收用 ±50ms 容差；MKV 同样通过。
- MP4 的 `mov_text` 不保留 `title` 元数据（只有语言标签），MKV 保留标题；AC-3 要求的语言标签和默认轨均已验证，标题在 MKV 验证。
- 本会话未提交 commit，报告不能绑定固定 sha；提交后需按新 commit 重跑回归命令。

## 结论

可以发布（工作区验证通过）。建议维护者先提交本次改动，再按新 commit 重跑回归命令并确认本报告；桌面端、Windows/Linux/Cloud 和真实播放器手动切换仍按 AC-9 记为待补测。

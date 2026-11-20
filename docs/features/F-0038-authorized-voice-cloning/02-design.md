---
id: F-0038
stage: 02-design
status: draft
approved_by:
approved_at:
---

# F-0038 项目说话人声音克隆：设计

## UI / UX

在字幕编辑器工具栏新增「声音克隆」面板：从当前项目视频输入起止时间截取 1–15 秒样本，必须勾选本人/说话人授权并填写说明；创建后命名、试听、删除。删除时明确提示 302.ai 无远端删除接口，只清本地样本。

| 状态 | 用户看到什么 | 验收构造 |
|---|---|---|
| 空态 | 「暂无内容 / Nothing here yet」+ 起止时间/名称/授权表单 | `voices.list` 返回空 |
| 未授权 | 创建按钮禁用，提示先确认授权 | 不勾选 |
| 处理中 | 「正在处理…」+ 进度；禁止重复提交 | `voices.create` 挂起 |
| 完成 | 音色列表显示名称、时长、试听/删除 | 返回 profile |
| 删除 | 二次确认；完成后提示远端留存 | `voices.delete` |
| 失败/冲突 | 具体原因、重试、保留输入 | job error |

## 技术方案

- `project.json` 增量字段 `voiceProfiles` / `voiceProfilesRevision`；样本存 `videos/<videoId>/voices/<uuid>.wav`。
- Host `voices.create` job：校验项目/视频/授权/1–15 秒，FFmpeg 从项目媒体提取 16k 单声道 WAV，写入 profile；`voices.list`、`voices.delete`、只读音频路由。
- 302.ai Provider `index-tts-302`：把参考 WAV 上传 `/302/upload-file`，创建 `/302/index_tts2/task`（2.0），轮询下载；`voiceCloning: true`。
- 授权记录写入 profile（statement、confirmedAt、sourceLabel）；Agent/CLI 不提供代替确认的入口。

## 实现清单

- [x] 1. 共享 voice profile schema 与项目增量字段。
- [x] 2. Host `voices.create/list/delete` + 样本提取 + 只读音频路由。
- [x] 3. 302.ai IndexTTS Provider（真实克隆验证通过）。
- [x] 4. 声音克隆面板：起止时间、授权、创建、列表、试听、删除。
- [x] 5. 把项目音色接入单条/整段配音音色选择，并补试听原片段、取消与远端留存决策。

## 验证计划

- 架构测试 `tests/architecture/voices-f0038.test.ts`：授权、1–15 秒、样本落盘、列表、删除、远端留存。
- 真实接口 `pnpm acceptance:f0038`：用 `音色.m4a` 调 302 IndexTTS 2.0，验证 WAV 返回。
- E2E `tests/e2e/features/F-0038.spec.ts`：中英文 × 明暗主题，空态/授权/完成/删除。

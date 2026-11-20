---
id: F-0038
stage: 04-test-report
status: approved
approved_by: zhangxiang.chen
approved_at: 2026-11-17
---

# F-0038 项目说话人声音克隆：测试与验收

验收在 **工作区（HEAD `bf58f93` + 未提交改动）** 上进行；提交后需按新 commit 重跑回归。

## 设计与实现摘要

- 项目级音色：`voiceProfiles` 增量字段 + `videos/<videoId>/voices/<uuid>.wav`；`voices.create/list/delete` 与只读音频路由。
- 授权：必须勾选本人/说话人授权并填写说明，记录 confirmedAt、sourceLabel；样本只从当前项目视频提取，限制 1–15 秒。
- 302.ai IndexTTS Provider：FFmpeg 转 16k WAV → `/302/upload-file` → `/302/index_tts2/task`（2.0）→ 轮询下载；真实克隆通过。
- 音色接入 F-0035/F-0036：`voiceProfileId` 传入 `dubbing.synthesizeCue`/`alignTrack`，Host 解析项目音色文件作为 `referenceAudioPath`，并写入 artifact。
- 面板支持原片段试听、创建中取消、命名、试听、删除确认和远端留存披露。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| IndexTTS 版本 | 固定 2.0 | 2.5 对提供样本返回 Synthesis failed，2.0 真实成功 | AC-4 |
| 远端删除 | 只删本地 + 披露 | 302.ai 无删除接口，不能伪报已删除 | AC-4 |
| 样本来源 | 当前项目视频起止时间，1–15s | 不做任意录音上传 | AC-1 |
| 音色使用 | `voiceProfileId` 注入 clone 参数 | 复用现有 TTS 授权校验与 artifact 存储 | AC-4 |

## 验收标准逐条结果

| AC | 环境 | 验证方式 | 证据 | 结果 |
|---|---|---|---|---|
| AC-1 | Web/Host | 面板起止时间、时长、原片段试听；架构测试从项目媒体提取样本 | `voices-f0038.test.ts`；E2E 4/4 | ✅ |
| AC-2 | Host | 授权必填；架构测试断言 authorization 记录；未勾选创建按钮禁用 | 架构测试 + E2E | ✅ |
| AC-3 | Web | 面板声明上传到 302 IndexTTS；支持取消；不支持克隆的模型不显示项目音色入口 | 代码/E2E | ✅ |
| AC-4 | Web/Host/真实 API | 命名、试听、单条/整段配音使用、删除；真实 IndexTTS 克隆 | `acceptance:f0038` `cloned=true duration=4.748s`；音色接入架构测试 | ✅（远端删除 ⏸ Not run） |
| AC-5 | Web | 入口/空态/授权提示 | E2E `empty-*` | ✅ |
| AC-6 | Web | 处理中、取消、禁重复 | E2E/代码 | ✅ |
| AC-7 | Host | 创建成功才完成；重开读取 profile | 架构测试列表/删除 | ✅ |
| AC-8 | Web/Host | 失败原因、保留输入 | 面板 error 分支 | ✅ |
| AC-9 | Web + 真实 API | E2E 中英文 × 明暗主题 4/4；真实 302 IndexTTS | 截图 8 张、录屏 4 段 | ✅（桌面/Windows Not run） |

### 真实验证与未测项

- Ran：`pnpm acceptance:f0038`，302.ai IndexTTS 2.0，使用 `音色.m4a`，输出 `cloned=true duration=4.748s bytes=209486 magic=RIFF`。
- Not run：302.ai 远端样本删除核实（服务无删除接口）；Tauri 桌面、Windows/Cloud。
- 说明：302 的 2.5 版本对该样本失败，Provider 固定 2.0。

## 界面证据

`PW_PORT=5215 pnpm e2e:evidence F-0038`：4/4，截图 8 张、录屏 4 段。

## 回归检查

| 命令 | 结果 |
|---|---|
| `pnpm lint` | ✅ 0 error（1 条既有 warning） |
| `pnpm tsc -b --noEmit` | ✅ |
| `pnpm check:host` | ✅ |
| `tests/architecture/voices-f0038.test.ts` | ✅ |
| `pnpm acceptance:f0038` | ✅ 真实克隆 |
| `PW_PORT=5215 pnpm e2e:evidence F-0038` | ✅ 4/4 |

## 发现的问题

- 302 无远端删除接口，AC-4 远端删除无法核实，需维护者接受“只删本地 + 披露”。
- 302 2.5 对提供样本失败，固定 2.0。

## 结论

可以发布（本地与真实克隆验证通过）；远端删除核实和桌面/Windows 按 Not run 记录。

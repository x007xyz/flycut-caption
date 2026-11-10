---
id: F-0006
stage: 04-test-report
status: approved
approved_by: zhangxiang.chen
approved_at: 2026-11-09
---

# F-0006 VAD 去静音：测试与验收

验收在未提交工作区上进行（维护者要求跳过 commit）。

## 设计与实现摘要

去静音的分析在 Host：silence.analyze 只接收 projectId/videoId，用 ProjectStore 解析媒体、提取 16 kHz WAV，再通过 Provider detectVoice 调用 FSMN/Silero sidecar；候选由 shared/editing/silence.ts 生成。建议进入与 F-0007 共用的 pendingSuggestions 临时层，选择/预览/确认一次提交；保存失败会回滚候选和正式 EDL。导出接点默认 5ms afade，可关闭，不改变输出时长。未确认建议不进入项目、恢复副本或导出。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| 项目媒体读取 | 插件内直接用 ProjectStore，不新增 projectMedia 服务 | 避免改动 projects 插件边界，路径仍只在 Host 内 | AC-1 |
| 过期基准 | 复用 keyOf(edl/chunks/wordChunks) 快照，不新增 editRevision | 行为等价，减少 F-0005 迁移面 | AC-7 |
| 保存失败 | 抽出 cutPersistence 统一回滚 | F-0006/F-0007 共用，避免两套事务逻辑 | AC-7 |

## 验收标准逐条结果

| AC | 验证方式 | 证据 | 结果 |
|---|---|---|---|
| AC-1 能力入口 | E2E + architecture | 无模型状态 4 组；FSMN/Silero 模型状态与真实 sidecar | ✅ |
| AC-2 参数 | 单元 + E2E | 默认值、非法参数、模式切换；参数测试 | ✅ |
| AC-3 分析/取消 | E2E + architecture | 分析、取消、失败、真实 Host job；取消 E2E | ✅ |
| AC-4 建议标记 | E2E | 候选数、原因、时间轴红标、无候选 | ✅ |
| AC-5 临时预览 | E2E + real page | 预览不写正式 EDL；真实页面 9 候选预览 | ✅ |
| AC-6 切点保护 | 单元 + real Host | VAD/word 并集、guard/retain、安全 padding | ✅ |
| AC-7 确认/过期/失败 | E2E + architecture | 过期 E2E、保存失败回滚 E2E、原子应用 | ✅ |
| AC-8 导出与平滑 | real Host | joinFadeMs 5ms afade，真实导出成功 | ✅ |
| AC-9 历史回退 | E2E | 确认后历史记录；F-0005 历史预览/回退 | ✅ |
| AC-10 两端与边界 | real Host + page | 两段真实口播、缺失媒体、无音轨、Caddy 自部署页面 | ✅ |

## 界面证据

`pnpm e2e:evidence F-0006`：9/9，8 张截图、9 段录屏。

| 界面 | 状态 | AC | 截图 |
|---|---|---|---|
| 去静音面板 | 模型/参数/分析/候选/预览 | AC-1、AC-2、AC-4、AC-5 | `screenshots/` |
| 去静音面板 | 无模型、保存失败、过期、取消 | AC-1、AC-3、AC-7 | `screenshots/` |
| 时间轴/播放器 | 待确认红标、预览 | AC-4、AC-5 | `screenshots/` |

## 回归检查

- `pnpm test`：93 passed / 3 skipped / 0 failed
- `pnpm test:architecture`：86/86
- `pnpm check:host`、`pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm build`、`cargo check`：通过
- F-0006 E2E：11/11；`pnpm e2e:evidence F-0006`：11/11
- 真实 Host：`tests/architecture/silence-f0006.test.ts` 3/3（两段真实口播、真实 FSMN VAD、导出、缺失媒体、无音轨）
- 真实页面：Vite/Host + FSMN VAD 生成 9 个候选，勾选确认后历史出现「确认剪辑建议」
- Caddy TLS + Basic Auth 自部署页面可连接

## 发现的问题

- Tauri GUI 实际操作 Not run；cargo check 通过，未做桌面人工点击验收。
- 人工逐候选听校仍是最终主观证据，当前以真实 VAD/导出和页面行为为主。

## 复审修复（2026-11-09）

代码审查发现并已修复下列问题，每项都带回归测试并做了 Red check：

- **片头/片尾静音保留量是设计值的两倍**：`shared/editing/silence.ts` 在文件边缘也留了一段。已改为只在靠近语音的一侧保留（压缩 `max(guard, retain)`、删除 `guard`）。新增 `tests/silence-rules.test.mjs`「edge silence keeps padding only on the speech side」。Red check：恢复旧逻辑后该测试失败，实际 `[[0.25,1.75],[3.15,4.75]]`，期望 `[[0,1.75],[3.25,5]]`。
- 复跑（全部修复之后的工作区）：`pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host` ✅；`pnpm test` 95 通过 / 3 跳过 / 0 失败；`pnpm test:architecture` 91/91；页面 E2E `tests/e2e/features` 全量 192/192（第一轮 188/192：F-0013 主流程因新增撤销/重做记录导致定位歧义，已改测试后 12/12）。
- Not run：Tauri GUI 实际操作、人工听校（同上文）。

## 结论

AC-1 到 AC-10 的自动化、真实 Host 和页面证据均通过；Tauri GUI 与人工听校标注为 Not run。建议维护者确认后进入待发布。

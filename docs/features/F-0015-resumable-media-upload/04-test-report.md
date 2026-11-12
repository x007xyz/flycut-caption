---
id: F-0015
stage: 04-test-report
status: approved
approved_by: zhangxiang.chen
approved_at: 2026-11-12
---

# F-0015 大文件断点续传与断线恢复：测试与验收

验收代码在 commit `0a2608b` 上进行；本报告与阶段确认随后作为本地文档提交。

> 技术设计和开发阶段由 agent 连续推进、自动确认；维护者在这里一并审阅。

## 设计与实现摘要

Host 新增持久分片上传契约：会话、分片确认、暂停/继续、取消/过期、最终大小与 SHA-256 校验和原子资产接管都按已认证主体隔离。Web 项目导入使用 `/uploads`，刷新后只保留 sessionId、摘要等非敏感定位信息；源文件需要用户重新选择并完整校验。ASR、导出和项目落库使用可选 `operationId` 消除回执丢失时的重复副作用。

客户端任务定位按 hostId 隔离，每次动作重新读取 Host 身份。等待任务时遇到断网或未知结果会保留定位，只有明确终态或成功交付才清理。ASR 输入键包含源文件完整 SHA-256、模型、语言和选项；导出裸文件使用内容摘要，项目媒体使用受保护资产路径身份。`flycut/transcribed` 保持为公开可订阅事件，项目监听器在事件内只保存一次，保存失败时保留已完成任务供同一操作重试。

ADR-0008 仍为 `proposed`，按流程由维护者确认本报告时一并决定是否 accepted。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| 身份失效 | 每次读写任务定位都重新读取 `projects.identity` | 同地址 Host 可能重启或切换；永久缓存会把旧主体用于新 Host | AC-9、AC-10 |
| 输入身份 | 裸媒体使用完整内容 SHA-256；项目媒体使用 Host 资产路径身份 | 文件名、大小和桌面路径都不能单独证明内容未变化 | AC-9 |
| 定位清理 | 网络/超时/等待失败保留定位；仅明确终态或成功交付后清理 | 防止不确定结果被当成失败后再次创建收费任务 | AC-5、AC-9 |
| ASR 持久化 | 事件改为可等待并保留全部订阅者；项目保存失败保留任务定位 | 三方事件兼容，且不得在项目写入未确认时丢失恢复入口 | AC-9 |
| 未知任务资产 | 客户端未确认终态时保留 ASR 输入资产，交由 Host TTL 清理 | 已受理任务可能在 Host 侧继续使用该资产 | AC-9 |
| Red check | 仅在 `/private/tmp` 隔离副本移除完整性判断 | 满足回退测试要求，同时不削弱生产安全边界 | AC-3、AC-8 |

## 验收标准逐条结果

| AC | 验证方式 | 证据 | 结果 |
|---|---|---|---|
| AC-1 | 架构 + E2E | `F-0015/AC-1 Host advertises...`；中英文 unsupported 明暗截图；旧 Host 无能力时不进入上传 | ✅ |
| AC-2 | 架构 + E2E | 大小/类型双端检查、目标 Host/大小/进度；rejected 与 checking 明暗状态 | ✅ |
| AC-3 | 架构 + 隔离 Red check | 分片 offset/摘要、同片幂等、缺失分片、整体 SHA/大小/媒体头；移除 offset 或整体 SHA 校验后对应测试分别失败 | ✅ |
| AC-4 | 架构 + E2E | 暂停中止当前片、保留确认字节、继续只查缺失分片；paused 明暗状态 | ✅ |
| AC-5 | 架构 + 真实 60 分钟素材 | 真实 TCP 代理连续切断三次，Host 确认字节 8/16/24 MiB 后继续，最终项目媒体摘要一致 | ✅ |
| AC-6 | E2E + 真实浏览器 | 刷新进入 needs-file；错文件 mismatch；重新选择原文件后只发送剩余分片并完成 | ✅ |
| AC-7 | 架构 + E2E | 取消可重复、完成/取消串行竞态、过期 410 阻止写入；取消二次确认与 expired 明暗状态 | ✅ |
| AC-8 | 架构 + E2E | 空间 507、权限 401、完整性 422、分片冲突 409 均显示具体失败；owner 伪造/跨身份 404 | ✅ |
| AC-9 | 故障注入 + E2E | 回执丢失、刷新恢复、重复点击、同 operationId、身份切换、等待断网、终态清理、项目保存失败重试 10/10；verifying 明暗状态禁用重复启动 | ✅ |
| AC-10 | 真实 Host + Chrome + TCP 代理 | 255,668,512 bytes 的 60 分钟 MP4，三次断网+刷新重选；最终长度一致，SHA-256 为 `f0e38bf3443df40ff8fa127933d98bce8fd17b5b83d4b155f4655d25ddf2a2d6` | ✅ |

真实刷新证据：刷新前 Host 已确认 8,388,608 bytes；重新选择后最终确认 255,668,512 bytes，期间新发送 247,279,904 bytes，小于完整文件。

## 界面证据

| 界面 | 状态 | AC | 截图 | 录屏 |
|---|---|---|---|---|
| 项目首页/详情 | checking、unsupported、rejected、hashing、uploading、paused、interrupted、needs-file、mismatch、verifying、failed、expired；中英文、明暗主题 | AC-1–AC-9 | `screenshots/*.png`，29 张 | `recordings/*.webm`，22 段（不入 git） |
| 真实 Host 上传 | interrupted、needs-file、recovered | AC-5、AC-6、AC-10 | `real-interrupted-light.png`、`real-needs-file-light.png`、`real-recovered-light.png` | 长素材运行以 Playwright 成功日志和摘要为准 |

## 回归检查

- `pnpm lint` ✅
- `pnpm tsc -b --noEmit` ✅
- `pnpm check:host` ✅
- `cargo check --manifest-path src-tauri/Cargo.toml` ✅
- `pnpm test` ✅：98 tests，94 passed，4 skipped（缺 moonshine、parakeet、whisper 和双 VAD 资产）
- `pnpm test:architecture` ✅：114/114
- `pnpm build` ✅（仅有现有的大 chunk 警告）
- `pnpm e2e:evidence F-0015` ✅：22/22，29 screenshots，22 recordings
- `F0015_REAL=1 F0015_REAL_MEDIA=... pnpm exec playwright test tests/e2e/features/F-0015.real.spec.ts --workers=1` ✅：1/1，46.1 秒
- `git diff --check` ✅

架构测试首次运行有 3 项缺少被 `.gitignore` 排除的媒体；从原仓库复制这些运行资源后 114/114 通过，资源未进入提交。

## 发现的问题

- Cloud 端就是当前 Host 部署在服务器后的形态；本轮使用同一 Host 后端、真实 Chrome 和可切断 TCP 代理完成续传验收。账号与计费属于仓库外服务，不是本需求待实现或待验的客户端能力。
- ASR 与导出的故障注入覆盖客户端任务定位和 Host 幂等契约；独立产品端完整 ASR/导出长流程仍由既有 F-0002、F-0005、F-0028 回归覆盖。
- Windows 打包和 Tauri GUI 全流程仍需在对应环境补测。

## 结论

AC-1 到 AC-10 在固定代码 commit `0a2608b` 上通过，结论为「可以发布」，等待维护者审阅 02/03/04。发布、推送和合并尚未执行。

---
id: F-0053
stage: 04-test-report
status: review
approved_by:
approved_at:
---

# F-0053 TTS Provider能力与接入：测试与验收

验收在代码与测试提交 `127b737` 上进行；本报告随后作为文档提交，不改变代码与测试。

> 技术设计和开发阶段由 agent 连续推进、自动确认；维护者在这里一并审阅。

## 设计与实现摘要

为 Provider 增加 TTS 角色，并把「设置页选模型 → 列音色 → 试听 → 保存」做成一条可验收链路：

- **能力声明**（`shared/providers.ts`、`shared/tts/`）：新增 `TtsCapabilities`（是否支持克隆、可用音色、语言与参数）、`TtsVoice`、`TtsRequest`、`TtsCloneAuthorization`。`capabilities: ['asr','tts']` 允许同一个 HTTP Provider 同时承担 ASR 与 TTS；不支持的模型不注册空实现。`sherpa-onnx` 只暴露 ASR，不伪造 TTS。
- **HTTP 协议**（`server/providers/httpProvider.ts`、`docs/provider-http-protocol.md`）：新增 `POST /v1/tts/jobs`、`GET /v1/jobs/{id}`、`GET /v1/jobs/{id}/audio`、`POST /v1/jobs/{id}/cancel`，复用现有鉴权与 job 形状；克隆请求必须带完整授权结构。
- **Host 侧**（`server/plugins/tts.ts`）：`tts.getSettings` / `tts.saveSettings`（`hostId` + `revision` + `operationId` 幂等）/ `tts.synthesize`。合成结果走资产存储并校验音频头，密钥只在 Host 解析、不回传。
- **客户端**（`src/services/ttsService.ts`、`src/components/TTS/TTSSettingsPanel.tsx`）：独立 TTS 设置面板接入 `SettingsDialog`，含空态跳转、模型/音色/参数选择、能力限制提示、授权克隆、加载/处理中/取消、失败重试/返回、不确定保存先查后发、版本冲突需重新检查。
- **示例服务端**：`scripts/examples/tts-provider-server.mjs` 可独立运行，架构测试真实启动它验证全链路，保证第三方能按文档复现。
- 新增 proposed [ADR-0012 TTS Provider 能力声明与 HTTP 协议契约](../../20-architecture/adr/0012-tts-provider-contract.md)（`status: proposed`，待维护者确认本报告时一并决定是否 accepted）。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| 契约文件拆分 | TTS 类型与 schema 放 `shared/tts/`，`shared/providers.ts` 只扩能力枚举与 ModelRef 选择 | 避免 ASR 主契约文件继续膨胀；客户端可按需引入 | AC-1 |
| 音频校验方式 | `validateTtsAudio` 按文件头判定 WAV/FLAC/Ogg/MP3 并校验字节，不信任 Provider 的 MIME | 上游返回错误格式时必须在 Host 侧拦住，避免坏音频进入项目 | AC-2、AC-4 |
| 克隆授权门槛 | `cloneAuthorization` 需 `confirmed: true` 且有 `speakerLabel`；Host 在 `tts.synthesize` 再次校验，缺失直接拒绝 | 授权不能只靠前端勾选，Agent/CLI 调用也不能绕过 | AC-4 |
| 单 Provider 多能力 | 允许同一 HTTP Provider 同时声明 ASR 与 TTS，不按能力拆成多个 Provider | 用户只配一个自建服务地址时不该被迫复制条目 | AC-1 |
| E2E 断言修正 | 克隆试听用例先轮询 `tts.synthesize` 调用计数增加，再断言 payload | 先前试听的「已完成」仍在 DOM，原断言会提前通过（`dark-zh` 偶发失败） | AC-4、AC-9 |

## 验收标准逐条结果

| AC | 目标平台 / 环境 | 验证方式、用例与命令 | 证据或未跑原因 | 结果 |
|---|---|---|---|---|
| AC-1 | Node + 真实 Host | `pnpm test`：`tests/tts-audio.test.mjs`、`modelInfoSchema and checkTtsRequest enforce capabilities`；`pnpm test:architecture` 的 TTS 能力声明与注册表用例 | 断言 `sherpa-onnx` 不暴露 `synthesize`；单 HTTP Provider 可同时暴露 ASR 与 TTS；通过 ModelRef 选择 | ✅ 通过 |
| AC-2 | 真实 Host + 示例 HTTP Provider | `pnpm test:architecture` 启动 `scripts/examples/tts-provider-server.mjs`，跑 health/models/jobs/audio/cancel 全链路 | 请求、状态、音频下载与取消均按文档工作；错误码透传 | ✅ 通过 |
| AC-3 | Web Chrome（中英文 × 明暗） | E2E「F-0053/AC-3 AC-4 AC-6 AC-7 AC-8 selection, limits, audition…」 | 设置页可选 TTS 模型、列出自带音色、显示「不支持声音克隆 / Voice cloning is not supported」并试听生成真实 WAV | ✅ 通过 |
| AC-4 | Node + 真实 Host + Web Chrome | `pnpm test`（音频格式与损坏拒绝）、`tests/architecture/tts-f0053.test.ts`（401/超时/坏音频/未授权克隆/完整授权克隆）、E2E 克隆段 | 401 与坏音频有明确提示；未勾选授权时试听按钮禁用；带授权克隆成功且 Key 不出现在 RPC | ✅ 通过 |
| AC-4 | 真实第三方 TTS 服务试听 | 用 Kokoro / MeloTTS / CosyVoice / FlyCut Cloud 真实凭据完成一次试听 | 当前环境无本地 Python TTS 运行时、无云端 TTS 凭据与计费账号 | ⏸ Not run |
| AC-5 | Web Chrome | E2E「F-0053/AC-5 AC-6 empty state, configure redirect, and loading indicator」 | 空态显示「暂无内容 / Nothing here yet」并提供去配置入口；已有项目编辑不中断 | ✅ 通过 |
| AC-6 | Web Chrome | 同上用例的加载/处理/取消段 | 「正在加载…」「正在处理…」可见，试听按钮在处理中禁用，取消触发 `jobs.cancel` | ✅ 通过 |
| AC-7 | 真实 Host + Web Chrome | E2E 完成态与重开段 + `tts.saveSettings` revision 断言 | 仅 Host 确认后显示「已完成 / Completed」；重开读到同一配置 | ✅ 通过 |
| AC-8 | Web Chrome | E2E 错误/重试/不确定保存/冲突段 | 失败保留输入并可重试/返回；不确定保存先 `tts.getSettings` 回查后重发；冲突显示「内容已更新，请重新检查」并禁用保存 | ✅ 通过 |
| AC-9 | Web Chrome（中英文 × 明暗） | `PW_PORT=5294 pnpm test:e2e tests/e2e/features/F-0053.spec.ts --workers=1` | 8/8 通过；32 张截图入库，录屏仅本地 | ✅ 通过（Web） |
| AC-9 | 真实 Tauri 桌面端 | 打包后的 macOS/Windows 应用内完成同一设置与试听 | 本 worktree 未构建桌面安装包 | ⏸ Not run |

## 界面证据

由 `PW_PORT=5194 pnpm e2e:evidence F-0053` 生成，覆盖 `light/dark × zh/en`；`screenshots/` 已入库，`recordings/` 仅留本地。

| 界面 | 状态 | AC | 截图 | 录屏 |
|---|---|---|---|---|
| TTS 设置面板 | 空态 + 去配置 | AC-5 | `tts-empty-{light,dark}-{zh,en}.png` | 本地 |
| TTS 设置面板 | 加载中 | AC-6 | `tts-loading-{light,dark}-{zh,en}.png` | 本地 |
| TTS 设置面板 | 固定音色（不支持克隆） | AC-3 | `tts-fixed-model-{light,dark}-{zh,en}.png` | 本地 |
| TTS 设置面板 | 试听处理中 + 取消 | AC-6 | `tts-processing-{light,dark}-{zh,en}.png` | 本地 |
| TTS 设置面板 | 试听完成 | AC-3、AC-7 | `tts-audition-completed-{light,dark}-{zh,en}.png` | 本地 |
| TTS 设置面板 | 合成失败可重试 | AC-8 | `tts-error-{light,dark}-{zh,en}.png` | 本地 |
| TTS 设置面板 | 授权克隆 | AC-4 | `tts-clone-authorized-{light,dark}-{zh,en}.png` | 本地 |
| TTS 设置面板 | 版本冲突 | AC-8 | `tts-conflict-{light,dark}-{zh,en}.png` | 本地 |

## 回归检查

全部运行于提交 `127b737`：

- `pnpm lint` ✅（修复了 `shared/protocol.ts` 两处未使用类型导入）
- `pnpm tsc -b --noEmit` ✅
- `pnpm check:host` ✅
- `cargo check --manifest-path src-tauri/Cargo.toml` ✅
- `pnpm test` ✅：114 tests，109 passed，0 failed，5 skipped（未下载的额外 ASR 模型）
- `pnpm test:architecture` ✅：149/149 passed
- `PW_PORT=5294 pnpm test:e2e tests/e2e/features/F-0053.spec.ts --workers=1` ✅：8/8 passed
- Red check ✅：把 `validateTtsAudio` 的格式判定改为恒真后，`F-0053/AC-4 validateTtsAudio accepts valid WAV/FLAC/OGG/MP3 and rejects corrupt payloads` 立即失败于损坏负载被接受；恢复后重新全绿

## 发现的问题

- `shared/protocol.ts` 初次实现导入了两个未使用的 TTS 输入类型，`pnpm lint` 报错，已改为只在服务层引用。
- 克隆试听 E2E 在 `dark-zh` 下偶发失败：上一次试听的完成态仍在 DOM，断言提前通过后读到的是旧的 `tts.synthesize` 调用。已改为先等待调用计数增加。

## 结论

协议、Host 插件、注册表、客户端面板与示例服务端的自动化验证全部通过（AC-1 至 AC-8 与 AC-9 的 Web 部分）；真实第三方 TTS 服务试听与 Tauri 桌面实机受环境缺少本地运行时/云端凭据/桌面构建限制，如实记为 `⏸ Not run`。ADR-0012 仍为 proposed，请维护者在确认本报告时一并决定。

本报告等待维护者审阅确认；未自行执行 `pnpm feature approve`。


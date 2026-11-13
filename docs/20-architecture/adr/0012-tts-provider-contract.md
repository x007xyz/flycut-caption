---
id: ADR-0012
status: proposed     # proposed → accepted → superseded / deprecated
date: 2026-11-13
deciders:
feature: F-0053
superseded_by:
---

# ADR-0012 TTS Provider 能力声明与 HTTP 协议契约

## 背景

F-0034 调研确认了本地固定音色（Kokoro、MeloTTS）与支持克隆的候选模型（CosyVoice、Qwen3-TTS、Chatterbox）及商用许可边界，并要求在 F-0053 中定义统一的 TTS Provider 能力声明与 HTTP 协议边界。已有模型 Provider 决策（`docs/decisions.md`）规定：一个后端只注册为一个 Provider，不按能力拆成多个 Provider；没有的能力不写抛错空实现；调用方只传 `ModelRef` 与已声明选项；客户端不随包分发 Python。

## 决策

在已有 `Provider` / `ModelInfo` / FlyCut Provider HTTP v1 协议上扩展可选 TTS 能力与 Host 侧默认配置契约：

1. **能力与音色声明**：`ModelInfo` 对 `role: 'tts'` 模型携带可选 `tts` 能力对象（`voices`、`voiceCloning`、`cloningTerms`、`maxReferenceSeconds`、`streaming`、`durationControl`、`outputFormats`），沿用 `languages` 与 `options` 声明语言和可调参数；Provider 只在支持 TTS 时实现可选 `synthesize` 方法。
2. **HTTP Provider TTS 协议 v1**：
   - `GET /v1/health` 在 `capabilities` 中声明 `"tts"`；未声明时 Host 拒绝发起 TTS 请求，不暴露虚假能力。
   - `POST /v1/tts/jobs` 创建异步任务并返回 `202 { id }`：常规合成使用 `application/json`；声音克隆使用 `audio/wav` 参考样本请求体 + `X-Flycut-TTS-Request`（ASCII 转义 JSON）携带完整请求与可核验的 `authorization` 对象（`{ confirmed: true, statement, confirmedAt, sourceLabel? }`），无需 multipart 解析依赖且与 `/v1/asr/jobs` 一致。
   - 轮询 `GET /v1/jobs/{id}` 与取消 `POST /v1/jobs/{id}/cancel` 复用现有任务接口；完成结果提供同源 `audioUrl`（如 `/v1/jobs/{id}/audio`）与格式元数据，由 Host 带 Bearer 鉴权与 `redirect: 'error'` 下载音频并校验头部/时长完整性后再存入 Host 资产库返回 `assetId`。
3. **Host 侧 TTS 默认配置持久化**：`server/plugins/tts.ts` 在 Host home 维护带 `hostId` 与单调 `revision` 的 `tts-settings.json`（记录当前默认 `ModelRef`、`voiceId`、`language`、`speed`、`options`、近期保存幂等记录与最近一次已验证试听摘要），所有写操作校验 `expectedRevision`，冲突返回最新快照而不是覆盖；API Key 继续留在既有内存/系统凭据边界，不进入 `tts-settings.json`、任务快照、RPC 返回或日志。
4. **声音克隆授权门禁**：`ProviderRegistry.synthesize`、`tts.synthesize` RPC 与 HTTP Provider 协议共同强制校验：未声明 `voiceCloning: true` 的模型拒绝任何带参考样本的请求；带参考样本的请求必须携带 `cloneAuthorization.confirmed === true` 与非空授权声明及时间戳。

## 备选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| 沿用 `Provider` 单一抽象 + `/v1/tts/jobs` 异步任务 + 同源 `audioUrl`（采用） | 与 `/v1/asr/jobs`、`GET /v1/jobs/{id}`、`cancel` 完全一致；无 multipart 依赖；大音频不撑爆 JSON 状态 | 需一次轮询与一次音频下载请求 |
| 同步 `POST /v1/tts/synthesize` 直接返回音频流 | 短文本少一次轮询 | 长文本或大模型推理易触发 HTTP 超时，且无法复用 `jobs.cancel` 取消机制 |
| 克隆请求使用 `multipart/form-data` | 常见 Web 表单格式 | 与 `/v1/asr/jobs`「避免 multipart 依赖」原则不一致，简单本地服务需额外解析库 |
| TTS 选择状态只放前端 `localStorage` | 改动小 | 多客户端/重开无法与 Host 保持一致，也无法做 `revision` 并发冲突检测 |

## 后果

- 后续 F-0035（单条配音）、F-0036（对齐）、F-0038（项目说话人克隆）直接复用 `tts` 能力声明、`ProviderRegistry.synthesize` 与 `cloneAuthorization` 契约，不需改写底层 Provider 与协议。
- 任何不支持 TTS 或不支持克隆的 Provider/模型都不会伪造能力或暴露空实现。
- `tts-settings.json` 与 `endpoints.json` 各自遵守 Host 存储边界，API Key 不落盘进普通配置。
- 本 ADR 在维护者验收 F-0053 前保持 `proposed`。

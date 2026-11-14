---
id: ADR-0015
status: accepted
date: 2026-11-13
deciders: zhangxiang.chen
feature: F-0019
superseded_by:
---

# ADR-0015 项目级术语词表与 ASR 热词能力契约

## 背景

口播创作者在视频中常包含人名、产品名、中英混排专有名词，仅靠通用模型容易反复识别错误（[F-0019](../../features/F-0019-asr-hotwords/01-spec.md)）。同时，后续多语翻译（[F-0032](../../features/F-0032-project-terminology/01-spec.md)）也需要项目级术语译名一致性，两者明确约定共享同一项目级术语实体，不建第二份平行词库。

约束如下：

- 调用方只传 `ModelRef` 与模型声明的选项，不得在前端或调用处写 `if (providerId === ...)` 硬编码判断（[docs/subsystems/providers.md](../../subsystems/providers.md)）。
- 不支持热词的模型（包括当前内置 `sherpa-onnx` 离线模型）不得伪造支持或静默接收无效热词，必须诚实提示并允许继续普通转写或切换模型。
- 词表属于项目资产，由 Host `ProjectStore` 随项目原子读写并带版本号检测并发冲突（[ADR-0003](0003-multi-video-projects.md)）。

## 决策

**在 `ProjectFile` 内维护单一的 `terminology` 术语词表实体（带 `terminologyRevision` 版本号），并通过 `ModelInfo.hotwords` 能力声明驱动 Host 与前端对识别热词的选择性传递。**

1. **单一共享术语实体（`shared/terminology.ts`）**：
   - 在 `ProjectFile` 增加可选 `terminology: ProjectTermEntry[]` 与 `terminologyRevision: number`（向后兼容 `PROJECT_FORMAT_VERSION = 4`，缺省视为 `[]` 与 `0`）。
   - 每条 `ProjectTermEntry` 包含 `{ id, term, asHotword, weight?, translations?, updatedAt }`。`F-0019` 读写 `term`、`asHotword` 与 `weight` 并无损保留 `translations` 字段，供 `F-0032` 直接复用同一实体与 `terminologyRevision`。
   - 词条按规范化去重键（`term.trim().toLowerCase()`）唯一，拒绝空白词与非正有限权重。
2. **模型热词能力声明与网关校验（`shared/providers.ts`、`server/plugins/providers.ts`）**：
   - 在 `ModelInfo` 增加可选 `hotwords?: { supported: boolean; weights?: boolean; maxTerms?: number; format?: 'space-separated' | 'weighted-lines' | 'prompt' }`。
   - `httpProvider.ts` 兼容已声明 `options.hotword` 的 FlyCut HTTP Provider 自动映射为支持热词；`endpoints.ts` 允许 OpenAI 兼容模型声明是否将热词写入 `/audio/transcriptions` 的 `prompt` 字段；`sherpa-onnx` 模型如实声明 `hotwords: { supported: false }`。
   - `ProviderRegistry.transcribe()` 强校验：若请求携带非空 `hotwords` 而目标模型未声明 `hotwords?.supported === true`，直接拒绝执行；不支持权重的模型自动剥离 `weight`，仅发送其允许的字段。
3. **Host 持久化与并发冲突（`server/plugins/projects.ts`）**：
   - 新增 `projects.getTerminology`（只读，加入 `READ_ONLY_RPC_METHODS`）与 `projects.saveTerminology`（校验 `baseRevision === project.terminologyRevision` 并发冲突并支持 `operationId` 幂等回查，冲突返回 `conflict` / `CONTENT_CHANGED`）。

## 备选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| **在 `ProjectFile` 扩展统一 `terminology` 实体（选定）** | 随项目创建/备份/回收站天然一致；与 `F-0032` 零冲突共享同一版本号与读写锁 | 每次改词表需更新 `project.json` |
| 独立 `<project>/terminology.json` 文件 | 不触碰 `project.json` | 备份、复制、版本号与项目开放快照需要两处同步，且易产生孤立锁问题 |
| 将热词仅存前端 `appStore.asrOptions` | 不改 Host | 无法在项目多视频和第二个客户端间共享，也无法与 `F-0032` 共用术语实体 |

## 后果

- `F-0032` 落地时无需新建词库或迁移旧数据，只需在 `ProjectTermEntry.translations` 上补充译名编辑与翻译提示注入即可。
- 所有调用点（前端 `useASR`、`AgentPanel`、`projects.transcribe`）统一读取 `ModelInfo.hotwords`，确保不支持热词的模型收到的热词请求数严格为 0。

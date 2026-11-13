---
id: F-0053
stage: 03-implementation
status: draft
approved_by:
approved_at:
---

# F-0053 TTS Provider能力与接入：开发记录

## 分支与 PR

- 分支：codex/f0053-tts-provider
- PR：

## 进度

| 日期 | 清单项 | 提交 | 检查 |
|---|---|---|---|
| 2026-11-13 | 1. 共享契约与音频校验 | 750d778 | `node --test tests/tts-audio.test.mjs` ✅, `pnpm check:host` ✅, `pnpm tsc -b --noEmit` ✅ |
| 2026-11-13 | 2. Provider 注册表与 HTTP TTS 协议 | a72286a | `pnpm check:host` ✅, `pnpm tsc -b --noEmit` ✅, `pnpm lint` ✅ |
| 2026-11-13 | 3. Host TTS 插件与持久化 | b7e47d2 | `tts-f0053.test.ts` (3/3) ✅, `pnpm check:host` ✅, `pnpm tsc -b --noEmit` ✅, `pnpm lint` ✅ |
| 2026-11-13 | 4. 协议文档与可复现示例服务端 | 2eee485 | `tts-f0053.test.ts` (4/4) ✅, `pnpm check:host` ✅, `pnpm tsc -b --noEmit` ✅, `pnpm lint` ✅ |
| 2026-11-13 | 5. 设置页独立 TTS 面板与客户端闭环 | 6576d2e | `pnpm check:host` ✅, `pnpm tsc -b --noEmit` ✅, `pnpm lint` ✅ |
| 2026-11-13 | 6. 端到端界面验收与静态/架构全量检查 | 待提交 | `pnpm lint` ✅, `pnpm tsc -b --noEmit` ✅, `pnpm check:host` ✅, `cargo check` ✅, `pnpm test` 109 passed/5 skipped ✅, `pnpm test:architecture` 149/149 ✅, `PW_PORT=5294 pnpm test:e2e tests/e2e/features/F-0053.spec.ts` 8/8 ✅ |

## 自行决定的事项

- **共享契约归属**：TTS 类型与 Zod schema 放在 `shared/tts/`（`settings.ts`、`audio.ts`）而不是全部塞进 `shared/providers.ts`，只把能力枚举与 `ModelRef` 选择扩展留在 `shared/providers.ts`，避免 ASR 契约文件继续膨胀。影响 AC-1。
- **音频格式判定**：`validateTtsAudio` 按文件头（RIFF/WAVE、fLaC、OggS、ID3/MPEG 帧同步）判定并校验字节一致，不信任 Provider 声明的 MIME。影响 AC-2、AC-4。
- **克隆授权**：`cloneAuthorization` 要求 `confirmed: true` 与 `speakerLabel`/来源说明同时存在，Host 在 `tts.synthesize` 入口再次校验，缺少授权直接拒绝而不是回退到自带音色。影响 AC-4。
- **E2E 竞态修正**：克隆试听用例原先直接断言最后一次 `tts.synthesize` 的 payload，但先前试听的「已完成」状态仍在 DOM 中会导致断言提前通过；改为先轮询 `tts.synthesize` 调用计数增加再断言。仅测试修正，产品行为不变。影响 AC-4、AC-9。

## 与设计的偏差

- 设计中的 `src/services/ttsService.ts` 与 `src/components/TTS/TTSSettingsPanel.tsx` 按设计落地；额外在 `shared/protocol.ts` 只导出结果类型，输入类型由 `src/services/ttsService.ts` 直接从 `shared/tts/settings` 引入，以通过 `no-unused-vars` 且不重复导出。无行为偏差。

## 遗留问题

- 真实第三方 TTS 服务（Kokoro/MeloTTS/CosyVoice/FlyCut Cloud）试听需要本地 Python 环境或云端凭据，当前环境缺失，已在 `04-test-report.md` 记为 `⏸ Not run`。仓库内提供了可复现的示例 HTTP Provider 与真实 Host 架构测试覆盖协议链路。


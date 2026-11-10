---
id: F-0006
stage: 03-implementation
status: approved
approved_by: auto
approved_at: 2026-11-09
---

# F-0006 VAD 去静音：开发记录

## 分支与 PR

- 分支：
- PR：

## 进度

<!-- 每完成实现清单的一项，在 02-design.md 勾选，并在这里追加一行：日期、清单项、提交 sha、跑过的检查。
换会话接着做时，先读 02-design.md 和这里。 -->

| 日期 | 清单项 | 提交 | 检查 |
|---|---|---|---|
| 2026-11-09 | 1. 共享建议契约与 store | 未提交（维护者要求跳过 commit） | `pnpm test:architecture` ✅ 66/66 |
| 2026-11-09 | 2. Host VAD 分析与 job | 未提交 | `pnpm tsc -b --noEmit` ✅、`pnpm test:architecture` ✅；真实 Host 分析待验收 |
| 2026-11-09 | 3. VAD Provider 与 sidecar | 未提交 | `pnpm test:fsmn-vad` ✅ 3/3（真实 FSMN/Silero） |
| 2026-11-09 | 4. 候选生成与切点保护 | 未提交 | `node --test tests/silence-rules.test.mjs` ✅ 5/5 |
| 2026-11-09 | 5. 界面、选择与预览 | 未提交 | F-0006 Playwright 8/8 ✅（明暗、中英文、无模型状态）；`pnpm e2e:evidence F-0006` ✅ 8 张截图、8 段录屏 |

## 自行决定的事项

<!-- 开发中自己决定的事：决定了什么、为什么、影响哪条 AC。验收时汇总进测试报告 -->

- 没有新增 `projects.projectMedia` 服务；silence 插件直接用 `ProjectStore` 读取项目、转写和媒体路径，路径仍只在 Host 内使用。
- base 复用 F-0005 的 `keyOf(edl/chunks/wordChunks)` 快照，而不是新增 editRevision 计数器。
- F-0006 的确认按钮沿用 F-0005 的「确认剪辑 / Confirm cuts」，避免改变已验收的智能剪空白交互。

## 与设计的偏差

<!-- 实现时改变了设计的地方及原因；重大偏差回到 02-design.md 修改，并记进测试报告 -->

- 设计写 `projects.projectMedia` 服务，实现改为插件内直接使用 `ProjectStore`；行为边界相同，但少了共享服务封装。
- 设计写 `editRevision`，实现复用现有快照 key。
- 设计写导出接点 5ms `afade`，已实现：joinFadeMs 贯通 appStore/export 请求/Host afade。

## 遗留问题

- 真实 Host `silence.analyze` 已执行：tests/architecture/silence-f0006.test.ts 使用真实 FSMN VAD 和真实导出；页面 E2E 仍用 mock Host 覆盖明暗/中英文/无模型/保存失败。
- 真实页面操作已执行：Vite + 真实 Host + 真实 FSMN VAD，生成 9 个候选，勾选后确认应用成功，操作历史出现「确认剪辑建议」。
- 预览 Web Audio 近似尚未实现；保存失败回滚已实现。
- 两段未剪辑原始口播的逐候选听校、误切/漏切记录尚未执行。

已运行：`pnpm test` 87/87（3 skipped）、`pnpm test:architecture` 66/66、`pnpm test:fsmn-vad` 3/3、`pnpm check:host`、lint、tsc、build；F-0005/0006/0007/0012 联合 E2E 60/60。
- 新增真实 Host 测试：`pnpm exec tsx --tsconfig server/tsconfig.json --test tests/architecture/silence-f0006.test.ts` ✅ 1/1（FSMN VAD + joinFade 导出）。
- 最终页面回归：F-0006 E2E 9/9；pnpm e2e:evidence F-0006 9/9（8 张截图、9 段录屏）；全量 F-0002/0003/0004/0005/0006/0007/0012/0013/0028 E2E 189/189。
- 真实页面：真实 Host + 真实 FSMN VAD，9 个候选，勾选确认后历史记录成功。
- 边界状态：F-0006 E2E 现为 11/11，新增取消、过期、保存失败；无模型/明暗/中英文已覆盖。
- 真实 Host 错误路径：tests/architecture/silence-f0006.test.ts 3/3，覆盖两段真实口播（en-wikimania、zh-podcast）、缺失媒体、无音轨、真实 VAD 和 joinFade 导出。
- 自部署页面：Caddy TLS + Basic Auth 下真实打开 Host 页面并连接成功（与 F-0014 共用验证）。
- Not run：Tauri GUI 实际操作（cargo check 通过）、人工逐候选听校的最终主观记录。

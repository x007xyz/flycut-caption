---
id: F-0056
stage: 03-implementation
status: approved
approved_by: auto
approved_at: 2026-11-10
---

# F-0056 AI模型配置与密钥保存到Host：开发记录

## 分支与 PR

- 分支：`codex/f0056-host-ai-settings`
- PR：

## 进度

<!-- 每完成实现清单的一项，在 02-design.md 勾选，并在这里追加一行：日期、清单项、提交 sha、跑过的检查。
换会话接着做时，先读 02-design.md 和这里。 -->

| 日期 | 清单项 | 提交 | 检查 |
|---|---|---|---|
| 2026-11-09 | 1. shared 契约与 Host 元数据/迁移/revision | `096e0c9` | `pnpm check:host` ✅；F-0056 架构测试 5/5 ✅（含 lost response、metadata/secret 一致性） |
| 2026-11-09 | 2. secret backend、遮罩与脱敏 | `096e0c9` | `pnpm exec tsx --tsconfig server/tsconfig.json --test tests/architecture/ai-settings-f0056.test.ts` ✅；加密文件串行/0600/tmp、元数据失败保留旧 ref、server 私网拒绝 ✅ |
| 2026-11-09 | 3. configId 消费链路与兼容 | `096e0c9` | `pnpm tsc -b --noEmit` ✅；真实本机 OpenAI 兼容 fixture 的 text/agent 请求 ✅ |
| 2026-11-10 | 4. AI 设置面板、CRUD、冲突、切 Host 与迟到响应 | `417ea1b`, `83059bd` | `pnpm lint` ✅；`pnpm tsc -b --noEmit` ✅；隔离 localhost:5175 Playwright 8/8 ✅ |
| 2026-11-10 | 5. 浏览器旧配置显式迁移与幂等重试 | `417ea1b` | 迁移失败保留来源和同一 migrationId，重试成功后才清本地 Key ✅；E2E 8/8 ✅ |
| 2026-11-10 | 6. 主题/i18n、Red check、完整回归与真实使用 | `417ea1b`, `83059bd` | `pnpm test:architecture` 96/96 ✅；`pnpm test` 95 pass / 3 optional-model skip ✅；`pnpm build`、`pnpm build:lib`、`cargo check` ✅；40 张截图、8 段录屏 ✅ |

## 自行决定的事项

<!-- 开发中自己决定的事：决定了什么、为什么、影响哪条 AC。验收时汇总进测试报告 -->

- 编辑配置时增加显式「清除已保存的 Key」操作；空 Key 仍表示保留，输入新 Key 会取消清除意图。影响 AC-3、AC-4。
- 所有 AI 设置异步操作绑定 Host generation；列表响应还校验 `snapshot.hostId`，切换 identity 后旧请求不能更新当前 store。影响 AC-6、AC-7、AC-8。
- 验收证据脚本支持 `FLYCUT_E2E_CONFIG`，并修正 Playwright 1.64 的 JSON 输出变量；默认行为保持原端口和配置。影响 AC-9 的证据生成。
- 全量架构回归从原仓库只读复用被 git 忽略的媒体、FFmpeg、FunASR 与 VAD 资源；除本地软链外没有复制或改写源文件。影响验证环境，不改变产品代码。

## 与设计的偏差

<!-- 实现时改变了设计的地方及原因；重大偏差回到 02-design.md 修改，并记进测试报告 -->

- 清单 4–6 在功能上连续交付，最终代码用 `417ea1b` 和补充 Host identity E2E 的 `83059bd` 两次提交完成；未再拆分仅用于记进度的提交。
- UI 状态用 Playwright mock Host 构造；Host 持久化、重启、第二个 HTTP 客户端、真实 OpenAI 兼容本地 fixture 和凭据后端由架构测试/真实命令覆盖。

## 遗留问题

- 未用真实付费外部 AI 服务验证；当前没有产品授权凭据，未使用 Codex 或代理凭据。
- 未启动完整 Tauri 窗口做人工点击；macOS 系统 Keychain、Host 打包和 `cargo check` 已分别验证。

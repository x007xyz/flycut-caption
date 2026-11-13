---
id: F-0030
stage: 04-test-report
status: review
approved_by:
approved_at:
---

# F-0030 多语言字幕轨道与兼容迁移：测试与验收

验收在 commit `cb15dc3d9ef4c9b969d663f9b93cb2155439f370` 上进行；产品代码和 E2E 用例在 `dd9466e`，此后只增加了真实 Host/Tauri 验收入口与文档。

> 技术设计和开发阶段由 agent 连续推进、自动确认；维护者在这里一并审阅。

## 设计与实现摘要

每个视频在 `edits.json` 中保存语言轨，条目按字幕 chunk id 关联，不复制时间。每条译文保存写入时的原文快照 `sourceText`；当前原文不同即显示过期，用户可保留旧译文并接受新原文版本，或手动重翻。轨道的增删改、切换与译文修改全部复用 `projects.saveVideoEdits` 和视频修订号，没有新增 RPC。

项目格式从 3 升到 4。旧项目读取时仅从非空 `secondText` 在内存生成 `legacy-second-text` 轨，语言为 `null`，不会猜测成英语；旧 `secondText` 字段继续作为活动轨投影，既有双语显示和字幕导出保持可用。首次写盘迁移保留 `project.v3.json`。长期契约见 proposed [ADR-0011](../../20-architecture/adr/0011-multilingual-subtitle-tracks.md)。

实现与设计一致。新增两个正式真实验收入口：`pnpm acceptance:f0030`（真实 Host + Chrome）和 `pnpm acceptance:f0030:tauri`（打包后的 macOS WKWebView）。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| 旧语言未知 | 迁移轨 `languageCode: null`，名称显示「未指定 / Unspecified」 | 旧数据没有语言元数据，不能擅自认作英语 | AC-2 |
| 原文版本 | 每条译文保存写入时的完整 `sourceText` | 简单、可回读、可显示过期；保留操作可显式推进版本 | AC-3 |
| 活动轨 | `activeLanguageTrackId` 随 edits 保存，并投影 `secondText` | 重开恢复上下文，旧显示/导出读取路径继续工作 | AC-1、AC-4、AC-7 |
| 写入校验 | 新写入禁止孤立 chunk id；读取保留孤立条目 | 阻止新错误，同时不丢旧数据 | AC-2、AC-4 |
| 双语 E2E 初始语言 | demo 入口支持 `?ui=en` | 加载页没有编辑器语言按钮，仍能验证英文加载态；既有 `?lang` 路径未改 | AC-9 |
| Tauri 验收构建 | 构建输出和临时诊断放 `/private/tmp`，结束前删除 | 不把未跟踪构建产物带入工作树 | AC-9 |
| 本机 Node 动态库 | 只在临时 macOS 验收包补 `libnode.147.dylib` 并 ad-hoc 重签 | 本机 Homebrew Node 打包缺动态库；产品代码和打包脚本未被改动 | AC-9 |

## 验收标准逐条结果

| AC | 验证方式 | 证据 | 结果 |
|---|---|---|---|
| AC-1 创建、命名、切换、编辑译文与空轨 | 架构 + Playwright + 真实 Host/Tauri | `tests/architecture/language-tracks-f0030.test.ts` 的 “F-0030/AC-1 AC-4 format-4 tracks persist…” 与 “editor tracks switch…”；E2E “F-0030/AC-1 AC-4 AC-7 create, name, switch…”；`pnpm acceptance:f0030`、`acceptance:f0030:tauri` 均 PASS；截图 `tracks-empty-*`、`track-no-translation-*`、`tracks-populated-*` | ✅ 通过 |
| AC-2 旧 `secondText` 无损迁移、语言未知不猜测、双语导出兼容 | 架构 + Playwright + 真实重开 | “F-0030/AC-2 legacy secondText migrates…” 断言磁盘不改、语言为 null、SRT 双语内容保留并在首写后生成 `project.v3.json`；各语言/主题 “legacy secondText stays readable…”；截图 `legacy-unspecified-*`、`legacy-language-set-*` | ✅ 通过 |
| AC-3 原文版本、过期提示、保留/重翻 | 架构 + Playwright + 真实 Host | “editor tracks switch…”、E2E “source edits mark translations outdated…”；`acceptance:f0030` 与 Tauri 均在真实 Host 回读 `sourceText` 从「这是原字幕」推进到「字幕已更新」；截图 `translation-outdated-*` | ✅ 通过 |
| AC-4 共用原文时间/EDL、删除确认、重开、并发不覆盖 | 架构 + Playwright + 真实重开 | Host 测试断言保存前后 chunk timestamp 不变，旧客户端修订保存返回 conflict 且另一语言仍保留；E2E 删除轨先显示确认，切轨/重开保留内容；F-0005 EDL 架构回归 96 项全量通过 | ✅ 通过 |
| AC-5 入口、空态、前置和未知语言 | Playwright + 真实 Host | 复用现有项目/字幕编辑器入口；无字幕显示「暂无内容 / Nothing here yet」；无轨显示同一空态；无译文显示「此语言尚无译文 / No translation for this language」；旧轨显示未指定及设置语言入口；截图 `no-content-*`、`tracks-empty-*`、`track-no-translation-*`、`legacy-unspecified-*` | ✅ 通过 |
| AC-6 加载、处理中、重复提交防护、取消与迟到响应 | Playwright + 既有项目保存回归 | “F-0030/AC-6 AC-7 loading, processing…” 构造延迟打开与延迟保存，显示 Loading/Processing/Completed；保存继续走单飞队列，切换视频后的响应由既有 `sameVideo` 检查丢弃；添加、编辑、删除对话框均提供 Cancel；截图 `loading-*`、`processing-*`、`completed-*` | ✅ 通过 |
| AC-7 Host 确认后完成、重开和同 Host 一致 | Playwright + 架构 + 真实 Web/Tauri | E2E 在保存返回后显示 Completed 并 reload 回读；真实 Host 验收重启 UI 后在两条轨之间切换；Host 架构测试以两个修订客户端验证持久化与冲突；截图 `completed-*` | ✅ 通过 |
| AC-8 失败、冲突与重试 | Playwright + 架构 | E2E 注入 `disk full`，保留输入并显示错误、Retry、Back，恢复后保存成功；再注入 conflict，显示「内容已更新，请重新检查 / Content changed. Review again.」并打开既有冲突对话框，未覆盖 Host；截图 `save-failed-*`、`conflict-*`、`conflict-dialog-*` | ✅ 通过 |
| AC-9 真实验证与中英文/明暗矩阵 | Playwright + 真实 Host/Tauri | `F-0030.spec.ts` 24/24；`pnpm e2e:evidence F-0030` 24/24，56 张截图、24 段录屏；`acceptance:f0030` 在真实 Host + Chrome 通过；`acceptance:f0030:tauri` 在 macOS 26.6.2 WKWebView 通过 | ✅ 通过 |

## 界面证据

全部 14 个状态各有 light-zh、light-en、dark-zh、dark-en 四张，共 56 张，位于 [screenshots](screenshots/)。本地验收录屏 24 段及摘要位于 `recordings/`（按规则不入 Git）。

| 界面 | 状态 | AC | 代表截图 | 录屏 |
|---|---|---|---|---|
| 项目首页 | 打开项目加载中 | AC-5、AC-6 | [loading-light-zh.png](screenshots/loading-light-zh.png) | 有 |
| 项目首页 | 打开完成 | AC-7 | [completed-light-zh.png](screenshots/completed-light-zh.png) | 有 |
| 字幕编辑器 | 无字幕内容 | AC-5 | [no-content-light-zh.png](screenshots/no-content-light-zh.png) | 有 |
| 语言轨道 | 无轨道空态 | AC-1、AC-5 | [tracks-empty-light-en.png](screenshots/tracks-empty-light-en.png) | 有 |
| 语言轨道 | 当前轨无译文 | AC-1、AC-5 | [track-no-translation-dark-en.png](screenshots/track-no-translation-dark-en.png) | 有 |
| 语言轨道 | 中英双语轨与切换 | AC-1、AC-7 | [tracks-populated-dark-en.png](screenshots/tracks-populated-dark-en.png) | 有 |
| 语言轨道 | 删除确认 | AC-4 | [track-delete-confirm-light-zh.png](screenshots/track-delete-confirm-light-zh.png) | 有 |
| 语言轨道 | 旧 `secondText` 未指定语言 | AC-2、AC-5 | [legacy-unspecified-light-zh.png](screenshots/legacy-unspecified-light-zh.png) | 有 |
| 语言轨道 | 指定旧轨语言后 | AC-2 | [legacy-language-set-dark-zh.png](screenshots/legacy-language-set-dark-zh.png) | 有 |
| 译文 | 原文变化后过期 | AC-3 | [translation-outdated-light-zh.png](screenshots/translation-outdated-light-zh.png) | 有 |
| 保存状态 | 正在处理 | AC-6 | [processing-light-en.png](screenshots/processing-light-en.png) | 有 |
| 保存状态 | 保存失败 | AC-8 | [save-failed-dark-zh.png](screenshots/save-failed-dark-zh.png) | 有 |
| 保存状态 | 版本冲突 | AC-8 | [conflict-light-en.png](screenshots/conflict-light-en.png) | 有 |
| 冲突对话框 | 需重新检查 | AC-8 | [conflict-dialog-dark-zh.png](screenshots/conflict-dialog-dark-zh.png) | 有 |

## 回归检查

| 命令 | 结果 |
|---|---|
| `pnpm lint` | ✅ |
| `pnpm tsc -b --noEmit` | ✅ |
| `pnpm check:host` | ✅ |
| `pnpm test` | ✅ 90 通过，0 失败，8 个既有 ASR 模型集成跳过 |
| `pnpm test:architecture` | ✅ 96/96 |
| `pnpm build` | ✅ |
| `pnpm package:host && cargo check --manifest-path src-tauri/Cargo.toml` | ✅ |
| `pnpm test:e2e tests/e2e/features/F-0030.spec.ts --workers=1` | ✅ 24/24 |
| `pnpm e2e:evidence F-0030` | ✅ 24/24；56 截图、24 录屏 |
| `pnpm acceptance:f0030` | ✅ 真实 Host + Chrome：两条轨、切换、重开、过期保留 |
| `pnpm acceptance:f0030:tauri <temp app>` | ✅ macOS 26.6.2、Chrome 157.0.8103.50；WKWebView 同一流程通过 |

Red check 1：临时让 `normalizeLanguageTracks` 不迁移旧 `secondText`，架构测试按预期失败在 `undefined !== 'Bonjour'` 与 `null !== 'legacy-second-text'`；恢复实现后通过。

Red check 2：临时让 `isTranslationOutdated` 恒为 false，架构测试按预期失败在过期数 `0 !== 1`；恢复实现后通过。

## 发现的问题

- 未发现 F-0030 范围内的失败。
- 本机用 Homebrew Node 打包 debug Tauri 时，`package:host` 产物缺少 `libnode.147.dylib`。本次只在 `/private/tmp` 的临时验收包补齐并 ad-hoc 重签，未提交构建产物、未修改打包脚本。该既有打包问题应由父代理在发布链路中处理。
- F-0031 和 F-0033 的后续实现应直接使用 ADR-0011 的 `languageTracks`、`sourceText` 与活动轨投影，不再另建轨道 RPC 或时间字段。当前没有需要推翻已确认 AC 或 decisions.md 的冲突。

## Not run

- ⏸ Windows / Linux 桌面端：本机没有对应构建与 WebDriver 环境。
- ⏸ 远程 Web Host / FlyCut Cloud 环境：没有远程实例和凭据；本地 Web + 真实 Host 已通过同一接口。
- ⏸ 真实 ASR 模型集成 8 项：本机缺少 `sensevoice-small-int8-zh-en-ja-ko-yue-2024-07-17`，不影响 F-0030 的手动语言轨路径。
- ⏸ 正式签名、公证与发布包验收：不属于需求验收，且本轮明确不 push/发版。

## 结论

F-0030 在 macOS Web 与 Tauri debug、真实 Host、旧格式迁移、冲突和过期路径上通过验收，可以进入维护者确认。正式发版前仍需父代理处理本机 Node 动态库随包问题，并确认 proposed ADR-0011；本轮不自行 approve、不 push、不发版。

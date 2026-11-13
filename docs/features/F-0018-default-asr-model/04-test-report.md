---
id: F-0018
stage: 04-test-report
status: review
approved_by:
approved_at:
---

# F-0018 默认模型推荐与下载引导：测试与验收

验收在代码与测试提交 `bbb374a` 上进行；本报告随后作为文档提交，不改变代码与测试。

> 技术设计和开发阶段由 agent 连续推进、自动确认；维护者在这里一并审阅。

## 设计与实现摘要

围绕「首次使用不知道下哪个模型」补一条离线推荐闭环：

- **推荐元数据**（`models.json`）：只把 SenseVoice Small INT8 标为推荐，附 F-0001 参照（两份 COSCUP 精校文本、CER 区间、文本对齐语气词召回）、时间戳级别（segment/VAD）、离线可用与体积，并显式写入「无独立时间真值、其余模型未重跑」的限制说明。
- **Host 下载**（`server/plugins/models.ts`、`server/plugins/providers.ts`）：字节级进度、磁盘空间检查（含 ENOSPC）、分片写入后 SHA-256 校验再原子落盘、取消即清理临时文件、并发 prepare 去重；校验通过前模型不可选。
- **前端状态**（`src/utils/modelRecommendation.ts`、`src/hooks/useProviderModels.ts`、`src/hooks/useASR.ts`）：下载状态机（idle/checking/downloading/verifying/ready/error/cancelled）、过期响应守卫、已有有效选择不被覆盖。
- **引导卡片**（`src/components/ASR/RecommendedModelCard.tsx`）：接入模型面板、ASR 设置与编辑器字幕区三个既有入口，显示「下载推荐模型 / Download recommended model」、进度、取消与重试，失败给原因。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| 推荐范围 | 单一中文口播离线推荐，不做全模型排名 | F-0001 只完成两模型文字评测、缺独立时间真值，不能支撑「最佳模型」结论 | AC-1 |
| 推荐元数据位置 | 写进 `models.json` 的 `recommendation` 字段，Host 与前端读同一份 | 避免 UI 与 Host 各自硬编码导致漂移 | AC-1、AC-4 |
| 就绪判定 | SHA-256 通过且原子替换完成后才标记 ready | 半包或校验失败必须是不可用状态，不能拿去识别 | AC-2 |
| 无网络/磁盘不足 | 只提示改选已下载模型或重试，不推荐也不自动切云 | 推荐是离线能力，不能借引导把用户推向收费服务 | AC-3 |

## 验收标准逐条结果

| AC | 目标平台 / 环境 | 验证方式、用例与命令 | 证据或未跑原因 | 结果 |
|---|---|---|---|---|
| AC-1 | Node + Host + Web Chrome | `pnpm test`（清单推荐字段与限制文案）；E2E「F-0018/AC-1 AC-5 AC-6 loading, empty state, and recommended card metadata」 | 卡片显示模型名、Provider、体积、离线、时间戳级别与 F-0001 限制说明，无「最佳」字样 | ✅ 通过 |
| AC-2 | Host + Web Chrome | `tests/architecture/default-asr-model.test.ts`「Host verifies checksums, reports byte progress, cleans cancelled downloads, checks disk space, and deduplicates concurrent prepares」；E2E「F-0018/AC-2 AC-5 AC-6 AC-7 …」 | 字节进度与取消生效，取消后临时文件清理，校验前不可识别 | ✅ 通过 |
| AC-3 | Web Chrome | E2E「F-0018/AC-3 AC-5 AC-8 error retry/back, preserve user model, never switch to cloud, stale conflict, existing editing」 | 已有选择保留；失败/磁盘不足时可改选已下载模型；全程不出现云端切换 | ✅ 通过 |
| AC-4 | 真实 Host + 真实模型文件 | `tests/architecture/default-asr-model.test.ts`「fresh install downloads real SenseVoice model, verifies SHA-256, transcribes Chinese talking-head clip, and persists across Host restart」 | 本地静态源真实下载 → SHA-256 校验 → 真实 `funasr-asr` 识别中文口播 → 重启后选择保持 | ✅ 通过（真实模型与 sidecar） |
| AC-4 | 全新图形化安装环境 | 清空模型目录的首次启动，从引导下载到识别并重启 | 未做全新系统级安装（清空 `~/Library/Application Support` 全量用户数据与重装桌面包） | ⏸ Not run |
| AC-5 | Web Chrome | E2E 空态与前置不足段 | 无模型的入口显示缺失项与配置入口；无记录显示「暂无内容 / Nothing here yet」；已有编辑不中断 | ✅ 通过 |
| AC-6 | Web Chrome | E2E 加载/下载中段 | 「正在加载…」「正在处理…」与字节进度可见，下载中禁止重复提交，提供取消 | ✅ 通过 |
| AC-7 | 真实 Host + Web Chrome | 架构测试重启保持 + E2E 「completion & second client」 | 仅校验通过后显示「已完成 / Completed」；第二个客户端读到同一模型状态 | ✅ 通过 |
| AC-8 | Web Chrome | E2E 错误/重试/过期段 | 失败显示具体原因与「重试 / Retry」「返回 / Back」；保留已有选择；过期响应不串台 | ✅ 通过 |
| AC-9 | Web Chrome（中英文 × 明暗） | `PW_PORT=5296 pnpm test:e2e tests/e2e/features/F-0018.spec.ts --workers=1` | 12/12 通过；32 张截图入库，录屏仅本地 | ✅ 通过（Web） |
| AC-9 | 真实 Tauri 桌面端 | 打包后的 macOS/Windows 应用内完成同一引导下载与识别 | 本 worktree 未构建桌面安装包 | ⏸ Not run |

## 界面证据

由 `PW_PORT=5196 pnpm e2e:evidence F-0018` 生成，覆盖 `light/dark × zh/en`；`screenshots/` 已入库。

| 界面 | 状态 | AC | 截图 |
|---|---|---|---|
| 模型面板 | 加载中 / 空态 / 推荐卡片 / 错误 / 过期 | AC-1、AC-5、AC-6、AC-8 | `models-{loading,empty,recommended,error,stale}-{light,dark}-{zh,en}.png` |
| 编辑器字幕区引导 | 引导 / 下载中 / 完成 | AC-2、AC-5、AC-7 | `editor-{guide,downloading,completed}-{light,dark}-{zh,en}.png` |

## 回归检查

全部运行于提交 `bbb374a`：

- `pnpm lint` ✅
- `pnpm tsc -b --noEmit` ✅
- `pnpm check:host` ✅
- `cargo check --manifest-path src-tauri/Cargo.toml` ✅
- `pnpm test` ✅：117 tests，112 passed，0 failed，5 skipped（未下载的额外 ASR 模型）
- `pnpm test:architecture` ✅：147/147 passed（含真实 SenseVoice 下载与识别用例）
- `PW_PORT=5296 pnpm test:e2e tests/e2e/features/F-0018.spec.ts --workers=1` ✅：12/12 passed
- Red check ✅：把 SHA-256 比较改成恒真后，`default-asr-model.test.ts` 的校验失败用例立即失败于损坏文件被接受；恢复后重新全绿

## 发现的问题

- 原有推荐标记分散在 `models.json` 的 `recommended: true` 与前端文案中，缺少 F-0001 限制说明，容易被读成「官方最佳」；本次收敛为单一推荐 + 显式限制元数据。
- 下载中断后残留的部分文件原先可能被当作已安装；现在只有校验通过的原子落盘结果才算可用。

## 结论

推荐元数据、Host 下载与校验、前端状态机与三处引导入口的自动化验证通过，并用真实 SenseVoice 模型 + 真实 `funasr-asr` 在隔离 Host 中完成了下载到识别再到重启保持的闭环（AC-1 至 AC-8 与 AC-9 的 Web 部分）。全新图形化安装环境与 Tauri 桌面实机受环境限制，如实记为 `⏸ Not run`。

本报告等待维护者审阅确认；未自行执行 `pnpm feature approve`。


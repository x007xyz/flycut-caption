---
id: F-0011
stage: 04-test-report
status: review
approved_by:
approved_at:
---

# F-0011 剪映草稿导出：测试与验收

验收在本地代码提交 `7b8feac` 上进行；本文件随后作为报告提交。技术设计和开发阶段已按流程自动确认，维护者在这里一并审阅。

## 设计与实现摘要

实现了完整但默认关闭的剪映导出链路：Host 负责能力矩阵、目录 grant/preflight、冻结快照、媒体探测、复制、封面、草稿 JSON、回读、job 进度/取消和原子提交；Tauri 只提供原生目录选择并用 shell secret 登记，WebView 只收到 opaque grant。正常 Host 不注册写 RPC/route，显式内部验证构建才开放，能力和 UI 固定标“仅内部验证”。

`jianying.start` 只接受 preflight ID，并将其作为确定性 job ID；operation→job 关联持久化。并发、响应丢失、重复调用和 Host 重启后用同一 preflight 返回同一 JobSnapshot。server profile 对 linked 项目媒体硬拒绝，普通 patch/env 不能暗开。

生成器只写 Windows 5.9.0 候选布局：单时间线、单视频轨、单条不重叠主字幕轨，媒体复制并校验 SHA-256，不写用户 `root_meta_info.json`。ADR-0009 仍为 proposed。与设计没有范围级偏差；实现清单把 Tauri、Host 幂等和证据拆得更细，已同步 02。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| 默认发布门禁 | 正常 Host 不注册目录/preflight/start；内部验证需显式配置 | Mac 只验证了单候选有界能力，编辑/重开/搬迁/两段素材仍缺 | AC-1、AC-8 |
| 任务幂等 | preflight ID=job ID，operation 关联持久化；重复 start 返回原 JobSnapshot | 防丢回包重试和并发创建多个任务 | AC-2、AC-5 |
| linked 媒体 | desktop 默认允许；server profile 固定拒绝，resolved profile 绕过 patch | server 不得因普通配置读取本机路径 | AC-3 |
| 字幕重叠 | 投影后重叠直接失败 | Mac 可能自行重排；不能静默改变字幕时序 | AC-7 |
| 新测试字幕 | 使用文本自带时间标识的非重叠字幕和独立期望数组 | 不拿生成器自检冒充真机时序 | AC-7、AC-10 |
| 端口 | 使用 5181，并让 Playwright 支持 `PW_PORT` | 5173 被其他 worktree 的开发服务器占用 | 界面验收 |

## 验收标准逐条结果

| AC | 验证方式 | 证据 | 结果 |
|---|---|---|---|
| AC-1 | Host + Playwright | 默认 capabilities `exportEnabled:false`，写方法/route 不存在；内部模式明确标“仅内部验证”；Mac 仅显示有界导入/时序证据 | ✅ 禁用门禁；正式支持尚未完成 |
| AC-2 | Host + E2E | 准备时冻结正式 EDL/字幕/样式/身份；准备后输入锁定；界面显示项目、视频、冻结时间；operation 关联可恢复 | ✅ 内部链路 / ⏸ 新 Tauri 实机 |
| AC-3 | Host + Rust + E2E | shell-only/CORS 拒绝、原生目录命令、一次性 grant、同名目标拒绝、server linked 媒体硬拒绝；普通 RPC 无 path | ✅ 安全/自动测试 / ⏸ 原生选择器闭环 |
| AC-4 | Host + E2E | copy 策略、空间估算、媒体复制、SHA-256、源 mtime 不变、降级清单 | ✅ 内部链路 |
| AC-5 | Host + E2E | job 进度、取消、唯一 start、丢回包/重启返回同一 job；取消和注入失败无 staging | ✅ 自动/界面 / ⏸ 新 Tauri 实机 |
| AC-6 | Host + E2E | 媒体缺失、空间不足、权限分类、重叠、同名、授权失效、格式失败；失败可重选重试 | ✅ 自动/界面 / ⏸ 实际权限错误 |
| AC-7 | 真机 + Host | Mac 旧候选以 AX currentProgress 核对 20–22 秒及跨切点字幕；新生成器拒绝重叠并独立回读。字幕轨道编辑未验证 | ⏸ 部分：时序有证据，可编辑性缺 |
| AC-8 | Host + E2E | 内部成功态显示“草稿已生成”、项目/视频/时间/路径/导入说明；正常产品只显示禁用 | ✅ 内部界面 / ⏸ 新 Tauri 实机成功 |
| AC-9 | 真机 | 移动新产物后打开未执行；绝对媒体路径风险仍在 | ⏸ Not run |
| AC-10 | 真机 | 仅一个 Mac 测试候选；两段不同原始口播的字幕/EDL、播放、编辑、保存重开未执行 | ⏸ Not run |

## 界面证据

`PW_PORT=5181 pnpm e2e:evidence F-0011`：20/20 通过，32 张截图，20 段录屏。中英、明暗均覆盖。

| 界面/状态 | AC | 截图 | 录屏 |
|---|---|---|---|
| 加载 | AC-1 | `support-loading-{light,dark}-{zh,en}.png` | 本机 `recordings/` |
| 能力错误/重试 | AC-1 | `support-error-{light,dark}-{zh,en}.png` | 本机 `recordings/` |
| 默认矩阵/禁用 | AC-1 | `support-matrix-{light,dark}-{zh,en}.png` | 本机 `recordings/` |
| 冻结准备 | AC-2/4 | `export-prepared-{light,dark}-{zh,en}.png` | 本机 `recordings/` |
| 进度 | AC-5 | `export-running-{light,dark}-{zh,en}.png` | 本机 `recordings/` |
| 取消 | AC-5/6 | `export-cancelled-{light,dark}-{zh,en}.png` | 本机 `recordings/` |
| 空间错误 | AC-6 | `export-error-{light,dark}-{zh,en}.png` | 本机 `recordings/` |
| 成功 | AC-8 | `export-success-{light,dark}-{zh,en}.png` | 本机 `recordings/` |

## 回归检查

- `pnpm lint` ✅
- `pnpm tsc -b --noEmit` ✅
- `pnpm check:host` ✅
- `cargo check --manifest-path src-tauri/Cargo.toml` ✅
- `pnpm test`：95 通过、3 跳过、0 失败；跳过仅为 3 个未下载模型。真实 FunASR、FSMN + Silero VAD 和其余可运行集成测试已执行。
- `pnpm test:architecture`：97/97 ✅；中途发现既有 WebSocket snapshot 测试在 `host/ready` 后立即断开，偶发丢 `jobs/snapshot`，已让测试等两帧后再断并重跑全绿。
- `node --import tsx --test tests/architecture/jianying-f0011.test.ts`：6/6 ✅，含丢回包、Host 重启幂等和 server linked-media 暗开拒绝。
- `cargo test --manifest-path src-tauri/Cargo.toml jianying_output`：2/2 ✅。
- `PW_PORT=5181 pnpm exec playwright test tests/e2e/features/F-0011.spec.ts`：20/20 ✅。
- 只读复用原分支的 `tests/media`、FFmpeg/FunASR binary 和 FSMN VAD 权重；本机链接均忽略，不进入提交。

## 发现的问题

- **正式产品仍不可用：** 当前是内部验证候选，不是已声明支持的剪映目标。
- **新 Tauri 产品链路未跑：** 尚未在桌面外壳里实际点击目录选择、生成新候选、取消和成功；E2E 的 Tauri IPC 是替身，不能替代真实使用。
- **字幕编辑未验证：** CUA 无法选择字幕轨道（`noWindowsAvailable`）；不能把播放/时序通过写成可编辑。
- **保存后重开未验证：** 已观察到旧候选保存迁移到 Timelines，但没有在 UI 内重新打开核对。
- **搬迁未验证：** 候选写最终绝对媒体路径；移动后打开仍为 AC-9 缺口。
- **两段真实口播未验证：** 同一 demo 的多个切段不算 AC-10。
- **Windows 5.9.0 未验证：** 本机没有目标应用。

## 结论

**需要修复后重测，暂不可发布。** 完整产品代码、默认 fail-closed 门禁、内部验证导出链路和自动测试已经完成；正式验收还缺新 Tauri 实机链路、字幕编辑、保存后重开、搬迁、两段真实口播和 Windows 证据。请维护者审阅设计与实现后决定是否继续实机验证；不要依据本报告批准正式支持。

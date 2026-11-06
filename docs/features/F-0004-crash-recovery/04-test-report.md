---
id: F-0004
stage: 04-test-report
status: review
approved_by:
approved_at:
---

# F-0004 崩溃恢复：测试与验收

验收在 commit `3c6e27c` 上进行（分支 `feat/f-0004-crash-recovery`，基于未合并的 `feat/f-0003-project-management`）。之后只改了本报告和截图。

> 技术设计和开发阶段由 agent 连续推进、自动确认；维护者在这里一并审阅。

## 设计与实现摘要

- 编辑器每个会话把还没写进 Host 的完整编辑状态（字幕、删除标记、译文、样式来源、样式、画幅）记成一份 IndexedDB 副本。键是 Host 身份 + 项目 + 视频 + 会话。停止编辑 250ms 后记录，连续编辑最多每 1 秒记录一次。Host 保存成功后，副本删除或换成新的基准修订号。
- 打开视频时检查副本，跳过还开着的窗口（Web Lock）。与 Host 内容相同的副本说明已经写入，不提示，直接删掉。其余的让用户恢复、放弃或稍后处理。恢复前重新读 Host，基准修订号不对就让用户选择覆盖、另存为新项目或取消。写入失败先查询确认，查不到时说明「暂时无法确认保存结果」，副本保留。
- Host 新增 `projects.identity`（Host home 里的稳定随机 ID）。`projects.duplicate` 可带客户端生成的 `copyId`，重试不会建出第二个副本。项目存储格式不变。
- 新 ADR：[ADR-0004](../../20-architecture/adr/0004-client-recovery-copies.md)，状态 proposed，已按实现重写，确认本报告时一并改为 accepted。`docs/decisions.md` 记下已批准的本地副本例外。
- **与设计的主要偏差：** 设计打算在 Host 加持久操作回执和可恢复事务。实现改为按内容比较副本和 Host，因为 F-0003（ADR-0003）已经决定项目写入不做事务恢复记录。完整列表见 03「与设计的偏差」和 ADR-0004 最后一节。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| 判断副本是否已写入 | **按内容比较，不做 Host 操作回执 / 事务。请确认** | F-0003 没有事务层；内容比较不改存储格式，并同时覆盖「保存成功但副本没删」和「恢复响应丢失」 | AC-1、AC-5、AC-6 |
| 保存接口 | 复用 F-0003 的 `saveVideoEdits` / `saveProjectStyle`；`duplicate` 加可选 `copyId`；新增 `projects.identity` | 不新增平行的保存路径；改动向后兼容 | AC-1、AC-7 |
| 代码位置 | 恢复逻辑在 `ctx.projects`，状态在 `stores.project.recovery`，不另建插件 / store | 和自动保存共用编辑器状态、保存起点和写入队列 | — |
| F-0003 多视频 | **已按视频适配（需求说明原定 F-0003 上线后再做）。请确认** | F-0003 已先合入；不适配会写错项目样式 | AC-1、AC-5、AC-7 |
| 还开着的窗口 | 用 Web Lock 标记，其他窗口跳过 | 另一个窗口正在编辑的内容不是崩溃留下的 | AC-3 |
| 「正在检查恢复内容…」 | 项目读取完成后才进入检查；检查超过 300ms 才显示（期间编辑器一直被挡住） | 否则会挡住 F-0002 / F-0003 的打开中状态，那些测试会失败；也避免每次打开都闪一下 | AC-2 |
| Host 身份 | 每个连接读一次并缓存，重连后重读 | 打开长视频时页面忙 35–45 秒，之后再请求身份会超时，被误报成检查失败 | AC-2、AC-6 |
| 会话命名 | 「会话 n · 时间」，按时间倒序，默认选最新 | AC-3 没规定 | AC-3 |
| 放弃失败后的按钮 | 确认按钮变为「重试」 | AC-9 要求提供重试和取消 | AC-9 |
| 记录节奏 | 停止 250ms / 连续最多 1 秒 | 给 PRD 的 1 秒 / 2 秒边界留余量 | AC-1 |
| 已知小窗口 | 本窗口保存成功到副本换成新基准之间（毫秒级）崩溃，下次会当成冲突提示 | 选「覆盖」即可，不丢数据、不静默覆盖；消除它需要设计里的持久 pending 标记 | AC-1、AC-7 |

## 验收标准逐条结果

E2E 命令：`pnpm e2e:evidence F-0004`（28 通过 / 0 失败，明暗各一遍，含英文）。Host 测试：`pnpm test:architecture`（`tests/architecture/projects-f0004.test.ts` 4 条）。真实使用：隔离的 Host home + Vite（等同 `pnpm dev`），真实视频 `tests/media/zh-press/zh-mfa-briefing-2021-04-08.webm`（5.9 分钟口播）及其 ASR 基线字幕，在内置浏览器里操作。

| AC | 验证方式 | 证据 | 结果 |
|---|---|---|---|
| AC-1 | E2E + Host 测试 + Red check + Real use | `F-0004/AC-1 AC-3 AC-5 客户端崩溃后重新打开…`、`F-0004/AC-1 停止编辑 1 秒内记录；保存成功后不再提示；旧保存成功不清除更新的修改`、`F-0004/AC-1 AC-3 只列出这个 Host、项目、视频的副本…`；Host：`identity survives restarts and token changes…`、`a damaged identity file stops the Host…`。Red check：去掉保存后重记 → 副本不删的断言失败；去掉还开着窗口的过滤 → 隔离测试失败。Real use（Web）：客户端强退 3/3、Host 强退 3/3、同时强退 3/3，结果见「真实故障记录」；记录耗时见「成功指标」 | ✅ Web；⏸ 桌面端强退 Not run（见下） |
| AC-2 | E2E | `F-0004/AC-2 检查中挡住编辑区，可以返回首页；检查失败不当作没有副本`（文案、编辑区点不到、返回首页、读取失败进入 AC-6、重试）；截图 checking-* | ✅ |
| AC-3 | E2E | 主流程测试（标题、说明带时间、Host 最后保存时间、多会话倒序单选、三个按钮、选择前不写项目）；`F-0004/AC-3 稍后返回首页，副本保留，不启动自动保存`；英文测试；截图 choose-*、en-choose-* | ✅ |
| AC-4 | E2E | `F-0004/AC-4 AC-6 恢复中不能重复提交；响应丢失先查询确认`（「正在恢复…」禁用、其他按钮禁用、编辑区点不到）；截图 applying-* | ✅ |
| AC-5 | E2E + Real use | 主流程测试（「修改已恢复并保存」、只清除这份副本、再次重开从 Host 读到同样结果）；`F-0004/AC-5 媒体丢失时仍恢复字幕…`；Real use：9 次恢复后 `edits.json` 与界面一致 | ✅ |
| AC-6 | E2E + Host 测试 | `…响应丢失先查询确认`（已写入 → 按成功处理，只写一次）；`F-0004/AC-6 无法确认结果、目标不存在时保留副本…`（结果待确认 / 原项目不存在两种补充说明、重试、返回首页、副本保留、项目未被写）；`F-0004/AC-6 无法读取的副本不删除…`；截图 failed-uncertain-*、failed-missing-*、en-failed-* | ✅ |
| AC-7 | E2E + Host 测试 + Real use | `F-0004/AC-7 版本冲突：取消回到选择，覆盖必须显式选择`；`F-0004/AC-7 冲突时另存为新项目：重试不会建出第二个副本，只处理选中的副本`；Host：`Save as new project with a client-chosen ID makes one copy…`（Red check：忽略 copyId 后失败）、`a copy a crash left half done is made again`。Real use：崩溃留下副本后另一台设备通过 RPC 保存 → 打开 → 冲突 → 另存为新项目：原项目保留另一台设备的版本，只多出一个副本项目，内容是崩溃前的修改 | ✅ |
| AC-8 | E2E | `F-0004/AC-8 AC-9 放弃需要确认…`（文案、取消返回选择、副本不变）；截图 discard-confirm-*、en-discard-* | ✅ |
| AC-9 | E2E | 同上（「正在移除恢复副本…」及按钮禁用；失败保留确认框并提示「无法移除恢复副本，请重试。」；成功后「已放弃恢复」、显示 Host 内容、不写项目）；截图 discarding-*、discard-failed-* | ✅ |
| AC-10 | E2E | `F-0004/AC-10 记录失败时持续提示，不影响 Host 自动保存；重试成功后提示消失`（存储写入抛 QuotaExceededError：提示一直在、自动保存照常发出、「立即保存」走保存流程、重试成功后消失、最后一份副本完整）；英文；截图 unavailable-*、en-unavailable-* | ✅ |

### ⏸ Not run

- **桌面端（Tauri）真实强退 ×3 类 ×3 次。** 需要 `pnpm tauri:dev`，它会使用本机真实的 App Data 和 Host home（会写进你的真实项目），还要操控原生窗口。本会话不能隔离这两点。两端用的是同一份 IndexedDB 代码路径；WKWebView 的 IndexedDB 和 Web Locks 持久性没有在桌面上验证。**建议维护者操作：** 打开一个已转写的项目，改一条字幕后立即 `kill -9` 应用进程（也可以同时杀 Host sidecar），重开后应出现「发现未保存的修改」，恢复后内容一致。
- **真实双窗口冲突用了「另一台设备 RPC 保存」代替第二个窗口。** Host 侧行为相同；两个浏览器窗口同时打开同一项目、不显示对方的副本，由 E2E 的「还开着的窗口」测试覆盖。
- **两个 Host 上同名项目：** 由 E2E（另一个 hostId 的副本不显示、原样保留）和 Host 身份测试覆盖，没有起第二个真实 Host。

### 真实故障记录（Web，隔离 Host）

| 类型 | 次数 | 操作 | 结果 |
|---|---|---|---|
| 客户端强退 | 3 | 改一条字幕，0.6 秒后在自动保存（1.5 秒）之前关闭标签页；Host 的 `edits.json` 确认没有收到这次修改 | 3/3：重开出现恢复对话框，恢复后界面和 Host 文件一致 |
| Host 强退 | 3 | `kill -9` Host，改字幕，显示「保存失败，重试中」，副本里有这次修改；重启 Host | 3/3：自动保存重试成功，Host 有这次修改，副本被删除，没有误弹恢复框 |
| 同时强退 | 3 | `kill -9` Host，改字幕，关闭标签页，重启 Host，重开 | 3/3：恢复成功，Host 文件一致 |

另有一次客户端强退作废：我在后台标签页用脚本改 textarea，没有触发失焦提交，编辑器根本没收到这次修改（状态一直是「已保存」），之后改用真实键盘输入重做。这是测试方法的问题，不是产品问题。

## 成功指标

- **记录耗时（PRD：停止编辑后 ≤1 秒、连续编辑间隔 ≤2 秒）：** 用 910 条字幕的项目（基线字幕重复 10 次，约等于 60 分钟口播；每份副本 223 KB），真实键盘输入 24 次。
  - 18 次间隔编辑：从离开输入框到 IndexedDB 事务完成 253–550 ms，最长 550 ms。
  - 6 次 1.9 秒内的连续编辑：合并为 2 次写入，间隔 1175 ms、967 ms；最后一次在最终编辑后 267 ms 完成。
  - 单次事务耗时 2–196 ms。
- **三类故障各 3 次：** Web 达成（上表）；桌面端 Not run。
- **双窗口冲突、两个 Host、响应丢失、存储故障：** 见上表，没有静默覆盖、串项目或误删更新副本。
- **维护者在真实长口播里各做一次主动恢复和主动放弃：** 待维护者验收时完成。

## 界面证据

`pnpm e2e:evidence F-0004`：截图 32 张在 `screenshots/`（进 git），录屏 28 段在 `recordings/`（只在本地）。

| 界面 | 状态 | AC | 截图 | 录屏 |
|---|---|---|---|---|
| 检查中 | 挡住编辑区、返回首页 | AC-2 | checking-light / dark | `recordings/*AC-2*` |
| 发现未保存的修改 | 两个会话可选 | AC-3 | choose-light / dark、en-choose-* | `recordings/*AC-1_AC-3_AC-5*` |
| 正在恢复 | 按钮禁用 | AC-4 | applying-light / dark | `recordings/*AC-4_AC-6*` |
| 恢复成功 | 提示、已保存 | AC-5 | recovered-light / dark | 同上 |
| 恢复成功 + 媒体丢失 | 重新选择文件 | AC-5 | recovered-media-missing-* | `recordings/*AC-5_媒体丢失*` |
| 无法完成恢复 | 结果待确认 / 原项目不存在 | AC-6 | failed-uncertain-*、failed-missing-*、en-failed-* | `recordings/*AC-6*` |
| 版本冲突 | 覆盖 / 另存 / 取消 | AC-7 | conflict-light / dark | `recordings/*AC-7*` |
| 放弃确认 | 确认、处理中、失败 | AC-8、AC-9 | discard-confirm-*、discarding-*、discard-failed-*、en-discard-* | `recordings/*AC-8_AC-9*` |
| 崩溃恢复暂不可用 | 提示条 | AC-10 | unavailable-*、en-unavailable-* | `recordings/*AC-10*` |

## 回归检查

在 `3c6e27c` 上：

- `pnpm lint` ✅，`pnpm tsc -b --noEmit` ✅，`pnpm check:host` ✅，`cargo check --manifest-path src-tauri/Cargo.toml` ✅
- `pnpm test` ✅ 63 通过，`pnpm test:architecture` ✅ 44 通过，`pnpm build` ✅
- Playwright：F-0004 28 条 ✅（另跑两遍无不稳定），F-0002 + F-0003 80 条 ✅

## 发现的问题

1. **已修复：** 从别的编辑器切换到 910 条字幕的项目时，页面忙 35–45 秒，之后再读 Host 身份的请求超时，误报「无法完成恢复」。改为每个连接读一次身份（39c010f）。
2. **已有问题，不属于本需求：** 切换到长视频本身就要 35–45 秒（F-0004 之前的代码实测 35.7 秒），应由 F-0017 处理。
3. **已修复（开发中）：** 检查对话框挡住了 F-0002 / F-0003 的「正在打开」状态；检查在 Host 的修改缺少 `deletedWordIds` 字段时报错。
4. **小的界面问题，未改：** AC-10 提示条显示期间盖住字幕面板顶部的「双字幕 / 主字幕 / 副字幕」切换（见 unavailable-light.png）。提示条只在本地存储故障时出现，可以以后挪进面板布局里。

## 结论

可以发布（Web）。桌面端真实强退请维护者验收时操作一次（见 Not run），并确认标「请确认」的两项。

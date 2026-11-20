# 未完成的工作

更新于 2026-11-19。这份文档取代原来 `docs/features/` 下的逐需求文档（需求说明、设计、实现记录、测试报告、批次文件），那些文件已从仓库移除。完整原文仍在 git 历史里：

- 已验收的 45 个需求的说明、设计、测试报告与截图：提交 `ed177c8` 下的 `docs/features/`。
- 下面三个未完成需求的完整设计（含 AC 覆盖表、验证计划、待核实项）：同一提交下的 `docs/features/F-0029-*`、`F-0040-*`、`F-0054-*/02-design.md` 与 `docs/features/batches/B-01-remaining-designs.md`。

```bash
git show ed177c8:docs/features/F-0054-desktop-auto-update/02-design.md
```

## 1. 发布 v2.1.0

当前分支包含 45 个已验收需求（F-0002 到 F-0058 中除下文三项和 F-0022 以外的全部），本地检查全绿（`pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`、`cargo check`、`pnpm test`、`pnpm test:architecture`）。发布说明草稿：[docs/40-ops/releases/v2.1.0.md](40-ops/releases/v2.1.0.md)。

还没做：

1. 合入 main 并推送（origin/main 是当前分支的祖先，可以快进）。推送后 `ci.yml` 才会进入默认分支并运行。
2. 三处版本号改为 2.1.0（`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`），改完跑 `cargo check`。
3. CI 全绿后跑 `pnpm release --dry-run`，结果贴进发布说明的「发版闸门」。
4. 维护者同意后 `pnpm release` 打 tag。
5. 发布前实机核实回滚说法：回装 v2.0.2 不会读写 v2.1.0 新增的 Host 项目数据。

## 2. 三个待开发的需求

需求说明都已确认，依赖都已完成；设计写完，但两轮独立 AI 审查都没通过，遗留问题已修正并核对，剩下的是需要维护者拍板的事（见第 3 节）。三者都需要外部条件，缺条件时对应检查记为 Not run，不用 mock 代替。

### F-0029 Windows 与 Linux 无界面环境的字幕渲染补测（E-03）

- **问题**：F-0016/F-0028 只在 macOS 上验证过字幕图形层，不能保证 Windows WebView2 预览和 Linux 无界面 Host 导出的字体、打包和性能。
- **方案**：用 macOS Host 生成参考条带与换行数据；在 Windows 安装包 / WebView2 与无桌面、无 GPU、无中文系统字体的 Linux x86_64 Host 上做三层比较（换行逐字一致、包围盒 ≤2 px、像素阈值）；新增字体 SHA-256 清单（`scripts/fetch-subtitle-fonts.sh` 校验）；Windows WebDriver 入口——把 `src-tauri/Cargo.toml` 里仅 macOS 的 `tauri-plugin-wdio-webdriver` 扩展到 Windows，用 debug 构建（注册条件含 `debug_assertions`）+ `--features acceptance-webdriver` + `src-tauri/tauri.acceptance.conf.json`。
- **实现顺序**：基线与比较函数 → Linux 无界面 Host 验收脚本 → Windows 入口与安装包检查 → WebView2 预览测量 → Windows 界面状态截图 → 修缺陷并重跑 Linux/Windows → 支持矩阵与 ADR-0006 验证范围更新。
- **外部条件**：前台 Windows x64 实机（性能指标必须）、无桌面 Linux 容器或虚拟机。
- **规模**：14–23 人日，超过两周，建议拆成 Linux / Windows 两个需求。
- **待核实**：`tauri-plugin-wdio-webdriver` 是否支持 WebView2（不支持则改用 `tauri-driver` + `msedgedriver`）。

### F-0040 授权口型同步与结果管理（E-05）

- **问题**：配音后的视频口型对不上；需要在授权前提下接入口型同步服务，并管理结果。
- **前提**：F-0039 调研结论是「暂不产品化，先做有条件试点」，没有试点证据前不进入实现。
- **方案**：新增内置插件 `lipsync` 与 Sync.so `lipsync-2` Provider 插件；按 EDL 投影时间线生成预览；每次提交前逐次授权确认（记录来源素材）；记录存 `lipsync/<recordId>/` 与 `records.json`；用服务商幂等键防重复计费，`unknown` 结果核对前阻止同一输入；结果用内置 FFmpeg 校验；删除只删本地并说明远端可能保留。前置重构：从 `server/plugins/dubbing.ts` 抽出 `mixDubbingTrack`，从 `server/plugins/export.ts` 抽出 `probeVideo`/`probeStderr`。
- **关键未决问题**：现有架构下 Host 无法区分请求来自界面还是 Agent/CLI（RPC handler 只收到 `input`；桌面与 CLI/MCP 用同一种 bearer；`confirmations.decide` 的 `actor` 由调用方自填），Agent 可以自己批准提交。见第 3 节问题 2。
- **共用契约改动**：`shared/confirmations.ts` 与 `server/plugins/confirmations.ts`（新 kind、按 kind 的 target、`enrichAndValidateTarget` 分支、`decide` 停在 approved、`consume` 一次性消费、`defaultSummary`）；`shared/providers.ts` 新增 `lipsync` 角色；`shared/protocol.ts` 7 个 RPC；`server/profile.ts` BUILTINS；Provider 接收视频输入是 `providers.md`「只收 16 kHz WAV」的例外。
- **外部条件**：Sync.so 账号与密钥、授权素材、试点预算（约 $30）。
- **规模**：按建议方向约 12–16 天，超过两周，建议拆成「契约、可信确认通道、状态机、假服务」与「真实服务、结果管理、界面」。
- **待核实**：Sync 409 返回内容、结果地址有效期、上传上限、取消与删除接口、项目备份是否包含 `lipsync/`。

### F-0054 桌面端自动更新（E-08）

- **问题**：桌面端没有自动更新，用户要手动下载安装包。
- **方案**：Tauri 官方 updater 插件 + 本仓库 GitHub Release 静态 `latest.json`；独立 updater 密钥，私钥只在 `release.yml` 新增的 `updater-sign` 作业（GitHub Environment `release`）注入；整包替换，Host 与 FFmpeg 随包同版本；安装前门禁读 `jobs.list`、上传定位（`flycut.upload.sessions.<hostId>`）、任务定位（`flycut.task.operations.<hostId>`，含备份导入导出）、恢复副本（用 `projects.open` 与 Host 比较），任一读取失败即禁止安装（现有 `read()` 会吞异常，需新增不吞异常的读取）；新增 1 个只停 Host 的 Tauri 命令 `update_stop_host`，安装失败时用 `ensure_host` 拉起旧版 Host。
- **实现顺序**：插件 spike（是否忽略 `size` 字段、`download()` 能否中止、signer 私钥变量名、测试构建能否连 `http://localhost`、Windows `installMode` 配置位置）后再冻结发版契约 → 设置页「应用与更新」 → 更新状态机 → 安装门禁 → 下载/安装/重启 → 界面全状态证据 → 真实升级验证与运维手册。子系统文档随改动同步。
- **外部条件**：F-0057 的真实 Apple / Windows 签名凭据、updater 密钥对、GitHub Environment `release`。
- **规模**：约 11 天；若插件不能中止下载需 +3–4 天，届时拆分。
- **验证要点**：升级前后比较 Host home（`projects/`、`host-id.json`、`ai-settings.json`）、`models/`，以及桌面默认 AI 密钥存储（macOS 钥匙串 `com.flycut.caption.ai-settings`、Windows `%LOCALAPPDATA%\FlyCut\ai-settings\*.dpapi`）。

### F-0022 字词时间戳校准：不实施

F-0001 调研没有独立时间真值，也没有确认可用的 align 模型。建议在 E-01 候选表标「不实施」；以后拿到独立时间标注和可用模型再重新立项。

## 3. 等维护者决定的事

每条后面是建议答案。

1. F-0040 能否在 F-0039 试点前开工？——契约、确认门、状态机与假服务先做；真实服务调用、质量判定和发布等试点结论。
2. F-0040 确认门的可信来源：(a) 新增只有本机界面持有的批准通道，Gateway 把调用方传给 handler（改 `server/plugins/gateway.ts`、`server/plugins/rpc.ts`）；(b) 接受「持 bearer 即本人」，书面接受与 decisions.md 的冲突；(c) 只在界面开放口型同步，不进 MCP/CLI 工具清单。——建议 (a)。
3. 拆分：F-0029 拆 Linux / Windows；F-0040 选 (a) 时拆两段；F-0054 只在插件不能中止下载时拆。——建议按此拆。
4. F-0040 AC-3「保存为新视频」改为源视频下的产物（备选 `projects.addVideo`）。——建议附属源视频。
5. F-0040 成片 AI 标注：decisions.md 要求默认标注，设计只写元数据。——建议加画面角标「AI 口型同步」。
6. F-0029 AC-1 测试对象从正式安装包改为同提交的 debug WebDriver 测试构建（安装包本身由 AC-2 脚本检查）。——建议接受。
7. F-0029 AC-5 导出「排队」「取消」：现有界面没有这两个状态。——本需求只复测现有 7 个状态，排队与取消另立需求。
8. F-0054 AC-5「暂无内容」判为不适用，AC-7「第二个客户端读取一致」收窄为本机重启后的版本检查。——建议接受。
9. F-0029、F-0054 的依赖补 F-0058（驱动与 `acceptance:bundle`）。——建议补。
10. F-0054：清单托管在本仓库 GitHub Release；独立 updater 密钥放新建 Environment `release`（required reviewers、只限 `v*` 标签）并离线备份；2.0.2 及更早需一次手动安装过渡；Windows 用 NSIS + passive；v1 不做更新前自动备份、不做 Host 排空接口、不新增 `uploads.list`。——建议全部接受。
11. F-0040：首个服务 Sync.so `lipsync-2`；支持单人正面、中文或英文配音，10 分钟上限；单次估价超过 $30 二次确认；密钥改用现有 aiSettings 存储。——建议接受。
12. F-0022 正式关闭。——建议是。

## 4. 截图与录屏证据

`docs/features/` 移除后，`pnpm e2e:evidence <F-编号>` 与测试里的 `shot()` 把截图和录屏写到 `test-results/evidence/<F-编号>/`（不进 git）。需要长期保存的证据请附到 PR 或发布记录里。

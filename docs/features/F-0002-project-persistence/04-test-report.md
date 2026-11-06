---
id: F-0002
stage: 04-test-report
status: approved
approved_by: zhangxiang.chen
approved_at: 2026-11-05
---

# F-0002 项目数据保存到 Host：测试与验收

验收在 commit `26d4353` 上进行（分支 `feat/f-0002-project-persistence`）。

> 技术设计和开发阶段由 agent 连续推进、自动确认；维护者在这里一并审阅。

## 设计与实现摘要

- **Host**：新插件 `projects`（`server/plugins/projects.ts`），项目存在 `<home>/projects/<id>/`，按 ADR-0001 拆成 `project.json`、每个视频的 `transcript.json` / `edits.json` / `thumbnail.jpg`；所有写入「临时文件 → 改名」，同一项目串行。上传的媒体用 `AssetService.claim` 移出 24 小时清理的资产目录；桌面端按 ADR-0002 记录原文件位置，由 Tauri 外壳经只认外壳密钥的通道登记，RPC 只收不透明的 `mediaRef`。RPC：`list / create / open / saveTranscript / saveEdits / duplicate / relinkMedia / thumbnail`。Gateway 增加插件 HTTP 路由机制，项目媒体地址支持 Range。
- **前端**：`ProjectsApp` 用 URL hash 在「我的项目」和编辑器之间切换；`projectService`（前端插件）负责新建、打开、自动保存（1.5 秒停顿、单请求在途、⌘S / Ctrl+S）、失败退避重试、冲突、离开保护和媒体重选；字幕样式对移进 `appStore`，随项目保存。
- **ADR**：沿用已确认的 ADR-0001、ADR-0002，本需求没有新写 ADR。
- **与设计的偏差**：清单 2–5 合并成一次提交；Web 媒体路由随清单 1 完成；自动保存放在服务里而不是 Hook；样式对放进 `appStore`。详见 [03-implementation.md](03-implementation.md)。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| **Tauri 权限（请确认）** | `src-tauri/capabilities/default.json` 增加 `core:window:allow-destroy` | 拦截关闭窗口后要由前端关窗，Tauri 要求这项权限；按 code-standards 属安全相关改动，需要维护者放行 | AC-4、AC-24 |
| 修改检测 | 按 `chunks` / `wordChunks` / 样式对的引用判断，载入项目和转写结果写入时记为保存起点 | 打开项目不会多写一次；不做 1 MB 级的深比较 | AC-3 |
| 转写结果写入失败 | 保留结果，随自动保存一起重试；离开前也会提示 | Host 短暂不可用时识别结果不丢 | AC-2、AC-4 |
| 没有转写时不保存修改 | 转写写进项目之前不写 `edits.json` | 否则空字幕会在重开时盖掉转写 | AC-3 |
| 另存为新项目的名称 | 「原名（副本）」/「name (copy)」，新增文案 `copyName`；`projects.duplicate` 增加 `name` 参数 | PRD 没有规定名称 | AC-25 |
| 对话框按 PRD 改 | 版本过新的按钮由「确定」改为「关闭」；未保存离开对话框重试期间「取消」也不可点 | 原型与 PRD 不一致，以 PRD 为准 | AC-24、AC-26 |
| 媒体丢失时的播放器 | `FlyCutCaption` 新增可选参数 `playerPlaceholder`，显示横幅代替上传按钮 | 避免在丢失媒体的项目里误点上传又建一个项目 | AC-27 |
| 画幅不再被自动推断覆盖 | 样式来自项目时（`subtitleStyleRestored`），视频尺寸变化不再改 `aspectPreset` | 否则重开后用户选的画幅被覆盖 | AC-3、AC-5 |
| 时长与封面 | 用 FFmpeg 解析 `Duration:`（安装包没有 ffprobe）；新建后后台生成，不改修订号 | 改修订号会让新建窗口第一次保存误报冲突 | AC-14 |
| 读取媒体统一入口 | 新增 `src/utils/mediaSource.ts`，导出、波形、AI 面板、WebAV 都经它读取 | 重开项目的媒体只有空占位 `File`，原来导出会上传 0 字节 | AC-6 |
| 编辑器顶栏版本号 | `v2.0.0` 写死改为从 `package.json` 注入 | code-standards 第 6 条；顺手修 | — |

## 验收标准逐条结果

自动测试命令：Host `pnpm test:architecture`（`tests/architecture/projects.test.ts`）；界面 `pnpm e2e:evidence F-0002`（`tests/e2e/features/F-0002.spec.ts`，36 条，明暗主题各一遍）；Rust `cargo test --lib`（`media_link`）。真实使用在 Web 端（`pnpm dev` + 内置浏览器，本机 Host）完成。

| AC | 验证方式 | 证据 | 结果 |
|---|---|---|---|
| AC-1 新建项目、不传路径 | Host 测试；e2e；Rust 测试；真实使用 | `F-0002/AC-1: the shell channel registers picked files…`（前端 token、浏览器 Origin、无密钥、`server` Profile 都被拒）；e2e `AC-17` 断言 `create` 只带 `assetId`；`only_picked_paths_are_allowed`；浏览器选 demo.mp4 → 项目「demo」 | ✅ Web；⏸ 桌面端选文件 / 拖入未在 `tauri:dev` 走（见下） |
| AC-2 转写结果自动保存 | 真实使用；Host 测试 | 内置 sherpa-onnx SenseVoice 识别 demo.mp4 → 103 句写入 `transcript.json`，`model` 记录正确；离开编辑器后转写在后台完成也写入 | ✅ sherpa-onnx（Web）；⏸ HTTP Provider 未跑（本机没有配置可用的 HTTP Provider） |
| AC-3 3 秒内自动保存、⌘S、不按键写 | e2e；真实使用 | `AC-3 AC-19 AC-20 AC-21`、`AC-3 快捷键立即保存，连续修改合并成一次写入`；浏览器改字幕 / 换样式 → 刷新后仍在；60 分钟数据 5 次连续修改合并为 1 次写入 | ✅ |
| AC-4 失败保留并重试，离开前提示 | e2e | `AC-4 AC-22`、`AC-4 AC-24` | ✅ Web 应用内离开；⏸ 桌面端关闭窗口未在 `tauri:dev` 走 |
| AC-5 首页、重开不重新转写 | e2e；真实使用 | `AC-5 AC-19 打开项目直接进入编辑…`；浏览器刷新后从首页打开 → 字幕、修改、样式还在，没有识别请求 | ✅ |
| AC-6 重启且超过清理期限 | Host 测试；真实使用 | `F-0002/AC-5 AC-6: reopening after a Host restart…`（`assetTtlHours: 0` + 重启 Host，Range 播放正常）；对重开项目的媒体经 Host 导出（保留 0–10、20–30 秒）→ 20.0 秒 mp4，音视频俱全 | ✅ Host / Web；⏸ 桌面端重启电脑场景 |
| AC-7 媒体丢失 | Host 测试；e2e | `a moved or replaced linked file reads as missing`、`choosing the file again restores playback and keeps the edits`；e2e `AC-7 AC-27` | ✅；⏸ 桌面端真实移走文件 |
| AC-8 旧格式迁移、新格式拒绝 | Host 测试 | `a newer format is listed but never opened or rewritten…`（文件 mtime 不变）、`migrations run step by step and refuse gaps` | ✅ |
| AC-9 两个窗口冲突 | Host 测试；e2e；Red check；真实使用 | `AC-9 AC-25: a stale baseRevision is a conflict…`；Red check：去掉 `baseRevision` 校验后该测试失败（第二个窗口得到 `saved`）；浏览器两个标签页打开同一项目，A 保存后 B 修改 → B 显示「保存已暂停」，磁盘上仍是 A 的版本 | ✅ |
| AC-10 Web 端同一套接口 | 真实使用 | 本报告全部真实使用都在 Web 端完成 | ✅ Web；⏸ 「桌面端保存的项目在 Web 端打开」需要 `tauri:dev` |
| AC-11 加载中 | e2e | `AC-11` ×2 主题 | ✅ |
| AC-12 读取失败 | e2e | `AC-12` ×2 + RPC 报错 | ✅ |
| AC-13 空 | e2e | `AC-13` ×2 | ✅ |
| AC-14 有项目、封面、列表、视图保持 | e2e；Host 测试；真实使用 | `AC-14` ×2、`有封面的项目显示封面…`；Host `a new project gets a cover frame and its real duration…`；浏览器里新项目卡片显示封面和 3:21 | ✅ |
| AC-15 搜索 | e2e | `AC-15` ×2 | ✅ |
| AC-16 拖入遮罩 | e2e | `AC-16` ×2 | ✅ Web；⏸ 桌面端拖入 |
| AC-17 正在创建 | e2e；真实使用 | `AC-17` ×2 | ✅ |
| AC-18 正在打开 | e2e | `AC-18` ×2 | ✅ |
| AC-19 已保存、返回首页 | e2e | `AC-5 AC-19`、`AC-3 AC-19 AC-20 AC-21`（3 秒后淡出） | ✅ |
| AC-20 有未保存的修改 | e2e | 同上，断言悬停提示「立即保存（⌘S）」 | ✅ |
| AC-21 保存中 | e2e | 同上 | ✅ |
| AC-22 保存失败 | e2e | `AC-4 AC-22` | ✅ |
| AC-23 保存已暂停 | e2e；真实使用 | `AC-9 AC-23 AC-25`（暂停后再改不写）；两个标签页 | ✅ |
| AC-24 未保存离开 | e2e | `AC-4 AC-24`（重试中三个按钮不可点、取消留下、放弃离开） | ✅ 应用内离开；⏸ 桌面端关窗、Web 关标签页的浏览器确认框 |
| AC-25 版本冲突对话框 | e2e；Host 测试 | `AC-9 AC-23 AC-25`、`AC-25 另存为新项目…` | ✅ |
| AC-26 版本过新 | e2e；Host 测试 | `AC-26` ×2 | ✅ |
| AC-27 媒体丢失横幅 | e2e | `AC-7 AC-27`（字幕可改且自动保存、重选后横幅消失） | ✅ |

**中英文界面**：e2e 全部在中文界面下跑；英文文案已在 `en_US.ts` 补齐，但⏸ **英文界面未跑**——项目首页没有语言切换入口（语言只能在编辑器顶栏切换），见「发现的问题」。

**桌面端（`pnpm tauri:dev`）整体 ⏸ Not run**：这次会话里没有驱动桌面窗口的手段（需要打包 Host、sidecar 并在原生窗口里操作）。桌面相关逻辑由 Rust 单元测试（只允许登记本次选择 / 拖入的文件）和 Host 测试（外壳通道的三项安全测试、`linked` 媒体校验与重选）覆盖。建议维护者在确认前用 `pnpm tauri:dev` 走一遍：选文件 → 识别 → 改字幕 → 关窗再开；移走原文件 → 重选；有未保存修改时关窗。

## 界面证据

截图在 `screenshots/`（进 git，`*-light.png` / `*-dark.png` 各一张）；录屏在 `recordings/`（只在本地，每个测试一段，摘要 `recordings/summary.json`，36 通过 0 失败，commit `26d4353`）。`screenshots/` 里 `01-…`–`18-….jpg` 是原型阶段的截图，保留作对照。

| 界面 | 状态 | AC | 截图 |
|---|---|---|---|
| 我的项目 | 加载中 | AC-11 | `home-loading-{light,dark}.png` |
| 我的项目 | 读取失败 | AC-12 | `home-error-{light,dark}.png` |
| 我的项目 | 空 | AC-13 | `home-empty-{light,dark}.png` |
| 我的项目 | 网格 / 列表 | AC-14 | `home-grid-*.png`、`home-list-*.png` |
| 我的项目 | 搜索无结果 | AC-15 | `home-no-results-*.png` |
| 我的项目 | 拖入遮罩 | AC-16 | `home-dragging-*.png` |
| 我的项目 | 正在创建 | AC-17 | `home-creating-*.png` |
| 我的项目 | 正在打开 | AC-18 | `home-opening-*.png` |
| 我的项目 | 版本过新对话框 | AC-26 | `home-newer-version-*.png` |
| 编辑器 | 打开后 | AC-5、AC-19 | `editor-opened-*.png` |
| 编辑器 | 有未保存的修改 / 保存中 / 已保存 | AC-19–AC-21 | `editor-pending-*.png`、`editor-saving-*.png`、`editor-saved-*.png` |
| 编辑器 | 保存失败 | AC-22 | `editor-save-failed-*.png` |
| 编辑器 | 未保存离开 / 重试中 | AC-24 | `editor-unsaved-*.png`、`editor-unsaved-retrying-*.png` |
| 编辑器 | 保存已暂停 / 冲突对话框 | AC-23、AC-25 | `editor-conflict-*.png`、`editor-conflict-dialog-*.png` |
| 编辑器 | 媒体丢失 | AC-27 | `editor-media-missing-*.png` |

## 回归检查

在 `26d4353` 上：

- `pnpm lint` ✅、`pnpm tsc -b --noEmit` ✅、`pnpm check:host` ✅、`cargo check --manifest-path src-tauri/Cargo.toml` ✅
- `pnpm test` ✅（64 条：58 通过、6 跳过——需要本地模型的集成测试，与改动前相同）
- `pnpm test:architecture` ✅（29 条，含 F-0002 Host 测试 11 条）
- `cargo test --lib` ✅（含 `media_link` 2 条）
- `pnpm e2e:evidence F-0002` ✅（36 条）
- 导出回归：Host 导出重开项目的媒体（见 AC-6）✅；⏸ 浏览器界面里点导出（最后一步会下载文件，没有在本次会话里触发下载）

## 发现的问题

1. **长视频打开慢（成功指标未达成）**：60 分钟数据（1200 句、36000 字）从点击到可编辑 6.9 秒，指标是 3 秒。Host 只占约 65 ms；时间在前端——字幕列表没有虚拟化（1200 条全部渲染文本框），`historyStore.setTranscript` 还把整份转写打印到控制台。转写完成后载入走同一条路径，不是本需求引入的。建议单独立项做字幕列表虚拟化。
2. **首页没有语言切换**：项目首页只能用默认语言（`App.tsx` 初始为中文），英文界面要先进编辑器切换。PRD 要求首页在中英文下都成立，建议在首页侧栏的「设置」里加语言选项，或沿用编辑器顶栏的切换按钮。
3. **离开前保存没有超时**：Host 收到请求却一直不返回时，点「我的项目」会一直等待、不弹对话框（Host 断开时请求立即失败，不受影响）。
4. **首页转写进度一直是 0%**：离开编辑器后卡片显示「转写中 0%」直到完成；sherpa-onnx 在识别期间没有上报百分比进度，不是项目功能的问题，但卡片上的数字不变。
5. **转写失败后编辑器右侧显示「未选择文件」**：识别失败（例如没选模型）时右侧字幕区显示上传空状态而不是错误，原有行为；在项目模式下更容易让人误解。

## 结论

**可以发布（待维护者确认 Not run 项）**。全部 27 条 AC 在 Web 端有自动测试或真实使用证据；需要维护者拍板的是：

- 是否接受桌面端（`tauri:dev`）、HTTP Provider、英文界面这几项 ⏸ Not run，或先跑完再确认；
- Tauri 权限 `core:window:allow-destroy`；
- 「发现的问题」1、2 是否另立需求。

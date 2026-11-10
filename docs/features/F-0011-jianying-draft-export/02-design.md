---
id: F-0011
stage: 02-design
status: draft
approved_by:
approved_at:
---

# F-0011 剪映草稿导出：设计

## UI / UX

顶部「导出」菜单增加「剪映草稿 / Jianying draft」入口，打开后显示只读的兼容矩阵和研究状态。**本轮不提供可点击的草稿导出流程**：F-0010 没有真实 Windows 5.9.0 导入证据，AC-1 要求未知或不支持的目标禁用。

| 目标 | 展示 | 产品行为 |
|---|---|---|
| 剪映 Windows 5.9.0 明文草稿 | `候选格式，尚未完成真实导入验证 / Candidate format; real import is not verified` | 仅展示能力与缺口，导出按钮禁用 |
| 其他 Windows 5.9.0 build | `不支持此草稿版本 / Unsupported draft version` | 禁用 |
| macOS 11.7.0（Timelines/私有封装） | `不支持此草稿版本 / Unsupported draft version` | 禁用，不尝试解密或伪生成 |
| CapCut | `不支持此草稿版本 / Unsupported draft version` | 禁用 |
| Web | `剪映草稿目前仅支持桌面 Host；Windows 5.9.0 仍在验证 / Desktop Host only; Windows 5.9.0 is still being verified` | 禁用 |

候选卡片列出：单时间线、单视频轨、单主字幕轨、媒体复制、不更新 `root_meta_info.json`；副字幕/双语、字体、精确定位、搬迁重开均未证实。界面显示 `真实导入验证：未完成 / Real import verification: not run`，不出现「草稿已生成」或「支持剪映」的普通用户成功态。

界面只实现：

1. 检查中：`正在检查剪映草稿支持信息… / Checking Jianying draft support…`。
2. 检查失败：`无法读取剪映草稿支持信息 / Could not read Jianying draft support`，可重试。
3. 未验证/不支持：固定文案、研究来源 F-0010、缺失证据、禁用按钮；不选择目录、不上传媒体、不创建任务。
4. 详情展开：显示媒体与字幕降级清单和真实导入测试要求。

覆盖明暗主题和中英文。E2E 用 Host 路由 mock 构造加载/失败/候选未验证/明确不支持，断言文案、禁用按钮和 `jianying.start` 调用次数为 0。

## 技术方案

### 涉及的子系统

- [cordis-host](../../subsystems/cordis-host.md)、[architecture-current](../../architecture-current.md)：只注册只读能力 RPC，不注册启用型导出 RPC。
- [frontend](../../subsystems/frontend.md)：导出菜单和只读矩阵面板。
- [funasr-tauri](../../subsystems/funasr-tauri.md)：本轮无 Tauri 改动。
- [F-0005 设计](../F-0005-unified-edit-decisions/02-design.md)：EDL、`deriveKept`、`projectCues` 为唯一时间映射。
- [F-0010 研究](../archive/F-0010-jianying-draft-research/02-research.md)：Windows 5.9.0 明文结构、字段及 Not run 项。

### 方案

分两层实现：

1. **可审阅的离线候选生成器。** 纯 Host 模块接收已冻结的 EDL、句子字幕、主样式、媒体信息和输出元数据，生成 Windows 5.9.0 草稿目录。它不注册为普通 RPC，不接产品按钮；本轮通过测试 harness 和本地验证脚本生成候选产物，供以后真实剪映验证。
2. **产品硬门禁。** `jianying.capabilities` 只读 RPC 从构建常量返回 `verifiedByImport: false`、`exportEnabled: false`。即使平台是 Windows/Tauri，UI 仍禁用。没有 `jianying.preflight`、`jianying.start` 或其他可触发生成/目录写入的普通 RPC。以后真实导入验收通过后才增加启用通道。

**时间映射。** 快照 EDL 使用整数微秒。每个 `deriveKept` 区间生成一个视频 segment：target 从 `outputStartUs` 开始，source 从 `startUs` 开始，时长都取 `endUs-startUs`。`projectCues(edl, sentenceChunks)` 结果生成文本 material/segment；跨切点字幕由 F-0005 拆段，生成器不另算。为保证字幕可回读，快照带每个 cue 的原始 `[start,end]`，回读器按同一 EDL 重新投影并逐条比较，不能只检查“文本存在”。

**字幕范围。** 只写主字幕。样式只映射 F-0010 有字段证据的颜色/透明度、粗体/斜体/下划线、描边颜色/宽度、字号和间距候选值；字体 family、精确定位、背景 padding、副字幕和双语不写入。`buildJianyingDegradations(snapshot)` 返回稳定 key，测试和报告逐项断言。

**媒体策略与目录。** 候选生成器只接受测试/CLI harness 给出的源媒体路径和最终输出目录，固定复制媒体到 `<draft>/materials/`，JSON 写最终绝对路径，原媒体只读。生成到同父目录 staging，回读验证后原子 rename；目标存在即失败，不覆盖。取消/失败只删 staging。因为是本轮离线 harness、不是产品导出，不新增 shell route、Tauri command 或目录 grant。

以后启用产品导出时，仍必须按下列安全前提设计：目录只能来自原生选择器；shell-only、无 Origin、绑定本次选择和资产、15 分钟 TTL、一次性消费、撤销/重启失效；realpath + `lstat` 拒绝符号链接和穿越；普通 RPC 只收 opaque grant；Host 单写并原子清理。实现前需重新审阅，不能因本调研生成器存在而跳过。

**回读校验器。** 重新解析 `draft_content.json`、`draft_info.json`、`draft_meta_info.json` 和封面，检查：两份 content 字节一致；版本/platform；轨道/material/speed 引用；视频 source/target 与 EDL 一致；字幕文本和时间与项目后的 cue 一致；媒体路径在最终 `materials/` 下、大小/SHA-256 与源一致；封面是 JPEG；无悬空引用。失败时不产生最终目标。

**候选格式。** 只写 Windows 5.9.0 明文布局：`draft_content.json`、字节相同的 `draft_info.json`、`draft_meta_info.json`、`draft_cover.jpg`、`materials/`。不写 `root_meta_info.json`，不生成 macOS Timelines 封装，不修改现有草稿。

### 接口与数据

`shared/protocol.ts` 只增加：

- `jianying.capabilities`：input `void`；输出 `{ research:'F-0010', verifiedByImport:false, exportEnabled:false, targets:[...], reason, checkedAt }`。

不存在可调用生成器、preflight、start、路径或 grant 的普通 RPC。生成器 API 位于 `server/jianying/`，仅供架构测试、真实产物脚本和以后 Host 层复用。不修改 `PROJECT_FORMAT_VERSION`、项目 store、上传实现、模型配置或字幕列表。

新增共享纯模块：目标/能力、草稿名安全校验、快照 schema、EDL→Windows 草稿内容、回读验证和降级清单。新增 `JianyingDraftInfoPanel` 与 `src/locales/jianying.ts`（中英文），接入现有导出对话框，默认只显示矩阵和禁用按钮。

### 备选方案与取舍

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 纯生成器 + 产品禁用 + 真实候选产物 | 不违反 AC-1；研究产物可继续推进真实导入 | 用户暂时不能用 | 采用 |
| 未验证即启用实验按钮 | 可提前体验 | 把“实验性”当发布开关，违背 AC-1 | 拒绝 |
| 直接接普通目录路径 RPC | 实现短 | 推翻 RPC 无任意路径安全边界 | 拒绝 |
| 生成 macOS 私有封装 | 覆盖本机 | 无格式证据且不在批准范围 | 拒绝 |

## 架构决策

新增 [ADR-0009](../../20-architecture/adr/0009-jianying-draft-export.md)，状态 `proposed`：Windows 5.9.0 候选、真实导入前产品禁用、Host 纯生成器、复制媒体、未来 shell-only grant 的安全前提、失败关闭。ADR-0002/0005 不变。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| 未验证候选的产品可用性 | UI 与普通 RPC 全部禁用 | AC-1 明确未知/不支持目标不得生成并宣称可用 | AC-1、AC-8 |
| 本轮验证路径 | 仅测试/CLI harness 生成候选产物 | 允许推进真实产物证据，不形成可发布导出入口 | AC-2 到 AC-10 |
| 字幕范围 | 只写主字幕 | 双语没有真实样本，提前展示降级 | AC-7 |
| 媒体策略 | 固定复制 | F-0010 推荐，原媒体移动不影响草稿副本 | AC-4、AC-9 |
| 根索引 | 不写 | 无法证明自动扫描且修改资料库风险高 | AC-3、AC-8 |
| Tauri grant | 本轮不实现 | 产品导出入口未启用；提前增加未使用写通道只会扩大风险 | AC-3、AC-5 |

## 风险与回退

- **验收阻塞：** 本机没有 Windows 5.9.0 剪映；macOS 11.7.0 不是可生成的目标。AC-1 的“支持”无法成立，AC-2/3/5/6/8 的普通用户流程未启用，AC-7/9/10 的真实导入无法完成。
- 候选生成器通过格式、文件、字节和时间测试，不证明剪映能打开。报告必须写 `Not run`。
- 剪映是专有格式；任何字段异常都应失败关闭，不猜其他 build。
- 如果未来生成器 API 被包装成产品导出，必须重新过安全设计和 AC-1，不在本次自动启用。

## 实现清单

- [ ] 共享能力/快照/命名契约、Windows 5.9.0 候选生成器和回读验证器；固定 EDL 含两段以上保留区间和跨切点字幕。
- [ ] 离线候选产物 harness：真实媒体复制、封面、三份 JSON、SHA-256、同名拒绝、取消/失败 staging 清理和原子提交。
- [ ] 只读 `jianying.capabilities` RPC 与无导出 RPC 的安全断言，确保 `verifiedByImport:false` 时任何客户端都不能生成目录。
- [ ] 剪映草稿只读能力面板和导出入口禁用态，中英文明暗主题 E2E，断言普通导出调用次数为 0。
- [ ] 用真实媒体生成候选产物并回读；记录实机导入、两段口播、搬迁的 Not run 证据，生成 04 报告。

## 验证计划

1. `pnpm test:architecture` 覆盖 `F-0011/AC-1、AC-4、AC-7`：能力字段、生成结构、多保留区间、跨切点字幕、主字幕降级、引用闭合、回读、哈希和同名失败。Red check 去掉一次 source 跳转、字幕投影或媒体哈希后目标测试必须失败。
2. 真实候选 harness：用 `src/assets/demo.mp4` 生成到 `/private/tmp`，实际复制媒体，解析文件并重算 SHA-256；另用两段同源切段仅验证“多段输入”逻辑，不能冒充 AC-10 两段真实口播。目标目录存在时不覆盖，注入失败/取消时 staging 为空。
3. Host RPC：断言 `jianying.capabilities` 返回 `verifiedByImport:false/exportEnabled:false`，方法表没有 generation start/preflight，普通 RPC 不接收 path/grant。
4. UI：`pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`；Playwright 使用 `/private/tmp` 下 5179 覆盖配置，断言四平台矩阵、两语言两主题、禁用按钮和截图。`cargo check` 记录基线，本轮无 Rust 改动。
5. 真实使用：真实 Windows 5.9.0 打开/播放/编辑/保存/重开、两段原始口播和搬迁重开全部 `⏸ Not run`，原因写明本机只有 macOS 11.7.0 且其格式不兼容。

全量回归遵循 `docs/code-standards.md` 第 1、2 条；主 agent 已提供原仓库基线，仍在本需求 commit 上重跑可运行项。

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | 只读能力矩阵；`verifiedByImport:false` 时所有平台/形态的 UI 禁用；没有生成 RPC；两语言两主题断言固定不支持文案 |
| AC-2 | 冻结快照生成器输入；普通导出未启用，因此无可验收用户导出；测试夹具证明快照不读取临时建议 |
| AC-3 | 产品目录选择/写入未启用；候选 harness 只用于 `/private/tmp`；普通 RPC 无 path；不覆盖既有目录 |
| AC-4 | 生成器固定复制媒体、显示降级/空间估算契约；真实 harness 校验非空和哈希；产品策略未启用 |
| AC-5 | 无任务、进度或取消的用户流程；测试验证禁用按钮和 start 调用为 0；离线 harness 失败清理 |
| AC-6 | harness 覆盖同名、媒体缺失、权限/格式失败和 staging 清理；产品错误态因导出禁用而不适用 |
| AC-7 | 结构/回读验证多保留区间与主字幕时间；真实剪映可编辑为外部阻塞，副字幕/双语列为不支持 |
| AC-8 | 产品成功态未实现/未启用；面板只显示候选未验证与真实导入要求，避免伪成功 |
| AC-9 | 复制媒体与绝对路径风险写入报告；真实移动后打开 `Not run` |
| AC-10 | 生成真实候选并回读；两段原始口播及 Windows 5.9.0 真实播放/编辑/保存/重开 `Not run` |

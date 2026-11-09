---
id: F-0005
stage: 04-test-report
status: review
approved_by:
approved_at:
---

# F-0005 统一时间映射与编辑决策（EDL）：测试与验收

最终代码在 commit `07aba00` 验收；上一实现提交为 `730d45a`。工作区中其他需求与 F-0001 的未提交文件未纳入本需求的实现或测试结论。

## 设计与实现摘要

每个视频以原媒体坐标上的整数微秒删除并集为唯一真源，保留区段、字幕 cue、预览和视频导出全部从 shared EDL 派生。正式 EDL 与只含剪辑的持久历史写入项目格式 3；待确认建议和历史预览只在内存中。Host 与 FFmpeg 适配器共用全局输出时钟 filter，WebAV 也消费同一捕获快照。历史回退先保存，再按内容判断结果；保存响应丢失时会读回 Host 确认。ADR-0005 仍为 `proposed`，请在验收时一并审阅。

相对设计的主要偏差是：一个纯核心模块代替多个文件、区间映射使用顺序扫描、历史回退同步等待 Host。技术取舍与遗留环境验证见 [03-implementation.md](03-implementation.md)。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| EDL 存储形式 | 规范化删除并集 + 整数微秒半开区间；保留区间派生 | 避免两份互补集合不一致和重复舍入 | AC-1、AC-3、AC-5 |
| 历史范围 | 只持久化剪辑决策与删除投影，不持久化全部文字撤销栈 | 满足重开回退，又不扩大需求范围 | AC-6、AC-12 |
| 临时建议 | 仅内存保存；确认前不进入项目、恢复副本和导出 | 保证预览不会冒充正式成片 | AC-8、AC-11 |
| 旧项目迁移 | 打开只读迁移；下一次保存才写格式 3，沿用已有备份 | 重开不改原文件，同时保护旧成片 | AC-7、AC-10 |
| 丢失保存响应 | 先重读 Host 并按内容比较，再回滚或宣告成功 | 不能把不确定状态误报为失败或成功 | AC-10、AC-12 |
| WebAV 切点 | 每段 sprite 使用 EDL 精确时长 | 抵消编码样本边界多带的一帧 | AC-5 |

## 验收标准逐条结果

| AC | 验证方式 | 证据 | 结果 |
|---|---|---|---|
| AC-1 | 纯区间、store 与浏览器删除/恢复 | `pnpm test:architecture` 中显式删除、重叠、片头片尾和文字隔离断言；`F-0005/AC-1 AC-6 AC-7 AC-12 deletion…`；真实 Web 口播删除后 20.0s → 17.0s 显示 | ✅ 通过 |
| AC-2 | 智能剪空白兼容与幂等；真实 Web 预览/取消 | 现有 `smart-cut-blank.test.mjs` 集成通过；`F-0005/AC-2 AC-11 silence suggestions…` 四组主题语言通过；桌面入口在当前素材未产生额外空白候选 | ✅ 通过 |
| AC-3 | 播放器/进度条接点、删除区间定位、元信息前百分比 | `F-0005/AC-3 real player seeks join…`、`progress percentage stays finite…`，明暗中英文截图 | ✅ 通过 |
| AC-4 | cue 交集、跨段拆分、四格式时间精度、主副字幕 | `edl-f0005` 的 `AC-4 crossing cue…`、`subtitle formats…`；F-0005 E2E 的主副字幕与导出状态全部通过 | ✅ 通过 |
| AC-5 | Host 与本地适配器真实 FFmpeg；真实 WebAV；两段真实口播 | `pnpm test:architecture` 覆盖有/无音轨、尾裁、12 切点，目标 4.272s/成片 4.280s；WebAV 目标 2.5s 与切点源画面通过；两段 COSCUP 18.89s/17.59s 成片均能在播放器打开；Tauri 硬字幕导出 17.59s | ✅ 通过 |
| AC-6 | 删除/撤销/重做原子恢复；持久历史回退 | 区间/store 测试、历史预览与回退 E2E；回退后后续校对文本不变；重开仍保留 | ✅ 通过 |
| AC-7 | 格式 3、旧项目重复重开、原转写/媒体不变 | `projects-f0003` 的重复重开、格式 1 备份和旧导出规则；E2E 刷新重开回放 | ✅ 通过 |
| AC-8 | updating、保存失败不冒充保存成功、失败保留最后有效值 | `restore-updating-*` 截图；失败回滚和 lost response E2E；F-0002 保存状态回归通过 | ✅ 通过 |
| AC-9 | 全删空状态与导出门禁 | `F-0005/AC-9 all-cut…`，四组主题语言截图；视频与字幕导出按钮均禁用 | ✅ 通过 |
| AC-10 | 非法版本/倒置/越界/坏 EDL、旧数据、保存不确定 | 区间校验、格式迁移非法写拒绝、无效 EDL E2E、历史失败和回执丢失 E2E | ✅ 通过 |
| AC-11 | 建议标红、文案、预览/当前、过期、确认和取消 | `F-0005/AC-2 AC-11 silence suggestions…`、过期建议测试；临时建议不写项目或导出 | ✅ 通过 |
| AC-12 | 历史加载/空/失败、预览、确认回退、并发保存和失败 | 四组主题语言历史状态；并发保存后等待新修改；失败及 lost-response 不误报；重开保留 | ✅ 通过 |

真实桌面主流程：从 macOS 原生文件选择器导入 COSCUP 视频 → 载入已有真实转写 → 删除首句，保存状态变为已保存、17.0s 预览成立 → 选择硬烧录并导出 → 系统保存对话框写出 MP4。`ffmpeg` 探测得到 17.59s、1280×720 H.264、48kHz AAC；QuickTime Player 实际打开并显示烧录字幕。切点音频与源素材的归一化相关度约 0.9992，见下方界面证据。

## 界面证据

`pnpm e2e:evidence F-0005`：41 通过、0 失败；生成 52 张自动化截图和 41 段本地录屏。截图在 `screenshots/`（已在 git），录屏在 `recordings/`（本地）。另加入一张真实桌面导出截帧。

| 界面 | 状态 | AC | 截图 | 录屏 |
|---|---|---|---|---|
| 操作历史 | 空、加载、失败、回退确认、回退中、回退失败、并发保存 | AC-6、AC-8、AC-12 | `history-*`、`restore-*` | 41 段统一录屏 |
| 待确认建议 | 正式/预览切换、确认记录、取消 | AC-2、AC-11 | `suggestions-*` | 同上 |
| 剪辑预览 | 接点定位、媒体元信息加载前百分比 | AC-3 | `preview-join-*` | 同上 |
| 全删与非法数据 | 空预览、导出禁用、错误后重试 | AC-9、AC-10 | `empty-cuts-*`、`invalid-cuts-*` | 同上 |
| 真实桌面导出 | 硬烧录 17.59s 成片截帧 | AC-5 | [real-native-export-frame.png](screenshots/real-native-export-frame.png) | 本地 QuickTime 实看 |

所有自动化状态均覆盖明暗主题和中英文；真实浏览器/桌面主流程测试使用测试数据目录，未写入正常 FlyCut 项目。

## 回归检查

`Verification (@ 07aba00):`

- Ran: `pnpm lint` ✅、`pnpm tsc -b --noEmit` ✅、`pnpm check:host` ✅、`cargo check --manifest-path src-tauri/Cargo.toml` ✅。
- Ran: `pnpm build` ✅（Vite 大 chunk 警告不属于失败）。
- Ran: `pnpm test` ✅ 68 pass / 3 skip（跳过项来自既有可选 ASR/VAD 前置资源）。
- Ran: `pnpm test:architecture` ✅ 57 pass / 0 fail；F-0005 60 分钟、1 万编辑单元、20 次删除/撤销最大删除耗时 56.19ms。
- Ran: F-0002～F-0005 浏览器回归 149 pass / 0 fail；F-0005 证据套件 41 pass；截图 52 + 真实桌面包 1。
- Red check 1: 撤销整条输出时钟的 fps 量化后，保留源画面比较失败（并非编译失败）。
- Red check 2: 恢复旧导出适配器后，未选中空隙被误删的断言失败。
- Red check 3: 撤销 WebAV sprite 精确时长后，真实 WebAV 成片超过 2.5s 容差；恢复后通过。
- Real use: Web 连接真实隔离 Host 导入、校对、删除、回退、建议预览/取消、重开通过；Tauri 使用原生选择器导入真实 COSCUP、删除保存、硬烧录导出，并由 QuickTime 打开成片。
- Not run: Windows/macOS 发布安装包、签名、公证与自动更新（非本需求改动的发布验证）；外部 HTTP Provider（本次使用已有真实转写）。

## 发现的问题

已修复的是 WebAV 样本边界多带一帧、历史读取碰到保存中修改而误报、以及媒体元信息加载前进度百分比显示 `Infinity`。当前没有已知、会阻塞本需求主流程的问题。

## 结论

可以发布。ADR-0005 仍为 `proposed`，请维护者在确认本报告时审阅并接受；实现与测试范围到此完成。

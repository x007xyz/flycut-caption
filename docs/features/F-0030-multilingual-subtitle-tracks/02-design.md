---
id: F-0030
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-12
---

# F-0030 多语言字幕轨道与兼容迁移：设计

## UI / UX

在现有字幕编辑器内增加 `LanguageTrackBar`，不改项目入口，也不新增独立的业务页面。它位于“编辑 / 原语言”模式切换下方，读取当前视频的 `historyStore` 和同一个 Host 的保存状态。

- 有字幕但还没有语言轨时，轨道区显示「暂无内容 / Nothing here yet」和「添加语言 / Add language」。添加对话框选择语言并填写名称；名称默认取语言名称，中文/英文界面都复用项目现有语言列表。
- 有语言轨时显示选择器、当前轨名称、过期数量和「添加 / 重命名 / 删除」。切换轨道立即切换下方每行的译文输入框；轨道没有非空译文时显示「此语言尚无译文 / No translation for this language」。
- 旧 `secondText` 迁移为一条标记为 `legacy-second-text` 的轨道。它的语言未知，界面显示「未指定 / Unspecified」和「设置语言 / Set language」，不能默认认作英语。设置语言只补语言代码，不改译文。
- `SubtitleItem` 的副字幕输入框编辑当前轨。每条译文保存当前原文快照；原文与快照不同时显示「译文已过期 / Translation is outdated」，并提供「保留译文 / Keep translation」和「重新翻译 / Retranslate」。「保留译文」把当前原文作为新版本并保留译文；「重新翻译」聚焦并全选现有译文，等待用户输入或后续 F-0031 流程产生新译文。
- 删除轨道必须经过确认，说明会删除该语言的所有译文；确认后选择相邻轨或回到无轨道状态。
- 轨道区沿用编辑器现有打开状态；项目打开期间显示「正在加载… / Loading…」。保存状态映射为「正在处理… / Processing…」和「已完成 / Completed」。失败时显示 Host 错误、`save.error`、「重试 / Retry」「返回 / Back」；冲突时显示「内容已更新，请重新检查 / Content changed. Review again.」，打开现有冲突对话框，输入和另一设备内容都保留。
- 现有 AI 翻译按钮继续可用：按目标语言找到或创建语言轨，把结果写入该轨并记录当时的原文快照；F-0030 不增加新的翻译校验或供应商能力。

端到端测试用 `mockHost` 构造旧项目、空轨、保存中、失败和冲突；持久化与迁移使用真实 Host 架构测试。所有新增状态在中英文、明暗主题下覆盖并截图。

## 技术方案

### 涉及的子系统

- [cordis-host.md](../../subsystems/cordis-host.md)、[architecture-current.md](../../architecture-current.md)：Host 是项目数据唯一来源，RPC 由插件注册。
- [frontend.md](../../subsystems/frontend.md)：字幕编辑器、历史 store、项目自动保存、恢复副本和 Playwright 验收。
- [ADR-0001](../../20-architecture/adr/0001-project-storage-format.md)、[ADR-0003](../../20-architecture/adr/0003-multi-video-projects.md)、[ADR-0004](../../20-architecture/adr/0004-client-recovery-copies.md)：项目格式、视频修订号、样式和恢复副本边界。
- [ADR-0005](../../20-architecture/adr/0005-unified-edit-decisions.md)：所有字幕轨共用原文和 EDL 时间轴。

### 方案

在 `shared/languageTracks.ts` 定义语言轨契约和纯函数，`ProjectEdits.languageTracks` 按视频保存。轨道中的译文以句级字幕 `chunk.id` 为键，不另存时间；显示、播放和导出仍用原文 `timestamp` 与 EDL 投影，因此剪辑不会产生第二套时间映射。

每条译文记录 `text`、`sourceText` 和 `updatedAt`。`sourceText` 是创建该译文时的原文完整快照，也是可离线比较的原文版本；当前原文不同即过期。这样不需要给 `SubtitleChunk` 增加可漂移的版本号，也能在保留旧译文时显式把快照推进到当前原文。

`secondText` 保留，并投影当前活动轨的译文。加载时若格式 3 的 edits 没有 `languageTracks`，Host 从所有非空 `secondText` 生成 `legacy-second-text` 轨：语言为 `null`、名称为 `Legacy translation`、每条 `sourceText` 取读取时的原文。读取只做内存迁移；下一次保存写出格式 4。没有 `secondText` 的旧项目得到空轨道数组，不凭空造语言。

历史 store 新增轨道和活动轨状态，翻译修改与字幕文本修改使用同一撤销快照。`buildEdits` 写入轨道和活动轨 id；打开项目时把活动轨投影回 chunks 的 `secondText`，保证现有双语预览和既有字幕导出继续工作。项目自动保存、恢复副本和“另存为新项目”都沿用同一份轨道数据。

### 接口与数据

```ts
interface LanguageTrackEntry {
  text: string;
  sourceText: string; // exact source text when this translation was written/kept
  updatedAt: string;
}

interface LanguageTrack {
  id: string;
  name: string;
  languageCode: string | null; // null is the explicit Unspecified state
  origin: 'manual' | 'legacy-second-text';
  entries: Record<string, LanguageTrackEntry>; // subtitle chunk id -> translation
}
```

`ProjectEdits` 增加可选的 `languageTracks`、`activeLanguageTrackId`。Host 在 `ProjectStore.readEdits` 校验并惰性归一化轨道，`writeEdits` 再校验一次；所有条目的 `chunk.id` 必须来自当前 edits 的 chunks，活动 id 必须存在。未知条目字段仍由现有模式校验规则决定，不静默改成另一种语言。

项目格式从 3 升到 4。`project.json` 的迁移 3→4 保留未知字段；首次写入沿用 `writeProject` 机制，保留 `project.v3.json`。`edits.json` 的轨道迁移在读取时计算，重开结果稳定，不写文件。旧程序读取格式 4 时按现有 `NewerFormatError` 拒绝，备份用于受控降级。

不新增 RPC。轨道增删改、切换和译文编辑都通过现有 `projects.saveVideoEdits` 保存，继续比较视频 `baseRevision`，同一项目串行写入。两台设备改同一视频时，后到请求返回 `conflict` 且不写入；用户必须显式选择覆盖或另存，符合 AC-4/AC-8。

### 备选方案与取舍

| 方案 | 优点 | 缺点 |
|---|---|---|
| 每视频 `languageTracks`，按 chunk id 保存，复用 edits 修订号（选定） | 与原文、删除、EDL 同一保存单元；切换视频和并发语义沿用 F-0003；不重复时间 | edits 文件变大，一次译文修改仍保存整份视频编辑 |
| 项目级独立语言轨文件和 RPC | 轨道数据更小，可单独合并 | 引入第二套修订号、并发和回收站生命周期，跨文件原子性更复杂 |
| 在 chunk 上保存 translations map | 与 `secondText` 相近 | 字词级 chunks 也会复制轨道，文件膨胀；EDL/编辑器投影更难保持单一真源 |
| 用时间区间关联译文 | 导入外部字幕方便 | 原文改字、拆分和 EDL 后容易漂移，违反共用时间轴和稳定关联 |
| 只保存原文 hash，不保存快照 | 文件更小 | 无法展示或审核过期原因；迁移旧 `secondText` 时无可靠基准，后续重翻也难定位 |

## 架构决策

采用 [ADR-0011 多语言字幕轨道与项目格式 4](../../20-architecture/adr/0011-multilingual-subtitle-tracks.md)。ADR 保持 `proposed`，随维护者验收一并决定。

## 自行决定的事项

- **未知语言不猜测**：旧 `secondText` 没有语言元数据，迁移轨使用 `languageCode: null` 和明确的未指定状态；用户必须选择语言才能消除提示。影响 AC-2。
- **原文版本用快照**：保存创建译文时的完整原文，而不是新增 chunk 级递增版本；比较简单、可离线、可稳定回读。影响 AC-3。
- **活动轨持久化**：`activeLanguageTrackId` 随 edits 保存，重开恢复上次轨道；切换轨道会同步 `secondText`，因此也会触发一次自动保存。影响 AC-1、AC-4、AC-7。
- **旧字段投影**：`secondText` 只投影活动轨，旧项目首次保存后仍保留该字段；F-0033 可从 `languageTracks` 读取任意轨。影响 AC-2。
- **手动重翻边界**：F-0030 提供聚焦当前译文的“重新翻译”入口，实际生成新译文仍由用户输入或后续 F-0031 完成；不在本需求新增模型调用。影响 AC-3。

## 风险与回退

- 格式 4 不能被旧客户端打开；首次写盘保留 `project.v3.json`，且不自动写回旧文件。
- 每条译文复制一份原文会增大大文件 edits，但相比字词转写仍很小；若真实 60 分钟项目出现明显写盘压力，可后续在格式 5 做增量文件，不在本需求暗拆。
- `secondText` 与活动轨必须同步；所有写入集中在历史 store 的轨道动作和 `buildEdits`，架构测试覆盖 read/save/reopen 与冲突。
- 目前系统没有专用字幕轨导出；F-0030 保持现有双语导出兼容，任意轨导出按 F-0033 范围执行，不承诺本需求提前完成。

## 实现清单

- [x] 1. 定义语言轨数据契约、原文过期/保留纯逻辑，升级项目格式 4 并实现 Host 惰性迁移、格式备份和读写测试。
- [x] 2. 将语言轨接入 history store、项目打开/自动保存、恢复副本和另存流程，保证 `secondText` 投影与视频修订冲突。
- [x] 3. 实现字幕编辑器轨道选择、空态、添加/命名/设置未知语言/删除确认及保存生命周期状态。
- [x] 4. 将副字幕编辑和现有 AI 翻译写入当前轨，显示原文过期、保留和重新翻译操作，并覆盖 EDL/删除后的共用时间轴。
- [x] 5. 补齐架构、单元和 Playwright 用例，覆盖 AC-1～AC-9 的中英文、明暗主题、失败/冲突/重开状态并生成证据。
- [ ] 6. 在固定实现提交上跑静态检查、单元/架构/端到端、真实 Host 与桌面验证；填写 03/04、Red check、真实性说明和 Not run。

## 验证计划

| 清单 | 检查 |
|---|---|
| 1 | `pnpm test:architecture -- tests/architecture/language-tracks-f0030.test.ts`、`pnpm test:architecture`、`pnpm check:host`；固定旧格式目录断言读取不写、未知语言不猜测、首次保存保留 `project.v3.json`。 |
| 2 | `pnpm tsc -b --noEmit`、语言轨 store/恢复副本测试；真实 Host 两客户端同视频保存，后到冲突且不覆盖先到轨道。 |
| 3 | `pnpm lint`、`pnpm tsc -b --noEmit`、Playwright 轨道添加/切换/空态/删除与保存状态。 |
| 4 | `pnpm test`、Playwright 原文修改后过期、保留/重翻与双语导出回归；`pnpm test:architecture` 覆盖 EDL 只移动时间、不丢译文索引。 |
| 5 | `pnpm test:e2e tests/e2e/features/F-0030.spec.ts`；`pnpm e2e:evidence F-0030`；中英文 × 明暗主题所有新增状态截图和录屏。 |
| 6 | `pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`、`cargo check --manifest-path src-tauri/Cargo.toml`、`pnpm test`、`pnpm test:architecture`、`pnpm build`；`pnpm dev` 真实 Host 浏览器流程与桌面实机流程。 |

Red check：临时撤掉轨道读取迁移或 `sourceText` 过期判断，对应架构/Playwright 用例必须失败并指出丢轨或过期未标记。真实使用至少包含一次真实 Host 保存/重开，以及桌面编辑器实际操作；没有 Web 远程 Host、桌面运行环境或外部模型时逐项记 `Not run` 与阻塞原因。

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | 每视频 `languageTracks`、`LanguageTrackBar`、活动轨选择、空译文提示和 `SubtitleItem` 译文输入。 |
| AC-2 | 格式 3→4 迁移、`legacy-second-text`、`languageCode: null`、`secondText` 投影、现有双语导出回归。 |
| AC-3 | 每条译文保存 `sourceText` 快照；过期徽标、保留（推进快照）和重新翻译入口。 |
| AC-4 | 译文只存 chunk id，时间来自原文/EDL；删除确认；`saveVideoEdits` 视频修订号冲突不写；真实 Host 重开。 |
| AC-5 | 复用字幕编辑器入口；无轨道/无译文/未指定语言/无字幕状态分别说明；不显示假成功。 |
| AC-6 | 打开项目沿用加载态，保存态显示 Processing；保存队列单飞，切视频后迟到结果按 `sameVideo` 丢弃；创建/删除对话框可取消。 |
| AC-7 | 只有 `saveVideoEdits` 返回 saved 才显示 Completed；状态写入 edits，重开和第二个客户端读取同一 Host 数据。 |
| AC-8 | Host 错误原文、Retry/Back；`failed` 保留输入；冲突显示 Content changed. Review again. 并打开既有冲突对话框，未显式覆盖不写。 |
| AC-9 | `tests/e2e/features/F-0030.spec.ts` 中英文 × 明暗主题；真实 Host 保存/重开、EDL、恢复副本和桌面验证在 04 记录，缺环境写 Not run。 |


---
id: F-0027
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-16
---

# F-0027 自定义字幕样式保存与复用：设计

## UI / UX

在现有「样式」面板的内置预设下方新增「自定义预设 / Custom presets」区块；不改播放器、导出和样式字段本身。只有打开项目时可用；独立演示模式显示「打开项目后可保存自定义预设」。

| 状态 / 入口 | 用户看到什么、能做什么 | 验收构造 |
|---|---|---|
| 加载中 | 「正在加载… / Loading…」，保存和删除按钮禁用 | `projects.getStylePresets` 挂起 |
| 空态 | 「暂无内容 / Nothing here yet」和「保存为预设 / Save as preset」 | 返回空列表 |
| 保存表单 | 名称输入、当前样式预览（Aa 样张）、「保存预设 / Save preset」「取消 / Cancel」；空名、超长、同名就地报错；同名时出现「已存在同名预设，确认覆盖？」和「覆盖 / Overwrite」 | mock 返回空列表后输入各名称 |
| 列表 | 每个预设显示预览、名称、「应用 / Apply」「删除 / Delete」；点击删除先出现「确认删除这个预设？」 | 保存一个预设后查看 |
| 应用中 / 已完成 | 保存显示「正在处理… / Processing…」并禁用重复提交；Host 确认写入后显示「已完成 / Completed」；应用只改本地样式并显示「已应用到当前样式 / Applied to the current style」 | mock 保存成功 |
| 版本过期 | 「内容已更新，请重新检查 / Content changed. Review again.」和「重新检查 / Review again」，不覆盖新列表 | mock 首次保存返回 `conflict` |
| 失败 | 具体原因 +「重试 / Retry」「返回 / Back」；重试重放上一次保存；网络不确定时先读取 Host 列表 | mock 首次保存报错 |
| 字体缺失 | 应用含未知字体 id 的预设时保留当前字体，显示「预设使用的字体不可用，已保留当前字体」 | 返回 `fontId: "missing-font"` 的预设 |
| 内置预设 | 内置预设列表不变，没有删除入口；删除自定义预设不影响已应用样式 | 有自定义预设时检查内置列表 |

文案放 `src/locales/customPresets.ts`，中英文各一份；沿用现有明暗主题变量。

## 技术方案

### 涉及的子系统

已读 [frontend.md](../../subsystems/frontend.md)、[cordis-host.md](../../subsystems/cordis-host.md)、[code-standards.md](../../code-standards.md)、[acceptance-testing.md](../../30-engineering/acceptance-testing.md)、[decisions.md](../../decisions.md)、[ADR-0001](../../20-architecture/adr/0001-project-storage-format.md)、[ADR-0003](../../20-architecture/adr/0003-multi-video-projects.md)，并核对 `shared/projects.ts`、`shared/protocol.ts`、`server/plugins/projects.ts`、`server/projects/store.ts`、`src/services/projectService.ts`、`src/subtitle/subtitlePresets.ts`、`src/subtitle/subtitleStyle.ts`、`src/components/SubtitleSettings/*`。

### 方案

**1. 项目级存储（`shared/stylePresets.ts` + `shared/projects.ts`）**

`project.json` 增加可选字段 `stylePresets: CustomStylePreset[]` 和 `stylePresetsRevision: number`，都是格式 4 的增量字段，缺失按空列表/0 读取，不抬 `PROJECT_FORMAT_VERSION`，不改旧项目。预设结构：

```ts
interface CustomStylePreset {
  id: string; name: string;
  primary: Record<string, unknown>; secondary: Record<string, unknown>; // 样式对 Host 不透明
  createdAt: string; updatedAt: string;
}
```

名称去空白、合并连续空格、最多 60 字；最多 50 个；大小写不敏感去重。Host 只校验名称/数量/结构，样式字段原样保存，避免 Host 理解渲染细节。

**2. Host RPC（`server/plugins/projects.ts`）**

- `projects.getStylePresets({ projectId })` 返回 `{ projectId, revision, presets }`，加入只读方法；
- `projects.saveStylePresets({ projectId, presets, baseRevision, operationId? })` 在项目写锁内执行：`baseRevision` 不匹配返回 `conflict` 和最新列表；`operationId` 去重；写 `project.stylePresets`、`stylePresetsRevision + 1`、`project.revision + 1`。
- 保存时按名称复用旧 `id`/`createdAt`，覆盖同名预设；不修改任何视频的 `edits.stylePair`。

**3. 客户端（`useCustomStylePresets` + `CustomPresetsSection`）**

- 打开项目时读取列表；保存/删除走 `projects.saveStylePresets`，冲突进入 stale，重新读取后才能再写；网络不确定时下一次保存先 `getStylePresets` 核对修订号。
- 「保存为预设」捕获当前 `SubtitleStylePair`；应用时 `applyCustomStylePreset` 只合并样式字段，保留当前视频的 `aspectPreset` 和 `bottomOffsetRatio`（画幅按视频保存，F-0003 AC-13）；未知 `fontId` 回退当前字体并提示。
- 应用预设调用现有 `onStylePairChange`，因此继续走现有样式来源规则：跟随项目时保存到项目样式，视频单独样式时保存到该视频；不新增第二套提示。
- 删除预设只改预设列表，不触碰已应用的 `stylePair` 快照（AC-4）。

### 接口与数据

| 位置 | 接口 / 约束 |
|---|---|
| `shared/stylePresets.ts` | schema、名称校验、去重、快照/结果类型 |
| `shared/projects.ts` | `stylePresets?`、`stylePresetsRevision?`（增量，无迁移） |
| `shared/protocol.ts` | `projects.getStylePresets` / `projects.saveStylePresets` |
| `server/plugins/projects.ts` | 读/写、修订号冲突、operationId 去重、项目写锁 |
| `src/hooks/useCustomStylePresets.ts` | 加载/保存/覆盖/删除/应用/重试/冲突状态 |
| `src/subtitle/customPresets.ts` | 合并样式、保留画幅与底边距、字体回退 |
| `src/components/SubtitleSettings/CustomPresetsSection.tsx` | 全部界面状态与 `data-testid` |

### 备选方案与取舍

| 选定 | 备选 | 理由 |
|---|---|---|
| 预设存 `project.json` | 全局 `presets.json` 或 localStorage | AC-2 要求 Host 保存且项目内多视频复用；项目文件随项目备份/迁移，作用域正确 |
| 独立 `stylePresetsRevision` + 专用 RPC | 复用 `saveProjectStyle` | 预设列表与项目样式保存频率/冲突语义不同，混在一起会互相触发冲突 |
| 应用时保留视频画幅 | 预设连画幅一起应用 | 画幅是每个视频的属性（F-0003 ADR-0003）；切预设不应悄悄改画幅 |
| 未知字体回退并提示 | 直接写未知字体 | 缺少字体时不能保证渲染；显式回退符合 AC-4 |
| 删除只改列表 | 删除时改写已应用样式 | 已应用样式是快照，删除预设不应改现有视频（AC-4） |

## 架构决策

不新增 ADR。沿用 [ADR-0001](../../20-architecture/adr/0001-project-storage-format.md) 的增量字段约定和 [ADR-0003](../../20-architecture/adr/0003-multi-video-projects.md) 的「画幅按视频保存、样式跟随项目或视频」。

## 自行决定的事项

- 预设存主、副两条样式和名称；不存显示模式、画幅和底边距。应用时保留当前视频的画幅/底边距（AC-3）。
- 同名判断忽略大小写和多余空格；覆盖必须由用户点「覆盖」，不静默覆盖（AC-1）。
- `stylePresetsRevision` 独立于 `styleRevision`；保存预设不会触发视频样式保存冲突（AC-8）。
- 网络不确定时先读列表再决定是否重发，避免重复副作用（AC-8）。
- 非项目模式不显示可用操作，只提示打开项目（AC-5）。

## 风险与回退

- `project.json` 变大：每个预设约几 KB，上限 50 个，可接受。
- 旧客户端打开新项目会忽略未知字段；Host 的 `chunkSchema`/项目 schema 用增量字段，不破坏旧文件。
- 预设样式含未知字段时不参与渲染，不会让项目打不开；字体缺失显式回退。
- 删除预设后无法恢复列表项（已应用样式不受影响）；界面要求二次确认。

## 实现清单

- [x] 1. **共享契约**：`shared/stylePresets.ts`、`shared/projects.ts` 增量字段、`shared/protocol.ts` RPC 声明；名称校验/去重测试（AC-1、AC-2）。
- [x] 2. **Host 持久化**：`projects.getStylePresets` / `saveStylePresets`，修订号冲突、operationId 去重、项目写锁、重开保持；架构测试覆盖重启读取和冲突（AC-2、AC-7、AC-8）。
- [x] 3. **客户端状态与样式合并**：`useCustomStylePresets`、`applyCustomStylePreset`，保留画幅/底边距、字体回退、冲突与重试；单测覆盖（AC-3、AC-4、AC-8）。
- [x] 4. **界面**：`CustomPresetsSection` 接入样式面板，覆盖加载、空态、保存、同名覆盖、应用、删除确认、失败重试、版本过期、字体缺失；中英文文案（AC-1、AC-4–AC-8）。
- [x] 5. **验收与真实验证**：`tests/e2e/features/F-0027.spec.ts` 中英文 × 明暗主题、截图；`acceptance:f0027` 用真实 Host、真实媒体和两个视频验证保存/复用/删除/重开（AC-2、AC-4、AC-7、AC-9）。

## 验证计划

- **架构/单测**（`tests/architecture/style-presets-f0027.test.ts`，`pnpm test:architecture`）：名称空/超长/同名/上限；去重；应用保留画幅和底边距、未知字体回退；Host 保存/重启读取/冲突/operationId 去重。
- **界面 E2E**（`tests/e2e/features/F-0027.spec.ts`）：加载、空态、保存、同名覆盖、应用、删除确认、失败重试、版本过期重新读取、字体缺失；中英文 × 明暗主题，`pnpm e2e:evidence F-0027` 生成截图/录屏。
- **真实使用**（`pnpm acceptance:f0027`）：真实 Host + 真实生成的媒体 + 两个视频，验证保存到项目、第二个视频可复用、应用后样式写入 Host、画幅不变、删除预设后已应用样式不变、重开列表仍在。
- **Red check**：撤掉同名校验后单测必须在重复名断言失败；撤掉画幅保留后单测必须在 `aspectPreset` 断言失败。
- **回归**：`pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host`、`pnpm test`、`pnpm test:architecture`、`cargo check`。

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | 保存表单、名称校验、同名覆盖确认、预览，清单 1、4 |
| AC-2 | project.json 持久化、多视频读取、重开保持、内置预设不可改，清单 2、3、5 |
| AC-3 | 只合并样式字段、保留画幅/底边距、沿用现有样式来源规则，清单 3、4 |
| AC-4 | 删除确认、已应用样式快照不变、字体缺失回退提示，清单 3、4、5 |
| AC-5 | 项目模式入口、非项目提示、空态，清单 4 |
| AC-6 | 加载/处理中、禁用重复提交、网络不确定先查，清单 3、4 |
| AC-7 | Host 确认后显示完成、重开与第二视频读取一致，清单 2、4、5 |
| AC-8 | 冲突、重试、保留输入、先查后写，清单 2、3、4 |
| AC-9 | 中英文 × 明暗主题 E2E、截图/录屏、真实 Host 双视频验证，清单 5 |

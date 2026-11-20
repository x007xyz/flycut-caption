# 开发流程

从产品规划到单个需求验收、再到按版本发布的完整流程。维护者一个人从需求做到开发，所以流程按「人只在两个节点集中审，能让 AI 确认的都让 AI 确认」设计：

- **一批需求只有两个人工节点**，维护者在同一个时间点一次看完：
  1. **节点一：方案确认**：这一批所有需求的需求说明（`01-spec`）和技术设计（`02-design`），以及一起改动的 Epic / 产品文档、新写的 ADR、执行图、待澄清的问题。
  2. **节点二：验收**：这一批所有需求的测试与验收报告（`04-test-report`），以及执行期间 AI 已确认的事项（调研结论、自行决定的事项）。
- **能让 AI 确认的都让 AI 确认**：任何要交给维护者的文件，先由独立的 AI 审查员（不是写它的 agent）按 [AI 审查清单](ai-review.md) 审过；开发（`03`）由脚本检查确认，调研报告（`02-research`）由 AI 审查员确认。
- **按批次执行**：一批需求有一份批次文件 `docs/features/batches/B-NN-<slug>.md`，里面的**执行图**说明执行顺序、哪些可以并发；方案确认后严格按执行图执行，每完成一步运行 `pnpm feature batch sync` 把状态同步回执行图。
- **发布、运维观察、复盘按版本做**，写在 `docs/40-ops/releases/vX.Y.Z.md`，不在单个需求里重复。打 tag 是对外操作，单独需要维护者同意。

借鉴：[Spec Kit](https://github.com/github/spec-kit)（需求编号目录）、[OpenSpec](https://github.com/Fission-AI/OpenSpec)（变更与长期规格分离、完成后归档）、Kiro（验收标准编号）。开发阶段的执行规则沿用 [code-standards.md](../code-standards.md)。

## 三层结构

```text
产品规划（VISION、CAPABILITY-MAP、ROADMAP）        docs/10-product/
  └─ Epic：一块能力（E-01 … E-08）                docs/10-product/epics/E-NN-<slug>.md
       └─ 需求：可以单独发布的最小单元（F-0001 …）  docs/features/F-NNNN-<slug>/
            （一起推进的一批需求 = 批次 B-NN）       docs/features/batches/B-NN-<slug>.md
```

| 层 | 内容 | 门禁 |
|---|---|---|
| 产品规划 | 愿景、目标用户、竞品、获客、能力地图、路线图 | 维护者确认（跟着批次的方案确认一起看） |
| Epic | 要解决的问题、做完是什么样、候选需求及其依赖 | 确认前要先确认 VISION 和 CAPABILITY-MAP |
| 需求 | 下面的 4 个阶段（调研类 2 个） | 所属 Epic 已确认才能立项 |
| 批次 | 一批需求的范围、执行图、两个人工节点的审阅材料 | 方案确认、验收各一次 |

**需求内部不再拆任务。** 产品层已经把需求拆到能单独发布的大小，开发时整个需求在一个上下文里做完，存储、接口和界面一起考虑。技术设计里写一份「实现清单」，开发时按清单推进、每段提交一次；它是进度记录，不是门禁。**并发发生在需求之间**：执行图里同一波次、互不依赖的需求可以在各自的 worktree 里同时做。

## 大需求怎么拆

**在写需求说明之前就拆。** 大需求先放进 Epic 的候选需求表里拆好，每个候选再单独写需求说明；不要先写一个大需求说明再拆。

一个需求要满足下面全部条件，否则继续拆：

- **用户能感受到**：发布后用户能用到点什么，不能只是「搭好了底层框架」。
- **可以单独发布**：不用等其他需求一起上线。
- **验收标准不超过 10 条左右。**
- **两周左右能做完，并且能在一个需求里一次做完。** 做的过程中发现需要拆成几次分别发布，就回到 Epic 拆成多个需求，不在需求内部拆任务。
- **结果可预期**：有重大技术不确定性的（选哪个引擎、算法效果如何），先拆一个**调研需求**（`--type spike`），产出调研报告和 ADR。

按「用户能完成的一步」拆，不按技术层拆：「先做后端、再做前端」是错的拆法；「先能为单条字幕生成配音并试听，再做整段配音导出」是对的拆法。

需求说明（01-spec）里有规模检查，发现太大就在结论里建议怎么拆，退回 Epic 增加候选，在下一次方案确认时由维护者确认。

## 需求的阶段

| # | 阶段 | 文件 | 产出 | 谁确认 | Skill |
|---|---|---|---|---|---|
| 1 | 需求说明 | `01-spec.md` | 来源、问题、竞品与获客、优先级与依赖、范围（做 / 不做）、验收标准 `AC-n`、成功指标、规模检查、待澄清的问题 | AI 审查 → **维护者（节点一）** | `fc-spec` |
| 2 | 技术设计 | `02-design.md` | 技术方案（含界面怎么改、接哪些数据）、接口与数据、备选方案、实现清单、验证计划；重大架构决策另写 ADR | AI 审查 → **维护者（节点一）** | `fc-spec` 写完需求说明后接着写 |
| 3 | 开发 | `03-implementation.md` | 整个需求一次做完：按实现清单推进、进度记录、与设计的偏差 | 脚本检查（实现清单全部勾选） | `fc-build` |
| 4 | 测试与验收 | `04-test-report.md` | 每条 AC 的结果、设计与实现摘要、自行决定的事项、截图和录屏 | AI 审查 → **维护者（节点二）** | `fc-build` |

**调研需求**（spike）只有两个阶段：`01-spec`（写「要回答的问题」代替 AC，节点一确认）→ `02-research`（调研报告，`fc-research`，**AI 审查员确认**）。结论影响后续需求范围或写了新 ADR 的，汇总进批次文件，在下一个人工节点给维护者看；确认后直接归档。

验收通过的需求就算完成，进入「待发布」列表。

## 批次与执行图

批次是人工审阅的单位：一批需求一起写方案、一起确认、按执行图推进、一起验收。批次文件模板见 [templates/batch.md](templates/batch.md)。

```text
fc-spec ─┬─ 并行写每个需求的 01-spec + 02-design（AI 审查）
         └─ pnpm feature batch new → 执行图
                       │
              🧑 节点一：方案确认（pnpm feature approve B-NN）
                       │
fc-build ── 按执行图逐波次执行：同一波次并发，每个需求 03 开发 → 04 测试 → AI 审查
            每完成一步 pnpm feature batch sync，状态同步回执行图
                       │
              🧑 节点二：验收（pnpm feature approve B-NN）
```

- **创建批次**：`pnpm feature batch new <slug> "<标题>" F-… [--docs E-05,ROADMAP]`。脚本按需求的 `depends_on` 生成 Mermaid 执行图：方案阶段全部并行 → 节点一 → 按依赖分的波次（同一波次可以并发）→ 节点二；批外依赖用虚线标出。执行图和「进度」表由脚本生成，不要手改。
- **并发与分派**：创建批次时在「并发与分派」表里写清楚每个需求在哪个分支 / worktree 做、由谁做（主会话还是哪个子代理）、合入集成分支的顺序。同一波次的需求文件可能重叠时，各自用独立 worktree；合入按依赖顺序。
- **同步**：每个需求每完成一个阶段、每次合入、每次 AI 审查后运行 `pnpm feature batch sync B-NN`，脚本重算执行图节点颜色、进度表和批次状态，状态变化写进「同步日志」。`pnpm feature batch status B-NN` 列出「现在可以并行开始」的需求。
- **批次状态**：`planning → plan-review → executing → acceptance-review → done`，由脚本根据各需求阶段算出。
- **同批依赖**：依赖的需求在同一批次里时，它的验收报告通过 AI 审查就可以开始依赖方的开发，不用等维护者验收；节点二维护者退回依赖项时，依赖方一起重新验收。批外依赖仍然要求已验收或已归档。

## AI 审查

- 写文件的 agent 不审自己的文件：由另一个子代理或会话按 [ai-review.md](ai-review.md) 对应阶段的清单审查，结果用 `pnpm feature ai-review <F-编号> --by <审查员> [--fail "<原因>"]` 记进 frontmatter。不通过就改完再审，最多两轮；两轮还不过的问题写进批次文件，留给人工节点。
- 以下阶段没有 AI 审查通过，`pnpm feature review` 会拒绝：`01-spec`、`02-design`、`02-research`、`04-test-report`。
- AI 能确认的就不留给人：实现细节、清单顺序、测试写法、调研结论（不改范围时）、措辞和格式。**只有这些必须留给人工节点**：需求范围和 AC、待澄清的问题、推翻 `docs/decisions.md` 或前面需求的共用契约、新 ADR、对外或不可逆的操作、AI 两轮审不过的问题。

## 界面改动怎么确认

不单独做交互原型阶段：AI 写代码之后，改界面的成本已经很低，原型和正式代码重复确认不划算。界面靠下面三处把关：

- **需求说明写清楚界面状态**：每个新增或改动的界面，每个状态（空、加载中、正常、出错、冲突……）都写成一条 AC，说明用户看到什么、能做什么、文案是什么。状态怎么处理在方案确认时就定下来，不留到写代码时顺手决定。
- **开发直接写真实代码**：界面直接接真实的 stores 和 Host，不另写假数据版本。
- **验收先跑自动化**：涉及界面的每条 AC 优先用目标平台上的端到端测试，测试名带 AC 编号，覆盖需求说明列出的状态和明暗主题；Web 沿用 Playwright，桌面专属行为在真实 Tauri 中验证。截图存进需求目录的 `screenshots/`，作为补充证据。规则见 [自动化验收方案](../30-engineering/acceptance-testing.md) 和 [fc-build](../../.claude/skills/fc-build/SKILL.md)。

例外：全新的大页面、方向还不清楚时，可以先用独立 HTML 或 Artifact 页面做低保真探索，看完就扔，结论写进需求说明。**从零开始的项目**在第一个有界面的需求之前，先建立设计系统（技术栈、颜色 / 字号 / 间距等基础样式值、基础组件），写一份 ADR，见 [agent-maintenance-playbook.md](../agent/agent-maintenance-playbook.md)。

`fc-status` 查看整体进度；`fc-plan` 维护产品规划和 Epic。

模板在 [templates/](templates/)。

## 编号与引用

| 编号 | 含义 | 位置 |
|---|---|---|
| `VISION`、`CAPABILITY-MAP`、`ROADMAP` | 产品规划文档 | `docs/10-product/` |
| `E-01` | Epic | `docs/10-product/epics/E-01-<slug>.md` |
| `E-05/2` | Epic 里的第 2 个候选需求（立项前的临时编号） | Epic 文档 |
| `F-0001` | 需求 | `docs/features/F-0001-<slug>/` |
| `F-0001/AC-3` | 需求的第 3 条验收标准 | `01-spec.md` |
| `B-01` | 批次 | `docs/features/batches/B-01-<slug>.md` |
| `ADR-0001` | 架构决策 | `docs/20-architecture/adr/0001-<slug>.md` |
| `INC-0001` | 事故 | `docs/40-ops/incidents/0001-<slug>.md` |
| `v2.1.0` | 版本发布文档 | `docs/40-ops/releases/v2.1.0.md` |

- 编号只增不减，删除或归档后也不复用。
- 候选需求立项后，在 Epic 文档的「需求编号」列回填 F-编号；依赖里引用候选编号的，立项后改成 F-编号。
- AC、T 编号在需求内唯一；修改时不重排已有编号，新增的接着往后编，废弃的标注 `~~AC-2~~（废弃：原因）`。
- commit 正文加一行 `Refs: F-0001/AC-3`；测试名称带上 AC 编号，例如 `test('F-0001/AC-3 删除原文后配音同步删除', …)`。

## 门禁

### 确认门禁

每个文件开头都有 frontmatter，状态 `draft → review → approved`。

1. agent 写完一个阶段：先 `pnpm feature ai-review`（独立审查员），再 `pnpm feature review`：
   - **需求说明（01）**：进入 `review`，脚本立即创建 `02-design.md`，接着写设计，不等维护者。
   - **技术设计（02）**：检查有实现清单后进入 `review`。
   - **开发（03）**：实现清单全部勾选就自动确认（`approved_by: auto`），创建 `04`。
   - **调研（02-research）**：AI 审查通过即确认（`approved_by: ai:<审查员>`）。
   - **测试与验收（04）**：进入 `review`。
2. **agent 不能自己把 `review` 改成 `approved`。** 维护者在对话里明确确认后，才执行 `pnpm feature approve B-NN --by <名字>`：节点一一次确认批次里全部需求说明、技术设计和 `docs` 里列出的文档；节点二一次确认全部验收报告。单个需求仍可 `pnpm feature approve F-0001 --by <名字>`（确认它所有处于 `review` 的阶段）。
3. 执行期间，agent 只在这几种情况停下来问：要改需求说明的范围或 AC；要推翻 `decisions.md` 或前面需求的共用契约；需求一次做不完；要做不可逆或对外的操作。其他事自己决定，记进「自行决定的事项」，在节点二汇总。能等到节点二再问的，记进批次文件，不中途停。
4. 没有跳过阶段：每个阶段都要有（没有架构变化的技术设计可以很短，但实现清单和验证计划必须有）。
5. 后面的阶段发现需求说明或设计有错：回去修改，把它的状态改回 `review`，这个需求和依赖它的需求暂停，其他需求继续；维护者确认后用 `pnpm feature approve <编号> --stage 01-spec --by <名字>`。

### 依赖门禁

依赖只有需求一级，写在 `01-spec.md` 的 `depends_on`（`pnpm feature depends`），只能写需求编号（`F-0003`）。

- 依赖的需求 `04-test-report` 已确认（调研：`02-research` 已确认）或已归档，才算完成；同一批次里的依赖，验收报告通过 AI 审查即可开始依赖方的开发。
- 依赖没满足时不能进入 `03-implementation`（调研：不能进入 `02-research`）；需求说明和技术设计可以提前做。
- 写依赖时脚本检查编号是否存在、是否成环；`pnpm feature check` 检查全部需求和批次。

### 开发阶段的检查点

开发阶段没有任务门禁，由 agent 按执行图掌握节奏：

- 按 `02-design.md` 的实现清单推进，每完成一项：跑验证计划里的检查 → 提交 → 勾选清单 → 在 `03-implementation.md` 记一行进度。
- 每完成一个阶段或一次合入：`pnpm feature batch sync`。
- `03-implementation` 提交确认时，脚本要求实现清单全部勾选。

### 两个人工节点交给维护者看什么

两个节点都只给一个入口：**批次文件**。批次文件里链接每个需求的文件，并把要维护者拍板的事汇总在一处，维护者不用逐个打开需求目录。

- **节点一（方案确认）**：每个需求一句话方案、AC 数、依赖；执行图；待澄清的问题和建议答案；Epic / 产品文档改动；新写的 ADR；AI 审查结论和没审过的问题。
- **节点二（验收）**：每个需求的结论和验收报告链接（AC 结果、目标平台、命令、Not run 及原因、界面证据）；请确认的事项；AI 已确认的事项（调研结论、自行决定的事项）。

## 与项目级文档的关系

需求目录记录的是「这一次变更」；下面这些是「系统当前的样子」，版本复盘（`fc-retro`）时把变化合并进去：

| 目录 | 内容 |
|---|---|
| [10-product/](../10-product/) | 产品愿景、能力地图、路线图、Epic |
| [20-architecture/](../20-architecture/) | 架构总览与 ADR |
| [30-engineering/](../30-engineering/) | 工程规范（现有的 `code-standards.md` 等暂不迁移） |
| [40-ops/](../40-ops/) | 版本发布文档、运维手册、事故记录 |

需求随版本发布后，用 `pnpm feature archive F-0001 F-0002 --release v2.1.0` 移到 `docs/features/archive/`（调研确认后用 `--release none`）。

## 命令

```bash
pnpm feature status [E-05 | F-0001]          # 整体进度（含批次、待发布列表）/ 单个 Epic / 单个需求
pnpm feature check                           # 检查依赖和批次
pnpm feature epic <slug> "<标题>"            # 新建 Epic
pnpm feature new <slug> "<标题>" --epic E-05 [--type spike] [--depends F-0002,F-0003]
pnpm feature depends F-0001 F-0002 F-0003   # 设置需求依赖（--clear 清空）
pnpm feature ai-review F-0001 --by <审查员> [--stage 02-design] [--fail "<原因>"]   # 记录独立 AI 审查结果
pnpm feature review <VISION | E-05 | F-0001> # 写完，提交确认（需要先通过 AI 审查）
pnpm feature batch new <slug> "<标题>" F-0001 F-0002 [--docs E-05,ROADMAP]   # 新建批次并生成执行图
pnpm feature batch add B-01 F-0003 [--docs ROADMAP]
pnpm feature batch sync [B-01]               # 把各需求状态同步回执行图和进度表
pnpm feature batch status [B-01]             # 批次状态、波次、现在可以并行开始的需求
pnpm feature approve <B-01 | VISION | E-05 | F-0001 ...> --by <名字> [--stage 01-spec]   # 维护者确认后才运行
pnpm feature next F-0001                     # 手动创建下一阶段文件（一般不需要）
pnpm feature release-notes v2.1.0            # 新建版本发布文档，带上所有已验收、未发布的需求
pnpm feature archive F-0001 ... --release v2.1.0   # 发布后归档
pnpm e2e:evidence F-0001                     # 跑需求的端到端测试，生成截图和录屏
pnpm feature adr <slug> "<标题>" [--feature F-0001]
pnpm feature incident <slug> "<标题>" [--feature F-0001]
```

# 开发流程

从产品规划到单个需求复盘的完整流程。**规划、立项、PRD 和测试与验收之后的每一步都要维护者确认；技术设计 → 开发 → 测试与验收由 agent 连续推进，维护者在验收时看测试报告、截图和录屏一并审阅**；依赖没有完成的需求和任务不能开始开发。

借鉴：[Spec Kit](https://github.com/github/spec-kit)（需求编号目录）、[OpenSpec](https://github.com/Fission-AI/OpenSpec)（变更与长期规格分离、完成后归档）、[BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD)（阶段划分）、Kiro（验收标准编号）。开发阶段的执行规则沿用 [code-standards.md](../code-standards.md)。

## 三层结构

```text
产品规划（VISION、CAPABILITY-MAP、ROADMAP）        docs/10-product/
  └─ Epic：一块能力（E-01 … E-08）                docs/10-product/epics/E-NN-<slug>.md
       └─ 需求：可以单独发布的最小单元（F-0001 …）  docs/features/F-NNNN-<slug>/
```

| 层 | 内容 | 门禁 |
|---|---|---|
| 产品规划 | 愿景、目标用户、竞品、获客、能力地图、路线图 | 维护者确认 |
| Epic | 要解决的问题、做完是什么样、候选需求及其依赖 | 确认前要先确认 VISION 和 CAPABILITY-MAP |
| 需求 | 下面的 8 个阶段（调研类 3 个） | 所属 Epic 已确认才能立项 |

**需求内部不再拆任务。** 产品层已经把需求拆到能单独发布的大小，开发时整个需求在一个上下文里做完，存储、接口和界面一起考虑，比拆成互相依赖的任务更一致。技术设计里写一份「实现清单」，开发时按清单推进、每段提交一次；它是进度记录，不是门禁。

## 大需求怎么拆

**在写 PRD 之前就拆。** 大需求先放进 Epic 的候选需求表里拆好，每个候选再单独立项；不要先写一个大 PRD 再拆。

一个需求要满足下面全部条件，否则继续拆：

- **用户能感受到**：发布后用户能用到点什么，不能只是「搭好了底层框架」。
- **可以单独发布**：不用等其他需求一起上线。
- **验收标准不超过 10 条左右。**
- **两周左右能做完，并且能在一个需求里一次做完。** 做的过程中发现需要拆成几次分别发布，就回到 Epic 拆成多个需求，不在需求内部拆任务。
- **结果可预期**：有重大技术不确定性的（选哪个引擎、算法效果如何），先拆一个**调研需求**（`--type spike`），产出调研报告和 ADR。

按「用户能完成的一步」拆，不按技术层拆：「先做后端、再做前端」是错的拆法；「先能为单条字幕生成配音并试听，再做整段配音导出」是对的拆法。

立项（01-intake）和 PRD（02-prd）里都有拆分检查，发现太大就退回 Epic 增加候选，由维护者确认。

## 需求的阶段

| # | 阶段 | 文件 | 产出 | Skill |
|---|---|---|---|---|
| 0–1 | 需求收集与立项 | `01-intake.md` | 问题、目标用户、竞品、获客价值、依赖、规模检查；结论：做 / 待澄清 / 不做 | `fc-intake` |
| 2 | 产品文档 | `02-prd.md` | 范围、不做什么、用户故事、验收标准 `AC-n`、成功指标、拆分检查 | `fc-prd` |
| 3 | 技术设计（自动确认） | `03-design.md` | 技术方案（含界面怎么改、接哪些数据）、接口与数据、备选方案、实现清单、验证计划；重大架构决策另写 ADR | `fc-design` |
| 5 | 开发（自动确认） | `05-implementation.md` | 整个需求一次做完：按实现清单推进、进度记录、与设计的偏差 | `fc-implement` |
| 6 | 测试与验收 | `06-test-report.md` | 每条 AC 的结果、设计与实现摘要、自行决定的事项、截图和录屏；维护者在这里一并审阅 3、5、6 | `fc-verify` |
| 7 | 发布 | `07-release.md` | 版本、发布说明、发版闸门结果 | `fc-release` |
| 8 | 运维观察 | `08-ops.md` | 发布后的问题、崩溃、用户反馈 | `fc-ops` |
| 9 | 复盘 | `09-retro.md` | 成功指标是否达成、教训、后续需求 | `fc-retro` |

**调研需求**（spike）只有三个阶段：`01-intake` → `02-research`（调研报告，模板 [02-research.md](templates/02-research.md)）→ `09-retro`。

### 界面改动怎么确认

不单独做交互原型阶段：AI 写代码之后，改界面的成本已经很低，原型和正式代码重复确认不划算。界面靠下面三处把关：

- **PRD 写清楚界面状态**：每个新增或改动的界面，每个状态（空、加载中、正常、出错、冲突……）都写成一条 AC，说明用户看到什么、能做什么、文案是什么。状态怎么处理在 PRD 确认时就定下来，不留到写代码时顺手决定。
- **开发直接写真实代码**：界面直接接真实的 stores 和 Host，不另写假数据版本。
- **验收用端到端测试**：涉及界面的每条 AC 都有 Playwright 测试（`tests/e2e/features/<F-编号>.spec.ts`，测试名带 AC 编号），覆盖 PRD 列出的每个状态和明暗主题，并把截图存进需求目录的 `screenshots/`，维护者在验收阶段看截图确认界面。规则见 [fc-verify](../../.claude/skills/fc-verify/SKILL.md)。

例外：全新的大页面、方向还不清楚时，可以先用独立 HTML 或 Artifact 页面做低保真探索，看完就扔，结论写进 PRD。**从零开始的项目**在第一个有界面的需求之前，先建立设计系统（技术栈、颜色 / 字号 / 间距等基础样式值、基础组件），写一份 ADR，见 [agent-maintenance-playbook.md](../agent/agent-maintenance-playbook.md)。

`fc-status` 查看整体进度；`fc-plan` 维护产品规划和 Epic。

模板在 [templates/](templates/)。

## 编号与引用

| 编号 | 含义 | 位置 |
|---|---|---|
| `VISION`、`CAPABILITY-MAP`、`ROADMAP` | 产品规划文档 | `docs/10-product/` |
| `E-01` | Epic | `docs/10-product/epics/E-01-<slug>.md` |
| `E-05/2` | Epic 里的第 2 个候选需求（立项前的临时编号） | Epic 文档 |
| `F-0001` | 需求 | `docs/features/F-0001-<slug>/` |
| `F-0001/AC-3` | 需求的第 3 条验收标准 | `02-prd.md` |
| `ADR-0001` | 架构决策 | `docs/20-architecture/adr/0001-<slug>.md` |
| `INC-0001` | 事故 | `docs/40-ops/incidents/0001-<slug>.md` |

- 编号只增不减，删除或归档后也不复用。
- 候选需求立项后，在 Epic 文档的「需求编号」列回填 F-编号；依赖里引用候选编号的，立项后改成 F-编号。
- AC、T 编号在需求内唯一；修改时不重排已有编号，新增的接着往后编，废弃的标注 `~~AC-2~~（废弃：原因）`。
- commit 正文加一行 `Refs: F-0001/AC-3`；测试名称带上 AC 编号，例如 `test('F-0001/AC-3 删除原文后配音同步删除', …)`。

## 门禁

### 确认门禁

每个文件开头都有 frontmatter，状态 `draft → review → approved`，或 `skipped`。

1. **新阶段文件只在上一阶段 `approved` 或 `skipped` 之后创建**（`pnpm feature next`，脚本检查）。
2. agent 写完后运行 `pnpm feature review`：
   - **技术设计（03）和开发（05）**：脚本检查通过（设计有实现清单；开发时清单全部勾选）就自动确认，`approved_by: auto`，agent 接着进入下一阶段，不停下来。
   - **其他阶段**：状态改成 `review`，停下来请维护者确认。**agent 不能自己把这些阶段改成 `approved`。**
3. 维护者在对话里明确确认后，才执行 `pnpm feature approve <编号> --by <名字>`；维护者也可以自己运行。
4. 连续推进期间，agent 只在这几种情况停下来问：要改 PRD 的范围或 AC；要推翻 `decisions.md` 或前面需求的共用契约；需求一次做不完；要做不可逆或对外的操作。其他事自己决定，记进「自行决定的事项」，测试报告汇总给维护者。
5. 不需要的阶段同样要维护者确认，用 `pnpm feature skip`，并写明原因。立项、PRD、调研、技术设计（实现清单在里面）、测试与验收不能跳过。
6. 后面的阶段发现前面的文档有错：回到前面的文件修改，把它的状态改回 `review` 重新确认；后续阶段暂停。

### 依赖门禁

依赖只有需求一级，写在 `01-intake.md` 的 `depends_on`（`pnpm feature depends`），只能写需求编号（`F-0003`）。

- 依赖的需求 `06-test-report` 已确认（调研：`02-research` 已确认）或已归档，才算完成。
- 依赖没完成时不能进入 `05-implementation`（调研：不能进入 `02-research`）；立项、PRD、设计可以提前做。
- 写依赖时脚本检查编号是否存在、是否成环；`pnpm feature check` 检查全部需求。

### 开发阶段的检查点

开发阶段没有任务门禁，由 agent 自己掌握节奏：

- 按 `03-design.md` 的实现清单推进，每完成一项：跑验证计划里的检查 → 提交 → 勾选清单 → 在 `05-implementation.md` 记一行进度。
- 什么时候停下来问维护者，见上面「确认门禁」第 4 条。
- `05-implementation` 提交确认时，脚本要求实现清单全部勾选。

### 验收交给维护者看什么

`06-test-report.md` 是技术设计之后维护者唯一的确认点，里面要有：

- 每条 AC 的验证方式和结果；
- 设计与实现摘要、新写的 ADR、与设计的偏差；
- 自行决定的事项（技术设计和开发阶段 agent 自己拍板的事）；
- 界面证据：`pnpm e2e:evidence <F-编号>` 生成的截图（`screenshots/`，进 git）和每个测试的录屏（`recordings/`，只在本地）。

## 与项目级文档的关系

需求目录记录的是「这一次变更」；下面这些是「系统当前的样子」，需求复盘（阶段 9）时把变化合并进去：

| 目录 | 内容 |
|---|---|
| [10-product/](../10-product/) | 产品愿景、能力地图、路线图、Epic |
| [20-architecture/](../20-architecture/) | 架构总览与 ADR |
| [30-engineering/](../30-engineering/) | 工程规范（现有的 `code-standards.md` 等暂不迁移） |
| [40-ops/](../40-ops/) | 运维手册、事故记录 |

需求复盘确认后，用 `pnpm feature archive F-0001` 移到 `docs/features/archive/`。

## 命令

```bash
pnpm feature status [E-05 | F-0001]          # 整体进度 / 单个 Epic / 单个需求（含实现清单和阻塞原因）
pnpm feature check                           # 检查依赖是否存在、是否成环
pnpm feature epic <slug> "<标题>"            # 新建 Epic
pnpm feature new <slug> "<标题>" --epic E-05 [--type spike] [--depends F-0002,F-0003]
pnpm feature depends F-0001 F-0002 F-0003   # 设置需求依赖（--clear 清空）
pnpm feature next F-0001                     # 上一阶段已确认后，创建下一阶段文件
pnpm feature review <VISION | E-05 | F-0001> # 写完，提交确认
pnpm feature approve <VISION | E-05 | F-0001> --by <名字> [--stage 02-prd]   # --stage 确认被退回重审的前面阶段
pnpm feature skip F-0001 --by <名字> --reason "<原因>"
pnpm feature archive F-0001                  # 复盘确认后归档
pnpm e2e:evidence F-0001                     # 跑需求的端到端测试，生成截图和录屏
pnpm feature adr <slug> "<标题>" [--feature F-0001]
pnpm feature incident <slug> "<标题>" [--feature F-0001]
```

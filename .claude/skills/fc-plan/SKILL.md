---
name: fc-plan
description: 维护 FlyCut 的产品规划：产品愿景（目标用户、竞品、获客）、能力地图、路线图和 Epic（拆分候选需求及依赖）。改动经 AI 审查后并入下一个批次的「方案确认」一起给维护者看，不单独停下来。用户说「产品规划」「拆 Epic」「这个需求太大要拆」「更新竞品分析」时使用。
---

# 产品规划与 Epic

文件都在 `docs/10-product/`：`vision.md`（VISION）、`capability-map.md`（CAPABILITY-MAP）、`roadmap.md`（ROADMAP）、`epics/E-NN-<slug>.md`。规则见 `docs/00-process/README.md` 的「三层结构」和「大需求怎么拆」。

1. 先 `pnpm feature status` 看各文档的确认状态。
2. 修改已确认（approved）的文档：直接改，把状态改回 `review`（编辑 frontmatter 的 `status`，并清空 `approved_by`、`approved_at`），记下改了什么、为什么。
3. 新的一块能力用 `pnpm feature epic <slug> "<标题>"` 新建 Epic，并加进 capability-map.md 和 roadmap.md。
4. 拆候选需求：
   - 按「用户能完成的一步」拆，每个候选满足：用户能感受到、可以单独发布、AC 约 10 条以内、约两周做完。
   - 有技术不确定性的先拆调研（类型 spike）。
   - 依赖写候选编号（E-05/1）或已立项的 F-编号，不要成环；跨 Epic 的依赖同时写进 capability-map.md。
5. 竞品和获客：资料写明来源和日期；没核实的价格和功能写「待核实」，不要编造。
6. 写完运行 `pnpm feature review <VISION | CAPABILITY-MAP | ROADMAP | E-NN>`，让独立 AI 审查员核对一致性（候选是否满足拆分条件、依赖是否成环、和 `vision.md`、`decisions.md` 是否矛盾、资料是否有来源）。
7. **不单独停下来。** 改动的编号放进下一个批次的 `--docs`（`pnpm feature batch new … --docs E-05,ROADMAP` 或 `pnpm feature batch add <B-NN> --docs …`），在批次文件「节点一：方案确认 / 产品文档与 Epic 改动」里写清楚改了什么、为什么，和这一批需求的方案一起给维护者确认。Epic 要在 VISION、CAPABILITY-MAP 确认之后才能确认，同一次 `approve B-NN` 里脚本会按顺序处理。
8. 只有维护者明确要求单独看规划（没有要一起推进的需求）时，才单独停下来请维护者确认；**不要自己运行 `approve`。**
9. 注意：Epic 没确认前不能 `pnpm feature new` 立项。新 Epic 下的需求要在同一批里写方案时，先用 Epic 草稿把候选拆好，方案确认后再立项写 01-spec；或者请维护者在节点一先确认 Epic，再立项。在批次文件里写明是哪种。

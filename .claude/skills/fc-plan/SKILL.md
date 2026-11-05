---
name: fc-plan
description: 维护 FlyCut 的产品规划：产品愿景（目标用户、竞品、获客）、能力地图、路线图和 Epic（拆分候选需求及依赖）。用户说「产品规划」「拆 Epic」「这个需求太大要拆」「更新竞品分析」时使用。
---

# 产品规划与 Epic

文件都在 `docs/10-product/`：`vision.md`（VISION）、`capability-map.md`（CAPABILITY-MAP）、`roadmap.md`（ROADMAP）、`epics/E-NN-<slug>.md`。规则见 `docs/00-process/README.md` 的「三层结构」和「大需求怎么拆」。

1. 先 `pnpm feature status` 看各文档的确认状态。
2. 修改已确认（approved）的文档：先说明要改什么、为什么，维护者同意后再改，改完把状态改回 `review`（直接编辑 frontmatter 的 `status`，并清空 `approved_by`、`approved_at`），再请维护者确认。
3. 新的一块能力用 `pnpm feature epic <slug> "<标题>"` 新建 Epic，并加进 capability-map.md 和 roadmap.md。
4. 拆候选需求：
   - 按「用户能完成的一步」拆，每个候选满足：用户能感受到、可以单独发布、AC 约 10 条以内、约两周做完。
   - 有技术不确定性的先拆调研（类型 spike）。
   - 依赖写候选编号（E-05/1）或已立项的 F-编号，不要成环；跨 Epic 的依赖同时写进 capability-map.md。
5. 竞品和获客：资料写明来源和日期；没核实的价格和功能写「待核实」，不要编造。
6. 写完运行 `pnpm feature review <VISION | CAPABILITY-MAP | ROADMAP | E-NN>`，停下来请维护者确认。**不要自己运行 `approve`。** Epic 要在 VISION、CAPABILITY-MAP 确认之后才能确认。

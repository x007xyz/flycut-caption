---
id: F-0039
stage: 02-research
status: approved
approved_by: zhangxiang.chen
approved_at: 2026-11-17
---

# F-0039 口型同步服务调研：报告

调研日期：2026-11-17。只查阅一手官方文档/条款；本轮没有服务账号与 API Key，真实成片试用全部未运行，按 `⏸ Not run` 记录，不据此宣称效果。

## 结论摘要

- 可接入的第三方服务至少四家：Sync.so、Hedra、HeyGen、D-ID。四家都提供异步视频/口型任务、查询与下载；Sync 与 HeyGen 文档最完整（幂等、资产上传、删除、ZDR）。
- **建议暂不产品化，先做有条件试点**：候选优先级 Sync.so `lipsync-2`（API/幂等/删除/ZDR 最清楚）→ HeyGen `POST /v3/lipsyncs`（有删除与 ZDR）→ Hedra（按秒便宜、但输出只保留 48 小时）→ D-ID（保留政策清楚，但价格与商用分层需核实）。
- 真实质量、耗时、脸部伪影、背景变化和首尾同步必须用已授权中英素材实测；没有这些证据前不能给“可用”结论，也不能进 F-0040 实现。
- Provider 需要新增 `lipsync` 角色/能力、异步作业、授权记录和产物元数据；Agent/CLI 不得绕过本人确认。

## Q-1 服务、协议、许可、授权与保留政策

| 服务 | 官方协议（访问 2026-11-17） | 授权/同意 | 数据保留/删除 | 商用与许可 |
|---|---|---|---|---|
| Sync.so | `POST https://api.sync.so/v2/generate`，`x-api-key`；支持资产上传 `POST /v2/assets/upload`；状态 `PENDING/PROCESSING/COMPLETED/FAILED/REJECTED`；`Idempotency-Key` 重试去重；有成本估算端点 | 文档要求输入为视频/音频；未在 API 层强制说话人同意，需调用方自行取得 | 企业可申请 Zero Data Retention（合同开通，非自助）；账户删除会删除项目 | 订阅+按帧计费；未在本次查阅页面看到专门的输出商用限制说明，需合同确认 |
| Hedra | `POST /v3/models/{model}/...`，API Key；作业查询 `GET /v3/jobs/{id}`；预付费 USD 钱包；有 `estimate` | 企业 API 条款要求客户向可识别人物提供通知并取得同意、保存可审计记录（§2.4、§2.5） | 生成文件保留 48 小时，之后链接失效；隐私政策称删除后备份最多 30 天 | 企业 API 许可限制“仅内部业务使用”，除非订单明确允许集成到自己的平台（§1.1、§1.5） |
| HeyGen | `POST https://api.heygen.com/v3/lipsyncs`，`X-Api-Key`；`GET /v3/lipsyncs/{id}` 查询；`DELETE /v3/lipsyncs/{id}` 删除作业及文件；支持 `mode: speed/precision` | 数字人克隆有 consent API；口型同步文档要求输入视频/音频，未在接口层强制授权 | ZDR 企业附加条款：输入/输出/中间产物按约定 24 小时–100 天删除；日志不含媒体 | 付费计划才商用；企业 ZDR 需合同 |
| D-ID | API 文档/开发者 Hub；创建与查询异步任务；有 Delete APIs、`persist` 标志 | 条款要求用户保证拥有素材权利并取得必要同意（§20.2） | 未 `persist` 的 API 数据任务完成后 24 小时内删除；可查询/删除持久数据 | Lite 计划仅非商用；付费计划商用，具体分层见条款 |

本表只记录页面明确写出的内容；“商用许可细节”“口型同步是否单独收费”等未逐条核实的项目标为待核实，不作为选型依据。

## Q-2 真实质量、耗时与成本

**未运行。** 没有四家服务的账号/API Key，也没有已获授权的中英口播+配音成片用于上传。因此以下都没有实测数据：

- 口型准确度、脸部伪影、牙齿/边缘、背景稳定性、首尾同步；
- 分辨率上限、单次时长上限、并发、排队与端到端耗时；
- 真实账单（官方标价不等于含失败重试/下载/存储的总成本）。

可复现的试点方案（F-0040 前必须做）：

1. 选 3 段已授权素材：正面中文口播、正面英文口播、带轻微侧脸/遮挡的失败边界样例；每段 15–30 秒。
2. 每家服务同一素材、同一配音，记录模型/参数/分辨率/时长；
3. 三人盲评 1–5 分（口型、伪影、背景、首尾），并记录失败样例；
4. 记录提交→完成耗时、账单、下载失败/重试次数；
5. 质量门槛建议：口型主观均分 ≥4/5、无严重脸部伪影、背景无可感知变化、首尾误差 ≤1 输出帧；未达门槛不产品化。

费用参考（官方页面，2026-11-17）：

- Sync：`lipsync-2` $0.04–0.05/秒（25fps 等价），`lipsync-2-pro` $0.067–0.083/秒，`sync-3` $0.107–0.133/秒；10 分钟约 $24–30（lipsync-2）。
- Hedra：Avatar 540p 2.5¢/秒、720p 5¢/秒、1080p 6.25¢/秒（10 分钟约 $15/$30/$37.5）。
- HeyGen、D-ID：官方页面价格未在本次抓取中稳定取得，标待核实；第三方汇总称 D-ID 约 $0.59/成品分钟，不能作为官方报价。

## Q-3 异步、取消、幂等、下载失败与删除

| 能力 | Sync | Hedra | HeyGen | D-ID |
|---|---|---|---|---|
| 异步提交/查询 | 是 | 是（`/v3/jobs`） | 是（lipsync_id） | 是 |
| 取消 | 文档有生成状态；取消接口未在本次页面确认 | 未在本次页面确认 | 未在本次页面确认 | 未在本次页面确认 |
| 幂等/重试 | `Idempotency-Key`，7 天保留；重复提交 409 | 未确认 | Idempotency-Key 参数存在 | 未确认 |
| 下载失败 | 需客户端重试/重新查询 | 输出 48 小时内有效 | 下载链接随 ZDR 到期失效 | 未 persist 24 小时删除 |
| 删除 | 账户删除；ZDR 企业合同 | 未在本次页面确认单作业删除 | `DELETE /v3/lipsyncs/{id}` | Delete APIs / persist |

产品必须向用户披露：任务一旦提交到第三方，本地取消只能停止等待；远端是否可取消、样本/成片保留多久取决于服务合同。无法核实远端删除的服务不能宣称“已删除”。

## Q-4 Provider 扩展建议

- `ModelInfo.role` 增加 `lipsync`；`ModelInfo` 声明 `lipsync: { maxDurationSeconds, resolutions, async: true, cancel: boolean, delete: boolean, zdr: boolean }`。
- `Provider` 增加 `submitLipsync` / `pollLipsync` / `cancelLipsync` / `deleteLipsync`（或统一 `lipsync` job 接口）；Host 只接收 `ModelRef` + 资产 ID，不接受任意本地路径。
- 输入：项目视频资产 + 配音资产（来自 F-0037 混音或单条配音）；上传前展示接收方、内容、保留条款；确认后才上传。
- 授权：每次任务必须带本人/说话人授权记录（confirmed、statement、时间、来源），写入产物元数据；Agent/CLI 不得代替确认。
- 产物：`edits.lipsync` 记录服务、模型、任务 ID、输入哈希、输出资产、授权、提交/完成时间、成本估算；原视频不覆盖。
- 失败/不确定：用服务幂等键查询结果；不重复提交；无法查询时标记待确认。

## Q-5 推荐与最小支持矩阵

**推荐：暂不实施 F-0040，先做有条件试点。**

| 优先级 | 服务 | 理由 | 前置 |
|---|---|---|---|
| 1 | Sync.so `lipsync-2` | 协议/幂等/状态/ZDR 文档最完整；按秒成本可控 | 账号、API Key、ZDR 合同（如需） |
| 2 | HeyGen `v3/lipsyncs` | 有删除接口和 ZDR；模式区分 speed/precision | 账号、付费计划、价格核实 |
| 3 | Hedra Avatar | 按分辨率/秒计费，10 分钟长音频支持 | 企业 API 许可（集成到 FlyCut 需订单允许）、48 小时下载窗口 |
| 4 | D-ID | 保留/删除政策清楚 | 商用分层、价格、口型质量待核实 |

费用上限建议：先按 10 分钟成片 ≤$30（Sync lipsync-2 档）做试点预算；超过需维护者确认。质量门槛见 Q-2。若试点不达标，结论为暂不实施，不进入生产协议。

## 未测项与重评条件

- Not run：四家真实上传/生成/下载/删除、质量盲评、耗时、账单、取消。
- 未核实：HeyGen/D-ID 官方单价、各服务取消接口、Sync 商用输出条款细节、Hedra 单作业删除。
- 重评条件：拿到任一服务账号与授权素材；或服务协议/价格发生变更；或维护者决定换成本地方案（则另立调研，不在本报告宣称）。

## 来源

访问日期均为 2026-11-17：

- Sync：https://sync.so/docs/api-reference/api/generate-api/create.mdx、https://sync.so/docs/product/billing、https://sync.so/pricing.md
- Hedra：https://www.hedra.com/develop/models/video/hedra-avatar、https://www.hedra.com/docs/pages/developer/v3/billing、https://www.hedra.com/enterprise-lite-api-terms、https://www.hedra.com/privacy
- HeyGen：https://developers.heygen.com/reference/create-lipsync、https://developers.heygen.com/docs/compliance、https://developers.heygen.com/docs/avatar-consent、https://developers.heygen.com/llms.txt
- D-ID：https://www.d-id.com/privacy-policy/、https://www.d-id.com/pricing/api/、https://www.d-id.com/wp-content/uploads/2024/07/DID-Terms-and-Conditions-20240718-Clean.pdf

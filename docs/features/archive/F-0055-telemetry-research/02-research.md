---
id: F-0055
stage: 02-research
status: approved
approved_by: zhangxiang.chen
approved_at: 2026-11-09
---

# F-0055 崩溃收集与匿名统计调研：调研报告

## 结论摘要

**建议本轮只做本地诊断导出，不做远程遥测。** 默认不安装任何遥测 SDK、不自动上传崩溃或使用事件；先把崩溃、导入、ASR、导出失败变成可复现的本地结构化诊断包，由用户主动预览、导出并决定是否发给维护者。远程崩溃报告和匿名使用统计各自另立需求，经过显式同意、字段评审和至少一个版本的本地证据后再决定。

许可证方面，已核实 Sentry 主仓库为 `FSL-1.1-Apache-2.0`、GlitchTip 为 MIT、PostHog 核心为 MIT 且 `ee/` 为独立企业许可、Aptabase 服务端为 AGPL-3.0 且 SDK 为 MIT、OpenTelemetry 为 Apache-2.0、Umami 为 MIT、Plausible 为 AGPL-3.0。Sentry 的 Rust SDK 是 MIT；活跃的 Tauri 社区插件 `timfish/sentry-tauri` 没有声明许可证，不能直接采用。

结论可信度：许可证和公开文档为高；价格、配额和地区为公开页面快照，可能变化；接入工作量为工程估算，未做真实集成或压力测试。

## 要回答的问题

来自 [01-spec.md](./01-spec.md)：

1. **Q-1**：需要回答哪些可行动的问题（激活、导出失败、崩溃）？不收集数据、本地导出诊断、自愿远程上传三种方案的收益和成本是什么？
2. **Q-2**：拟收集字段是否可能包含字幕、媒体、文件路径、API Key、token 或可关联身份？逐字段最小化、脱敏和保留期限如何制定？
3. **Q-3**：哪些开源或托管方案可用，许可、部署、费用、地区和数据控制条件如何？
4. **Q-4**：首次同意、拒绝、撤回、查看/导出/删除数据与离线时的行为怎么设计；不接受统计是否完整保留核心功能？
5. **Q-5**：给出做/不做建议和显式同意文案草案。

## 评估标准

| 标准 | 说明 |
|---|---|
| 许可证与合规 | 是否允许闭源桌面应用使用；是否要求公开修改；是否有竞争使用限制；是否适合再分发 |
| 数据控制 | 数据存在哪里；能否自托管；能否选择 US/EU 区域；服务商是否仍会在其他地区保存账号、项目元数据或支持数据 |
| Tauri/桌面适配 | 是否覆盖 Rust 原生崩溃、WebView 崩溃、前端错误；是否有维护中的 Tauri 集成；是否需要额外 crash reporter 进程 |
| 字段最小化 | 默认采集什么；能否关闭自动采集、会话回放、截图、附件和用户身份；是否支持发送前清洗 |
| 成本 | 许可费、托管费、基础设施、运维人力；免费额度是否足够 |
| 接入与运维 | 首次接入、升级、备份、保留期、告警和故障排查成本 |
| 退出能力 | 用户能否拒绝、撤回、查看、导出、删除；离线时是否阻塞核心功能 |

## 候选方案

### 方案总表

| 方案 | 部署 | 许可证 | 数据控制/地区 | 费用（公开页面快照） | 接入与运维 | 主要采集内容 | Tauri/桌面适配 | 判断 |
|---|---|---|---|---|---|---|---|---|
| Sentry SaaS | 托管 | 服务条款；客户端 SDK 许可证另计 | 组织创建时选 US 或 EU；账号、项目元数据等部分信息仍可能存 US | 免费 5k errors/月；Team 约 $26/月；Business 约 $80/月 | 低到中；托管运维 | 错误、堆栈、breadcrumbs、设备/OS、release；可关闭 PII、附件、回放 | Rust SDK 可用；未找到官方 Tauri 专用指南（该 URL 404）；社区 Tauri 插件许可证待核实 | 适合作为未来“仅崩溃”候选，但不建议本轮接入 |
| Sentry 自托管 | Docker Compose 自建 | `FSL-1.1-Apache-2.0`，限制 Competing Use，两年后转 Apache-2.0 | 完全自控；地区由部署位置决定 | 无许可费；最低 4 CPU、16 GB RAM + 16 GB swap、20 GB 磁盘 | 高；数据库、消息队列、升级、备份、磁盘 I/O 都要自己维护 | 同 Sentry，功能接近 Business，但无 SaaS 计费/部分 AI 功能 | 同 Sentry SDK；运维负担对单人维护者过重 | 不建议本轮采用 |
| GlitchTip | 托管或自托管 | MIT | 托管提供 US 和 EU（德国）；自托管完全自控 | 免费 1k events/月、30 天保留；Small 约 $15/月/100k、90 天；Medium $50/月/500k；Large $250/月/3M | 托管低；自托管中低，推荐 512 MB RAM，最低 256 MB，PostgreSQL 14+ | 错误和性能事件；以 Sentry SDK/DSN 协议接入，具体 SDK/功能覆盖需做兼容性验证 | 理论上可用 Sentry SDK；未验证 Tauri 原生崩溃与 minidump 覆盖 | 自托管数据控制最好的开源候选；本轮不接入 |
| PostHog | 托管或自托管 | 核心 MIT；`ee/` 为企业许可 | Cloud 有 US/EU；自托管完全自控 | Cloud 免费 1M events/月；付费按用量；自托管基础设施自付 | 中到高；自托管官方明确“不支持”，付费功能仅 Cloud | 产品分析、Feature Flags、Session Replay、Error Tracking 等；默认能力很宽，必须逐项关闭 | JS SDK 可跑在 WebView；不覆盖 Rust 原生崩溃；对本项目过重 | 不建议用于崩溃；若未来做产品分析再单独评估 |
| Aptabase | 托管或自托管 | 服务端 AGPL-3.0；SDK MIT | 隐私优先、无唯一标识；Cloud 地区待核实；自托管完全自控 | 免费 20k events/月；从 $10/月起；无 overage，超限暂停 | 低；Tauri 插件由 Aptabase 维护 | 事件、OS、应用版本等；不自动跟踪，需手动 `trackEvent`；有 beta 错误上报 | 官方 Tauri 插件，桌面适配好；但主要是产品分析，不做原生崩溃/minidump | 若未来只做“无标识使用统计”，这是首选候选；本轮不接入 |
| OpenTelemetry | 库/规范，需自选后端 | Apache-2.0 | 后端决定；可自托管或任意厂商 | 软件免费；后端和运维另计 | 高；需要 Collector、存储、查询和告警 | Traces、metrics、logs，取决于 instrumentation | Rust/JS SDK 可用；不提供开箱即用的桌面崩溃收集 | 适合作为内部数据模型参考，不适合本轮直接落地 |
| Umami | 自托管或 Cloud | MIT | 自托管自控；Cloud 地区和价格待核实 | 自托管基础设施自付；Cloud 价格未核实 | 低到中 | 网页 pageview、来源、粗粒度设备/浏览器 | 面向网站；没有原生桌面崩溃 SDK；只能自定义 HTTP 事件 | 不适合崩溃；桌面使用统计也不如 Aptabase |
| Plausible | 自托管或 Cloud | AGPL-3.0 | 自托管自控；Cloud 地区和价格待核实 | Cloud 约 $9/月起（10k pageviews 档，页面快照）；自托管免费 | 低到中 | 网页 pageview、来源、目标事件；轻量、无 cookie 默认 | 面向网站；没有原生桌面崩溃 SDK | 不适合崩溃；不作为桌面遥测首选 |
| 本地诊断包（自建） | 纯本地 | 无第三方许可 | 完全在本机；默认不出网 | 无服务费；开发与支持成本 | 中；panic hook、结构化日志、清洗、UI、测试 | 由 allowlist 定义的应用版本、OS、错误码、耗时区间、脱敏堆栈 | 最贴合 Tauri；可同时覆盖 Rust panic、WebView 错误和导出失败 | **本轮推荐** |

> 费用均为 2026-11-09 访问公开页面时的快照，可能随套餐、年付/月付、地区和汇率变化；接入工作量为工程估算，未实测。

### 许可证核实记录

| 项目 | 核实结果 | 证据 |
|---|---|---|
| Sentry 主仓库 | `FSL-1.1-Apache-2.0`；Permitted Purpose 排除 Competing Use；约两年后转 Apache-2.0 | [LICENSE.md](https://github.com/getsentry/sentry/blob/master/LICENSE.md) |
| Sentry Rust SDK | MIT | [sentry-rust LICENSE](https://github.com/getsentry/sentry-rust/blob/master/LICENSE) |
| GlitchTip | MIT | [glitchtip-backend LICENSE](https://gitlab.com/glitchtip/glitchtip-backend/-/raw/master/LICENSE) |
| PostHog 核心 | MIT Expat；`ee/` 目录为企业许可 | [LICENSE](https://github.com/PostHog/posthog/blob/master/LICENSE)、[ee/LICENSE](https://github.com/PostHog/posthog/blob/master/ee/LICENSE) |
| Aptabase 服务端 | AGPL-3.0 | [LICENSE](https://github.com/aptabase/aptabase/blob/main/LICENSE) |
| Aptabase SDK | MIT；README 明确隐私优先、无唯一标识、提供 Tauri SDK | [README](https://github.com/aptabase/aptabase/blob/main/README.md) |
| OpenTelemetry | Apache-2.0 | [LICENSE](https://github.com/open-telemetry/opentelemetry-specification/blob/main/LICENSE) |
| Umami | MIT | [LICENSE](https://github.com/umami-software/umami/blob/master/LICENSE) |
| Plausible | AGPL-3.0 | [LICENSE.md](https://github.com/plausible/analytics/blob/master/LICENSE.md) |
| `timfish/sentry-tauri` | **未声明许可证**：GitHub API `license=null`，仓库内 `LICENSE` 404；虽然活跃（2026-11-04 仍有提交），但不能直接用于产品 | [仓库](https://github.com/timfish/sentry-tauri) |

## Q-1：可行动的问题与三种方案

### 需要回答的问题

优先级从高到低：

1. **崩溃是否可定位、可复现、可恢复**：启动、导入、ASR、字幕编辑、导出五个阶段中，哪一步崩溃；是 Rust 原生 panic、WebView 崩溃还是前端异常；是否发生在特定 OS/架构/应用版本；崩溃后用户能否重试或恢复项目。
2. **导出失败发生在哪一步**：读取源文件、时间映射、FFmpeg、字幕序列化、写目标文件，哪一步失败；失败码是什么；是否与格式（MP4/SRT/JSON）、分辨率、时长区间或磁盘空间有关。
3. **激活漏斗是否走通**：启动 → 导入成功 → ASR 完成 → 首次字幕编辑 → 首次成功导出。以“会话”为单位统计，不做用户级 cohort。
4. **性能是否造成放弃**：ASR、导出、打开项目的耗时区间；只记录分桶，不记录内容或文件名。
5. **环境差异**：OS 家族/主版本、CPU 架构、应用版本、构建渠道、WebView 主版本；用于复现，不用于识别个人。

**不需要回答、也不应收集的问题**：用户是谁、项目叫什么、字幕内容是什么、用了哪个文件、用了哪个模型或 Provider、API Key 是否有效、用户是否安装了某个软件、用户的完整使用轨迹。

### 三种方案

| 方案 | 收益 | 成本/风险 | 适用条件 |
|---|---|---|---|
| A. 不收集 | 零隐私、零运维、零同意负担 | 维护者继续“盲修”；崩溃和导出失败只能靠用户口头描述；无法判断优先级 | 只适合作为基线，不建议长期停留 |
| B. 本地诊断导出 | 用户可主动提供可复现的版本、环境、错误码、脱敏堆栈；无网络、无第三方、无账号；可做字段预览和删除 | 需要开发 panic hook、结构化日志、清洗器、诊断 UI；需要用户愿意导出；无法得到全局激活率 | **本轮推荐**；先做 1–2 个版本积累证据 |
| C. 自愿远程上传 | 维护者能被动收到崩溃；可做会话级漏斗和崩溃率；响应更快 | 需要同意 UI、字段评审、服务端、保留期、删除流程、地区/合规说明；仍有内容泄漏和误采集风险；免费额度/服务条款可能变化 | 只有本地证据证明“必须远程才能定位”时才做；先只做崩溃，不做使用统计 |

**结论**：先做 B。C 的收益主要是维护者便利，成本却是长期的隐私和运维承诺；在当前“单人维护、桌面端优先、内容高度敏感”的背景下，证据不足以支持默认开启 C。

## Q-2：字段级数据清单与最小化

### 允许的字段（allowlist）

只允许下表中的字段进入结构化诊断；序列化器采用 allowlist，未知字段直接丢弃，不靠“记得删除”。

| 字段 | 本地诊断 | 远程（若未来批准） | 用途 | 最小化/保留 |
|---|---|---|---|---|
| `schema_version` | 是 | 是 | 兼容字段演进 | 整数；随报告保留 |
| `event_name` | 是 | 是 | 固定枚举：`app_started`、`import_failed`、`asr_failed`、`export_failed`、`crash` 等 | 枚举；禁止自由文本 |
| `app_version` | 是 | 是 | 复现版本 | 语义版本号 |
| `build_channel` | 是 | 是 | 区分 dev/beta/stable | 枚举 |
| `os_family` | 是 | 是 | 复现平台 | `macos`/`windows`/`linux` 等枚举 |
| `os_version_major` | 是 | 是 | 复现系统代际 | 只保留主版本，如 `14` |
| `arch` | 是 | 是 | 复现架构 | `arm64`/`x86_64` 等枚举 |
| `locale_language` | 是 | 是 | 判断中文/英文界面差异 | 只保留语言，如 `zh`/`en`，不保留地区 |
| `feature_area` | 是 | 是 | 定位模块 | `import`/`asr`/`edit`/`export`/`settings` 等枚举 |
| `result` | 是 | 是 | 成功/失败/取消 | 枚举 |
| `error_code` | 是 | 是 | 稳定错误分类 | 固定枚举；禁止把异常 message 直接当错误码 |
| `duration_bucket` | 是 | 是 | 性能分桶 | `<1s`、`1–5s`、`5–30s`、`30–120s`、`>120s`；不记录精确耗时 |
| `crash_signature` | 是 | 是 | 聚合同类崩溃 | 规范化堆栈的哈希；不含路径和参数 |
| `stack_frames` | 是 | 是，脱敏后 | 定位崩溃 | 只保留模块/函数/行号；路径替换为 `<app>`/`<lib>`；不含参数、环境变量、URL |
| `webview_major` | 是 | 是 | WebView 兼容性 | 只保留主版本 |
| `tauri_version` | 是 | 是 | 框架兼容性 | 语义版本号 |
| `session_nonce` | 是 | 是，可选 | 计算会话级漏斗/崩溃率 | 每次启动随机生成，仅内存保存，退出即丢弃；不写磁盘、不跨会话关联 |
| `report_id` | 是 | 是 | 用户查看/删除单份报告 | 每份报告随机 UUID；不是安装 ID，不跨报告复用 |
| `timestamp_hour` | 是 | 是 | 按小时聚合 | 只保留小时，不保留精确秒和时区 |

### 明确禁止的字段

以下内容不得进入本地诊断包，也不得进入任何远程事件：

- 字幕文本、逐字稿、ASR 中间结果、翻译文本、提示词、模型输出。
- 视频、音频、封面、缩略图、帧、屏幕截图、录屏、剪贴板内容。
- 文件名、文件路径、目录名、最近打开列表、项目名称、工程 ID。
- API Key、token、cookie、Authorization header、Provider 端点、账号、邮箱、手机号。
- 稳定用户标识：账号 ID、安装 ID、设备指纹、广告 ID、MAC 地址、机器 hostname、OS 用户名、硬件序列号。
- IP 地址；服务端如无法关闭，必须在入库前丢弃，不能写入事件属性。
- 窗口标题、完整 URL、URL query、referrer、浏览器 localStorage、IndexedDB 内容。
- 自由文本错误 message、panic message、命令行参数、环境变量；这些可能夹带路径、项目名或密钥。
- GPU/驱动明细、已安装软件列表、网络名称等可用于指纹化的高熵环境信息。

### 脱敏与发送前检查

1. **捕获层**：Rust panic hook、前端 `window.onerror`/`unhandledrejection`、导入/ASR/导出边界只写结构化字段，不写原始异常字符串。
2. **清洗层**：对堆栈做路径归一化；把用户目录、临时目录、项目目录替换为 `<path>`；去掉 URL query、token 形态字符串、长十六进制串；限制堆栈深度和字段长度。
3. **发送层**：远程 SDK 若使用 Sentry，设置 `send_default_pii=false`，关闭 attachments、screenshots、session replay、automatic breadcrumbs 中的 URL/窗口标题；`before_send` 再按 allowlist 重建事件，未知字段丢弃。
4. **预览层**：本地导出前显示 JSON 预览和字段说明；用户可取消。远程发送前在“诊断”页展示最近报告和字段清单。
5. **测试**：用构造的假数据（含伪路径、伪 token、伪字幕）做单元测试，断言导出 JSON 中不出现这些值；不把真实用户素材放进测试。

### 保留期限

| 数据 | 位置 | 保留 |
|---|---|---|
| 结构化崩溃/失败报告 | 本机应用数据目录 | 7 天，最多 10 份或 50 MB，先到先删 |
| 原始应用日志 | 本机应用数据目录 | 3 天，最多 20 MB；默认不进入导出包 |
| 用户主动导出的诊断包 | 用户选择的位置 | 由用户管理；应用不自动删除，导出时提示可能含环境信息 |
| 远程崩溃报告（若未来批准） | 选定服务商/自托管 | 30 天；到期自动删除 |
| 远程使用统计聚合（若未来批准） | 选定服务商/自托管 | 90 天；只保留聚合计数，不保留逐事件原始记录 |
| 同意记录 | 本机 | 直到用户撤回或卸载；不上传 |

### 无稳定标识的代价

没有安装 ID、账号 ID 或设备指纹，就不能可靠计算 DAU、留存、独立用户转化，也不能按“某个用户”删除历史远程数据。报告明确接受这个限制：

- 激活只做**会话级**漏斗，不做用户级 cohort。
- 崩溃率只做**会话级**崩溃/失败比例，不做“受影响用户数”。
- 远程删除只支持按 `report_id` 或时间窗口删除；不承诺“删除某个人的全部数据”。
- 如果未来产品确实需要留存分析，必须另立需求，重新评审稳定标识、告知和删除方案，不能在本需求里顺手加。

## Q-3：方案调研与适用边界

### Sentry

**SaaS**：托管，组织创建时可选 US 或 EU 数据存储；官方明确说明，即使选 EU，账号、通知设置、2FA、组织集成元数据、访问 token、项目元数据、详细用量、SSO/SAML/SCIM 元数据等仍可能存 US，支持工单数据也存 US。价格页面快照：免费 5k errors/月，Team 约 $26/月，Business 约 $80/月。适合“未来只做崩溃、且接受托管”的候选，但必须接受上述元数据地区差异。

**自托管**：Docker Compose；官方最低 4 CPU、16 GB RAM + 16 GB swap、20 GB 磁盘，推荐 32 GB RAM；依赖 ClickHouse、Kafka 等，磁盘 I/O 敏感；官方明确“no guarantees or dedicated support”。许可证是 FSL-1.1-Apache-2.0，限制 Competing Use，两年后转 Apache-2.0。对单人维护者，基础设施和升级成本明显高于收益。

**Tauri 集成**：Sentry Rust SDK 是 MIT，`sentry-panic` 可捕获 panic；但官方 Tauri 专用指南 URL 在当前访问返回 404。社区 `timfish/sentry-tauri` 活跃、功能覆盖 Rust/WebView/minidump，但仓库没有许可证文件，GitHub API 也显示 `license=null`，**不能直接采用**。若未来用 Sentry，优先直接用 `sentry` Rust SDK + 前端 SDK，分别初始化，避免无许可证插件。

### GlitchTip

MIT；可托管或自托管。托管页面快照：免费 1k events/月、30 天保留；Small $15/月 100k、90 天；Medium $50/月 500k；Large $250/月 3M；提供 US 和 EU（德国）托管。自托管推荐 512 MB RAM，最低 256 MB；PostgreSQL 14+，Valkey/Redis 可选；Docker Compose 即可，明显比 Sentry 自托管轻。官方文档列有 SDK integration，通常以 Sentry SDK/DSN 接入，但具体 Tauri 原生崩溃、minidump、WebView 崩溃的覆盖需要在选型时做兼容性验证，本报告未做。

**判断**：如果未来坚持“开源 + 自托管 + 数据完全自控”，GlitchTip 是最现实的候选；但本轮不接入。

### PostHog

核心代码 MIT，`ee/` 目录为企业许可；Cloud 有 US/EU 区域，免费 1M events/月，付费按用量；自托管 Docker Compose 是 MIT，但官方明确“self-hosted deployments are officially unsupported”，付费功能仅 Cloud，推荐 4 vCPU、16 GB RAM、30 GB 存储。功能覆盖产品分析、Feature Flags、Session Replay、Error Tracking 等，默认能力很宽，必须关闭 autocapture、session replay、person profiles 等。对本项目来说，崩溃收集不是它的强项，产品分析又过重；不建议用于本轮。

### Aptabase

服务端 AGPL-3.0，SDK MIT；README 明确“Privacy-First”、不使用唯一标识、监控 sessions，提供 Tauri 插件。Cloud 免费 20k events/月，从 $10/月起，无 overage，超限暂停；自托管免费但自己维护。Tauri 插件需要手动 `trackEvent`，不会自动采集；有 beta 的 `track_error`/`trackError`，但不是原生崩溃/minidump 收集。Cloud 数据地区和托管细节本轮未核实。

**判断**：如果未来只做“不含稳定标识的使用统计”，Aptabase 是首选候选；它不适合替代崩溃收集。

### OpenTelemetry

Apache-2.0，厂商中立；本身是 API/SDK/协议，不是托管后端。要用起来必须选 Collector、存储、查询和告警，成本和地区由后端决定。Rust/JS instrumentation 可以做 traces/metrics/logs，但不提供开箱即用的桌面崩溃收集。适合作为内部事件 schema 和未来迁移的参考，不适合本轮直接落地。

### Umami / Plausible

Umami MIT；Plausible AGPL-3.0。两者都是轻量网站分析，核心是 pageview、来源、目标事件，默认没有原生桌面崩溃 SDK；在 Tauri 里只能通过自定义 HTTP 事件模拟，无法捕获 Rust panic 或 WebView 崩溃。自托管免费，Cloud 价格/地区本轮只核实了 Plausible 约 $9/月起（10k pageviews 档），其余待核实。两者都不适合作为本项目的崩溃或桌面遥测方案。

### Tauri 崩溃收集的三条路

| 路径 | 优点 | 缺点 | 本轮建议 |
|---|---|---|---|
| Sentry Tauri 社区插件 | 现成集成 Rust/WebView/minidump、breadcrumbs | 无许可证；依赖第三方维护；默认采集面较宽，需要大量关闭 | 不采用 |
| Sentry Rust SDK + 前端 SDK | SDK MIT；成熟；可分别控制 Rust/浏览器；可接 SaaS 或自托管 | 需要自己处理 Tauri 生命周期、符号化、minidump 进程；官方无 Tauri 指南 | 仅作为未来远程候选 |
| 自定义 panic hook + 本地诊断包 | 无第三方、无网络、字段完全可控；最贴合“本地优先” | 需要自己写捕获、清洗、UI、测试；没有服务端聚合 | **本轮采用** |

自定义方案的技术边界：Rust 用 `std::panic::set_hook` 捕获 panic 并 `Backtrace::force_capture`；前端监听 `error`/`unhandledrejection`；导入/ASR/导出边界写结构化错误码；报告写入应用数据目录，设置页提供列表、预览、导出、删除。不要捕获 panic message 原文，不要把 `Backtrace` 直接序列化为字符串；先转成帧数组并清洗。

## Q-4：同意、拒绝、撤回、查看/导出/删除与离线

### 默认状态

- 远程崩溃报告：**默认关闭**。
- 远程使用统计：**默认关闭**。
- 本地结构化诊断：默认开启，仅保存在本机，7 天/10 份/50 MB 上限；设置页可见、可关闭、可清空。
- 首次启动不弹同意墙；在“设置 > 隐私与诊断”里提供说明和开关。

### 首次同意

1. 用户进入“设置 > 隐私与诊断”，看到两个独立开关："发送崩溃报告"、"发送不含稳定标识的使用统计"。
2. 两个开关都默认关闭，不预勾选，不捆绑；打开任一项时展示同意卡片。
3. 同意卡片列出：接收方、服务器地区、字段清单、保留期、撤回方式、查看/导出方式、隐私政策链接。
4. 用户必须主动确认；仅打开开关不算同意，需点“我同意并开启”。
5. 同意记录只存本机，包含时间、版本、两项各自的选择；不上传。

### 拒绝

- 拒绝后不发送任何网络请求；不反复弹窗；核心功能完整可用。
- 可以在设置里再次打开，但不会自动开启。
- 拒绝不影响本地诊断；用户仍可主动导出诊断包发给维护者。

### 撤回

- 关闭开关立即生效；下一次启动不再初始化远程发送。
- 清空尚未发送的队列；已发送事件按保留期自然过期。
- 提供“撤回并删除已发送数据”入口：用户可复制 `report_id` 列表，或按时间窗口提交删除请求；没有 `report_id` 的历史数据无法定位到个人，只能等自动过期。

### 查看/导出

- “诊断”页列出本地报告：时间、事件类型、应用版本、大小；可预览 JSON。
- “导出诊断包”生成 ZIP，包含结构化报告和可选日志；导出前显示字段说明和脱敏预览。
- 远程发送后，本地保留一份“已发送记录”：`report_id`、时间、字段清单、接收方；不保留服务端返回的敏感信息。

### 删除

- 本地：单份删除、全部删除、关闭本地诊断并清空；立即生效。
- 远程：按 `report_id` 删除；或按时间窗口删除；服务端保留期到期自动删除。
- 因为不收集稳定标识，不提供“按账号删除全部数据”；这一点必须在同意卡片里说清楚，避免过度承诺。

### 离线

- 本地诊断完全离线可用。
- 远程发送队列上限：20 条或 1 MB，保留 7 天；离线时不阻塞、不无限重试、不后台唤醒。
- 恢复网络后只在用户已同意且应用在前台时发送；发送失败按指数退避，达到上限后丢弃并记录本地计数。
- 离线或服务不可用不影响导入、ASR、编辑、导出。

### 核心功能

所有功能在“两项远程都拒绝 + 完全离线”时保持可用；不得出现“开启统计才能导出”“崩溃报告才能使用云端 ASR”等门控。ASR Provider、模型下载、项目打开、导出都不依赖遥测端点。

## Q-5：做/不做建议

### 做

1. **做本地诊断导出**（另立实现需求）：Rust panic hook、前端错误捕获、结构化错误码、字段 allowlist、脱敏、7 天/10 份/50 MB 保留、设置页预览/导出/删除。
2. **做错误分类**：导入、ASR、时间映射、FFmpeg、字幕序列化、写文件各自有稳定错误码；这是本地诊断和未来任何远程方案的基础。
3. **做隐私说明**：在设置页写清楚本地诊断存什么、存多久、如何删除；远程开关默认关闭。
4. **做假数据测试**：用伪路径、伪 token、伪字幕验证导出包不含禁止字段。

### 不做

1. **本轮不安装 Sentry/GlitchTip/PostHog/Aptabase/Umami/Plausible/OpenTelemetry SDK**，不创建远程项目，不发送真实事件。
2. **不使用 `timfish/sentry-tauri`**，除非维护者先补齐许可证并获得法律确认；当前无许可证是硬阻断。
3. **不收集稳定用户标识**，不做用户级留存/DAU，不做设备指纹。
4. **不采集字幕、媒体、文件路径、项目名、API Key、token、窗口标题、完整 URL、截图、录屏、剪贴板**。
5. **不做自动上传**；崩溃后默认只写本地，不弹强制同意。
6. **不把遥测作为功能门禁**。

### 何时重评远程

满足以下任一条件，才另立需求评估远程：

- 连续两个版本、至少 10 份本地诊断显示同类崩溃/导出失败，且本地日志无法定位；
- 用户主动反馈中同类问题重复出现，维护者无法靠现有信息复现；
- 本地诊断导出完成率很低，且维护者确实需要被动收集才能修复关键问题。

重评时先做“仅崩溃、默认关闭、显式同意”的最小版本；使用统计再单独评审。优先候选：Sentry SaaS EU（运维最低）或 GlitchTip（MIT、可自托管、数据控制最好）；Aptabase 只用于无标识使用统计；PostHog/Umami/Plausible/OpenTelemetry 不作为本轮崩溃方案。

### 同意文案草案

**标题**：帮助改进 FlyCut（可选）

**说明**：

> FlyCut 默认只在本机保存诊断信息，不会自动上传。你可以分别选择是否发送崩溃报告、是否发送不含稳定标识的使用统计。两项都不影响任何功能。

**崩溃报告（可选，默认关闭）**：

> 发送崩溃发生时的应用版本、操作系统、CPU 架构、功能区域、错误码、脱敏后的错误堆栈和报告时间（精确到小时）。不会发送字幕、视频/音频、文件名或路径、项目名称、API Key、token、账号信息，也不会生成安装 ID 或设备指纹。接收方：[服务商/自托管地址]；存储地区：[US/EU/自托管]；保留 30 天。你可以随时在“设置 > 隐私与诊断”关闭；关闭后不再发送，未发送的队列会删除。发送前可在“诊断”页查看字段并导出。

**不含稳定标识的使用统计（可选，默认关闭）**：

> 发送功能区域、成功/失败、耗时区间、应用版本、OS 家族/主版本、语言。不会发送任何字幕、媒体、文件路径、项目名称、API Key、token 或稳定用户标识。接收方：[服务商/自托管地址]；存储地区：[US/EU/自托管]；保留 90 天，只保留聚合计数。你可以随时关闭；关闭后不再发送。

**按钮**：`暂不发送`（默认） / `我同意并开启`

**短版（设置页开关旁）**：

> 可选，默认关闭。只发送字段清单中的诊断信息，不发送字幕、媒体、路径、项目名、密钥或稳定标识。关闭后立即停止，未发送数据会删除。不影响任何功能。

## 实验与验证

本轮没有安装 SDK、没有创建远程项目、没有发送真实遥测。验证方式是只读访问官方仓库和文档：

- 读取 Sentry、GlitchTip、PostHog、Aptabase、OpenTelemetry、Umami、Plausible 的 LICENSE 文件，确认 SPDX 标识和例外条款。
- 读取 Sentry 自托管要求、Sentry 数据地区说明、Sentry/GlitchTip/PostHog/Aptabase 价格页。
- 读取 Aptabase Tauri 插件 README，确认手动 `trackEvent`、Tauri 支持和 beta 错误上报。
- 读取 Sentry Rust SDK README，确认 `sentry-panic` 存在；读取 `std::panic::set_hook` 作为本地方案依据。
- 检查 `timfish/sentry-tauri` 的 GitHub API 元数据和 LICENSE 路径，确认无许可证。

**未运行**：任何 SDK 集成、Tauri 构建、崩溃注入、网络抓包、负载/性能测试、跨平台验证、法律意见。

## 证据与访问记录

访问日期均为 **2026-11-09**。价格和配额是当日公开页面快照，不是合同报价。

| 资料 | URL | 用途 | 状态 |
|---|---|---|---|
| Sentry LICENSE | https://github.com/getsentry/sentry/blob/master/LICENSE.md | FSL-1.1-Apache-2.0、Competing Use、两年转 Apache | 已核实 |
| Sentry 自托管文档 | https://develop.sentry.dev/self-hosted/ | Docker、最低配置、无保证支持、自托管监控 | 已核实 |
| Sentry 价格 | https://sentry.io/pricing/ | 免费 5k errors、Team $26、Business $80 | 已核实（页面快照） |
| Sentry 数据地区 | https://docs.sentry.io/organization/data-storage-location/ | US/EU 选择；部分元数据仍存 US | 已核实 |
| Sentry Rust SDK | https://github.com/getsentry/sentry-rust | MIT；`sentry-panic` | 已核实 |
| Sentry Tauri 指南 | https://docs.sentry.io/platforms/javascript/guides/tauri/ | 检查官方 Tauri 专用指南 | 404，未找到 |
| `timfish/sentry-tauri` | https://github.com/timfish/sentry-tauri | 社区插件；Rust/WebView/minidump | 活跃，但无许可证 |
| GlitchTip LICENSE | https://gitlab.com/glitchtip/glitchtip-backend/-/raw/master/LICENSE | MIT | 已核实 |
| GlitchTip 价格 | https://glitchtip.com/pricing/ | 免费 1k/30 天；$15/100k/90 天；US/EU | 已核实（页面快照） |
| GlitchTip 安装 | https://glitchtip.com/documentation/install | Docker、512 MB 推荐、PostgreSQL 14+ | 已核实 |
| PostHog LICENSE | https://github.com/PostHog/posthog/blob/master/LICENSE | 核心 MIT | 已核实 |
| PostHog ee LICENSE | https://github.com/PostHog/posthog/blob/master/ee/LICENSE | 企业许可 | 已核实 |
| PostHog 价格 | https://posthog.com/pricing | 1M events/月免费、US/EU、按用量 | 已核实（页面快照） |
| PostHog 自托管 | https://posthog.com/docs/self-host | 官方不支持、Docker、4 vCPU/16 GB/30 GB | 已核实 |
| Aptabase LICENSE | https://github.com/aptabase/aptabase/blob/main/LICENSE | AGPL-3.0 | 已核实 |
| Aptabase README | https://github.com/aptabase/aptabase/blob/main/README.md | 隐私优先、无唯一标识、Tauri SDK | 已核实 |
| Aptabase Tauri 插件 | https://github.com/aptabase/tauri-plugin-aptabase | 手动 `trackEvent`、beta 错误上报 | 已核实 |
| Aptabase 价格 | https://aptabase.com/pricing | 20k events 免费、$10/月起 | 已核实（页面快照） |
| OpenTelemetry LICENSE | https://github.com/open-telemetry/opentelemetry-specification/blob/main/LICENSE | Apache-2.0 | 已核实 |
| Umami LICENSE | https://github.com/umami-software/umami/blob/master/LICENSE | MIT | 已核实 |
| Plausible LICENSE | https://github.com/plausible/analytics/blob/master/LICENSE.md | AGPL-3.0 | 已核实 |
| Plausible 价格 | https://plausible.io/#pricing | $9/月起（10k pageviews 档） | 已核实（页面快照） |
| Rust panic hook | https://doc.rust-lang.org/std/panic/fn.set_hook.html | 自定义 panic hook 依据 | 已核实 |

## 待核实事项

- GlitchTip 对 Tauri 原生崩溃、minidump、WebView 崩溃的具体覆盖；Sentry SDK/DSN 兼容矩阵需要在选型时做一次真实集成验证。
- PostHog 自托管的功能边界、升级路径和停更风险；本报告只核实了许可证和官方“不支持”声明。
- Aptabase Cloud 的数据存储地区、备份、删除接口和自托管升级成本。
- Umami/Plausible 的 Cloud 地区、完整价格和桌面事件 API 限制；本报告只核实了许可证和基础定位。
- OpenTelemetry 的后端选型、存储成本、采样和保留策略。
- Sentry SaaS 的最终合同条款、DPA、子处理者、数据地区变更政策；本报告只读了公开文档。
- `timfish/sentry-tauri` 的许可证归属和维护者意图；在补齐许可证前不进入任何实现。
- FSL 的 Competing Use 是否覆盖本项目自托管场景；需要法律确认，本报告不提供法律意见。
- 所有工作量估算和性能影响均未实测。

## 对后续需求的影响

- **F-0055 本身**：完成调研报告，不进入实现；由维护者确认后再归档。
- **新增候选需求**："本地崩溃诊断与导出"，范围是 panic hook、结构化错误码、脱敏、诊断页、保留期、测试；不包含任何远程上传。
- **远程崩溃报告**：只有在满足“何时重评远程”的条件后另立需求；需要 ADR 记录服务商、地区、字段、保留期和删除方案。
- **使用统计**：与崩溃报告分开评审；Aptabase 是首选候选，但不得复用崩溃需求的同意。
- **Epic E-08**：本报告不改变既有路线图顺序；只回填“本地诊断优先、远程暂缓”的结论。

## 最终状态

- 阶段：`02-research`
- 结论：**做本地诊断导出；不做远程遥测；默认不安装 SDK、不上传真实数据。**
- 待维护者确认：报告结论、字段清单、同意文案和后续需求拆分。

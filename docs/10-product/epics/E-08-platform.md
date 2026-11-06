---
id: E-08
status: approved
priority: 持续
depends_on: []
approved_by: zhangxiang.chen
approved_at: 2026-11-05
---

# E-08 平台与接入

## 要解决的问题

支撑其他 Epic 的平台能力：外部 Agent 调用、TTS 等新 Provider 能力、桌面端的分发、更新和问题收集、Web 端连接远程 Host。Web 要和桌面端功能对齐（见 [vision.md](../vision.md#平台)），识别和导出都依赖 Host。MCP / CLI 同时是获客渠道（见 [vision.md](../vision.md#获客方式与途径)）。

## 现状（2026-11-05）

- **Host 鉴权只有一个共享 token。** 网关校验 `Bearer <token>`；Host 托管前端页面时会把 token 交给能打开页面的人，所以非本机监听时 `server/main.ts` 会警告必须挡一层带鉴权的反向代理。适合单用户，不适合多人共用。
- **AI 模型设置（含 API Key）存在前端。** 在 `appStore.aiModels`（浏览器本地存储），每次纠错、翻译时由前端传给 Host。CLI / MCP 没有前端，拿不到这些设置；换设备也不会同步。
- **安装包没有签名和公证，也没有自动更新。** `release.yml` 里没有 macOS 公证、Windows 代码签名，没有 Tauri updater 插件。macOS 用户第一次打开会被系统拦住。

## 做完是什么样

- 外部 Agent 能通过 MCP / CLI 创建项目、转写、获取建议、导出。
- AI 模型设置由 Host 保存，前端、CLI、MCP 用同一份。
- Provider 体系支持 TTS（含声音克隆能力声明）。
- 桌面端安装包已签名和公证，能自动更新，崩溃和错误能被收集（用户同意后）。
- Web 端连接 FlyCut Cloud 托管的 Host 后，能完成和桌面端相同的流程。

## 设计要点

- **Web 端连接的远程 Host 由 FlyCut Cloud 托管。** 多用户、账号、鉴权、计费属于 Cloud，不在本仓库。本仓库只做客户端一侧（连接、上传、重连），并保证 Host 能在 Cloud 的鉴权层后面运行。高级用户自己部署是次要场景：提供单用户运行方式和「必须挡带鉴权的反向代理」的说明，不在本仓库做多用户鉴权。来源：维护者 2026-11-05 确认。
- **MCP 的安全边界。** MCP 产出的剪辑和建议同样要用户确认后才生效；删除项目、覆盖导出等破坏性操作需要在客户端二次确认，不能由 Agent 单方面完成。
- **API Key 的存放。** E-08/7 在设计阶段决定桌面端是否放进系统钥匙串；Key 不出现在日志和 RPC 返回值里。

## 不做

FlyCut Cloud 服务端、账号和计费（不在本仓库）；本仓库内的多用户鉴权。

## 候选需求

| 候选 | 需求 | 类型 | 依赖 | 需求编号 |
|---|---|---|---|---|
| E-08/1 | CLI：通过 Host 操作项目，转写、获取建议、导出 | feature | E-02/1、E-08/7 | |
| E-08/2 | MCP Server：复用 CLI 的应用服务，发布到 MCP / Skills 市场；建议需用户确认，破坏性操作需客户端二次确认 | feature | E-08/1 | |
| E-08/3 | TTS Provider 能力：协议、能力声明（含声音克隆）、HTTP Provider 支持 TTS | feature | E-05/1 | |
| E-08/4 | 桌面端自动更新：Tauri updater、更新包签名密钥的保管、更新通道 | feature | E-08/8 | |
| E-08/5 | 崩溃收集与匿名使用统计：是否做、收集什么、如何征得同意 | spike | — | |
| E-08/6 | Web 端连接 FlyCut Cloud 托管的 Host：连接配置、Cloud 鉴权与会话接入、状态及重连；附单用户自部署说明，不含大文件续传 | feature | — | F-0014 |
| E-08/9 | 大文件断点续传与断线恢复：分片完整性、上传恢复、任务状态核验与重复操作保护 | feature | F-0014 | F-0015 |
| E-08/7 | AI 模型设置存到 Host：配置和 API Key 由 Host 保存，前端、CLI、MCP 共用；从浏览器本地存储迁移 | feature | — | |
| E-08/8 | 安装包签名与公证：macOS 签名 + 公证、Windows 代码签名，接入发版流程 | feature | — | |

## 相关决定

[decisions.md 架构](../../decisions.md#架构)、[模型 Provider](../../decisions.md#模型-provider)、[目标用户与平台](../../decisions.md#目标用户与平台)

## 2026-11-05 拆分确认

维护者对批量立项建议回复“其他按你说的做”，确认将E-08/6原范围拆为E-08/6连接会话与E-08/9续传恢复；阶段一功能对齐仍为汇总验收，不以连接成功代替各功能验证。

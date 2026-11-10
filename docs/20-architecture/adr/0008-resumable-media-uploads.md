---
id: ADR-0008
status: proposed
date: 2026-11-09
deciders: zhangxiang.chen
feature: F-0015
superseded_by:
---

# ADR-0008 Host 分片媒体上传

## 背景

F-0015 需要让浏览器通过远程 Host 上传 10–60 分钟口播素材，并在断网、暂停、页面刷新和 Host 重启后继续。现有 `POST /assets` 只接收整份请求体，断线只能重传，也没有上传会话、分片确认、最终摘要、取消或过期契约。F-0014 已验收 `/__flycut/connection`、HttpOnly Cookie、CSRF、bearer 和 Host 身份；当前 Host 是维护者认可的 Cloud 后端。

不能由客户端自行声明 owner 或 namespace，否则同一 Host 上的客户端可以绕过既有凭证边界。也不能把上传临时文件当成功项目媒体，或在最终摘要不符时静默接管。

## 决策

- **Host 是会话真源。** `uploads` 插件在 `<home>/uploads/<sessionId>/` 保存原子写入的 `session.json` 与确认分片。会话记录创建者身份摘要、文件大小/类型、完整 SHA-256、分片大小、确认分片、过期时间、状态和确定性 assetId。
- **身份来自 Gateway。** 每次上传路由都在既有鉴权后执行；浏览器会话主体来自 HttpOnly Cookie，bearer 主体来自 Host token 摘要。查询、写片、完成、取消都要求主体一致，不一致返回 404。普通页面刷新复用仍有效的 Cookie 会话；登出删除会话，过期后签发新身份。客户端不能提供 owner 或 namespace。
- **分片幂等。** 每片请求带 index、offset、摘要；Host 校验范围、长度、末片余量和内容摘要后原子 rename。相同 index 相同内容返回原确认；相同 index 不同内容、错误 offset 或越界返回冲突，不累加字节。
- **完成后原子落资产。** 服务端确认没有缺失分片，顺序流式重算完整 SHA-256 和大小，再检查媒体容器头。先在会话中持久化确定性 assetId 和 `finalizing`，再原子移入资产目录，最后标记 `complete`。重复完成返回同一 assetId；重启时根据 finalizing 记录补完或回滚，不产生第二份资产。
- **取消、过期与空间。** 每个会话串行化完成与取消；完成前取消删除临时目录，完成后取消不删除可能已被项目接管的资产。查询和每小时扫描都处理过期，过期返回 410。创建和写片前检查公开最大大小、允许类型和磁盘余量；磁盘不足返回 507。
- **客户端只保存定位元数据。** localStorage 按 `hostId` 保存 sessionId、文件名、大小、类型、摘要、operationId 和目标，不保存源媒体、字幕、token 或 API Key。刷新后重新选文件必须比较大小和完整 SHA-256；错文件不写旧会话。
- **项目与任务幂等。** `projects.create`、`projects.addVideo` 接受可选 operationId 并持久记录结果；`workflow.start`、`export.start` 接受 operationId，JobSnapshot 记录它，相同操作号返回同一任务。旧调用不带该字段时保持原行为。

## 备选方案

- 继续整文件 `/assets`：无法满足断线续传和分片确认；只适合小型 ASR/导出资产。
- 引入 tus 或第三方上传服务：增加部署依赖，并把当前 Host 可维护的真实契约移到仓库外。
- 客户端生成 owner key：跨刷新方便，但客户端可任意指定命名空间，违反既有 Host/凭证边界。
- 仅内存会话：Host 重启丢失，无法覆盖重启恢复，也更容易在崩溃后留下不可判定临时文件。
- 完成后复制整份文件：多一次 4 GiB I/O；顺序摘要校验后原子 rename 更直接。

## 后果

- 新增 `/uploads` HTTP 路由、`uploads.capabilities` RPC、Host home 的 `uploads/` 临时目录和可选 operationId 字段；`/assets` 与项目格式版本不变。
- 普通刷新可继续同一身份；登出、会话过期或确认切换身份后不能续传旧会话，只能重新选择并重新开始。
- 上传临时分片占用磁盘，最长保留会话 TTL；取消、过期和启动清理会删除未完成临时目录。
- 完成后的资产仍按现有项目媒体生命周期接管，未接管的完成资产按资产 TTL 清理。
- 需要真实 Host + 可切断 TCP 代理、真实大文件、错误分片/摘要、重启、刷新、取消/过期竞态和身份隔离测试；mock 只覆盖界面状态。

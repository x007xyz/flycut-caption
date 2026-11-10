---
id: ADR-0007
status: proposed     # proposed → accepted → superseded / deprecated
date: 2026-11-09
deciders:
feature: F-0056
superseded_by:
---

# ADR-0007 Host AI settings and secret storage

## 背景

F-0056 把 AI 模型配置从浏览器迁到 Host，使字幕纠错、翻译、Agent、后续 CLI/MCP
和第二个客户端读取同一份设置。浏览器 localStorage 目前含明文 API Key；Host 又可能运行在
Tauri 包内的本机进程，或运行在远程单租户服务端。两端的安全边界不同，不能把“Host 能读到”
误当成“可以把 Key 写进普通 JSON”。

调用方还需要并发写入、迁移重试和 Host 切换。迁移请求可能已经提交但响应丢失，旧 Host 的
迟到响应也不能清掉新 Host 的待迁移数据。密钥不能进入 RPC 返回、错误、任务快照、日志、
备份或项目文件。

## 决策

Host 保存不含密钥的 AI 配置元数据和单调递增 revision；密钥由独立的 secret backend 保存，
调用方按 `configId` 使用配置，RPC 只返回 `hasApiKey`。

- 元数据位于 Host home 的版本化 JSON，写入使用同目录临时文件 + rename；配置和选中项共用
  一个 revision，所有写操作必须带客户端看到的 revision，不匹配时返回当前快照而不是覆盖。
- 密钥不进入元数据文件。桌面 `auto` backend 使用操作系统凭据库；远程 `server` backend
  默认要求运维配置高熵 `FLYCUT_AI_SECRET_KEY`，用 AES-256-GCM 加密 Host home 内的 secret
  文件。测试可显式使用 memory backend。没有安全 backend 时拒绝持久化 Key，不降级为明文。
- 每个 Key 版本使用不可变 `secretRef`。写 Key 时先生成新引用并保存，再原子提交引用切换；
  提交成功后才清理旧引用，失败则删除新引用、旧元数据仍指向旧 Key。进程在两次写入间崩溃也
  不会让旧配置读到新 Key；未被引用的 secret 是孤儿，不影响正式配置。响应丢失后的写重试由
  revision 检查或迁移记录确认结果。
- 浏览器迁移必须由用户确认目标 Host。客户端把迁移 intent 绑定到 Host identity，并在上传前
  持久化 `{hostId, migrationId}`；Host 按 migrationId 和来源配置 ID 去重。只有收到匹配
  Host/migrationId 的成功响应才清理浏览器副本。切 Host 或迟到响应不能写入当前 UI 缓存。
- `text.start`、`agent.start` 保留旧请求形状作为兼容读取，但 Host 内部和新客户端统一用
  `configId` 解析配置。Key 只在本机 Host 发起上游请求时进入 Authorization header；错误和
  job 快照只暴露经过清洗的消息。
- 配置 URL 的连接测试和实际解析共用 endpoints 的地址策略：`server` Profile 拒绝 loopback、
  link-local 和私网地址，桌面本机可访问兼容服务；不能借测试接口绕过 Provider 的 SSRF 边界。

桌面系统凭据库实现通过固定平台命令访问，不把 Key 放进命令行参数；远程加密文件要求密钥
至少 32 个字符并设置 `0600`。secret backend 的可用性属于 Host 能力，不受普通 Profile
补丁打开成明文模式。

## 备选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| 元数据 + 独立 secret backend（采用） | 普通配置可读、Key 生命周期独立、可原子回滚；本机与远程按部署边界选择后端 | 增加 platform adapter 和加密密钥运维要求 |
| 全部配置和 Key 写同一个 Host JSON | 实现简单，换设备天然同步 | 默认明文落盘，备份、日志和项目复制都会扩大泄露面 |
| 继续放浏览器、调用时带 Key | 改动少 | 无法跨客户端共用，Key 出现在每个请求和前端内存，仍受 localStorage 泄露影响 |
| 首次直接自动上传，不用 migrationId | 用户步骤少 | 无法确认目标 Host；响应丢失会重复创建或误清本地数据 |

## 后果

- 浏览器不再持久化新 AI Key；已有浏览器配置只作为一次性、用户确认的迁移来源。
- Host 备份必须包含元数据但不包括 secret backend；恢复后用户可能需要重新输入 Key。
- 远程部署缺 `FLYCUT_AI_SECRET_KEY` 时可以读取已有元数据，但新增/修改 Key 和测试连接会
  明确失败；运维需要提供密钥轮换和备份策略。
- 本机桌面依赖操作系统凭据库。不可用时保存 Key 失败，不提供不安全的自动降级。
- 配置删除、revision 冲突、迁移幂等、Host identity 绑定和密钥回滚都需要架构测试；
  本 ADR 在维护者验收 F-0056 前保持 `proposed`。

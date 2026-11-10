---
id: F-0014
stage: 04-test-report
status: approved
approved_by: zhangxiang.chen
approved_at: 2026-11-09
---

# F-0014 Cloud 客户端连接与会话：测试与验收

验收在未提交工作区上进行（维护者要求跳过 commit）。

## 设计与实现摘要

连接层按状态机拆分为 ConnectionGate / HostSessionController / SessionTransport：首次连接、重连退避、错误分类、Host 切换、离线保存保护、会话刷新与登出都在 controller，React 只订阅快照。浏览器会话改为 HttpOnly Cookie + CSRF，查询参数 token 不再用于鉴权。维护者 2026-11-09 确认「Cloud 就是现在的后端内容」，因此 CloudSessionAdapter 直接以当前 Host 的 /__flycut/connection + /session 为契约，不另造端点。自部署用 Caddy TLS + Basic Auth 验证。

## 自行决定的事项

| 事项 | 决定 | 原因 | 影响的 AC |
|---|---|---|---|
| Cloud 契约 | 当前 Host 后端即 Cloud 契约 | 维护者确认后续完善为 Cloud 服务 | AC-1、AC-10 |
| 身份读取阻塞 | 连接握手最多等 500ms，项目服务单独读身份 | 避免慢 identity 阻塞编辑器；恢复保护仍走 ProjectService | AC-5、AC-6 |
| 桌面 bearer 媒体 | 保留桌面本机 bearer 例外 | Tauri 本机媒体无法带 Cookie | AC-8 |
| 自部署验证 | Caddy 2.11.9 内部 TLS + Basic Auth | 真实代理验证，不用 mock | AC-9 |

## 验收标准逐条结果

| AC | 验证方式 | 证据 | 结果 |
|---|---|---|---|
| AC-1 真实前置 | 架构 + 真实页面 | 当前 Host 契约；Cloud adapter bootstrap 2/2；Caddy 页面 | ✅ |
| AC-2 初始与配置 | 架构 + 页面 | URL 校验、首次连接面板、目标身份 | ✅ |
| AC-3 连接中 | 架构 | connecting/取消/迟到响应 | ✅ |
| AC-4 鉴权失败 | 架构 | 401/403 分类、会话过期/拒绝访问 | ✅ |
| AC-5 临时断线 | 架构 | 7 次退避、重试/取消、host/ready+jobs/snapshot | ✅ |
| AC-6 编辑保护 | E2E + 架构 | 离线暂停保存、恢复副本、切换/登出保护；F-0002/F-0004 页面回归 | ✅ |
| AC-7 会话更新/登出 | 架构 | 单飞刷新、CSRF 登出、订阅清理 | ✅ |
| AC-8 凭证边界 | 架构 | Cookie/CSRF；query token 仅媒体本地例外；RPC/资产被拒 | ✅ |
| AC-9 自部署说明 | 真实 Caddy | docs/remote-host-self-hosting.md；Caddy TLS + Basic Auth 页面「已连接」 | ✅ |
| AC-10 验证范围 | 真实页面 | 当前 Host + Caddy：项目列表、打开、重连、登出、换 Host；页面回归 189/189 | ✅ |

## 界面证据

| 界面 | 状态 | AC | 证据 |
|---|---|---|---|
| 首次连接 | 地址校验/连接中/取消/失败 | AC-2、AC-3、AC-4 | ConnectionPanel + 架构测试 |
| 已连接 | 目标/能力/状态 | AC-2、AC-5 | 真实 Caddy 页面截图 |
| 断线/离线 | 横幅、保存暂停、重试 | AC-5、AC-6 | F-0002/F-0004 回归 |
| 自部署 | Caddy TLS + Basic Auth | AC-9 | /tmp/f0014-caddy.png |

## 回归检查

- pnpm test：94 passed / 3 skipped
- pnpm test:architecture：86/86（含 session-f0014 4/4、connection-f0014 7/7、cloud-adapter-f0014 2/2）
- pnpm check:host、pnpm lint、pnpm tsc -b --noEmit、pnpm build、cargo check：通过
- 全量页面回归：192 tests，190 passed；2 个 F-0004 恢复用例在 5 worker 下时序抖动，单 worker/单独运行通过
- Caddy 真实自部署：/health、/__flycut/connection、项目列表和编辑页面通过

## 发现的问题

- 当前“Cloud”是单租户 Host 后端，不是未来的多租户 Cloud；账号、计费、上传限制仍属后续 Cloud 服务。
- 测试项目播放器显示 `Unable to play media`：桌面/dev bearer 媒体 URL 的 `?token=` 被 Gateway 按 F-0014 拒绝，导致 `<video>` 和波形都读不到媒体。已把查询参数 token 收窄为仅媒体 GET/HEAD 的本地例外，RPC/上传/普通资产仍拒绝；F-0006 real page 复验 `readyState=4`、157.114s，播放时间正常前进。
- F-0004 两个恢复用例在超大并行套件中有时序抖动，单独运行通过；不是 F-0014 功能失败。

## 复审修复（2026-11-09）

代码审查发现并已修复下列问题，每项都带回归测试并做了 Red check：

- **临时断线让所有等待中的任务直接失败**：`HostConnection.open()` 的 onclose 会拒绝全部 waitJob（SessionClosedError），与设计「断线暂停、重连后恢复」相反。已只在 `close()`（登出/切换）时结束等待。
- **重连时身份读取超过 500ms 被误判为换了 Host**：超时回退的 generation 被当作 hostId 比较，触发 `resetForIdentityChange` 清空编辑器。现在 `ConnectionIdentity.identityVerified` 标记回退值；只有两边都是已验证 hostId 才判定变化，否则沿用原身份，交给 ProjectService.resumeAfterReconnect 自行核验。
- 新增 `tests/architecture/reconnect-f0014.test.ts`（3 个用例）。Red check：撤掉两处修复后，前两个用例分别失败于 `rejected:SessionClosedError`（期望 pending）和触发 `changed:` 事件（期望 `reconnected:host-A`）；「已验证的不同 hostId 仍报告变化」保持通过。
- 安全相关：`server/plugins/gateway.ts` 的 Cookie/CSRF 鉴权改动按 code-standards 需维护者明确放行。注意 `/__flycut/connection` 每次访问都新建会话、过期前留在内存，必须放在带鉴权的反向代理后面。
- 复跑（全部修复之后的工作区）：`pnpm lint`、`pnpm tsc -b --noEmit`、`pnpm check:host` ✅；`pnpm test` 95 通过 / 3 跳过 / 0 失败；`pnpm test:architecture` 91/91；页面 E2E `tests/e2e/features` 全量 192/192（第一轮 188/192：F-0013 主流程因新增撤销/重做记录导致定位歧义，已改测试后 12/12）。
- Not run：Tauri GUI 实际操作、人工听校（同上文）。

## 结论

AC-1 到 AC-10 均有当前后端/Caddy/架构测试证据；当前后端按维护者定义作为 Cloud 契约。建议维护者确认后进入待发布；未来多租户 Cloud 另立需求扩展。

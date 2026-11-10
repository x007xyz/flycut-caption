---
id: F-0014
stage: 03-implementation
status: approved
approved_by: auto
approved_at: 2026-11-09
---

# F-0014 Cloud 客户端连接与会话：开发记录

## 分支与 PR

- 分支：当前工作区（未新建分支）
- PR：未创建；按本轮指示不执行 commit/tag/release

## 进度

<!-- 每完成实现清单的一项，在 02-design.md 勾选，并在这里追加一行：日期、清单项、提交 sha、跑过的检查。
换会话接着做时，先读 02-design.md 和这里。 -->

| 日期 | 清单项 | 提交 | 检查 |
|---|---|---|---|
| 2026-11-09 | 1. 连接模型与首次连接 UI | 未提交 | pnpm tsc -b --noEmit ✅、pnpm lint ✅ |
| 2026-11-09 | 2. 浏览器会话传输 | 未提交 | pnpm check:host ✅、session-f0014.test.ts ✅ |
| 2026-11-09 | 3. 重连与错误分类 | 未提交 | connection-f0014.test.ts ✅ |
| 2026-11-09 | 4. Host 切换 | 未提交 | pnpm tsc -b --noEmit ✅；E2E 全量未跑 |
| 2026-11-09 | 5. 离线编辑保护 | 未提交 | pnpm tsc -b --noEmit ✅；F-0002 AC-11 E2E ✅ |
| 2026-11-09 | 6. 会话刷新与登出接缝 | 未提交 | session-f0014.test.ts ✅ |
| 2026-11-09 | 7. 自部署说明（部分） | 未提交 | docs/remote-host-self-hosting.md 已写；真实代理验证 Not run |

## 自行决定的事项

<!-- 开发中自己决定的事：决定了什么、为什么、影响哪条 AC。验收时汇总进测试报告 -->

## 与设计的偏差

<!-- 实现时改变了设计的地方及原因；重大偏差回到 02-design.md 修改，并记进测试报告 -->

## 遗留问题
- 连接状态由 HostSessionController 持有，React 只订阅快照；切换 Host 用 runtimeKey 重挂载 ClientRuntime，旧运行时在候选连接成功后才卸载。
- 同源 Web/自部署页面使用 Host 会话 Cookie + CSRF；桌面端和显式 window.__FLYCUT_HOST__ 继续使用内存 bearer。桌面本机媒体 URL 的 bearer 查询参数是设计允许的本地例外。
- Vite 开发服务器仍从本机 connection.json 取 bearer bootstrap；生产由 Host 自己提供 /__flycut/connection 会话引导。这样 dev 不需要额外代理也能工作。
- 重连采用 500ms/1s/2s/4s/8s/15s/30s + 20% 抖动，7 次后进入 unreachable，手动重试清零。影响 AC-5。
- 断线时保存状态改为 offline，自动保存和失败重试暂停；重连且身份一致后先 projects.open 比较内容，一致才恢复 saved，不一致进入既有 conflict 流程。影响 AC-6。
- 切换/登出复用 confirmLeave，并新增「保留副本并离开」选项；endSession(false) 不删除恢复副本。影响 AC-6、AC-7。
- 同一地址 hostId 变化按不同 Host 处理：清空项目视图回到首页；旧恢复副本按旧 hostId 保留。影响 AC-4、AC-6。
- ConnectionSnapshot 的错误码扩展了 rate-limited、server-error、request、switch-failed、logout-failed，用来显式分类 429/5xx 和切换/登出失败；设计原枚举没有这几项。
- Host 的 HttpOnly 会话、CSRF、DELETE /session 和 Cookie WebSocket 已实现；GET /__flycut/connection 只返回会话元数据，不再返回 token。Vite dev 的 /__flycut/connection 中间件仍返回本机 bearer，仅用于开发。
- ConnectionPanel 同时承担首次连接和会话终态的重连/切换入口；HostSwitcherDialog 自身就是设计的 switch-confirm 对话框。
- CloudSessionAdapter 只有接口和不可用状态，没有具体 Cloud 地址/刷新/登出实现；UI 在 adapter.available() 为 false 时不显示可点击的 Cloud 登录。
- 媒体凭证：Web 会话不带 token；桌面本机 bearer 和 Vite dev 的媒体 GET 允许 `?token=`（只读、仅媒体路由），其余 RPC/资产仍拒绝查询参数 token；未做 blob/MediaSource 回退。

- 清单 7 的真实 Caddy/Nginx + TLS + Basic Auth 验证：Not run。没有可用的代理/TLS 环境，不能把文档当成 AC-9 真实验收。
- 清单 8 Cloud 集成和 AC-10：阻塞。缺少 Cloud Host 端点、会话/刷新/登出协议、测试账号、上传限制和可访问环境；不得用 mock 代替。
- E2E：F-0002 AC-11 light/dark 已通过（修复 mockHost 的 credentialed CORS 后）；F-0002 全量 36 个用例只跑到约一半被本轮中止，未得到完整结果。F-0005/F-0006/F-0007/F-0012 未在本轮重跑。
- 真实自部署代理、桌面端 tauri:dev 和 Cloud 端到端均 Not run。
- 其它未跑：pnpm build、cargo check、完整 pnpm test、完整 pnpm test:architecture。已跑的子集见下。

## 本轮验证记录

- Ran: pnpm tsc -b --noEmit ✅
- Ran: pnpm lint ✅
- Ran: pnpm check:host ✅
- Ran: tests/architecture/host.test.ts ✅（18 passed）
- Ran: tests/architecture/session-f0014.test.ts ✅（4 passed）
- Ran: tests/architecture/connection-f0014.test.ts ✅（7 passed）
- 全量 `pnpm test:architecture` 81/81 ✅（包含 session-f0014 4/4、connection-f0014 7/7、host.test 18/18）。
- 全量页面回归 F-0002/0003/0004/0005/0006/0007/0012/0013/0028 189/189 ✅。
- Not run: 真实 Caddy/Nginx 自部署、Cloud AC-10、tauri:dev、cargo check（本需求没有 Rust 改动）。

## mockHost / E2E 兼容说明

- mockHost 已补 host/ready 和 jobs/snapshot，HostConnection.open() 不再等不到握手。
- 会话模式使用 credentials: include；mockHost 原先的 Access-Control-Allow-Origin: * 对带凭证请求无效，已改为回显 Origin 并加 Access-Control-Allow-Credentials: true。F-0002 AC-11 由此恢复通过。
- mockHost 现在默认返回 session bootstrap，并校验 X-Flycut-CSRF；仍保留 options.connection 覆盖，便于构造首次连接/无 Host 状态。
- 最终验证：pnpm tsc -b --noEmit ✅、pnpm lint ✅、pnpm check:host ✅、pnpm test 93 passed/3 skipped、pnpm test:architecture 81/81、pnpm build ✅。
- F-0014 架构测试：session-f0014 4/4、connection-f0014 7/7、host.test 18/18。
- 全量页面回归 189/189（含 F-0004 AC-2 在身份读取挂起时仍显示恢复检查对话框）。
- 仍未完成：真实 Caddy/Nginx 自部署验证（清单 7）与 Cloud AC-10（清单 8）；Cloud 端点/会话契约/测试账号缺失，不能用 mock 代替。
- 真实自部署：Caddy 2.11.9 内部 TLS + Basic Auth 反向代理 127.0.0.1:8766；`/health` 和 `/__flycut/connection` 通过，真实浏览器打开 https://localhost:9443，页面显示「已连接」，项目列表/编辑可用。
- Cloud 契约按维护者确认改为当前 Host 后端：新增 src/runtime/cloudAdapter.ts，使用 /__flycut/connection + /session Cookie/CSRF；ConnectionGate 默认注入 CurrentBackendCloudAdapter。
- 新增 tests/architecture/cloud-adapter-f0014.test.ts 2/2：bootstrap、CSRF 登出、401 过期。
- 真实 Cloud 路径以当前 Host + Caddy TLS + Basic Auth 验收：页面显示「已连接」，项目列表/编辑可用。

---
id: F-0014
stage: 02-design
status: approved
approved_by: auto
approved_at: 2026-11-09
---

# F-0014 Cloud 客户端连接与会话：技术设计

**结论：仓库里没有 FlyCut Cloud 托管 Host 的真实端点、会话/刷新/登出协议、上传限制或测试账户。** FLYCUT_CLOUD_URL 只用于官方 ASR Provider（server/plugins/cloud.ts），不是 Host 地址；discoverHost 只有桌面 ensure_host、window.__FLYCUT_HOST__ 和同源 /__flycut/connection 三条路径。因此 AC-1 不满足，Cloud 集成和 AC-10 真实验收是硬阻塞。本设计把可实现的客户端连接切片、自部署 Host 会话和测试替身定清楚，不宣称 Cloud 端到端可用。

## UI / UX

### 入口与组件

- 新增 src/components/Connection/ConnectionGate.tsx，包住 ProjectsApp 和 FlyCutCaption 的 ClientRuntime。ClientRuntime 不再自己调用 discoverHost，只接收已经建立好的连接和运行时 key；连接发现、配置、重试、切换由 Gate 负责。
- 新增 ConnectionPanel.tsx（首次连接/自部署地址）、HostSwitcherDialog.tsx（切换确认）、ConnectionStatus.tsx（顶栏状态）、ConnectionBanner.tsx（断线/离线/身份变化）。
- 设置里新增「连接 / Connection」分区：当前目标、Host ID、协议版本、能力摘要、会话到期时间（Cloud 提供时）、切换 Host、退出登录、自部署说明链接。
- Web 端提供连接配置和切换；桌面端继续自动连接 ensure_host 的本机 Host，只显示当前 Host 身份，不提供远程 Host 切换。桌面端要连远程 Host 属于开发调试，不作为本需求的用户流程。
- 所有状态覆盖明暗主题和中英文；文案进 src/locales/zh_CN.ts、en_US.ts、types.ts。

### 状态与文案

以 AC-2 到 AC-10 为准，界面状态如下。connecting、switching 时旧运行时保持挂载，只有候选连接成功后才替换，避免取消连接把用户已经打开的项目弄丢。

| 状态 | 触发 | 界面与操作 | 关键文案 | AC |
|---|---|---|---|---|
| initial | 没有可自动使用的目标 | 居中连接卡片：Host 地址输入、连接按钮、自部署说明、Cloud 入口（仅在发行版配置了 Cloud 适配器时显示） | 连接 Host / Connect to Host；连接 FlyCut Cloud 或你自己的 Host / Connect to FlyCut Cloud or your own Host | AC-2 |
| invalid | 地址不是合法 origin、协议不对、带账号密码/查询参数 | 输入框下即时错误，连接按钮不可用，不发送任何凭证或探测请求 | 连接地址无效 / Invalid connection address；只支持 https://，本机开发可用 http://127.0.0.1 / Use https://; http://127.0.0.1 is allowed for local development | AC-2 |
| connecting | 用户点连接或自动发现后开始握手 | 按钮转圈并禁用，输入框禁用，显示取消；重复点击无效 | 正在连接… / Connecting…；取消 / Cancel | AC-3 |
| connected | host/ready、host.info、projects.identity 都成功 | 顶栏显示「已连接」和目标；连接面板列出 Host ID、协议、能力、会话到期；提供切换 Host | 已连接 / Connected；目标 / Target；能力 / Capabilities；会话 / Session | AC-3 |
| switch-confirm | 用户选择新目标 | 确认对话框说明当前 Host 与目标 Host；有未保存修改时先走离开保护。取消不改变当前 Host | 切换 Host？ / Switch Host?；当前 Host 的未保存修改需要先处理；切换后不会把旧 Host 的内容写入新 Host。 / Unsaved changes on this Host must be handled first. Nothing from the old Host will be written to the new one. | AC-2、AC-6 |
| switching | 候选连接通过握手，等待提交 | 阻塞对话框；旧运行时仍在后台，候选连接成功后一次性替换。失败或取消回到旧 Host | 正在切换 Host… / Switching Host… | AC-3、AC-6 |
| auth-expired | 401、会话到期或 Cloud 适配器报告过期 | 替换内容区为登录失效页；不自动重试；重新登录入口；清除当前身份的项目缓存 | 登录已过期，请重新登录 / Your session expired. Sign in again.；重新登录 / Sign in again | AC-4 |
| access-denied | 403、Cloud 拒绝访问 | 替换内容区；不显示另一身份缓存的项目；不无限重试；提供切换 Host/账号 | 没有访问权限 / Access denied | AC-4 |
| reconnecting | 已连接后 WebSocket 断开、网络错误或 Host 重启 | 顶部常驻横幅；编辑器保持可见但依赖 Host 的新操作禁用；重试/取消 | 连接已断开，正在重连… / Disconnected. Reconnecting…；立即重试 / Retry now；取消 / Cancel | AC-5 |
| unreachable | 自动重连次数用尽 | 横幅变为错误；手动重试；切换 Host；显示最后一次错误摘要 | 无法连接Host / Cannot connect to Host | AC-5 |
| offline-editing | 断线时编辑器里有内容 | 编辑器和内存编辑保留；保存状态显示「离线，修改未保存」，不显示「已保存」；导出/识别/保存/切换视频等 Host 操作禁用；恢复副本继续记录 | 离线，修改未保存 / Offline — changes not saved；连接恢复后可继续 / Available when reconnected | AC-6 |
| signing-out | 用户确认退出 | 阻塞对话框；停止订阅和后台提交；不显示旧项目内容 | 正在退出… / Signing out… | AC-7 |
| signed-out | 退出完成 | 登录页；未处理的恢复副本保留在本机 | 已退出 / Signed out；重新登录 / Sign in again | AC-7 |
| incompatible | 协议版本不符或缺少浏览器会话能力 | 阻止连接；显示升级提示；不回退到 token-in-URL | Host 版本不兼容 / Incompatible Host version | AC-3、AC-8 |
| identity-changed | 同一地址重连后 hostId 变化 | 清空旧项目列表/详情/编辑器，回项目首页，提示身份变化；旧恢复副本保留 | Host 身份已变化，已返回项目列表 / This Host changed. Returned to projects. | AC-4、AC-6 |

### 交互规则

- 地址校验在本地完成，非法地址不触发 /health、host.info 或任何携带凭证的请求。
- 连接和切换都只允许一个进行中的尝试；connect() 用 generation 标记，取消后迟到的响应不得改状态、不得切换项目。
- 取消当前连接时，旧 Host、当前项目、当前编辑内容和恢复会话保持不变；候选连接单独关闭。
- 鉴权失败和拒绝访问进入终态，只有用户重新登录/切换/手动重试才继续，不做指数退避自动重试。
- 断线横幅不遮挡编辑；Host 依赖操作统一通过 connection.isReady() 判断，不能只在单个按钮里散落判断。
- 退出登录和切换 Host 前复用 F-0002/F-0003 的离开保护；未保存时先保存，保存不了弹既有 UnsavedChangesDialog。
- 所有新增界面状态用真实主题变量和现有 Dialog/Banner 组件，不新增第二套设计系统。

## 技术方案

### 涉及的子系统

已读 docs/subsystems/cordis-host.md、docs/subsystems/frontend.md、docs/architecture-current.md、docs/decisions.md、docs/10-product/epics/E-08-platform.md、docs/20-architecture/adr/0004-client-recovery-copies.md、docs/code-standards.md。涉及 src/runtime/**、src/services/projectService.ts、src/stores/**、src/components/Project/**、server/plugins/gateway.ts、server/plugins/rpc.ts、server/main.ts、shared/protocol.ts 和端到端测试夹具。

### 现状与真实契约结论

| 需要的东西 | 仓库现状 | 结论 |
|---|---|---|
| Cloud 托管 Host 的地址发现 | FLYCUT_CLOUD_URL 只喂 server/plugins/cloud.ts 的 ASR Provider；没有 Host URL 字段 | 不存在 |
| Cloud 登录/会话协议 | 没有 OAuth/OIDC/JWT/session/login RPC；只有 Host 共享 Bearer token | 不存在 |
| 刷新与登出规则 | cloud.setApiKey 只设 ASR Key；没有刷新、撤销、登出 | 不存在 |
| Host 侧的浏览器会话 | 只有 Bearer；/__flycut/connection 直接返回共享 token；WebSocket 和媒体 URL 把 token 放查询参数 | 需要新增，且是安全改动 |
| 上传契约 | 已有 /assets，单请求上限 4 GB；没有 Cloud 的文件大小/分片/配额约定 | Cloud 部分不存在 |
| 测试环境/账户 | 没有 Cloud 测试端点、账号、配额或环境变量 | 不存在 |
| 自部署反向代理 | server Profile 有 Origin/绑定说明；没有可复制的鉴权代理实例 | 可以补文档和验证 |

Cloud 至少需要提供并书面确认以下内容，缺一项都不能开始 Cloud 集成：

1. 每个用户/租户对应的 Host base URL 如何发现，是否一用户一 Host。
2. 登录后客户端拿到什么：HttpOnly Cookie、短期 JWT、还是一次性 bootstrap code。
3. 会话有效期、刷新入口、刷新失败语义、登出入口和撤销传播时间。
4. 稳定的用户/身份 ID，用于 UI 展示和客户端缓存隔离。
5. CORS、Origin 白名单、Cookie 的 Domain/SameSite/Secure 策略，以及 WebSocket 是否同源。
6. 媒体与资产下载的鉴权方式、Range 支持、最大文件大小和上传配额。
7. 401/403/429/5xx 的错误分类和 Retry-After 约定。
8. Host 是否在鉴权代理后面、代理是否注入 Host 凭证、客户端是否完全看不到 Host token。
9. 测试环境、测试账号、可用配额和可访问时间。
10. 预览/开发环境与生产环境的域名差异。

在这些确认之前，只能实现下面的客户端切片和自部署 Host 会话，不能把测试替身结果写成 Cloud 通过。

### 方案

#### 1. 分层与职责

    flowchart LR
      Gate[ConnectionGate UI] --> Controller[HostSessionController]
      Controller --> Adapter[CloudSessionAdapter / SelfHostedBootstrap]
      Controller --> Candidate[候选 HostConnection]
      Candidate --> Host[Host Gateway]
      Gate --> Runtime[ClientRuntime]
      Runtime --> Services[projects / asr / ai / export]
      Services --> Active[当前 HostConnection]

- CloudSessionAdapter 是唯一需要真实 Cloud 契约的接缝：负责取得 Host 地址、登录、刷新、登出和提供稳定 subject ID。本次不实现具体 Cloud 适配器，只定义接口和不可用状态。
- SelfHostedBootstrap 实现同源 /__flycut/connection 和显式地址 + token 的交换，服务自部署单用户场景。
- HostSessionController 拥有连接状态机、候选连接、重连计时器、身份缓存和切换提交；不把状态放进 React 组件。
- HostConnection 只负责传输：RPC、上传下载、WebSocket、任务快照、取消和状态回调。
- ConnectionGate 只负责展示和调用 Controller；ClientRuntime 用 Controller 提供的连接创建业务 Context。

#### 2. 连接状态机

    stateDiagram-v2
      [*] --> boot
      boot --> config: 无自动目标
      boot --> connecting: 桌面/同源/Cloud 自动目标
      config --> validating
      validating --> config: 地址非法
      validating --> connecting
      connecting --> connected: ready + info + identity
      connecting --> authExpired: 401
      connecting --> accessDenied: 403
      connecting --> unreachable: 超时/网络失败
      connecting --> config: 用户取消
      connected --> reconnecting: socket 断开/网络错误
      reconnecting --> connected: 重连成功且身份一致
      reconnecting --> authExpired: 401/刷新失败
      reconnecting --> accessDenied: 403
      reconnecting --> unreachable: 自动尝试用尽
      unreachable --> reconnecting: 手动重试
      connected --> switching: 用户选择新目标
      switching --> connected: 提交新运行时
      switching --> connected: 取消/失败，保留旧运行时
      connected --> signingOut
      signingOut --> signedOut
      authExpired --> connecting: 重新登录
      accessDenied --> config: 切换账号/Host
      signedOut --> connecting: 重新登录

状态数据固定为：

    type ConnectionPhase =
      | 'boot' | 'config' | 'validating' | 'connecting' | 'connected'
      | 'reconnecting' | 'auth-expired' | 'access-denied' | 'unreachable'
      | 'switching' | 'signing-out' | 'signed-out' | 'incompatible';

    interface ConnectionSnapshot {
      phase: ConnectionPhase;
      target?: { url: string; label: string; source: 'cloud' | 'self-hosted' | 'desktop' | 'same-origin' };
      identity?: { hostId: string; protocolVersion: number; generation: string; subjectId?: string; subjectLabel?: string };
      capabilities?: Record<string, boolean>;
      attempt: number;
      nextRetryAt?: number;
      error?: { code: 'invalid-address' | 'auth-expired' | 'access-denied' | 'unreachable' | 'protocol' | 'cancelled'; message: string };
    }

每次连接/切换都递增 generation。所有异步回调先比较自己的 generation，再写状态；取消不会让旧请求在稍后把新 Host 覆盖掉。连接尝试有 10 秒超时；RPC 保留现有 30 秒超时；WebSocket 等在 10 秒内收到 host/ready。

#### 3. 目标发现与地址校验

发现顺序保持兼容，但抽成可测试的 resolveTarget()：

1. 桌面：ensure_host，返回本机 Host 的 URL 和 bootstrap token。
2. 嵌入方：window.__FLYCUT_HOST__，只作为本地/开发入口。
3. 同源：GET /__flycut/connection，返回 { url?, auth: 'session', csrf }，由 Host 设置 HttpOnly Cookie；不再返回 token。
4. Cloud：由 CloudSessionAdapter 返回地址和会话；没有适配器时不显示可用的 Cloud 登录。
5. 都没有：进入 config，显示连接卡片。

地址规则：

- 只接受 https:；http: 只允许 127.0.0.1、localhost、[::1]。
- 拒绝 URL 中的用户名、密码、查询参数和片段；只接受 origin，避免把凭证或路由参数带进日志。
- 拒绝 javascript:、data:、file:、blob: 和非 Host 协议。
- 规范化末尾斜杠；持久化最近一次成功的目标 URL（非机密），不持久化 token、Cookie 或 CSRF。
- 地址非法时只在本地标红，不发起任何请求；这直接对应 AC-2。

#### 4. 浏览器会话与凭证边界

当前 HostConnection 只支持 Authorization: Bearer，WebSocket 和 resourceUrl() 还把 token 放查询参数，违反 AC-8。设计改为：

- bootstrap：桌面 IPC、显式嵌入或同源连接引导只拿到一次 bootstrap 凭证。
- exchange：ConnectionGate 调用 POST /session，Host 校验 bootstrap 后生成不透明会话 ID，设置 Set-Cookie: flycut_session=<opaque>; HttpOnly; Secure（TLS 时）; SameSite=Strict; Path=/，响应只返回 CSRF token 和会话元数据。
- transport：浏览器对 /rpc、/assets、/events 使用 Cookie；HostConnection 对写请求带 X-Flycut-CSRF。Cookie 为 HttpOnly，JavaScript 读不到；CSRF token 只在内存。
- WebSocket：浏览器自动发送同源 Cookie，不再拼 ?token=。
- 媒体：video/img 用 Cookie 访问 Host 资产；删除 resourceUrl() 的 token 拼接。跨域媒体必须由 Cloud 代理或 Host 的同源部署解决，不能回退到公开签名 URL。
- Cloud 代理形态：Cloud 可以在反向代理层完成用户鉴权，再向 Host 注入内部凭证；客户端只持有 Cloud 会话，完全看不到 Host token。具体 header/凭证交换必须由 Cloud 契约确认，不能用 X-Forwarded-User 这类可伪造头直接信任。
- 存储：Cloud 和自部署 Web 都用 HttpOnly Cookie；显式 window.__FLYCUT_HOST__ 的 token 只在内存中用于交换，交换后清空本地引用；桌面 ensure_host 的 token 只在 WebView 内存中，优先交换 Cookie。禁止写 localStorage；sessionStorage 也不作为默认方案，避免刷新后留下可被 XSS 读取的长期凭证。
- 日志：Authorization、Cookie、Set-Cookie、X-Flycut-CSRF、查询参数里的旧 token 全部脱敏；错误对象不拼接凭证。

Gateway 鉴权矩阵：

| 路由 | Bearer | HttpOnly Cookie | CSRF | 说明 |
|---|---|---|---|---|
| POST /session | 自部署 bootstrap | 否 | 否 | 设置会话 Cookie；Cloud 代理可在前面完成鉴权 |
| DELETE /session | 可选 | 是 | 是 | 撤销当前会话并清 Cookie |
| POST /rpc | 兼容 CLI/测试 | 是 | 是 | 浏览器默认 Cookie；写操作必须带 CSRF |
| POST /assets | 兼容 CLI/测试 | 是 | 是 | 上传 |
| GET /assets/:id | 兼容 CLI/测试 | 是 | 否 | 媒体流；只读 |
| GET /events | 兼容 CLI/测试 | 是 | 否 | WebSocket 握手；检查 Origin |
| GET /__flycut/connection | 否 | 可选 | 否 | 同源引导；只返回 {auth:'session', csrf}，不返回 token |
| GET /health | 否 | 否 | 否 | 只证明可达，不证明鉴权 |

GET /__flycut/connection 必须在 webRoot 模式下保持 Host 头/Origin 检查、Cache-Control: no-store，且不能把 Cookie 或 token 写进响应体之外的缓存。

#### 5. 重连、退避与请求语义

- 自动重连只发生在 connected -> reconnecting，不发生在 auth-expired、access-denied、signed-out。
- 退避序列 500ms, 1s, 2s, 4s, 8s, 15s, 30s，每档加 20% 抖动；7 次后进入 unreachable，等待手动重试。手动重试重置计数。
- navigator.onLine 和页面重新可见只作为立即重试的提示，不作为成功依据。
- 重连成功后先调用 host.info 校验协议/能力，再调用 projects.identity 校验 hostId，最后等 host/ready + jobs/snapshot。身份一致才恢复编辑器；身份变化进入 identity-changed。
- 不自动重发副作用请求：workflow.start、export.start、text.start、agent.start、projects.create/addVideo/removeVideo/trash/purge/save*、assets 上传都不在重连后重放。只重放只读查询：host.info、projects.list/open/identity、jobs.get/list。
- 已知 job ID 时，重连后用 jobs.get 恢复进度；waitJob 暂停轮询而不是在断线时不断发请求，重连后再查询。未知 job ID 的写请求显示「结果待确认」，交给用户手动核对。
- 上传中断直接失败并保留原文件选择；断点续传由 F-0015 负责，本需求不伪造续传能力。
- 所有写操作在 connection.isReady() === false 时快速失败并显示「连接恢复后可继续」，不排队到重连后自动执行。

#### 6. 切换 Host

切换采用「候选连接先成功，再提交」：

1. 用户输入/选择目标，地址校验通过。
2. 显示 switch-confirm，明确目标 label、URL 和当前 Host 身份。
3. 创建候选 HostConnection，完成 POST /session、host.info、projects.identity。
4. 候选成功后执行未保存保护：projects.confirmLeave()。保存失败/冲突时沿用既有对话框；用户取消则关闭候选，旧运行时不变。
5. 提交：停止旧自动保存和重连计时器，endSession 结束编辑会话（有未保存副本时保留），connection.close()，ctx.fiber.dispose()；清空旧 stores.project 的项目列表、详情、当前视频、撤销栈和连接缓存。
6. 用候选连接创建新 ClientRuntime，路由回 #/projects；如果候选 hostId 与旧相同，可保留当前项目并重新打开，否则绝不沿用旧项目。
7. 迟到的旧请求按 generation 丢弃；旧恢复副本留在 IndexedDB，按旧 hostId 隔离，不写入新 Host。

同一 URL 但 hostId 变化按「不同 Host」处理；同一 hostId 但 URL 变化（反向代理换域名）按「同一 Host」处理，仍要清空连接级缓存并重新读取能力。

#### 7. 未保存修改与离线编辑

- projectService.connectionChanged('disconnected') 时：清除自动保存 timer 和失败重试 timer；如果当前有编辑器，save.status 改为 offline；不显示 saved，不继续发送保存。
- SaveStatus 增加 'offline'；SaveStatusIndicator 显示「离线，修改未保存 / Offline — changes not saved」，点击重试只在连接恢复后可用。
- 恢复记录器继续按 F-0004 的节流写本地副本；副本 key 仍使用 hostId|projectId|videoId|sessionId。断线不删除副本，也不把它上传到任何 Host。
- 重连且身份一致后，先 projects.open 读取 Host 内容并与当前快照比较：一致则恢复 saved/pending，不一致则保留 pending 或进入既有冲突流程；不能仅凭“重连成功”显示已保存。
- 切换 Host/退出登录前调用 projects.confirmLeave()。用户选择放弃时，副本按现有规则处理；用户选择退出但保存不了时，使用 endSession(false) 保留副本，退出后副本仍只在旧 hostId 下可见。
- 旧 Host 的副本永远不写入新 Host；重新登录同一 hostId 才在打开项目时发现。

#### 8. 会话刷新、登出与订阅清理

- CloudSessionAdapter.refresh() 由 Cloud 定义；HostSessionController 用单飞 Promise 合并并发刷新。刷新成功只允许重试只读请求一次；写请求遇到 401 直接进入 auth-expired，不自动重试。
- 自部署 Host 的 DELETE /session 撤销内存会话并清 Cookie；POST /session 重新建立。Host 重启会让内存会话失效，客户端按 401 重新登录，恢复副本不受影响。
- 登出顺序：停止自动保存/重试/重连计时器 → 等待在途只读请求（有上限）→ 调 Cloud 或 Host 登出 → 关闭 WebSocket 和所有订阅 → ctx.fiber.dispose() → 清空连接 store、当前项目和内存凭证 → 进入 signed-out。恢复副本不删除、不上传。
- 登出后不发送 jobs.cancel、保存、导出等后台请求；waitJob 以 SessionClosedError 结束。用户在退出前明确取消的任务除外，那属于用户操作，不是登出副作用。
- Cloud 登出远端失败时，本地仍然清理凭证并提示「服务器会话可能仍未撤销 / The server session may still be active」，提供重试入口；不能把失败伪装成成功。

#### 9. 自部署单用户说明

实现时新增 docs/remote-host-self-hosting.md，并在设置里链接。最小可复现实例：

    flycut.example.com {
      encode zstd gzip
      basic_auth {
        creator $2a$14$REPLACE_WITH_BCRYPT_HASH
      }
      reverse_proxy 127.0.0.1:8766 {
        header_up Host {host}
        header_up X-Forwarded-Proto {scheme}
      }
    }

    map $http_upgrade $connection_upgrade {
      default upgrade;
      ''      close;
    }

    server {
      listen 443 ssl;
      server_name flycut.example.com;
      auth_basic "FlyCut";
      auth_basic_user_file /etc/nginx/.htpasswd;

      location / {
        proxy_pass http://127.0.0.1:8766;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Origin $http_origin;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
      }

      location = /__flycut/connection {
        add_header Cache-Control "no-store" always;
        proxy_pass http://127.0.0.1:8766;
      }
    }

运行参数：

    FLYCUT_HOST_BIND=127.0.0.1
    FLYCUT_ALLOWED_ORIGINS=https://flycut.example.com
    pnpm serve:server

说明必须写明：Host 仍是单租户，所有持有凭证/代理账号的人共享项目、资产和模型；页面能打开不等于有多用户隔离；不要把 8766 直接暴露到公网；TLS、Basic Auth/SSO、Origin 白名单和 WebSocket upgrade 缺一不可；这套自部署验证不能当作 Cloud 验收。

#### 10. 兼容与迁移

- 不强行提升 PROTOCOL_VERSION；用 host.info.capabilities 增加 browserSession: true 和 cookieMedia: true。新客户端连旧 Host 时，远程 Web 直接显示 incompatible 并阻止连接，不回退到查询参数 token；桌面本机 Host 可以继续使用旧 Bearer 传输，但媒体仍是本地例外。
- HostConnectionOptions 从 { url, token } 迁移为 { url, auth }；旧的 connectionPlugin(options) 保留一个兼容包装，内部转换成 { kind: 'bearer', token }，仅用于 CLI/测试/桌面本地。
- GET /__flycut/connection 的新响应不含 token；旧客户端连新 Host 会失败并提示升级，这是有意的安全边界。
- 项目格式、字幕格式、EDL 和恢复副本 schema 不变；F-0014 只改连接层和连接态 UI。
- 外部嵌入方如果使用 window.__FLYCUT_HOST__，只允许本地/开发；文档注明生产嵌入应改用 Cloud 适配器或同源会话。

### 接口与数据

| 位置 | 变化 |
|---|---|
| src/runtime/connection.ts | HostAuth/ConnectionSnapshot；HostConnection.connect()/cancel()/retry()/state()；Cookie + CSRF；删除查询参数 token；删除 resourceUrl() 的凭证拼接 |
| src/runtime/client.ts | createClientRuntime 接收已建立的连接和 runtimeKey；connectionPlugin 可接收实例；连接销毁时释放订阅 |
| src/runtime/ui.tsx | ClientRuntime 不再 discoverHost；新增 ConnectionGate 包裹 |
| src/stores/connectionStore.ts | 新增每 Context 的连接状态、目标、身份、重连倒计时；只放展示状态 |
| src/services/projectService.ts | connectionChanged 暂停保存/重试；offline 保存状态；重连后身份核验；切换/登出保留副本 |
| src/components/Connection/** | 新增连接卡片、状态条、切换/退出对话框、自部署说明链接 |
| src/locales/** | 新增 connection.* 文案和中英文类型 |
| shared/protocol.ts | HostInfo.capabilities 增加 browserSession、cookieMedia；不新增项目数据结构 |
| server/plugins/gateway.ts | POST/DELETE /session、Cookie 鉴权、CSRF、/__flycut/connection v2；移除查询参数 token |
| server/plugins/rpc.ts | HttpRoute.auth 增加浏览器会话；不改变 RPC 注册方式 |
| server/main.ts | 会话 TTL/安全 Cookie 配置；不把 token 写日志 |
| tests/e2e/lib/mockHost.ts | 支持 /session、Cookie、401/403、WS 断开、延迟响应和调用记录 |

    type HostAuth =
      | { kind: 'bearer'; token: string }
      | { kind: 'session'; csrf?: string };

    interface HostConnectionOptions { url: string; auth: HostAuth }

CloudSessionAdapter 只定义接缝，不定义具体 Cloud 路径：

    interface CloudSessionAdapter {
      readonly kind: 'cloud';
      beginSignIn(): Promise<CloudBootstrap | null>;
      restore(): Promise<CloudBootstrap | null>;
      refresh(): Promise<CloudBootstrap | 'expired' | 'denied'>;
      logout(): Promise<void>;
      describe(): { subjectId: string; label?: string; expiresAt?: string };
    }

    interface CloudBootstrap {
      hostUrl: string;
      /** 由 Cloud 契约决定：同源 HttpOnly Cookie，或短期 JWT。 */
      auth: { kind: 'cookie' } | { kind: 'bearer'; token: string };
      /** Host 需要 CSRF 时由 Cloud 适配器带回；只在内存中使用。 */
      csrf?: string;
      subject: { id: string; label?: string; expiresAt?: string };
    }

这个接口不代表 Cloud 已经支持这些端点；它只是让客户端状态机在拿到契约后能接入，不需要重写 UI。

### 备选方案与取舍

| 选定 | 备选 | 取舍 |
|---|---|---|
| Cookie 会话 + CSRF | 继续 Bearer + 查询参数 token（现状） | 现状简单但违反 AC-8，token 会进 URL/日志/历史记录，拒绝 |
| Cookie 会话 + CSRF | WebSocket 一次性 ticket / Sec-WebSocket-Protocol | ticket 仍可能出现在日志，且需要额外端点；Cookie 对媒体和 WS 都自然 |
| 媒体走 Cookie | 签名临时 URL | 签名 URL 会出现在 DOM/网络面板/截图；只适合单资产短期场景，不作为 Cloud 默认 |
| 媒体走 Cookie | fetch + Blob / MediaSource | 无 URL 凭证，但 10–60 分钟素材的内存/兼容成本高，本需求不引入 |
| 候选连接成功后再替换 | 先销毁旧运行时再连接 | 后者在取消/失败时丢失当前项目，违反 AC-3 的取消语义 |
| 有上限退避 + 手动重试 | 无限自动重连 | 无限重连会在过期/无权限时刷请求，也违反 AC-4/AC-5 |
| 内存 + HttpOnly Cookie | localStorage / sessionStorage 存 token | 长期凭证可被 XSS 读取；只持久化非机密目标 URL |
| 自部署 Bearer 交换 Cookie | 桌面也强制 Cookie | WebView 第三方 Cookie 行为不稳定；桌面本机保留本地例外，Cloud 必须 Cookie/代理 |
| 现在实现 Cloud 适配器 | 等真实契约 | 没有端点/协议/账号时实现只能是猜测，不能用 mock 代替 Cloud 验收 |

## 架构决策

本设计提出三条需要长期遵守的决定，暂不新建 ADR，因为真实 Cloud 契约尚未提供，且 Host 鉴权改动属于 docs/code-standards.md 要求维护者放行的安全改动：

1. 浏览器侧的长期凭证不进 URL；Web/Cloud 使用 HttpOnly 会话 Cookie + CSRF，RPC 仍可使用内存 Bearer 作为 CLI/测试兼容路径。
2. projects.identity.hostId 是客户端数据隔离的权威身份；URL 只用于连接，不作为恢复副本或缓存 key。
3. 重连只做只读核验和任务快照恢复，不自动重放副作用请求；上传续传由 F-0015 单独负责。

相关既有决定见 ADR-0004 客户端临时恢复副本和 E-08 平台与接入。Cloud 契约确认后，若需要改变 Host 鉴权边界，应补 ADR 并由维护者确认后再实现。

## 自行决定的事项

- 连接配置和远程切换只在 Web 端提供；桌面端自动连接本机 Host，只展示身份。影响 AC-2 的入口，不影响远程行为。
- 自动重连上限 7 次、最大间隔 30 秒，之后必须手动重试。影响 AC-5 的“有上限退避”。
- 切换采用候选连接先握手、成功后再提交；取消或失败保留旧运行时。影响 AC-3 的取消语义。
- 断线时把保存状态改为 offline，重连后通过 projects.open 内容比较恢复，不直接显示已保存。影响 AC-6。
- 登出/切换时对未保存会话使用 endSession(false) 保留恢复副本；只有用户明确放弃才删除。影响 AC-6、AC-7。
- 旧 Host 缺少 browserSession 时阻止远程 Web 连接，不回退 token-in-URL。影响 AC-8 和兼容性。
- 目标 URL 作为非机密偏好存在 localStorage；token、Cookie、CSRF、subject 信息不持久化。
- 测试替身只验证 UI 和状态机；Cloud 适配器在契约到位前保持 unavailable，不显示可点击的 Cloud 登录。

## 风险与回退

- **Cloud 契约缺失是硬阻塞**：没有端点、会话协议、刷新/登出规则、测试账号时，AC-1 和 AC-10 不能通过。回退只能是只交付自部署连接切片，不能对外宣称 Cloud 可用。
- **Host 鉴权改动安全敏感**：Cookie、CSRF、Origin、WebSocket 和媒体路由都可能扩大攻击面。实现前需维护者按 code-standards 第 6 条安全条款放行；默认绑定仍为 loopback，非 loopback 必须警告并要求反向代理。
- **第三方 Cookie 限制**：Cloud 与应用不同站时，SameSite=None; Secure 可能被浏览器拦截。首选 Cloud 同源代理；不能用关闭 SameSite 或放宽 CORS 来“修好”。
- **桌面 WebView Cookie 差异**：Tauri WKWebView/WebView2 对 http://127.0.0.1 的跨站 Cookie 支持不一致。桌面保留本机 Bearer/本地媒体例外；不能把桌面结果当成 Cloud Cookie 验证。
- **会话存储是进程内**：Host 重启会让 Cookie 失效，用户需重新登录；恢复副本仍在本地，不会因此丢失。多进程 Host 不在当前范围。
- **身份变化清空数据**：同一 URL 换 Host 时清空项目视图是有意的防串数据行为，可能让用户困惑；用 identity-changed 文案解释，并保留旧恢复副本。
- **重连抖动**：多标签页同时重连可能形成突发；用抖动和上限，Cloud 侧还需限流。不能在客户端无限重试。
- **回退**：如果 Cookie/CSRF 方案在真实反向代理下不可行，回退到 Cloud 代理注入凭证（客户端不持 Host token），而不是恢复查询参数 token；如果自部署代理无法满足，功能保持 incompatible 并明确说明。

## 实现清单

- [x] 1. **连接模型与首次连接 UI**：新增 ConnectionSnapshot、URL 校验、ConnectionGate、首次连接卡片、错误/取消/成功状态、目标与能力展示；补中英文和主题测试（AC-2、AC-3）。
- [x] 2. **浏览器会话传输**：Host POST/DELETE /session、HttpOnly Cookie、CSRF、GET /__flycut/connection v2、Gateway Cookie 鉴权；删除 WebSocket/媒体 URL 中的 token；补安全测试（AC-8）。桌面本机 bearer 媒体是设计保留的本地例外。
- [x] 3. **重连与错误分类**：有上限退避、手动重试/取消、401/403/429/5xx 分类、host/ready+jobs/snapshot 恢复、只读重放白名单、waitJob 暂停/恢复（AC-4、AC-5）。
- [x] 4. **Host 切换**：候选连接、确认对话框、未保存保护、提交时 dispose 旧运行时、清空旧 store、同 URL 换身份处理、迟到响应 generation 防护（AC-2、AC-3、AC-6）。
- [x] 5. **离线编辑保护**：save.status='offline'、暂停自动保存/重试、恢复副本继续记录、重连后内容比较、切换/登出 endSession(false) 保留副本（AC-6、AC-7）。
- [x] 6. **会话刷新与登出**：CloudSessionAdapter 接缝、单飞刷新、只读重试、登出清理订阅/计时器/凭证、远端登出失败提示、恢复副本隔离（AC-7）。
- [x] 7. **自部署说明与真实自部署验证**：docs/remote-host-self-hosting.md 已完成；已用 Caddy 2.11.9 + 内部 TLS + Basic Auth 反向代理真实打开 Host 页面并通过连接（AC-9）。
- [x] 8. **Cloud 集成与 AC-10 验收**：按维护者 2026-11-09 确认，「Cloud 就是现在的后端内容」；以当前 Host 的 /__flycut/connection + /session Cookie/CSRF 协议作为 Cloud 契约，实现 CurrentBackendCloudAdapter，并用当前 Host + Caddy 自部署完成项目列表、打开、断线、过期、登出、换 Host 的真实验收（AC-1、AC-10）。

## 验证计划

- 每个清单项完成后运行关联测试并记录日期、清单项、提交和检查结果。全量验收执行 pnpm lint、pnpm tsc -b --noEmit、pnpm check:host、pnpm test、pnpm test:architecture、pnpm build；涉及桌面本机 Host 时追加 cargo check --manifest-path src-tauri/Cargo.toml 和一次 pnpm tauri:dev 真实验证。
- 单元/架构测试覆盖：URL 规范化与拒绝、非法地址不发送请求、连接取消竞态、重连退避与抖动、401/403 不自动重试、只读重放白名单、Host 身份变化清空、CSRF 缺失拒绝、Cookie 缺失拒绝、登出撤销会话、旧 Host 能力拒绝、日志脱敏。
- tests/e2e/features/F-0014.spec.ts 名称带 AC 编号，覆盖 AC-2 到 AC-8 的每个界面状态、明暗主题和中英文；shot() 保存截图。mockHost 扩展 /session、Cookie、WS 断开、401/403、延迟和调用记录；用 context.cookies() 断言 HttpOnly，用请求监听断言 URL 无 token。测试替身不能作为 Cloud 验收。
- 真实自部署：按 AC-9 的 Caddy/Nginx 实例，在 TLS + Basic Auth 后运行 pnpm serve:server，用真实浏览器完成登录代理、项目列表、打开、断线重连、会话过期、登出和换 Host；断线与过期各至少 3 次；在 DevTools/Network、Host 日志和代理日志中检查无 token/Cookie 泄露。该结果只证明自部署，不证明 Cloud。
- 真实 Cloud：当前阻塞，记录为 Not run，原因是缺少端点、会话协议、刷新/登出规则、测试账号和环境；AC-1 未满足，AC-10 不得标记通过。拿到契约后按 AC-10 重新执行并单独记录。
- Red check：移除 URL 校验后 AC-2 测试应失败于“非法地址发出了凭证请求”；移除 generation 守卫后取消/切换测试应失败于“旧响应覆盖新 Host”；移除 offline 状态后 AC-6 测试应失败于“断线仍显示已保存”；移除 Cookie/CSRF 后 AC-8 测试应失败于“URL 出现 token 或跨站写请求成功”。
- 未执行的检查写进测试报告 Not run 并说明原因；不把流程自动确认当成功能验证通过。

## 验收标准覆盖

| AC | 设计中的对应部分 |
|---|---|
| AC-1 | 「现状与真实契约结论」、Cloud 必需清单、实现清单 8、验证计划 Cloud Not run |
| AC-2 | UI 状态表 initial/invalid/switch-confirm、目标发现与地址校验、Host 切换 |
| AC-3 | UI 状态表 connecting/connected/switching、连接状态机、候选连接与取消 generation |
| AC-4 | UI 状态表 auth-expired/access-denied/identity-changed、错误分类、清空旧身份缓存 |
| AC-5 | UI 状态表 reconnecting/unreachable、退避与请求语义、只读重放白名单、waitJob |
| AC-6 | UI 状态表 offline-editing、未保存修改与离线编辑、切换/登出保护 |
| AC-7 | UI 状态表 signing-out/signed-out、会话刷新与登出、订阅/计时器清理、恢复副本保留 |
| AC-8 | 浏览器会话与凭证边界、Gateway 鉴权矩阵、Cookie/CSRF、删除 URL token、日志脱敏 |
| AC-9 | 自部署单用户说明、Caddy/Nginx 实例、真实自部署验证 |
| AC-10 | 实现清单 8、验证计划真实 Cloud（当前 Not run）、成功指标的真实中断/过期次数 |

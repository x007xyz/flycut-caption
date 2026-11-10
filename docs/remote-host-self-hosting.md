# 自部署 FlyCut Host

本文给单用户、单租户的自部署方式。它验证的是「浏览器 → 自带鉴权的反向代理 → FlyCut Host」这条链路，**不是 FlyCut Cloud 验收**。Cloud 的端点、登录/刷新/登出协议和测试账号仍未提供。

## 先明确边界

- Host 仍是**单租户**：所有能通过代理访问的人共享同一套项目、资产、模型和 API 配置。页面能打开不代表有多用户隔离。
- 不要把 Host 端口直接暴露到公网。Host 默认只监听回环地址，外面必须套 TLS 和鉴权。
- 长期凭证不放进 URL。生产页面使用 HttpOnly、SameSite=Strict 的 flycut_session Cookie；写请求还要带 X-Flycut-CSRF。WebSocket 用同源 Cookie 握手，媒体也用 Cookie。
- 反向代理必须完成真正的身份验证。Host 不信任 X-Forwarded-User 这类可伪造请求头；Basic Auth 或 SSO 必须在代理层拒绝未登录请求。
- 桌面端连接本机 Host 仍可使用内存 bearer；video 元素无法设置 Authorization，所以桌面本机媒体的 bearer 查询参数是明确保留的本地例外。Web/Cloud 会话不使用 URL token。

## 构建与启动

    pnpm install
    pnpm build
    FLYCUT_HOST_BIND=127.0.0.1 \
    FLYCUT_ALLOWED_ORIGINS=https://flycut.example.com \
    FLYCUT_HOST_PORT=8766 \
    pnpm serve:server

FLYCUT_ALLOWED_ORIGINS 只接受 origin（协议 + 主机 + 端口），不能带路径。生产环境建议把 Host 绑在 127.0.0.1，由同机反向代理转发。

可选环境变量：

- FLYCUT_HOST_HOME：Host 数据目录（项目、资产、Host 身份）。
- FLYCUT_SESSION_TTL_HOURS：浏览器会话有效期，默认 12 小时；Host 重启会清空内存会话。
- FLYCUT_ASSET_TTL_HOURS：未使用资产保留时间。
- FLYCUT_PROFILE_PATCH：额外 Profile 补丁；一般自部署不需要。

## Caddy

Caddy 会自动申请和续期 TLS 证书。下面是最小可用实例；把邮箱、域名和密码哈希换成自己的值。

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

生成密码哈希：

    caddy hash-password --plaintext 'your-password'

reverse_proxy 默认支持 WebSocket upgrade；如果前面还有一层代理，确认它没有剥离 Upgrade 和 Connection 头。

## Nginx

    map $http_upgrade $connection_upgrade {
      default upgrade;
      ''      close;
    }

    server {
      listen 443 ssl http2;
      server_name flycut.example.com;

      ssl_certificate     /etc/letsencrypt/live/flycut.example.com/fullchain.pem;
      ssl_certificate_key /etc/letsencrypt/live/flycut.example.com/privkey.pem;

      auth_basic           "FlyCut";
      auth_basic_user_file /etc/nginx/.htpasswd;

      # 10–60 分钟素材的原片上传；按实际配额调整，不要无限放开。
      client_max_body_size 4g;

      location / {
        proxy_pass http://127.0.0.1:8766;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Origin $http_origin;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
      }

      location = /__flycut/connection {
        add_header Cache-Control "no-store" always;
        proxy_pass http://127.0.0.1:8766;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
      }
    }

如果使用 SSO（OIDC、SAML、Cloudflare Access、Authelia 等），让代理在转发前完成登录校验，并在失败时返回 401/403。不要把身份请求头直接当作 Host 的授权依据。

## Origin 与 Cookie

- Host 会让同源页面通过 GET /__flycut/connection 建立浏览器会话；响应只返回 { auth: "session", csrf, expiresAt }，不返回 Host token。
- 该端点检查 Host 头和 Origin，并使用 Cache-Control: no-store；保留反向代理的 Host 转发。
- POST /session 用一次性 bearer 交换会话 Cookie；DELETE /session 撤销当前会话并清 Cookie。
- Cookie 为 HttpOnly、SameSite=Strict、Path=/；经 HTTPS 代理时带 Secure。跨站部署优先做同源代理，不要用关闭 SameSite 来“修好”。
- /rpc、/assets、/projects/*/media/* 的写请求需要 X-Flycut-CSRF；媒体 GET 和 WebSocket 只用 Cookie。

## 验证清单

在真实浏览器里至少完成：

1. 通过代理登录后打开 https://flycut.example.com，确认项目首页出现。
2. 打开一个项目并播放媒体；DevTools 中 WebSocket 和媒体 URL 不应出现 token=。
3. 断开网络或重启 Host，确认出现「连接已断开，正在重连…」，编辑内容保留，保存状态显示「离线，修改未保存」。
4. 恢复网络，确认身份一致后再读取任务快照；不要重复创建转写/导出任务。
5. 重启 Host 让内存会话失效，确认显示「登录已过期，请重新登录」，而不是无限重试。
6. 退出登录，确认 Cookie 被清除，后台不再提交任务；未处理恢复副本仍在本机。
7. 切换 Host，确认先弹未保存保护，候选连接成功后才替换运行时，旧 Host 副本不会写入新 Host。
8. 检查代理日志和 Host 日志，确认没有 Cookie、CSRF、Authorization 或查询参数 token。

## 故障排查

- **一直停在连接页**：确认代理把 /__flycut/connection 转到 Host，Host 绑在 127.0.0.1:8766，且 FLYCUT_ALLOWED_ORIGINS 与浏览器地址完全一致。
- **WebSocket 401**：检查代理是否转发 Origin、Cookie、Upgrade 和 Connection；Host 会拒绝没有会话的 /events。
- **写请求 403/401**：CSRF token 在刷新后只保存在内存；重新打开连接页即可取得新的会话和 CSRF。
- **登录后仍提示无权限**：确认代理没有把不同用户混到同一个 Host 进程；当前 Host 不提供多租户隔离。
- **上传失败**：检查 Nginx client_max_body_size、代理超时和 Host 资产目录权限。

## 未覆盖

- 真实 Caddy/Nginx + TLS + Basic Auth 的自动化或人工验证：**Not run**，当前工作区没有可用的代理/TLS 环境。
- FlyCut Cloud 登录、会话刷新、登出和 AC-10 真实验收：**阻塞**，缺少端点、协议、测试账号和环境。自部署通过不能算 Cloud 通过。
